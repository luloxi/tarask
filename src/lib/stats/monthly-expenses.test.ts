import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aggregateByBank,
  aggregateByPeriod,
  aggregateCubiertoByPeriod,
  buildMonthFromAgg,
  formatGastosHeadline,
  filterByOwnership,
  isCubiertoUtilityRow,
  isExpenseRow,
  mergePeriodLists,
  visibleCubiertoRows,
  visibleExpenseRows,
  type ExpenseTx,
} from "./monthly-expenses";
import { parseReintegroPayees } from "@/lib/reintegro-hogar";
import type { MonthEndRate } from "@/lib/fx/month-end-rates";

const PAYEES = parseReintegroPayees("ANA+LOPEZ,ANITA");
const NO_PAYEES: string[][] = [];

function tx(
  partial: Partial<ExpenseTx> & Pick<ExpenseTx, "date" | "descriptionNormalized">,
): ExpenseTx {
  return {
    amountArs: null,
    amountUsd: null,
    isPayment: false,
    categoryId: null,
    bank: "BBVA",
    ownership: "personal",
    paidByUserId: "user-1",
    ...partial,
  };
}

const cats = new Map([
  ["cat-super", { slug: "supermercado", name: "Supermercado" }],
  ["cat-saas", { slug: "tecnologia", name: "Tecnología" }],
  ["cat-luz", { slug: "luz", name: "Luz" }],
  ["cat-internet", { slug: "internet", name: "Internet" }],
]);

const augustRate: MonthEndRate = {
  period: "2026-08",
  buy: 1400,
  asOf: "2026-08-28",
  source: "oficial_compra",
};

describe("isExpenseRow", () => {
  it("keeps real spends and drops payments / pesificación", () => {
    assert.equal(
      isExpenseRow({
        isPayment: false,
        descriptionNormalized: "DIA TIENDA 123",
      }),
      true,
    );
    assert.equal(
      isExpenseRow({
        isPayment: true,
        descriptionNormalized: "SU PAGO EN PESOS",
      }),
      false,
    );
    assert.equal(
      isExpenseRow({
        isPayment: false,
        descriptionNormalized: "PESIFICACION USD",
      }),
      false,
    );
    assert.equal(
      isExpenseRow({
        isPayment: false,
        descriptionNormalized: "Conversión",
      }),
      false,
    );
    assert.equal(
      isExpenseRow({
        isPayment: false,
        descriptionNormalized: "Compra KO",
      }),
      false,
    );
    assert.equal(
      isExpenseRow({
        isPayment: false,
        isCredit: true,
        descriptionNormalized: "Depósito de cuenta propia",
      }),
      false,
    );
    assert.equal(
      isExpenseRow({
        isPayment: false,
        descriptionNormalized: "TRANSFERENCIA ARS",
      }),
      false,
    );
    assert.equal(
      isExpenseRow({
        isPayment: false,
        descriptionNormalized: "12800",
      }),
      false,
    );
    assert.equal(
      isExpenseRow({
        isPayment: false,
        descriptionNormalized: "COMPRA SUPER ARS",
      }),
      true,
    );
    assert.equal(
      isExpenseRow({
        isPayment: false,
        descriptionNormalized: "DIA TIENDA 536",
        source: "bbva_period",
      }),
      false,
      "period xls feeds Deuda, not gastos neta",
    );
    assert.equal(
      isExpenseRow({
        isPayment: false,
        descriptionNormalized: "DIA TIENDA 536",
        source: "bbva_pdf",
      }),
      false,
    );
  });

  it("counts every spend in neta regardless of linked_transaction_id", () => {
    assert.equal(
      isExpenseRow({
        isPayment: false,
        descriptionNormalized: "CURSOR",
        source: "bbva_import",
      }),
      true,
    );
    assert.equal(
      isExpenseRow({
        isPayment: false,
        descriptionNormalized: "Cursor Pro",
        source: "invoice_iog",
      }),
      true,
    );
  });
});

describe("visibleExpenseRows", () => {
  it("hides someone else's personal spend", () => {
    const rows = [
      tx({
        date: "2026-08-01",
        descriptionNormalized: "MIO",
        amountArs: 100,
        paidByUserId: "user-1",
        ownership: "personal",
      }),
      tx({
        date: "2026-08-01",
        descriptionNormalized: "AJENO",
        amountArs: 999999,
        paidByUserId: "user-2",
        ownership: "personal",
      }),
      tx({
        date: "2026-08-01",
        descriptionNormalized: "HOGAR",
        amountArs: 50,
        paidByUserId: "user-2",
        ownership: "shared",
      }),
    ];
    const vis = visibleExpenseRows(rows, "user-1");
    assert.deepEqual(
      vis.map((r) => r.descriptionNormalized),
      ["MIO", "HOGAR"],
    );
  });
});


