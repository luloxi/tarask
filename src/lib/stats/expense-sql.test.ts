import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { isBankAccountingEntry, isInternalTransferDescription } from "../bbva/bank-entries";
import { isPeriodDebtSource } from "../import/source";
import { isConsumosHiddenPayment } from "../reintegro-hogar";
import { isExpenseRow } from "./monthly-expenses";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FIWIND_ECHO_CANDIDATE_SQL,
  loadFiwindEchoIds,
  pairFiwindEchoes,
  type FiwindEchoRow,
} from "../../../worker/fiwind-dups";
import { ARS_EXPR, USD_EXPR, consumosVisibleSql, expenseSql, EXPENSE_SQL } from "../../../worker/sql";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * The lite dashboard classifies in SQL. These rows are the phrases that
 * disagreed with `isExpenseRow` on a production backup (wallet transfers,
 * retiros) plus spends that must stay.
 *
 * Numeric-only descriptions are a documented SQL difference: legacy
 * `isBankAccountingEntry` treats every amount-only tipo as accounting, while
 * SQL counts them unless `pairFiwindEchoes` drops that id.
 * Exact "Transferencia inmediata" and a bare "TRANSFERENCIA" still match the
 * Fiwind wallet detector, so JS drops them while SQL counts them. A longer
 * BBVA line that only contains that phrase is not an own-account move: both
 * sides count it, and it stays on Consumos.
 */
const ROWS: Array<{
  id: string;
  description: string;
  source?: string;
  isPayment?: number;
  isCredit?: number;
  linked?: string | null;
  bank?: string | null;
  date?: string;
  amountArs?: string | null;
  householdId?: string;
  expense: boolean;
  /** When set, SQL is allowed to disagree with `isExpenseRow`. */
  sqlExpense?: boolean;
}> = [
  { id: "n1", description: "391048.03", bank: "Fiwind", date: "2026-08-01", amountArs: "391048.03", expense: false, sqlExpense: true },
  { id: "n2", description: "18.07", bank: "Fiwind", date: "2026-08-02", amountArs: "18.07", expense: false, sqlExpense: true },
  { id: "n3", description: "16000", bank: "Fiwind", date: "2026-08-03", amountArs: "16000.00", expense: false, sqlExpense: true },
  { id: "echo", description: "15420.50", bank: "Fiwind", date: "2026-08-18", amountArs: "15420.50", expense: false, sqlExpense: false },
  { id: "twin", description: "Pago a DIA", bank: "Fiwind", date: "2026-08-18", amountArs: "15420.50", expense: true },
  { id: "far", description: "59900", bank: "Fiwind", date: "2026-08-10", amountArs: "59900.00", expense: false, sqlExpense: true },
  { id: "w1", description: "TRANSFERENCIA ARS", expense: false },
  { id: "w2", description: "TRANSFERENCIA USDC", expense: false },
  { id: "w3", description: "Retiro", expense: false },
  { id: "w4", description: "Compra KO", expense: false },
  { id: "w5", description: "Venta KO", expense: false },
  { id: "w6", description: "Compra USDC", expense: false },
  { id: "w7", description: "Deposito salario", expense: false },
  { id: "w8", description: "Conversion USDC ARS", expense: false },
  { id: "w9", description: "Rendimiento diario", expense: false },
  { id: "w10", description: "Ganancia KO", expense: false },
  { id: "w11", description: "De una cuenta tuya", expense: false },
  { id: "w12", description: "TRANSF. POR PESIFICACION.", expense: false },
  { id: "w13", description: "CREDITOS VS EN USD-INTER-", expense: false },
  { id: "w14", description: "CR TBE INM COE", expense: false },
  { id: "w15", description: "Transferencia inmediata", expense: false, sqlExpense: true },
  { id: "w16", description: "TRANSFERENCIA", expense: false, sqlExpense: true },
  { id: "s1", description: "COMPRA SUPER ARS", expense: true },
  { id: "s2", description: "Pago a DIA", date: "2026-08-04", amountArs: "10.00", expense: true },
  { id: "s3", description: "TRANSFERENCIA A JUAN", expense: true },
  { id: "s4", description: "MERPAGO*TEMBICI", expense: true },
  { id: "s5", description: "TRANSF CREDITO Nro:215857", expense: false },
  { id: "bbnk", description: "TRANSFERENCIA BBNK 306333.80", expense: false },
  {
    id: "cliente",
    description: "BBVA CA$ TRANSF. CLIENTE CTA. CAP093 380138 5 Nro:00010008",
    expense: false,
  },
  { id: "s6", description: "COMPRA MERCADOLIBRE", expense: true },
  { id: "s7", description: "Retiro a Ana", expense: true },
  { id: "s8", description: "SU PAGO EN PESOS", isPayment: 1, expense: false },
  { id: "s9", description: "Resumen", source: "bbva_pdf", expense: false },
  { id: "s10", description: "Luz hogar", linked: "other", source: "csv_import", expense: false },
  { id: "s11", description: "Uber", linked: "x", source: "invoice_iog", expense: true },
  {
    id: "k60",
    description:
      "outgoing transfer (payee unknown) | transferencia inmediata | 100 - banca online | payee not in export",
    bank: "BBVA",
    date: "2026-08-20",
    amountArs: "60000",
    isPayment: 0,
    isCredit: 0,
    expense: true,
  },
];

