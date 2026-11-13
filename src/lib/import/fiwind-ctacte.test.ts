import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { markdownToStatementText } from "@/lib/bbva/parse-pdf";
import { isBankAccountingEntry } from "@/lib/bbva/bank-entries";
import {
  looksLikeFiwindCtaCte,
  parseCtaCteAmount,
  parseFiwindCtaCteText,
  pickImporteNeto,
} from "@/lib/import/fiwind-ctacte";
import { parseStatementFile } from "@/lib/import/parse-statement";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const fixture = (name: string) => join(root, "fixtures", "fiwind", name);

/** Workers AI `toMarkdown` of the real monthly statement, with name/account/CUIT replaced. */
const REAL_SHAPE_MARKDOWN = `# s.pdf
## Metadata
- PDFFormatVersion=1.7
- Title=RptCtasCorrientesConsolidado

## Contents
### Page 1
Hoja N° 1 de 21/9/2026
30/9/2026Fecha hasta:
Fecha desde:Estado de Cuenta13/11/2026
00:21:01Fecha de Emision:
Hora de Emision:
Cuenta: Titular Ejemplo - (99999)Concertación Liquidación Detalle Valor Nominal Importe Bruto Precio Importe
Neto Saldo Simbolo Derecho Arancel IVA del
Arancel
IVA del
D.MercMail: titular@example.com - CUIT: 20000000001Fiwind Capital S.A.Gorriti 196, piso 5 oficina B, Rosario, CP: 2000
Telefono: 3412572850
FIWIND CAPITAL S.A. ALYC INTEGRAL - N° de registro CNV 2231
ACDI - N° de registro CNV 214Disponible
MonedasPesos - $Saldo Anterior -20.0700 $
29/9/2026 29/9/2026 Movimiento Manual / Ajuste de saldo
residual cuenta 99999 (ARS) 20.07 20.07 $
Saldo al 30/09/2026 $Sistema aprobado por C.N.V.Domicilio: Gorriti 196 Piso 5 BSanta Fé Argentina Telefono: 3412572850

### Page 2
Hoja N° 2 de 21/9/2026
Cuenta: Titular Ejemplo - (99999)Concertación Liquidación Detalle Valor Nominal Importe Bruto Precio Importe
Neto Saldo Simbolo Derecho Arancel IVA del
D.MercMail: titular@example.com - CUIT: 20000000001ACDI - N° de registro CNV 214Sistema aprobado por C.N.V.Domicilio: Gorriti 196 Piso 5 BSanta Fé Argentina Telefono: 3412572850
`;

const EMPTY_MONTH_MARKDOWN = `# s.pdf
## Contents
### Page 1
Hoja N° 1 de 21/10/2026
31/10/2026Fecha hasta:
Fecha desde:Estado de Cuenta13/11/2026
Cuenta: Titular Ejemplo - (99999)Concertación Liquidación Detalle Valor Nominal Importe Bruto Precio Importe
Neto Saldo Simbolo Derecho Arancel IVA del
D.MercMail: titular@example.com - CUIT: 20000000001Fiwind Capital S.A.
No existen movimientos para la cuenta corrienteSistema aprobado por C.N.V.
`;

describe("parseCtaCteAmount", () => {
  it("reads Fiwind dot decimals, Argentine commas and thousands", () => {
    assert.equal(parseCtaCteAmount("20.0700"), 20.07);
    assert.equal(parseCtaCteAmount("-20.0700"), -20.07);
    assert.equal(parseCtaCteAmount("150000.00"), 150000);
    assert.equal(parseCtaCteAmount("1.234,50"), 1234.5);
    assert.equal(parseCtaCteAmount("1,234.50"), 1234.5);
    assert.equal(parseCtaCteAmount("12,50"), 12.5);
    assert.equal(parseCtaCteAmount("1.234.567"), 1234567);
    assert.equal(parseCtaCteAmount("(ARS)"), null);
    assert.equal(parseCtaCteAmount("27415x"), null);
  });
});

describe("pickImporteNeto", () => {
  it("takes the last number when the Saldo column is blank (zero)", () => {
    assert.equal(pickImporteNeto([20.07, 20.07], -20.07), 20.07);
    assert.equal(pickImporteNeto([-500], 1000), -500);
  });
  it("uses the running balance to tell Neto from Saldo", () => {
    assert.equal(pickImporteNeto([150000, 150000, 149979.93], -20.07), 150000);
    assert.equal(pickImporteNeto([-50000, -50000, 99979.93], 149979.93), -50000);
  });
});