describe("filterByOwnership", () => {
  it("keeps all when ownership is all", () => {
    const rows = [
      tx({ date: "2026-08-01", ownership: "personal", descriptionNormalized: "P" }),
      tx({ date: "2026-08-01", ownership: "shared", descriptionNormalized: "H" }),
    ];
    assert.equal(filterByOwnership(rows, "all").length, 2);
  });

  it("filters Personal and Hogar", () => {
    const rows = [
      tx({ date: "2026-08-01", ownership: "personal", descriptionNormalized: "P" }),
      tx({ date: "2026-08-01", ownership: "shared", descriptionNormalized: "H" }),
      tx({ date: "2026-08-01", ownership: "personal", descriptionNormalized: "P2" }),
    ];
    assert.deepEqual(
      filterByOwnership(rows, "personal").map((r) => r.descriptionNormalized),
      ["P", "P2"],
    );
    assert.deepEqual(
      filterByOwnership(rows, "shared").map((r) => r.descriptionNormalized),
      ["H"],
    );
  });
});

describe("aggregate monthly expenses from stored rows", () => {
  const rows: ExpenseTx[] = [
    tx({
      date: "2026-08-01",
      descriptionNormalized: "DIA TIENDA",
      amountArs: 10000,
      categoryId: "cat-super",
    }),
    tx({
      date: "2026-08-02",
      descriptionNormalized: "CAFE MARTINEZ",
      amountArs: "2500.00",
      categoryId: null,
    }),
    tx({
      date: "2026-08-03",
      descriptionNormalized: "OPENAI",
      amountUsd: 20,
      categoryId: "cat-saas",
      bank: "Fiwind",
    }),
    tx({
      date: "2026-08-04",
      descriptionNormalized: "SU PAGO",
      amountArs: 50000,
      isPayment: true,
    }),
    tx({
      date: "2026-08-05",
      descriptionNormalized: "PESIFICACION",
      amountArs: 1000,
    }),
    tx({
      date: "2026-07-15",
      descriptionNormalized: "YPF NAFTA",
      amountArs: 8000,
    }),
  ];

  const expenses = rows.filter(isExpenseRow);
  const { periods, byPeriod } = aggregateByPeriod(expenses, cats);

  it("lists periods newest first from real dates", () => {
    assert.deepEqual(periods, ["2026-08", "2026-07"]);
  });

  it("sums August ARS + USD without payments or accounting lines", () => {
    const month = buildMonthFromAgg(
      "2026-08",
      byPeriod.get("2026-08"),
      augustRate,
    );
    assert.equal(month.totalCount, 3);
    assert.equal(month.totalArs, 12500);
    assert.equal(month.totalUsd, 20);
    assert.equal(month.totalArsFromUsd, 28000);
    assert.equal(month.totalArsCombined, 40500);
    const superCat = month.categories.find((c) => c.slug === "supermercado");
    assert.equal(superCat?.amountArs, 10000);
    const saas = month.categories.find((c) => c.slug === "tecnologia");
    assert.equal(saas?.amountUsd, 20);
    assert.equal(saas?.amountArsCombined, 28000);
  });

  it("does not invent totals for an empty month", () => {
    const month = buildMonthFromAgg(
      "2026-01",
      byPeriod.get("2026-01"),
      undefined,
    );
    assert.equal(month.totalArs, 0);
    assert.equal(month.totalUsd, 0);
    assert.equal(month.totalCount, 0);
    assert.equal(month.totalArsCombined, 0);
    assert.match(formatGastosHeadline(month), /No hay gastos registrados/);
  });

  it("headline uses the combined total from stored amounts", () => {
    const month = buildMonthFromAgg(
      "2026-08",
      byPeriod.get("2026-08"),
      augustRate,
    );
    const headline = formatGastosHeadline(month);
    assert.match(headline, /agosto.*2026/i);
    assert.match(headline, /3 movimientos/);
    assert.ok(headline.includes("20"));
  });

  it("groups by bank from stored rows", () => {
    const august = expenses.filter((r) => r.date.startsWith("2026-08"));
    const banks = aggregateByBank(august);
    const bbva = banks.find((b) => b.bank === "BBVA");
    const fiwind = banks.find((b) => b.bank === "Fiwind");
    assert.equal(bbva?.amountArs, 12500);
    assert.equal(bbva?.count, 2);
    assert.equal(fiwind?.amountUsd, 20);
    assert.equal(fiwind?.count, 1);
  });
});