function expected(row: (typeof ROWS)[number]): boolean {
  return isExpenseRow({
    isPayment: Boolean(row.isPayment),
    isCredit: Boolean(row.isCredit),
    descriptionNormalized: row.description,
    source: row.source ?? "bbva_import",
    linkedTransactionId: row.linked ?? null,
  });
}

describe("EXPENSE_SQL matches isExpenseRow on the phrases that drifted", () => {
  it("agrees row by row, except documented SQL differences", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE households (id text PRIMARY KEY);
      CREATE TABLE transactions (
        id text,
        household_id text,
        date text,
        description_normalized text,
        source text,
        is_payment integer,
        is_credit integer,
        linked_transaction_id text,
        bank text,
        amount_ars text,
        amount_usd text
      );
    `);
    const insert = db.prepare(
      `INSERT INTO transactions (
         id, household_id, date, description_normalized, source, is_payment, is_credit,
         linked_transaction_id, bank, amount_ars, amount_usd
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of ROWS) {
      insert.run(
        row.id,
        row.householdId ?? "hh",
        row.date ?? "2026-08-18",
        row.description,
        row.source ?? "bbva_import",
        row.isPayment ?? 0,
        row.isCredit ?? 0,
        row.linked ?? null,
        row.bank ?? null,
        row.amountArs ?? null,
        null,
      );
    }
    const drop = pairFiwindEchoes(
      ROWS.map((row) => ({
        id: row.id,
        householdId: row.householdId ?? "hh",
        date: row.date ?? "2026-08-18",
        bank: row.bank ?? null,
        description: row.description,
        amountArs: row.amountArs ?? null,
        amountUsd: null,
      })),
      new Set(ROWS.map((row) => row.householdId ?? "hh")),
    );
    const matched = db
      .prepare(
        `SELECT id FROM transactions t WHERE ${expenseSql(drop)}`,
      )
      .all() as Array<{ id: string }>;
    const kept = new Set(matched.map((row) => row.id));
    for (const row of ROWS) {
      const legacy = expected(row);
      assert.equal(legacy, row.expense, `${row.description} fixture`);
      const sqlKept = kept.has(row.id);
      if (row.sqlExpense != null) {
        assert.equal(isBankAccountingEntry(row.description), true, `${row.description} legacy accounting`);
        assert.equal(legacy, false, `${row.description} legacy excludes`);
        assert.equal(sqlKept, row.sqlExpense, `${row.description} sql`);
        if (row.sqlExpense) {
          assert.notEqual(sqlKept, legacy, `${row.description} sql keeps what legacy drops`);
        }
      } else {
        assert.equal(sqlKept, legacy, row.description);
      }
    }
    assert.equal(kept.has("echo"), false);
    assert.equal(kept.has("twin"), true);
    assert.equal(kept.has("s1"), true);
    assert.equal(kept.has("w4"), false);
    assert.equal(kept.has("w1"), false);
    assert.equal(kept.has("w15"), true);
    assert.equal(kept.has("w16"), true);
    assert.equal(kept.has("s3"), true);
    assert.equal(kept.has("k60"), true);
    assert.equal(kept.has("bbnk"), false);
    assert.equal(kept.has("cliente"), false);
  });
});

type EchoRow = {
  id: string;
  description: string;
  householdId?: string;
  date?: string;
  bank?: string | null;
  amountArs?: string | null;
  amountUsd?: string | null;
  isPayment?: number;
  isCredit?: number;
  source?: string;
};

function echoRows(rows: EchoRow[]): FiwindEchoRow[] {
  return rows.map((row) => ({
    id: row.id,
    householdId: row.householdId ?? "hh",
    date: row.date ?? "2026-08-18",
    bank: row.bank ?? null,
    description: row.description,
    amountArs: row.amountArs ?? null,
    amountUsd: row.amountUsd ?? null,
    isPayment: row.isPayment,
    isCredit: row.isCredit,
  }));
}

function keptExpenses(rows: EchoRow[], userHouseholds?: ReadonlySet<string>): Set<string> {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE households (id text PRIMARY KEY);
    CREATE TABLE transactions (
      id text,
      household_id text,
      date text,
      description_normalized text,
      source text,
      is_payment integer,
      is_credit integer,
      linked_transaction_id text,
      bank text,
      amount_ars text,
      amount_usd text
    );
  `);
  const insertHousehold = db.prepare(`INSERT OR IGNORE INTO households (id) VALUES (?)`);
  const insert = db.prepare(
    `INSERT INTO transactions (
       id, household_id, date, description_normalized, source, is_payment, is_credit,
       linked_transaction_id, bank, amount_ars, amount_usd
     ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
  );
  for (const row of rows) {
    const householdId = row.householdId ?? "hh";
    insertHousehold.run(householdId);
    insert.run(
      row.id,
      householdId,
      row.date ?? "2026-08-18",
      row.description,
      row.source ?? "bbva_import",
      row.isPayment ?? 0,
      row.isCredit ?? 0,
      row.bank ?? null,
      row.amountArs ?? null,
      row.amountUsd ?? null,
    );
  }
  const candidates = echoRows(rows);
  const homes = userHouseholds ?? new Set(candidates.map((row) => row.householdId));
  const drop = pairFiwindEchoes(candidates, homes);
  const matched = db.prepare(`SELECT id FROM transactions t WHERE ${expenseSql(drop)}`).all() as Array<{
    id: string;
  }>;
  return new Set(matched.map((row) => row.id));
}

