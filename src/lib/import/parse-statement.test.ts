import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import * as XLSX from "xlsx";
import { parseBbvaWorkbook, parseStatementWorkbook } from "@/lib/bbva/parse";
import {
  parseBbvaPdfText,
  parseGenericPdfText,
} from "@/lib/bbva/parse-pdf";
import { isBankAccountingEntry, isCardPaymentEntry } from "@/lib/bbva/bank-entries";
import { isExpenseRow } from "@/lib/stats/monthly-expenses";
import { classifyFiwindTipo, isDustYield } from "@/lib/import/fiwind";
import { parseBbvaAmount } from "@/lib/money";
import { summarizeParsedMovements } from "@/lib/agent/import-summary";
import {
  detectFiwindActividadLayout,
  resolveImportBank,
  statementTypeLabel,
} from "@/lib/import/source";
import { parseStatementFile } from "@/lib/import/parse-statement";

function workbookBuffer(
  rows: Array<Array<string | number | null>>,
  sheet = "Movimientos",
): Buffer {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, sheet);
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}

describe("BBVA Excel regression", () => {
  it("parses classic Últimos movimientos amounts", () => {
    const buf = workbookBuffer([
      [
        "Nro. Tarjeta",
        "Fecha",
        "Establecimiento",
        "Cuota",
        "Importe en $",
        "Importe en U$S",
      ],
      ["1234", "01/08/2026", "DIA TIENDA 99", "/", 15420.5, null],
      ["1234", "02/08/2026", "CAFE MARTINEZ", "/", 3200, null],
      ["1234", "03/08/2026", "OPENAI", "/", null, 20],
      ["1234", "04/08/2026", "SU PAGO EN PESOS", "/", -18000, null],
    ]);

    const parsed = parseStatementWorkbook(buf, "bbva-movimientos.xlsx");
    assert.equal(parsed.classicBbva, true);
    assert.ok(parsed.movements.length >= 4);

    const summary = summarizeParsedMovements(parsed.movements, "bbva_xlsx");
    assert.equal(summary.source, "bbva_xlsx");
    const august = summary.byPeriod.find((p) => p.period === "2026-08");
    assert.ok(august);
    assert.equal(august.amountArs, 15420.5 + 3200);
    assert.equal(august.amountUsd, 20);

    const same = parseBbvaWorkbook(buf);
    assert.equal(same.length, parsed.movements.length);
    assert.equal(same[0].fingerprint, parsed.movements[0].fingerprint);
  });
});