describe("Fiwind Capital Estado de Cuenta", () => {
  it("reads the real statement shape (one manual adjustment, balance back to zero)", () => {
    const text = markdownToStatementText(REAL_SHAPE_MARKDOWN);
    assert.ok(looksLikeFiwindCtaCte(text));
    const r = parseFiwindCtaCteText(text);
    assert.equal(r.movements.length, 1);
    assert.deepEqual(r.unreadable, []);
    const m = r.movements[0]!;
    assert.equal(m.date, "2026-09-29");
    assert.equal(m.amountArs, 20.07);
    assert.equal(m.amountUsd, null);
    assert.equal(m.descriptionNormalized, "Transferencia interna - Cuenta comitente: Movimiento Manual / Ajuste de saldo residual");
    assert.equal(m.isCredit, true);
    assert.match(m.fingerprint, /^[a-f0-9]{32}$/);
    // Broker-account bookkeeping is never a gasto or an ingreso.
    assert.equal(isBankAccountingEntry(m.descriptionNormalized), true);
    assert.equal(m.categoryHint, "conversiones");
  });

  it("a month without operations reads as empty, not as an error", () => {
    const text = markdownToStatementText(EMPTY_MONTH_MARKDOWN);
    assert.ok(looksLikeFiwindCtaCte(text));
    const r = parseFiwindCtaCteText(text);
    assert.equal(r.movements.length, 0);
    assert.equal(r.emptyPeriod, true);
  });

  it("reads the fictional multi-row fixture from toMarkdown output (ARS and USD sections)", () => {
    const md = readFileSync(fixture("estado-cuenta-ejemplo.markdown.txt"), "utf8");
    const r = parseFiwindCtaCteText(markdownToStatementText(md));
    assert.deepEqual(r.unreadable, []);
    assert.equal(r.movements.length, 4);
    const [dep, buy, adj, rent] = r.movements;
    assert.deepEqual(
      [dep!.date, dep!.amountArs, dep!.amountUsd, dep!.isCredit],
      ["2026-09-01", 150000, null, true],
    );
    assert.equal(dep!.descriptionNormalized, "Transferencia interna - Cuenta comitente: Depósito transferencia bancaria");
    assert.deepEqual([buy!.date, buy!.amountArs, buy!.isCredit], ["2026-09-08", 50000, false]);
    assert.equal(buy!.descriptionNormalized, "Transferencia interna - Cuenta comitente: Compra FONDO EJEMPLO A");
    assert.deepEqual([adj!.date, adj!.amountArs], ["2026-09-29", 20.07]);
    assert.deepEqual([rent!.date, rent!.amountArs, rent!.amountUsd], ["2026-09-15", null, 12.5]);
    // Every line is bookkeeping on the broker account.
    for (const m of r.movements) assert.equal(isBankAccountingEntry(m.descriptionNormalized), true);
    // Same file twice → same fingerprints (idempotent import).
    const again = parseFiwindCtaCteText(markdownToStatementText(md));
    assert.deepEqual(again.movements.map((m) => m.fingerprint), r.movements.map((m) => m.fingerprint));
    assert.equal(new Set(r.movements.map((m) => m.fingerprint)).size, 4);
  });

  it("also reads plain pdftotext order (detail above the dates, symbol on its own line)", () => {
    if (!existsSync(fixture("estado-cuenta-ejemplo.pdf"))) return;
    let raw: string;
    try {
      raw = execFileSync("pdftotext", ["-raw", fixture("estado-cuenta-ejemplo.pdf"), "-"], { encoding: "utf8" });
    } catch {
      return; // poppler not installed
    }
    const r = parseFiwindCtaCteText(raw);
    assert.equal(r.movements.length, 4);
    assert.deepEqual(r.movements.map((m) => m.date), ["2026-09-01", "2026-09-08", "2026-09-29", "2026-09-15"]);
    assert.deepEqual(r.movements.map((m) => m.amountArs ?? m.amountUsd), [150000, 50000, 20.07, 12.5]);
    assert.deepEqual(r.movements.map((m) => m.isCredit), [true, false, true, true]);
  });

  it("parseStatementFile routes a Fiwind PDF through the Estado de Cuenta parser", async () => {
    const md = readFileSync(fixture("estado-cuenta-ejemplo.markdown.txt"), "utf8");
    const pdf = readFileSync(fixture("estado-cuenta-ejemplo.pdf"));
    const parsed = await parseStatementFile(pdf, "estado.pdf", {
      pdfMarkdown: async () => md,
      skipAi: true,
    });
    assert.equal(parsed.detectedBank, "Fiwind");
    assert.equal(parsed.movements.length, 4);
    assert.equal(parsed.hint, null);

    const empty = await parseStatementFile(pdf, "estado.pdf", {
      pdfMarkdown: async () => EMPTY_MONTH_MARKDOWN,
      skipAi: true,
    });
    assert.equal(empty.movements.length, 0);
    assert.match(empty.hint ?? "", /no tiene movimientos/);
  });
});