describe("Ockham Fiwind numeric echoes", () => {
  it("drops a same-day named expense of the same amount", () => {
    const kept = keptExpenses([
      { id: "num", description: "15420.50", bank: "Fiwind", date: "2026-08-18", amountArs: "15420.50" },
      { id: "named", description: "Pago a DIA", bank: "BBVA", date: "2026-08-18", amountArs: "15420.50", source: "manual" },
    ]);
    assert.equal(kept.has("num"), false);
    assert.equal(kept.has("named"), true);
  });

  it("drops a named expense one day away and keeps one three days away", () => {
    const near = keptExpenses([
      { id: "num", description: "100.00", bank: "Fiwind", date: "2026-08-10", amountArs: "100.00" },
      { id: "named", description: "Kiosco", date: "2026-08-11", amountArs: "100.00" },
    ]);
    assert.equal(near.has("num"), false);
    assert.equal(near.has("named"), true);
    const edge = keptExpenses([
      { id: "num", description: "101.00", bank: "Fiwind", date: "2026-08-10", amountArs: "101.00" },
      { id: "named", description: "Kiosco", date: "2026-08-08", amountArs: "101.00" },
    ]);
    assert.equal(edge.has("num"), false);
    const far = keptExpenses([
      { id: "num", description: "102.00", bank: "Fiwind", date: "2026-08-10", amountArs: "102.00" },
      { id: "named", description: "Kiosco", date: "2026-08-13", amountArs: "102.00" },
    ]);
    assert.equal(far.has("num"), true);
    assert.equal(far.has("named"), true);
  });

  it("drops a same-day same-amount named row from another household", () => {
    const kept = keptExpenses([
      { id: "num", description: "80.00", bank: "Fiwind", date: "2026-08-18", amountArs: "80.00", householdId: "hh-a" },
      { id: "named", description: "Pago a DIA", date: "2026-08-18", amountArs: "80.00", householdId: "hh-b" },
    ]);
    assert.equal(kept.has("num"), false);
    assert.equal(kept.has("named"), true);
  });

  it("keeps the numeric row when another household's named row is one day away", () => {
    const kept = keptExpenses([
      { id: "num", description: "81.00", bank: "Fiwind", date: "2026-08-18", amountArs: "81.00", householdId: "hh-a" },
      { id: "named", description: "Kiosco", date: "2026-08-19", amountArs: "81.00", householdId: "hh-b" },
    ]);
    assert.equal(kept.has("num"), true);
    assert.equal(kept.has("named"), true);
  });

  it("keeps the numeric row when another household's same-day amount differs", () => {
    const kept = keptExpenses([
      { id: "num", description: "82.00", bank: "Fiwind", date: "2026-08-18", amountArs: "82.00", householdId: "hh-a" },
      { id: "named", description: "Kiosco", date: "2026-08-18", amountArs: "90.00", householdId: "hh-b" },
    ]);
    assert.equal(kept.has("num"), true);
    assert.equal(kept.has("named"), true);
  });

  it("pairs one cross-household named row with one of two numeric rows, ordered by id", () => {
    const kept = keptExpenses([
      { id: "n1", description: "83.00", bank: "Fiwind", date: "2026-08-18", amountArs: "83.00", householdId: "hh-a" },
      { id: "n2", description: "83.00", bank: "Fiwind", date: "2026-08-18", amountArs: "83.00", householdId: "hh-a" },
      { id: "named", description: "Cafe", date: "2026-08-18", amountArs: "83.00", householdId: "hh-b" },
    ]);
    assert.equal(kept.has("n1"), false);
    assert.equal(kept.has("n2"), true);
    assert.equal(kept.has("named"), true);
    assert.equal([...kept].filter((id) => id === "n1" || id === "n2").length, 1);
  });

  it("uses a same-household twin before a cross-household twin", () => {
    const both = keptExpenses([
      { id: "n1", description: "84.00", bank: "Fiwind", date: "2026-08-18", amountArs: "84.00", householdId: "hh-a" },
      { id: "n2", description: "84.00", bank: "Fiwind", date: "2026-08-18", amountArs: "84.00", householdId: "hh-a" },
      { id: "same", description: "Cafe", date: "2026-08-18", amountArs: "84.00", householdId: "hh-a" },
      { id: "cross", description: "Kiosco", date: "2026-08-18", amountArs: "84.00", householdId: "hh-b" },
    ]);
    assert.equal(both.has("n1"), false);
    assert.equal(both.has("n2"), false);
    assert.equal(both.has("same"), true);
    assert.equal(both.has("cross"), true);

    // a-num is paired at home, so the cross twin stays free for c-num.
    const shared = keptExpenses([
      { id: "a-num", description: "85.00", bank: "Fiwind", date: "2026-08-18", amountArs: "85.00", householdId: "hh-a" },
      { id: "a-named", description: "Cafe", date: "2026-08-18", amountArs: "85.00", householdId: "hh-a" },
      { id: "b-named", description: "Kiosco", date: "2026-08-18", amountArs: "85.00", householdId: "hh-b" },
      { id: "c-num", description: "85.00", bank: "Fiwind", date: "2026-08-18", amountArs: "85.00", householdId: "hh-c" },
    ]);
    assert.equal(shared.has("a-num"), false);
    assert.equal(shared.has("c-num"), false);
    assert.equal(shared.has("a-named"), true);
    assert.equal(shared.has("b-named"), true);
  });

  it("shares one cross-household named row across households by id", () => {
    const kept = keptExpenses([
      { id: "a-num", description: "86.00", bank: "Fiwind", date: "2026-08-18", amountArs: "86.00", householdId: "hh-a" },
      { id: "b-num", description: "86.00", bank: "Fiwind", date: "2026-08-18", amountArs: "86.00", householdId: "hh-b" },
      { id: "c-named", description: "Cafe", date: "2026-08-18", amountArs: "86.00", householdId: "hh-c" },
    ]);
    assert.equal(kept.has("a-num"), false);
    assert.equal(kept.has("b-num"), true);
    assert.equal(kept.has("c-named"), true);
  });

  it("does not reuse a named row already paired inside its own household", () => {
    const kept = keptExpenses([
      { id: "a-num", description: "87.00", bank: "Fiwind", date: "2026-08-18", amountArs: "87.00", householdId: "hh-a" },
      { id: "m-num", description: "87.00", bank: "Fiwind", date: "2026-08-18", amountArs: "87.00", householdId: "hh-b" },
      { id: "m-named", description: "Cafe", date: "2026-08-18", amountArs: "87.00", householdId: "hh-b" },
    ]);
    assert.equal(kept.has("m-num"), false);
    assert.equal(kept.has("a-num"), true);
    assert.equal(kept.has("m-named"), true);
  });

  it("payment or credit named row in another household still cancels one numeric row", () => {
    const kept = keptExpenses([
      { id: "num-pay", description: "88.00", bank: "Fiwind", date: "2026-08-18", amountArs: "88.00", householdId: "hh-a" },
      { id: "pay", description: "Alquiler", date: "2026-08-18", amountArs: "88.00", isPayment: 1, householdId: "hh-b" },
      { id: "num-cr", description: "89.00", bank: "Fiwind", date: "2026-08-18", amountArs: "89.00", householdId: "hh-a" },
      { id: "cr", description: "Devolucion super", date: "2026-08-18", amountArs: "89.00", isCredit: 1, householdId: "hh-b" },
    ]);
    assert.equal(kept.has("num-pay"), false);
    assert.equal(kept.has("pay"), false);
    assert.equal(kept.has("num-cr"), false);
    assert.equal(kept.has("cr"), false);
  });

  it("payment/credit named twin does cancel (1:1)", () => {
    const kept = keptExpenses([
      { id: "num-pay", description: "40.00", bank: "Fiwind", date: "2026-08-18", amountArs: "40.00" },
      { id: "num-pay-2", description: "40.00", bank: "Fiwind", date: "2026-08-18", amountArs: "40.00" },
      { id: "pay", description: "Alquiler", date: "2026-08-18", amountArs: "40.00", isPayment: 1 },
      { id: "num-cr", description: "41.00", bank: "Fiwind", date: "2026-08-18", amountArs: "41.00" },
      { id: "num-cr-2", description: "41.00", bank: "Fiwind", date: "2026-08-18", amountArs: "41.00" },
      { id: "cr", description: "Devolucion super", date: "2026-08-18", amountArs: "41.00", isCredit: 1 },
    ]);
    assert.equal(kept.has("num-pay"), false);
    assert.equal(kept.has("num-pay-2"), true);
    assert.equal(kept.has("pay"), false);
    assert.equal(kept.has("num-cr"), false);
    assert.equal(kept.has("num-cr-2"), true);
    assert.equal(kept.has("cr"), false);
  });

  it("pairs one named twin with one of two numeric rows, ordered by id", () => {
    const kept = keptExpenses([
      { id: "n1", description: "50.00", bank: "Fiwind", date: "2026-08-18", amountArs: "50.00" },
      { id: "n2", description: "50.00", bank: "Fiwind", date: "2026-08-18", amountArs: "50.00" },
      { id: "named", description: "Cafe", date: "2026-08-18", amountArs: "50.00" },
    ]);
    assert.equal(kept.has("n1"), false);
    assert.equal(kept.has("n2"), true);
    assert.equal(kept.has("named"), true);
    assert.equal([...kept].filter((id) => id === "n1" || id === "n2").length, 1);
  });

  it("drops both numeric rows when two named twins exist", () => {
    const kept = keptExpenses([
      { id: "n1", description: "70.00", bank: "Fiwind", date: "2026-08-18", amountArs: "70.00" },
      { id: "n2", description: "70.00", bank: "Fiwind", date: "2026-08-18", amountArs: "70.00" },
      { id: "a", description: "Uno", date: "2026-08-18", amountArs: "70.00" },
      { id: "b", description: "Dos", date: "2026-08-18", amountArs: "70.00" },
    ]);
    assert.equal(kept.has("n1"), false);
    assert.equal(kept.has("n2"), false);
    assert.equal(kept.has("a"), true);
    assert.equal(kept.has("b"), true);
  });

  it("keeps both numeric rows when no named twin exists", () => {
    const kept = keptExpenses([
      { id: "n1", description: "9.00", bank: "Fiwind", date: "2026-08-18", amountArs: "9.00" },
      { id: "n2", description: "9.00", bank: "Fiwind", date: "2026-08-18", amountArs: "9.00" },
    ]);
    assert.equal(kept.has("n1"), true);
    assert.equal(kept.has("n2"), true);
  });

  it("matches ARS within 0.01 and USD within 0.005, and ignores a wider gap", () => {
    const arsNear = keptExpenses([
      { id: "num", description: "200.00", bank: "Fiwind", date: "2026-08-18", amountArs: "200.00" },
      { id: "named", description: "Near", date: "2026-08-18", amountArs: "200.004" },
    ]);
    assert.equal(arsNear.has("num"), false);
    const arsFar = keptExpenses([
      { id: "num", description: "201.00", bank: "Fiwind", date: "2026-08-18", amountArs: "201.00" },
      { id: "named", description: "Far", date: "2026-08-18", amountArs: "201.02" },
    ]);
    assert.equal(arsFar.has("num"), true);
    const usdNear = keptExpenses([
      { id: "num", description: "8.00", bank: "Fiwind", date: "2026-08-18", amountArs: "0", amountUsd: "8.00" },
      { id: "named", description: "USD shop", bank: "BBVA", date: "2026-08-18", amountUsd: "8.004", source: "manual" },
    ]);
    assert.equal(usdNear.has("num"), false);
    assert.equal(usdNear.has("named"), true);
    const usdFar = keptExpenses([
      { id: "num", description: "8.50", bank: "Fiwind", date: "2026-08-18", amountUsd: "8.50" },
      { id: "named", description: "USD far", date: "2026-08-18", amountUsd: "8.52" },
    ]);
    assert.equal(usdFar.has("num"), true);
    const usdOnly = keptExpenses([
      { id: "num", description: "12.50", bank: "Fiwind", date: "2026-08-18", amountArs: null, amountUsd: "12.50" },
      { id: "named", description: "Spotify", date: "2026-08-18", amountArs: "999.00", amountUsd: "12.50" },
    ]);
    assert.equal(usdOnly.has("num"), false);
  });

  it("prefers a same-day named twin over an earlier numeric in the window", () => {
    const kept = keptExpenses([
      { id: "early", description: "100.00", bank: "Fiwind", date: "2026-08-01", amountArs: "100.00" },
      { id: "later", description: "100.00", bank: "Fiwind", date: "2026-08-02", amountArs: "100.00" },
      { id: "named", description: "Pago a DIA", bank: "BBVA", date: "2026-08-02", amountArs: "100.00", source: "csv_import" },
    ]);
    assert.equal(kept.has("early"), true);
    assert.equal(kept.has("later"), false);
    assert.equal(kept.has("named"), true);
  });

  it("does not treat a numeric row from another bank as a Fiwind echo", () => {
    const kept = keptExpenses([
      { id: "num", description: "60.00", bank: "BBVA", date: "2026-08-18", amountArs: "60.00" },
      { id: "named", description: "Pago a DIA", date: "2026-08-18", amountArs: "60.00" },
    ]);
    assert.equal(kept.has("num"), true);
    assert.equal(kept.has("named"), true);
  });

  it("drops only B's numeric in the household A/B case and the total keeps A's", () => {
    const rows: EchoRow[] = [
      { id: "a-num", description: "100", bank: "Fiwind", date: "2026-08-17", amountArs: "100", householdId: "hh-a" },
      { id: "a-named", description: "Cafe", date: "2026-08-18", amountArs: "100", householdId: "hh-a" },
      { id: "b-num", description: "100", bank: "Fiwind", date: "2026-08-18", amountArs: "100", householdId: "hh-b" },
    ];
    const kept = keptExpenses(rows);
    assert.equal(kept.has("a-num"), true);
    assert.equal(kept.has("b-num"), false);
    assert.equal(kept.has("a-named"), true);
    assert.equal([...kept].filter((id) => id === "a-num" || id === "b-num").length, 1);
    const total = expenseTotal(rows);
    assert.equal(Math.round(total.ars), 200);
  });

  it("does not pair 100 with -100 or a foreign household", () => {
    const signed = keptExpenses([
      { id: "num", description: "100", bank: "Fiwind", date: "2026-08-18", amountArs: "100" },
      { id: "named", description: "Cafe", date: "2026-08-18", amountArs: "-100" },
    ]);
    assert.equal(signed.has("num"), true);
    assert.equal(signed.has("named"), true);
    const foreign = keptExpenses(
      [
        { id: "num", description: "80", bank: "Fiwind", date: "2026-08-18", amountArs: "80", householdId: "hh-user" },
        { id: "named", description: "Cafe", date: "2026-08-18", amountArs: "80", householdId: "hh-other" },
      ],
      new Set(["hh-user"]),
    );
    assert.equal(foreign.has("num"), true);
    assert.equal(foreign.has("named"), true);
  });

  it("requires the numeric row's own currency", () => {
    const usdVsArs = keptExpenses([
      { id: "num", description: "10", bank: "Fiwind", date: "2026-08-18", amountArs: "1500", amountUsd: "10" },
      { id: "named", description: "Cafe", date: "2026-08-18", amountArs: "1500" },
    ]);
    assert.equal(usdVsArs.has("num"), true);
    const arsVsUsd = keptExpenses([
      { id: "num", description: "250", bank: "Fiwind", date: "2026-08-18", amountArs: "250" },
      { id: "named", description: "Cafe", date: "2026-08-18", amountArs: "999", amountUsd: "250" },
    ]);
    assert.equal(arsVsUsd.has("num"), true);
  });

  it("rejects ids that are not safe to inline and leaves an empty set unchanged", () => {
    assert.equal(expenseSql(), EXPENSE_SQL);
    assert.equal(expenseSql([]), EXPENSE_SQL);
    assert.equal(expenseSql(["bad id", "ab'cd", "x".repeat(65)]), EXPENSE_SQL);
    const sql = expenseSql(["b-id", "a-id", "nope!"]);
    assert.match(sql, /json_each\('\["a-id","b-id"\]'\)/);
    assert.equal(sql.includes("nope"), false);
    assert.equal(sql.includes("DROP"), false);
  });
});