describe("Fiwind Excel / CSV", () => {
  it("parses Fecha + Descripción + Monto + Moneda", () => {
    const buf = workbookBuffer([
      ["Fecha", "Descripción", "Monto", "Moneda"],
      ["01/08/2026", "DIA TIENDA 99", 15420.5, "ARS"],
      ["03/08/2026", "OPENAI", 20, "USD"],
      ["04/08/2026", "PAGO RECIBIDO", -18000, "ARS"],
    ]);
    const parsed = parseStatementWorkbook(buf, "Fiwind-agosto.xlsx");
    assert.equal(parsed.detectedBank, "Fiwind");
    assert.equal(parsed.classicBbva, false);
    assert.equal(parsed.movements.length, 3);

    const dia = parsed.movements.find((m) => m.descriptionNormalized.includes("DIA"));
    assert.equal(dia?.amountArs, 15420.5);
    const openai = parsed.movements.find((m) => m.descriptionNormalized.includes("OPENAI"));
    assert.equal(openai?.amountUsd, 20);
    assert.equal(openai?.amountArs, null);
    const pago = parsed.movements.find((m) => m.isPayment);
    assert.ok(pago);

    assert.equal(
      statementTypeLabel("xlsx", parsed.detectedBank),
      "Movimientos Excel (Fiwind)",
    );
  });

  it("parses semicolon CSV with débito/crédito", () => {
    const csv = [
      "Fecha;Concepto;Débito;Crédito",
      "01/08/2026;DIA TIENDA 99;15.420,50;",
      "02/08/2026;CAFE MARTINEZ;3.200,00;",
      "04/08/2026;PAGO RECIBIDO;;18.000,00",
    ].join("\n");
    const buf = Buffer.from(csv, "utf8");
    const parsed = parseStatementWorkbook(buf, "fiwind-movimientos.csv");
    assert.equal(parsed.fileKind, "csv");
    assert.equal(parsed.movements.length, 3);
    const dia = parsed.movements.find((m) => /DIA/i.test(m.descriptionNormalized));
    assert.equal(dia?.amountArs, 15420.5);
    const pago = parsed.movements.find((m) => m.isPayment);
    assert.ok(pago);
    assert.ok((pago?.amountArs ?? 0) < 0);
  });

  it("parses Fecha + Tipo + Monto + Moneda (Actividad export)", () => {
    const buf = workbookBuffer(
      [
        ["Fecha", "Tipo", "Monto", "Moneda", "Monto Origen", "Moneda Origen", "Precio"],
        ["31/08/2026 19:56:54", "Pago a DIA", 15420.5, "ARS", null, null, null],
        ["31/08/2026 19:23:58", "Depósito de cuenta propia", 12800, "ARS", null, null, null],
        ["30/08/2026 14:27:09", "Compra KO", 20, "USDC", null, null, null],
        ["29/08/2026 11:00:00", "Conversión", 110000, "ARS", 71.3, "USDC", 1542.7],
        ["28/08/2026 03:00:11", "Ganancia diaria", 0.68, "ARS", null, null, null],
      ],
      "Actividad",
    );
    const parsed = parseStatementWorkbook(buf, "actividad-1.xlsx");
    assert.equal(parsed.detectedBank, "Fiwind");
    assert.equal(parsed.classicBbva, false);
    // Ganancia diaria 0.68 ARS is dust — skipped
    assert.equal(parsed.movements.length, 4);
    assert.equal(
      parsed.movements.some((m) => /GANANCIA DIARIA/i.test(m.descriptionNormalized)),
      false,
    );

    const dia = parsed.movements.find((m) => /PAGO A DIA/i.test(m.descriptionNormalized));
    assert.ok(dia);
    assert.equal(dia?.date, "2026-08-31");
    assert.equal(dia?.amountArs, 15420.5);
    assert.equal(dia?.isPayment, false);
    assert.equal(isCardPaymentEntry(dia!.descriptionNormalized), false);
    assert.equal(isExpenseRow(dia!), true);

    const deposito = parsed.movements.find((m) => /DEP[OÓ]SITO/i.test(m.descriptionNormalized));
    assert.equal(deposito?.isCredit, true);
    assert.equal(isExpenseRow(deposito!), false);

    const ko = parsed.movements.find((m) => /COMPRA KO/i.test(m.descriptionNormalized));
    assert.equal(ko?.amountUsd, 20);
    assert.equal(ko?.amountArs, null);
    assert.equal(ko?.categoryHint, "crypto-inversiones");
    assert.equal(isExpenseRow(ko!), false);

    const conv = parsed.movements.find((m) => /CONVERSI[OÓ]N/i.test(m.descriptionNormalized));
    assert.equal(conv?.categoryHint, "conversiones");
    assert.equal(isExpenseRow(conv!), false);
    assert.equal(conv?.isPayment, false);

    assert.equal(
      statementTypeLabel("xlsx", parsed.detectedBank),
      "Movimientos Excel (Fiwind)",
    );
    assert.equal(
      resolveImportBank({
        selected: "BBVA",
        detected: parsed.detectedBank,
        fileName: "actividad-1.xlsx",
      }),
      "Fiwind",
    );
  });

  it("parses comma CSV", () => {
    const csv = [
      "Fecha,Descripción,Monto,Moneda",
      "15/07/2026,YPF,8900,ARS",
      "16/07/2026,OPENAI,12.5,USD",
    ].join("\n");
    const parsed = parseStatementWorkbook(
      Buffer.from(csv, "utf8"),
      "extracto.csv",
    );
    assert.equal(parsed.movements.length, 2);
    assert.equal(parsed.movements[0].amountArs, 8900);
    assert.equal(parsed.movements[1].amountUsd, 12.5);
  });
});

describe("PDF text parsers", () => {
  it("keeps BBVA DD-MMM-YY movement lines", () => {
    const text = [
      "DETALLE DE CONSUMOS",
      "04-Ago-26 SU PAGO EN PESOS 123456 180.000,00",
      "05-Ago-26 DIA TIENDA 99 654321 15.420,50",
      "06-Ago-26 OPENAI 111222 USD 20,00",
    ].join("\n");
    const rows = parseBbvaPdfText(text);
    assert.ok(rows.length >= 2, `got ${rows.length}`);
    const pago = rows.find((r) => r.isPayment);
    assert.ok(pago);
    const dia = rows.find((r) => /DIA/i.test(r.descriptionNormalized));
    assert.equal(dia?.date, "2026-08-05");
    assert.equal(dia?.amountArs, 15420.5);
  });

  it("parses Fiwind-like DD/MM/YYYY lines", () => {
    const text = [
      "Fiwind Mastercard",
      "Fecha Descripción Importe",
      "01/08/2026 DIA TIENDA 99 15.420,50",
      "03/08/2026 OPENAI 20,00",
      "04/08/2026 PAGO RECIBIDO -18.000,00",
    ].join("\n");
    const rows = parseGenericPdfText(text);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].date, "2026-08-01");
    assert.equal(rows[0].amountArs, 15420.5);
    const pago = rows.find((r) => r.isPayment);
    assert.ok(pago);
  });
});