describe("Cubierto fuera de neta", () => {
  it("isExpenseRow excludes isPayment Cubierto utilities", () => {
    assert.equal(
      isExpenseRow({
        isPayment: true,
        descriptionNormalized: "EDESUR FACTURA",
      }),
      false,
    );
  });

  it("isCubiertoUtilityRow matches utility isPayment, not card payments or reintegro", () => {
    assert.equal(
      isCubiertoUtilityRow(
        {
          isPayment: true,
          descriptionNormalized: "EDESUR",
          categoryId: "cat-luz",
        },
        cats,
        NO_PAYEES,
      ),
      true,
    );
    assert.equal(
      isCubiertoUtilityRow(
        {
          isPayment: true,
          descriptionNormalized: "SU PAGO EN PESOS",
          categoryId: null,
        },
        cats,
        NO_PAYEES,
      ),
      false,
    );
    assert.equal(
      isCubiertoUtilityRow(
        {
          isPayment: true,
          descriptionNormalized: "Ana Lopez Gomez Diaz",
          categoryId: "cat-luz",
        },
        cats,
        PAYEES,
      ),
      false,
      "roommate reintegro must not count as Cubierto even if miscategorized",
    );
    assert.equal(
      isCubiertoUtilityRow(
        {
          isPayment: false,
          descriptionNormalized: "EDESUR",
          categoryId: "cat-luz",
        },
        cats,
        NO_PAYEES,
      ),
      false,
    );
  });

  it("aggregateCubiertoByPeriod sums ARS/USD and buildMonth exposes cubierto", () => {
    const rows: ExpenseTx[] = [
      tx({
        date: "2026-09-01",
        descriptionNormalized: "EDESUR",
        amountArs: 15000,
        isPayment: true,
        categoryId: "cat-luz",
      }),
      tx({
        date: "2026-09-02",
        descriptionNormalized: "FIBRA",
        amountUsd: 40,
        isPayment: true,
        categoryId: "cat-internet",
      }),
      tx({
        date: "2026-09-03",
        descriptionNormalized: "DIA",
        amountArs: 5000,
        categoryId: "cat-super",
      }),
    ];
    const cubiertos = rows.filter((r) => isCubiertoUtilityRow(r, cats, NO_PAYEES));
    const byP = aggregateCubiertoByPeriod(cubiertos);
    const sep = byP.get("2026-09");
    assert.equal(sep?.amountArs, 15000);
    assert.equal(sep?.amountUsd, 40);
    assert.equal(sep?.count, 2);

    const expenses = rows.filter(isExpenseRow);
    const { byPeriod } = aggregateByPeriod(expenses, cats);
    const month = buildMonthFromAgg(
      "2026-09",
      byPeriod.get("2026-09"),
      { period: "2026-09", buy: 1400, asOf: "2026-09-01", source: "oficial_compra" },
      sep,
    );
    assert.equal(month.totalArs, 5000, "neta excludes Cubierto ARS");
    assert.equal(month.cubierto.count, 2);
    assert.equal(month.cubierto.amountArs, 15000);
    assert.equal(month.cubierto.amountUsd, 40);
    assert.equal(month.cubierto.amountArsFromUsd, 56000);
    assert.equal(month.cubierto.amountArsCombined, 71000);
  });

  it("mergePeriodLists includes Cubierto-only months", () => {
    assert.deepEqual(mergePeriodLists(["2026-08"], ["2026-09", "2026-08"]), [
      "2026-09",
      "2026-08",
    ]);
  });

  it("visibleCubiertoRows respects personal privacy", () => {
    const rows = [
      tx({
        date: "2026-09-01",
        descriptionNormalized: "EDESUR",
        amountArs: 1,
        isPayment: true,
        categoryId: "cat-luz",
        paidByUserId: "user-1",
        ownership: "personal",
      }),
      tx({
        date: "2026-09-01",
        descriptionNormalized: "AYSA",
        amountArs: 2,
        isPayment: true,
        categoryId: "cat-luz",
        paidByUserId: "user-2",
        ownership: "personal",
      }),
    ];
    const vis = visibleCubiertoRows(rows, "user-1", cats, NO_PAYEES);
    assert.deepEqual(
      vis.map((r) => r.descriptionNormalized),
      ["EDESUR"],
    );
  });
});