function expenseTotal(rows: EchoRow[], userHouseholds?: ReadonlySet<string>): { ars: number; usd: number } {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE transactions (
      id text,
      household_id text,
      date text,
      description_normalized text,
      source text,
      is_payment integer,
      is_credit integer,
      linked_transaction_id text,
      bank text,
      amount_ars text,
      amount_usd text
    );
  `);
  const insert = db.prepare(
    `INSERT INTO transactions (
       id, household_id, date, description_normalized, source, is_payment, is_credit,
       linked_transaction_id, bank, amount_ars, amount_usd
     ) VALUES (?, ?, ?, ?, 'bbva_import', 0, 0, NULL, ?, ?, ?)`,
  );
  for (const row of rows) {
    insert.run(
      row.id,
      row.householdId ?? "hh",
      row.date ?? "2026-08-18",
      row.description,
      row.bank ?? null,
      row.amountArs ?? null,
      row.amountUsd ?? null,
    );
  }
  const candidates = echoRows(rows);
  const homes = userHouseholds ?? new Set(candidates.map((row) => row.householdId));
  const drop = pairFiwindEchoes(candidates, homes);
  const total = db
    .prepare(`SELECT SUM(${ARS_EXPR}) AS ars, SUM(${USD_EXPR}) AS usd FROM transactions t WHERE ${expenseSql(drop)}`)
    .get() as { ars: number | null; usd: number | null };
  return { ars: total.ars ?? 0, usd: total.usd ?? 0 };
}

describe("consumosVisibleSql matches the legacy list filter", () => {
  it("hides bank accounting that is not an internal transfer", () => {
    const rows: Array<{
      description: string;
      visible: boolean;
      /** Legacy list filter, when it no longer matches SQL visibility. */
      legacyVisible?: boolean;
      numeric?: boolean;
      isPayment?: number;
      isCredit?: number;
      slug?: string;
      source?: string;
      id?: string;
      bank?: string | null;
      date?: string;
      amountArs?: string | null;
    }> = [
      { description: "18.07", bank: "Fiwind", amountArs: "18.07", visible: true, numeric: true },
      { id: "echo-c", description: "15420.50", bank: "Fiwind", date: "2026-08-18", amountArs: "15420.50", visible: false },
      { id: "twin-c", description: "Pago a DIA", bank: "BBVA", date: "2026-08-18", amountArs: "15420.50", source: "manual", visible: true },
      { description: "TRANSF. POR PESIFICACION.", visible: false },
      { description: "CREDITOS VS EN USD-INTER-", visible: false },
      { description: "Retiro", visible: false },
      { description: "Compra KO", visible: false },
      { description: "TRANSFERENCIA ARS", visible: false },
      { description: "Transferencia inmediata", visible: true, legacyVisible: false },
      { description: "TRANSFERENCIA", visible: true, legacyVisible: false },
      { description: "COMPRA SUPER ARS", visible: true },
      { description: "TRANSFERENCIA A JUAN", visible: true },
      { description: "MERPAGO*TEMBICI", visible: true },
      { description: "CR TBE INM COE", visible: true },
      { description: "TRANSFERENCIA BBNK 306333.80", visible: true },
      {
        description: "BBVA CA$ TRANSF. CLIENTE CTA. CAP093 380138 5 Nro:00010008",
        visible: true,
      },
      { description: "De una cuenta tuya", isPayment: 1, visible: true },
      { description: "SU PAGO EN PESOS", isPayment: 1, visible: false },
      { description: "Luz hogar", isPayment: 1, slug: "luz", visible: true },
      { description: "Resumen", source: "bbva_pdf", visible: false },
      { description: "Devolución de MERPAGO*TEMBICI", isCredit: 1, visible: false },
      { description: "COMPRA MERCADOLIBRE", visible: true },
      {
        id: "k60",
        description:
          "outgoing transfer (payee unknown) | transferencia inmediata | 100 - banca online | payee not in export",
        bank: "BBVA",
        amountArs: "60000",
        isPayment: 0,
        isCredit: 0,
        visible: true,
      },
    ];
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE households (id text PRIMARY KEY);
      CREATE TABLE categories (id text, slug text);
      CREATE TABLE transactions (
        id text,
        household_id text,
        date text,
        description_normalized text,
        source text,
        is_payment integer,
        is_credit integer,
        category_id text,
        bank text,
        amount_ars text,
        amount_usd text,
        linked_transaction_id text
      );
      INSERT INTO categories (id, slug) VALUES ('luz', 'luz');
    `);
    const insert = db.prepare(
      `INSERT INTO transactions (
         id, household_id, date, description_normalized, source, is_payment, is_credit,
         category_id, bank, amount_ars
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of rows) {
      insert.run(
        row.id ?? row.description,
        "hh",
        row.date ?? "2026-08-18",
        row.description,
        row.source ?? "bbva_import",
        row.isPayment ?? 0,
        row.isCredit ?? 0,
        row.slug ?? null,
        row.bank ?? null,
        row.amountArs ?? null,
      );
      const slug = row.slug ?? null;
      const legacy =
        !isConsumosHiddenPayment(Boolean(row.isPayment), row.description, slug) &&
        !(
          row.isCredit &&
          slug !== "transferencia-interna" &&
          !isInternalTransferDescription(row.description)
        ) &&
        !(
          isBankAccountingEntry(row.description) &&
          slug !== "transferencia-interna" &&
          !isInternalTransferDescription(row.description)
        ) &&
        !isPeriodDebtSource(row.source ?? "bbva_import");
      if (row.legacyVisible != null) {
        assert.equal(legacy, row.legacyVisible, `${row.description} legacy`);
      } else if (row.numeric) {
        assert.equal(legacy, false, `${row.description} legacy still hides amount-only`);
        assert.equal(row.visible, true, `${row.description} sql keeps unpaired numeric visible`);
      } else {
        assert.equal(legacy, row.visible, `${row.description} legacy`);
      }
    }
    const drop = pairFiwindEchoes(
      rows.map((row) => ({
        id: row.id ?? row.description,
        householdId: "hh",
        date: row.date ?? "2026-08-18",
        bank: row.bank ?? null,
        description: row.description,
        amountArs: row.amountArs ?? null,
      })),
      new Set(["hh"]),
    );
    const matched = db
      .prepare(
        `SELECT t.description_normalized AS description
         FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id
         WHERE ${consumosVisibleSql(undefined, drop)}`,
      )
      .all() as Array<{ description: string }>;
    const kept = new Set(matched.map((row) => row.description));
    for (const row of rows) {
      assert.equal(kept.has(row.description), row.visible, row.description);
    }
    assert.equal(kept.has(
      "outgoing transfer (payee unknown) | transferencia inmediata | 100 - banca online | payee not in export",
    ), true);
  });
});

const SIXTY_K =
  "outgoing transfer (payee unknown) | transferencia inmediata | 100 - banca online | payee not in export";

describe("Fiwind echo loader on the migrated schema", () => {
  it("uses tx_household_date_idx and does not scan transactions", () => {
    const db = openMigrated();
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${FIWIND_ECHO_CANDIDATE_SQL}`).all("user-u") as Array<{
      detail: string;
    }>;
    const detail = plan.map((line) => line.detail).join("\n");
    assert.match(detail, /USING INDEX tx_household_date_idx/);
    assert.match(detail, /household_id=\? AND date=\?/);
    assert.doesNotMatch(detail, /SCAN (t|m|n|transactions)\b/);
  });

  it("drops the mirrored numerics and keeps the 60k expense on Consumos", async () => {
    const db = openMigrated();
    seedMembership(db);
    const fixture: Array<{
      id: string;
      householdId: string;
      date: string;
      description: string;
      bank: string;
      amountArs?: string | null;
      amountUsd?: string | null;
    }> = [
      { id: "num-mirror-1", householdId: "hh-home", date: "2026-08-10", description: "1500", bank: "Fiwind", amountArs: "1500" },
      { id: "named-mirror-1", householdId: "hh-home", date: "2026-08-10", description: "Almacen", bank: "BBVA", amountArs: "1500" },
      { id: "num-mirror-2", householdId: "hh-home", date: "2026-08-12", description: "2500.50", bank: "Fiwind", amountArs: "2500.50" },
      { id: "named-mirror-2", householdId: "hh-home", date: "2026-08-12", description: "Farmacia", bank: "BBVA", amountArs: "2500.50" },
      { id: "num-mirror-usd", householdId: "hh-home", date: "2026-08-14", description: "15.00", bank: "Fiwind", amountUsd: "15" },
      { id: "named-mirror-usd", householdId: "hh-home", date: "2026-08-14", description: "Streaming", bank: "BBVA", amountUsd: "15" },
      { id: "num-solo-1", householdId: "hh-home", date: "2026-08-11", description: "8800", bank: "Fiwind", amountArs: "8800" },
      { id: "num-solo-2", householdId: "hh-home", date: "2026-08-21", description: "42", bank: "Fiwind", amountArs: "42" },
      { id: "num-cents", householdId: "hh-home", date: "2026-08-15", description: "0.50", bank: "Fiwind", amountArs: "0.50" },
      { id: "num-cents-twin", householdId: "hh-home", date: "2026-08-16", description: "18.07", bank: "Fiwind", amountArs: "18.07" },
      { id: "named-cents", householdId: "hh-home", date: "2026-08-16", description: "Kiosco", bank: "BBVA", amountArs: "18.07" },
      { id: "num-cross", householdId: "hh-home", date: "2026-08-18", description: "3300", bank: "Fiwind", amountArs: "3300" },
      { id: "named-cross", householdId: "hh-shared", date: "2026-08-18", description: "Cafe", bank: "BBVA", amountArs: "3300" },
      { id: "num-foreign", householdId: "hh-home", date: "2026-08-19", description: "7700", bank: "Fiwind", amountArs: "7700" },
      { id: "named-foreign", householdId: "hh-foreign", date: "2026-08-19", description: "Cafe", bank: "BBVA", amountArs: "7700" },
      { id: "bbva-60k", householdId: "hh-home", date: "2026-08-20", description: SIXTY_K, bank: "BBVA", amountArs: "60000" },
    ];
    const insert = db.prepare(
      `INSERT INTO transactions (
         id, household_id, date, description_raw, description_normalized,
         amount_ars, amount_usd, is_payment, is_credit, external_fingerprint, source, bank
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 'bbva_import', ?)`,
    );
    for (const row of fixture) {
      insert.run(
        row.id,
        row.householdId,
        row.date,
        row.description,
        row.description,
        row.amountArs ?? null,
        row.amountUsd ?? null,
        `fp-${row.id}`,
        row.bank,
      );
    }
    const echoIds = await loadFiwindEchoIds(wrapDb(db), "user-u");
    assert.deepEqual(echoIds, [
      "num-cents-twin",
      "num-cross",
      "num-mirror-1",
      "num-mirror-2",
      "num-mirror-usd",
    ]);
    const totals = db
      .prepare(
        `SELECT COUNT(*) AS n, SUM(${ARS_EXPR}) AS ars, SUM(${USD_EXPR}) AS usd
         FROM transactions t
         WHERE t.household_id IN ('hh-home', 'hh-shared')
           AND ${expenseSql(echoIds)}`,
      )
      .get() as { n: number; ars: number; usd: number };
    assert.equal(totals.n, 10);
    assert.equal(Math.round(totals.ars * 100), 8_386_107);
    assert.equal(Math.round(totals.usd * 1000), 15_000);
    const visible = db
      .prepare(
        `SELECT t.id AS id
         FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id
         WHERE t.household_id IN ('hh-home', 'hh-shared')
           AND ${consumosVisibleSql(undefined, echoIds)}`,
      )
      .all() as Array<{ id: string }>;
    const shown = new Set(visible.map((row) => row.id));
    assert.equal(shown.has("bbva-60k"), true);
    assert.equal(shown.has("num-solo-1"), true);
    assert.equal(shown.has("num-cents"), true);
    assert.equal(shown.has("num-foreign"), true);
    assert.equal(shown.has("num-cross"), false);
    assert.equal(shown.has("num-mirror-1"), false);
    assert.equal(shown.size, 10);
  });
});