describe("Fiwind Actividad fixtures", () => {
  const dir = join(process.cwd(), "fixtures/fiwind");

  it("detects Fiwind from Actividad+Tipo+Moneda headers", () => {
    assert.equal(
      detectFiwindActividadLayout({
        fileName: "actividad-2.xlsx",
        sheetNames: ["Actividad", "Balance"],
        headers: [
          "Fecha",
          "Tipo",
          "Monto",
          "Moneda",
          "Monto Origen",
          "Moneda Origen",
          "Precio",
        ],
      }),
      true,
    );
  });

  it("reads the three mock exports", async () => {
    const expected: Array<{
      file: string;
      min: number;
      date: string;
      snippet: string;
    }> = [
      {
        file: "actividad-1.xlsx",
        min: 25,
        date: "2026-06-29",
        snippet: "Rendimiento bonificado",
      },
      {
        file: "actividad-2.xlsx",
        min: 140,
        date: "2026-08-31",
        snippet: "Retiro a Persona Demo Uno",
      },
      {
        file: "actividad-3.xlsx",
        min: 70,
        date: "2026-07-31",
        snippet: "Retiro a Ana Lopez",
      },
    ];

    for (const exp of expected) {
      const buf = readFileSync(join(dir, exp.file));
      const parsed = await parseStatementFile(buf, exp.file);
      assert.equal(parsed.detectedBank, "Fiwind", exp.file);
      assert.equal(parsed.source, "xlsx", exp.file);
      assert.ok(
        parsed.movements.length >= exp.min,
        `${exp.file} got ${parsed.movements.length}`,
      );
      assert.ok(
        parsed.movements.some((m) => m.date === exp.date),
        `${exp.file} missing ${exp.date}`,
      );
      assert.ok(
        parsed.movements.some((m) =>
          m.descriptionNormalized.toLowerCase().includes(exp.snippet.toLowerCase()),
        ),
        `${exp.file} missing “${exp.snippet}” (got ${parsed.movements[0]?.descriptionNormalized})`,
      );
      assert.ok(
        parsed.movements.every((m) => !/^\d+(\.\d+)?$/.test(m.descriptionNormalized)),
        `${exp.file} still using amount as description`,
      );
      assert.equal(
        statementTypeLabel(parsed.source, parsed.detectedBank),
        "Movimientos Excel (Fiwind)",
      );
    }
  });

  it("maps USDC/USDT to USD and keeps ARS spends", () => {
    const buf = readFileSync(join(dir, "actividad-2.xlsx"));
    const parsed = parseStatementWorkbook(buf, "actividad-2.xlsx");
    const usd = parsed.movements.filter((m) => m.amountUsd != null);
    const ars = parsed.movements.filter((m) => m.amountArs != null);
    assert.ok(usd.length > 0, "expected USDC/USDT rows as USD");
    assert.ok(ars.length > 50, `expected many ARS rows, got ${ars.length}`);
    const pago = parsed.movements.find((m) => /PAGO A DIA/i.test(m.descriptionNormalized));
    assert.ok(pago);
    assert.equal(pago?.isPayment, false);
    assert.equal(isCardPaymentEntry(pago!.descriptionNormalized), false);
    assert.equal(isExpenseRow(pago!), true);
  });

  it("does not count conversions, crypto trades or dust yields as gastos", () => {
    const buf = readFileSync(join(dir, "actividad-2.xlsx"));
    const parsed = parseStatementWorkbook(buf, "actividad-2.xlsx");

    assert.equal(
      parsed.movements.some(
        (m) =>
          classifyFiwindTipo(m.descriptionNormalized) === "yield" &&
          isDustYield("yield", m.amountArs, m.amountUsd),
      ),
      false,
      "dust yields should be skipped on import",
    );

    const expenses = parsed.movements.filter(isExpenseRow);
    assert.ok(expenses.length > 20, `expected real spends, got ${expenses.length}`);
    assert.ok(
      expenses.every((m) => !isBankAccountingEntry(m.descriptionNormalized)),
    );
    assert.ok(
      expenses.every((m) => classifyFiwindTipo(m.descriptionNormalized) === "spend"),
    );

    const summary = summarizeParsedMovements(parsed.movements, "xlsx");
    const convArs = parsed.movements
      .filter((m) => classifyFiwindTipo(m.descriptionNormalized) === "conversion")
      .reduce((s, m) => s + Math.abs(m.amountArs ?? 0), 0);
    const totalArs = parsed.movements.reduce(
      (s, m) => s + Math.abs(m.amountArs ?? 0),
      0,
    );
    const expenseArs = summary.byPeriod.reduce((s, p) => s + p.amountArs, 0);
    assert.ok(convArs > 100_000, `expected large conversions in file, got ${convArs}`);
    assert.ok(
      expenseArs <= totalArs - convArs + 0.01,
      `conversions leaked into gastos: expenses ${expenseArs} total ${totalArs} conv ${convArs}`,
    );
    assert.equal(
      expenses.some((m) => /CONVERSI/i.test(m.descriptionNormalized)),
      false,
    );
    assert.equal(
      expenses.some((m) => /COMPRA KO|VENTA KO/i.test(m.descriptionNormalized)),
      false,
    );

    const pairSpend = parsed.movements.find((m) =>
      /RETIRO A PERSONA DEMO DOS/i.test(m.descriptionNormalized),
    );
    const pairConv = parsed.movements.find(
      (m) =>
        /CONVERSI/i.test(m.descriptionNormalized) &&
        m.date === pairSpend?.date &&
        m.amountArs === pairSpend?.amountArs,
    );
    assert.ok(pairSpend, "expected convert-then-pay Retiro a Persona Demo Dos");
    assert.ok(pairConv, "expected matching Conversión of the same ARS");
    assert.equal(isExpenseRow(pairSpend!), true);
    assert.equal(isExpenseRow(pairConv!), false);
  });

  it("keeps COMPRA SUPER as gasto and hides TRANSFERENCIA / amount-only Tipo", () => {
    const buf = workbookBuffer(
      [
        ["Fecha", "Tipo", "Monto", "Moneda", "Monto Origen", "Moneda Origen", "Precio"],
        ["18/08/2026 12:00:00", "COMPRA SUPER ARS", 8900, "ARS", null, null, null],
        ["18/08/2026 12:01:00", "TRANSFERENCIA ARS", 5000, "ARS", null, null, null],
        ["18/08/2026 12:02:00", "12800", 12800, "ARS", null, null, null],
        ["18/08/2026 12:03:00", "Pago a DIA", 15420.5, "ARS", null, null, null],
        ["18/08/2026 12:04:00", "Compra KO", 20, "USDC", null, null, null],
        ["18/08/2026 12:05:00", "De una cuenta tuya", 20000, "ARS", null, null, null],
      ],
      "Actividad",
    );
    const parsed = parseStatementWorkbook(buf, "actividad-jurio.xlsx");
    const superRow = parsed.movements.find((m) =>
      /COMPRA SUPER/i.test(m.descriptionNormalized),
    );
    const transfer = parsed.movements.find((m) =>
      /TRANSFERENCIA ARS/i.test(m.descriptionNormalized),
    );
    const numeric = parsed.movements.find(
      (m) => m.descriptionNormalized.trim() === "12800",
    );
    const dia = parsed.movements.find((m) => /PAGO A DIA/i.test(m.descriptionNormalized));
    const ko = parsed.movements.find((m) => /COMPRA KO/i.test(m.descriptionNormalized));

    assert.equal(isExpenseRow(superRow!), true);
    assert.equal(superRow?.categoryHint, undefined);
    assert.equal(isExpenseRow(transfer!), false);
    assert.equal(transfer?.categoryHint, "conversiones");
    assert.equal(isExpenseRow(numeric!), false);
    assert.equal(numeric?.categoryHint, "conversiones");
    assert.equal(isExpenseRow(dia!), true);
    assert.equal(isExpenseRow(ko!), false);
    const propia = parsed.movements.find((m) =>
      /CUENTA TUYA/i.test(m.descriptionNormalized),
    );
    assert.equal(propia?.categoryHint, "transferencia-interna");
    assert.equal(propia?.isPayment, true);
    assert.equal(propia?.isCredit, false);
    assert.equal(isExpenseRow(propia!), false);
    assert.equal(isBankAccountingEntry("TRANSFERENCIA ARS"), true);
    assert.equal(isBankAccountingEntry("12800"), true);
    assert.equal(isBankAccountingEntry("COMPRA SUPER ARS"), false);
  });
});

