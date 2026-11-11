import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pairLogicalDuplicates, type LogicalDupRow } from "./logical-dups";

function row(partial: LogicalDupRow): LogicalDupRow {
  return partial;
}

function dropped(rows: readonly LogicalDupRow[]): string[] {
  return [...pairLogicalDuplicates(rows, new Set(rows.map((item) => item.householdId)))].sort();
}

describe("pairLogicalDuplicates", () => {
  it("keeps the named BBVA spend and drops the Fiwind copy", () => {
    const drop = dropped([
      row({
        id: "bbva",
        householdId: "hh",
        date: "2026-08-18",
        bank: "BBVA",
        source: "bbva_xlsx",
        description: "DIA TIENDA 536",
        amountArs: "1200",
        createdAt: 2,
      }),
      row({
        id: "fiwind",
        householdId: "hh",
        date: "2026-08-18",
        bank: "Fiwind",
        source: "xlsx_import",
        description: "COMPRA DIA",
        amountArs: "1200",
        createdAt: 1,
      }),
    ]);
    assert.deepEqual(drop, ["fiwind"]);
  });

  it("drops a Personal numeric against Invoice IOG Uber the same day", () => {
    const drop = dropped([
      row({
        id: "num",
        householdId: "personal",
        date: "2026-08-31",
        bank: "Fiwind",
        source: "xlsx_import",
        description: "5971",
        amountArs: "5971",
      }),
      row({
        id: "uber",
        householdId: "casita",
        date: "2026-08-31",
        bank: "BBVA",
        source: "invoice_iog",
        description: "Uber",
        amountArs: "5971",
      }),
    ]);
    assert.deepEqual(drop, ["num"]);
  });

  it("drops a same-day numeric Fiwind when a named twin exists in another household", () => {
    const drop = dropped([
      row({
        id: "num",
        householdId: "hh-a",
        date: "2026-08-18",
        bank: "Fiwind",
        source: "fiwind",
        description: "80",
        amountArs: "80",
      }),
      row({
        id: "named",
        householdId: "hh-b",
        date: "2026-08-18",
        bank: "BBVA",
        source: "bbva_import",
        description: "Cafe Martinez",
        amountArs: "80",
      }),
    ]);
    assert.deepEqual(drop, ["num"]);
  });

  it("does not pair different shops on the same amount", () => {
    const drop = dropped([
      row({
        id: "cafe",
        householdId: "hh",
        date: "2026-08-18",
        bank: "BBVA",
        source: "bbva_xlsx",
        description: "CAFE MARTINEZ",
        amountArs: "5000",
      }),
      row({
        id: "super",
        householdId: "hh",
        date: "2026-08-18",
        bank: "Fiwind",
        source: "xlsx_import",
        description: "DIA TIENDA",
        amountArs: "5000",
      }),
    ]);
    assert.deepEqual(drop, []);
  });

  it("does not pair a spend with an opposite-sign amount", () => {
    const drop = dropped([
      row({
        id: "out",
        householdId: "hh",
        date: "2026-08-18",
        bank: "BBVA",
        source: "bbva_xlsx",
        description: "DIA",
        amountArs: "100",
      }),
      row({
        id: "in",
        householdId: "hh",
        date: "2026-08-18",
        bank: "Fiwind",
        source: "xlsx_import",
        description: "DIA",
        amountArs: "-100",
      }),
    ]);
    assert.deepEqual(drop, []);
  });

  it("does not collapse two transfer rows of the same amount", () => {
    const drop = dropped([
      row({
        id: "same-a",
        householdId: "hh",
        date: "2026-08-20",
        bank: "BBVA",
        source: "bbva_xlsx",
        description: "TRANSFERENCIA",
        amountArs: "254",
      }),
      row({
        id: "same-b",
        householdId: "hh",
        date: "2026-08-20",
        bank: "GALICIA",
        source: "xlsx_import",
        description: "TRANSFERENCIA",
        amountArs: "254",
      }),
    ]);
    assert.deepEqual(drop, []);
  });

  it("drops Pago a 0002 against a named spend of the same day and amount", () => {
    const drop = dropped([
      row({
        id: "carrefour",
        householdId: "hh",
        date: "2026-08-20",
        bank: "BBVA",
        source: "bbva_xlsx",
        description: "Pago a Carrefour",
        amountArs: "23781.85",
      }),
      row({
        id: "pago-0002",
        householdId: "hh",
        date: "2026-08-20",
        bank: "BBVA",
        source: "bbva_import",
        description: "Pago a 0002",
        amountArs: "23781.85",
      }),
      row({
        id: "fiwind-num",
        householdId: "hh",
        date: "2026-08-20",
        bank: "Fiwind",
        source: "xlsx_import",
        description: "23781.85",
        amountArs: "23781.85",
      }),
    ]);
    assert.deepEqual(drop, ["fiwind-num", "pago-0002"]);
  });

  it("pairs Mercado Libre across alert and statement wording", () => {
    const drop = dropped([
      row({
        id: "alert",
        householdId: "hh",
        date: "2026-03-02",
        bank: "BBVA",
        source: "bbva_import",
        description: "COMPRA MERCADOLIBRE*MLA",
        amountArs: "18402",
      }),
      row({
        id: "fiwind",
        householdId: "hh",
        date: "2026-03-02",
        bank: "Fiwind",
        source: "xlsx_import",
        description: "Mercado Libre",
        amountArs: "18402",
      }),
    ]);
    assert.deepEqual(drop, ["fiwind"]);
  });
});