function openMigrated(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const file of ["0001_app.sql", "0002_auth.sql", "0003_serpix_sync.sql", "0004_card_closed.sql"]) {
    db.exec(readFileSync(join(root, "migrations", file), "utf8"));
  }
  return db;
}

function seedMembership(db: DatabaseSync) {
  db.prepare("INSERT INTO users (id, email, name) VALUES ('user-u', 'u@example.com', 'User U')").run();
  db.prepare("INSERT INTO users (id, email, name) VALUES ('user-v', 'v@example.com', 'User V')").run();
  db.prepare("INSERT INTO households (id, name, invite_code) VALUES ('hh-home', 'Home', 'codehome1')").run();
  db.prepare("INSERT INTO households (id, name, invite_code) VALUES ('hh-shared', 'Shared', 'codeshare')").run();
  db.prepare("INSERT INTO households (id, name, invite_code) VALUES ('hh-foreign', 'Foreign', 'codefore1')").run();
  db.prepare(
    "INSERT INTO household_members (household_id, user_id, role) VALUES ('hh-home', 'user-u', 'owner')",
  ).run();
  db.prepare(
    "INSERT INTO household_members (household_id, user_id, role) VALUES ('hh-shared', 'user-u', 'member')",
  ).run();
  db.prepare(
    "INSERT INTO household_members (household_id, user_id, role) VALUES ('hh-foreign', 'user-v', 'owner')",
  ).run();
}

function wrapDb(db: DatabaseSync) {
  return {
    prepare(sql: string) {
      let params: unknown[] = [];
      const stmt = {
        bind(...values: unknown[]) {
          params = values;
          return stmt;
        },
        async all<T>() {
          return { results: db.prepare(sql).all(...(params as never[])) as T[] };
        },
      };
      return stmt;
    },
  };
}