describe("bare transfer is_payment", () => {
  it("stores a generic transfer as not a payment and keeps explicit own-account phrases", () => {
    const buf = workbookBuffer([
      ["Fecha", "Establecimiento", "Cuota", "Importe en $", "Importe en U$S"],
      ["10/08/2026", "TRANSFERENCIA", "/", 100, null],
      ["10/08/2026", "TRANSFERENCIA INMEDIATA", "/", 200, null],
      ["10/08/2026", "A una cuenta tuya", "/", 300, null],
      ["10/08/2026", "CR TRF INM COE", "/", 400, null],
      ["10/08/2026", "TRANSF A CUENTA PROPIA", "/", 500, null],
      ["10/08/2026", "ENTRE CUENTAS", "/", 600, null],
    ]);
    const parsed = parseStatementWorkbook(buf, "bbva-ca.xlsx");
    const byDesc = (re: RegExp) => parsed.movements.find((row) => re.test(row.descriptionNormalized));
    assert.equal(byDesc(/^TRANSFERENCIA$/i)?.isPayment, false);
    assert.equal(byDesc(/INMEDIATA/i)?.isPayment, false);
    assert.equal(byDesc(/CUENTA TUYA/i)?.isPayment, true);
    assert.equal(byDesc(/CR TRF/i)?.isPayment, true);
    assert.equal(byDesc(/CUENTA PROPIA/i)?.isPayment, true);
    assert.equal(byDesc(/ENTRE CUENTAS/i)?.isPayment, true);
  });
});

describe("amount formats", () => {
  it("uses the last separator so AR and US both work", () => {
    assert.equal(parseBbvaAmount("15.420,50")?.value, 15420.5);
    assert.equal(parseBbvaAmount("15,420.50")?.value, 15420.5);
    assert.equal(parseBbvaAmount("$ 30.277,00")?.value, 30277);
    assert.equal(parseBbvaAmount("USD 20,00")?.currency, "USD");
  });

  it("reads Argentine thousands without cents instead of NaN or a decimal", () => {
    assert.equal(parseBbvaAmount("1.234.567")?.value, 1234567);
    assert.equal(parseBbvaAmount("$ 30.277")?.value, 30277);
    assert.equal(parseBbvaAmount("-1.234")?.value, -1234);
    assert.equal(parseBbvaAmount("20.00")?.value, 20);
    assert.equal(parseBbvaAmount("0.50")?.value, 0.5);
    assert.equal(parseBbvaAmount("USD -102.48")?.value, -102.48);
  });
});

describe("BBVA card fixtures", () => {
  const dir = join(process.cwd(), "fixtures/bbva-card");

  it("parses period a/b/c xls with cuotas and two cards", async () => {
    const a = await parseStatementFile(
      readFileSync(join(dir, "mov-periodo-a.xls")),
      "mov-periodo-a.xls",
    );
    assert.equal(a.source, "bbva_period");
    assert.ok(a.movements.length >= 40);
    assert.ok(
      a.movements.some(
        (m) => m.installment === "4/6" && /PENGUIN/i.test(m.descriptionNormalized),
      ),
    );
    const last4 = new Set(a.movements.map((m) => m.cardLast4).filter(Boolean));
    assert.ok(last4.has("7022") && last4.has("8958"));

    const b = await parseStatementFile(
      readFileSync(join(dir, "mov-periodo-b.xls")),
      "mov-periodo-b.xls",
    );
    assert.equal(b.source, "bbva_period");
    assert.ok(b.movements.length > a.movements.length);

    const c = await parseStatementFile(
      readFileSync(join(dir, "mov-periodo-c.xls")),
      "mov-periodo-c.xls",
    );
    assert.equal(c.source, "bbva_period");
    assert.ok(c.movements.some((m) => m.installment === "1/6"));
  });

  it("asks for Excel or CSV when Workers AI is not bound", async () => {
    const parsed = await parseStatementFile(
      Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"),
      "resumen-a.pdf",
    );
    assert.equal(parsed.movements.length, 0);
    assert.match(parsed.hint ?? "", /Excel|CSV|texto/i);
  });

  it("parses both Últimos movimientos xlsx files", async () => {
    const u1 = await parseStatementFile(
      readFileSync(join(dir, "ultimos-movimientos.xlsx")),
      "ultimos-movimientos.xlsx",
    );
    assert.equal(u1.source, "bbva_xlsx");
    assert.ok(u1.movements.filter((m) => /TEMBICI/i.test(m.descriptionNormalized)).length >= 2);

    const u2 = await parseStatementFile(
      readFileSync(join(dir, "ultimos-movimientos-2.xlsx")),
      "ultimos-movimientos-2.xlsx",
    );
    assert.equal(u2.source, "bbva_xlsx");
    assert.ok(u2.movements.length >= 80);
    assert.ok(u2.movements.some((m) => m.installment === "2/6"));
  });
});
