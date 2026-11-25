import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { SessionUser } from "./auth";
import type { Env } from "./env";
import { primeFxForTests } from "./fx";
import { handleIncomeByMonth, handleSpendingByCategory, handleSpendingSeries, parseSpendWindowParam } from "./insights";
import {
  dateWindowSql,
  foldCombinedInternal,
  foldCombinedSpend,
  internalAsideQuery,
  spendingByCategoryCombinedQuery,
  spendingByCategoryQuery,
  spendingSeriesQuery,
} from "./insights-sql";
import { expenseSql } from "./sql";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const user: SessionUser = { id: "user-a", email: "a@example.com", name: "Ana", image: null };

function openDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const file of [
    "0001_app.sql",
    "0002_auth.sql",
    "0003_serpix_sync.sql",
    "0004_card_closed.sql",
    "0005_patrimonio_snapshots.sql",
    "0006_patrimonio_user_date.sql",
    "0007_perf_indexes.sql",
    "0008_tx_household_desc_idx.sql",
    "0009_balance_snapshots.sql",
  ]) {
    db.exec(readFileSync(join(root, "migrations", file), "utf8"));
  }
  return db;
}

function wrap(db: DatabaseSync): Env["DB"] {
  return {
    prepare(sql: string) {
      let params: unknown[] = [];
      const stmt = {
        bind(...values: unknown[]) {
          params = values;
          return stmt;
        },
        async all() {
          return { results: db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[] };
        },
        async first() {
          return (db.prepare(sql).get(...(params as never[])) as Record<string, unknown> | undefined) ?? null;
        },
        async run() {
          const info = db.prepare(sql).run(...(params as never[])) as { changes?: number };
          return { meta: { changes: Number(info.changes ?? 0) } };
        },
      };
      return stmt;
    },
    async batch() {
      return [];
    },
  } as Env["DB"];
}

function envFor(db: DatabaseSync): Env {
  return {
    DB: wrap(db),
    RECEIPTS: { put: async () => null, get: async () => null },
    AI: { toMarkdown: async () => null },
    ASSETS: { fetch: async () => new Response(null, { status: 404 }) },
  };
}

function seedHome(db: DatabaseSync) {
  db.prepare("INSERT INTO users (id, email, name) VALUES ('user-a', 'a@example.com', 'Ana')").run();
  db.prepare("INSERT INTO households (id, name, invite_code) VALUES ('h1', 'Personal', 'CODE0001')").run();
  db.prepare(
    "INSERT INTO household_members (household_id, user_id, role) VALUES ('h1', 'user-a', 'owner')",
  ).run();
  db.prepare(
    "INSERT INTO categories (id, slug, name, kind) VALUES ('cat-food', 'supermercado', 'Supermercado', 'expense')",
  ).run();
  db.prepare(
    "INSERT INTO categories (id, slug, name, kind) VALUES ('cat-move', 'transferencia-interna', 'Transferencia interna', 'payment')",
  ).run();
}

function insertTx(
  db: DatabaseSync,
  row: {
    id: string;
    date: string;
    desc: string;
    ars?: string | null;
    usd?: string | null;
    bank?: string | null;
    category?: string | null;
    credit?: number;
  },
) {
  db.prepare(
    `INSERT INTO transactions (
       id, household_id, date, description_raw, description_normalized,
       amount_ars, amount_usd, is_payment, is_credit, category_id, ownership,
       paid_by_user_id, external_fingerprint, source, bank
     ) VALUES (?, 'h1', ?, ?, ?, ?, ?, 0, ?, ?, 'personal', 'user-a', ?, 'manual', ?)`,
  ).run(
    row.id,
    row.date,
    row.desc,
    row.desc,
    row.ars ?? null,
    row.usd ?? null,
    row.credit ?? 0,
    row.category ?? "cat-food",
    `fp-${row.id}`,
    row.bank ?? "BBVA",
  );
}

describe("spending SQL", () => {
  it("keeps day 90, drops day 91, and never mixes ARS with USDT or USD", () => {
    const db = openDb();
    seedHome(db);
    insertTx(db, { id: "d91", date: "2026-03-16", desc: "LEJOS", ars: "5" });
    insertTx(db, { id: "d90", date: "2026-03-17", desc: "BORDE", ars: "8" });
    insertTx(db, { id: "hoy", date: "2026-06-15", desc: "HOY", ars: "2" });
    insertTx(db, { id: "man", date: "2026-06-16", desc: "MANIANA", ars: "9" });
    insertTx(db, { id: "usdt", date: "2026-06-01", desc: "PAGO A KIOSCO", usd: "10", bank: "Fiwind" });
    insertTx(db, { id: "usd", date: "2026-06-02", desc: "NETFLIX", usd: "4", bank: "BBVA" });
    insertTx(db, {
      id: "move",
      date: "2026-06-03",
      desc: "TRANSFERENCIA INTERNA",
      ars: "999",
      category: "cat-move",
    });

    const expense = expenseSql();
    const visibility = { sql: "t.paid_by_user_id = ?", binds: ["user-a"] };
    const ars = spendingByCategoryQuery({
      currency: "ARS",
      today: "2026-06-15",
      window: { kind: "days", days: 90 },
      householdId: "h1",
      expenseSql: expense,
      visibilitySql: visibility.sql,
      visibilityBinds: visibility.binds,
    });
    const arsRows = db.prepare(ars.sql).all(...(ars.params as never[])) as Array<{ category: string; total: number }>;
    assert.equal(arsRows.length, 1);
    assert.equal(arsRows[0]?.category, "Supermercado");
    assert.equal(Number(arsRows[0]?.total), 10);

    const usdt = spendingByCategoryQuery({
      currency: "USDT",
      today: "2026-06-15",
      window: { kind: "days", days: 90 },
      householdId: "h1",
      expenseSql: expense,
      visibilitySql: visibility.sql,
      visibilityBinds: visibility.binds,
    });
    const usdtRows = db.prepare(usdt.sql).all(...(usdt.params as never[])) as Array<{ total: number }>;
    assert.equal(Number(usdtRows[0]?.total), 10);

    const usd = spendingByCategoryQuery({
      currency: "USD",
      today: "2026-06-15",
      window: { kind: "days", days: 90 },
      householdId: "h1",
      expenseSql: expense,
      visibilitySql: visibility.sql,
      visibilityBinds: visibility.binds,
    });
    const usdRows = db.prepare(usd.sql).all(...(usd.params as never[])) as Array<{ total: number }>;
    assert.equal(Number(usdRows[0]?.total), 4);

    const aside = internalAsideQuery({
      currency: "ARS",
      today: "2026-06-15",
      window: { kind: "days", days: 90 },
      householdId: "h1",
      visibilitySql: visibility.sql,
      visibilityBinds: visibility.binds,
      internalIdsJson: "[]",
    });
    const asideRow = db.prepare(aside.sql).get(...(aside.params as never[])) as { total: number };
    assert.equal(Number(asideRow.total), 999);
  });

  it("does not count own-account BBNK / TRANSF CLIENTE as spend", () => {
    const db = openDb();
    seedHome(db);
    insertTx(db, { id: "cafe", date: "2026-06-10", desc: "CAFE", ars: "40" });
    insertTx(db, {
      id: "bbnk",
      date: "2026-06-11",
      desc: "TRANSFERENCIA BBNK 306333.80",
      ars: "306333.80",
      category: null,
    });
    insertTx(db, {
      id: "cliente",
      date: "2026-06-12",
      desc: "BBVA CA$ TRANSF. CLIENTE CTA. CAP093 380138 5 Nro:00010008",
      ars: "566000",
      category: "cat-food",
    });

    const expense = expenseSql();
    const visibility = { sql: "1 = 1", binds: [] as unknown[] };
    const ars = spendingByCategoryQuery({
      currency: "ARS",
      today: "2026-06-15",
      window: { kind: "days", days: 90 },
      householdId: "h1",
      expenseSql: expense,
      visibilitySql: visibility.sql,
      visibilityBinds: visibility.binds,
    });
    const arsRows = db.prepare(ars.sql).all(...(ars.params as never[])) as Array<{ category: string; total: number }>;
    assert.equal(arsRows.length, 1);
    assert.equal(arsRows[0]?.category, "Supermercado");
    assert.equal(Number(arsRows[0]?.total), 40);

    const aside = internalAsideQuery({
      currency: "ARS",
      today: "2026-06-15",
      window: { kind: "days", days: 90 },
      householdId: "h1",
      visibilitySql: visibility.sql,
      visibilityBinds: visibility.binds,
      internalIdsJson: "[]",
    });
    const asideRow = db.prepare(aside.sql).get(...(aside.params as never[])) as { total: number };
    assert.equal(Math.round(Number(asideRow.total) * 100), 87233380);
  });

  it("buckets weeks on Monday", () => {
    const db = openDb();
    seedHome(db);
    insertTx(db, { id: "mon", date: "2026-06-15", desc: "LUNES", ars: "3" });
    insertTx(db, { id: "sun", date: "2026-06-21", desc: "DOMINGO", ars: "4" });
    const query = spendingSeriesQuery({
      currency: "ARS",
      today: "2026-06-21",
      granularity: "week",
      householdId: "h1",
      expenseSql: expenseSql(),
      visibilitySql: "1 = 1",
      visibilityBinds: [],
    });
    const rows = db.prepare(query.sql).all(...(query.params as never[])) as Array<{ bucket: string; total: number }>;
    assert.deepEqual(
      rows.map((row) => ({ bucket: row.bucket, total: Number(row.total) })),
      [{ bucket: "2026-06-15", total: 7 }],
    );
  });
});

describe("spend windows", () => {
  const expense = expenseSql();
  const visibility = { sql: "1 = 1", binds: [] };

  function totalFor(db: DatabaseSync, window: Parameters<typeof spendingByCategoryQuery>[0]["window"]) {
    const query = spendingByCategoryQuery({
      currency: "ARS",
      today: "2026-06-15",
      window,
      householdId: "h1",
      expenseSql: expense,
      visibilitySql: visibility.sql,
      visibilityBinds: visibility.binds,
    });
    const rows = db.prepare(query.sql).all(...(query.params as never[])) as Array<{ total: number }>;
    return rows.reduce((sum, row) => sum + Number(row.total), 0);
  }

  it("keeps day 30, drops day 31, and includes the far past only in all", () => {
    const db = openDb();
    seedHome(db);
    insertTx(db, { id: "d31", date: "2026-05-15", desc: "DIA31", ars: "5" });
    insertTx(db, { id: "d30", date: "2026-05-16", desc: "DIA30", ars: "8" });
    insertTx(db, { id: "hoy", date: "2026-06-15", desc: "HOY", ars: "2" });
    insertTx(db, { id: "old", date: "2024-01-02", desc: "VIEJO", ars: "40" });
    insertTx(db, { id: "fut", date: "2026-06-16", desc: "FUTURO", ars: "9" });

    assert.equal(totalFor(db, { kind: "days", days: 30 }), 10);
    assert.equal(totalFor(db, { kind: "all" }), 55);
  });

  it("uses calendar 6 months and 1 year, inclusive of the far edge", () => {
    const db = openDb();
    seedHome(db);
    // today 2026-06-15 → 6 months: 2025-12-15 in, 2025-12-14 out
    insertTx(db, { id: "m-out", date: "2025-12-14", desc: "ANTES6M", ars: "3" });
    insertTx(db, { id: "m-in", date: "2025-12-15", desc: "BORDE6M", ars: "7" });
    // 1 year: 2025-06-15 in, 2025-06-14 out
    insertTx(db, { id: "y-out", date: "2025-06-14", desc: "ANTES1A", ars: "11" });
    insertTx(db, { id: "y-in", date: "2025-06-15", desc: "BORDE1A", ars: "13" });
    insertTx(db, { id: "hoy", date: "2026-06-15", desc: "HOY", ars: "2" });

    assert.equal(totalFor(db, { kind: "months", months: 6 }), 9);
    assert.equal(totalFor(db, { kind: "years", years: 1 }), 25);
  });

  it("always binds household and an upper date so the date index can be used", () => {
    const ranged = dateWindowSql("2026-06-15", { kind: "days", days: 30 });
    assert.match(ranged.sql, /t\.date >= date\(\?, \?\) AND t\.date <= \?/);
    assert.deepEqual(ranged.params, ["2026-06-15", "-30 days", "2026-06-15"]);
    const all = dateWindowSql("2026-06-15", { kind: "all" });
    assert.equal(all.sql, "t.date <= ?");
    assert.deepEqual(all.params, ["2026-06-15"]);
    const months = dateWindowSql("2026-06-15", { kind: "months", months: 6 });
    assert.deepEqual(months.params, ["2026-06-15", "-6 months", "2026-06-15"]);
  });

  it("parses period and days from the query string", () => {
    assert.deepEqual(parseSpendWindowParam(new URL("https://tarask.test/api/spending-by-category")), {
      period: "90d",
      window: { kind: "days", days: 90 },
    });
    assert.deepEqual(
      parseSpendWindowParam(new URL("https://tarask.test/api/spending-by-category?period=30d")),
      { period: "30d", window: { kind: "days", days: 30 } },
    );
    assert.deepEqual(
      parseSpendWindowParam(new URL("https://tarask.test/api/spending-by-category?period=all&days=90")),
      { period: "all", window: { kind: "all" } },
    );
    assert.deepEqual(
      parseSpendWindowParam(new URL("https://tarask.test/api/spending-by-category?days=all")),
      { period: "all", window: { kind: "all" } },
    );
    assert.deepEqual(
      parseSpendWindowParam(new URL("https://tarask.test/api/spending-by-category?days=45")),
      { period: null, window: { kind: "days", days: 45 } },
    );
    assert.equal(parseSpendWindowParam(new URL("https://tarask.test/api/spending-by-category?period=2y")), null);
    assert.equal(parseSpendWindowParam(new URL("https://tarask.test/api/spending-by-category?days=0")), null);
  });
});

describe("combined spend", () => {
  const expense = expenseSql();
  const visibility = { sql: "1 = 1", binds: [] };

  it("converts each month's USD at that month's oficial compra and adds ARS", () => {
    const folded = foldCombinedSpend(
      [
        { category: "Supermercado", slug: "supermercado", month: "2026-05", count: 1, ars: 10, usd: 2 },
        { category: "Supermercado", slug: "supermercado", month: "2026-06", count: 1, ars: 5, usd: 1 },
        { category: "Transporte", slug: "transporte", month: "2026-06", count: 1, ars: 0, usd: 3 },
      ],
      (month) => (month === "2026-05" ? 1000 : 1200),
    );
    // 10 + 2*1000 + 5 + 1*1200 = 3215 supermarket; 3*1200 = 3600 transport
    assert.equal(folded.total, 6815);
    assert.deepEqual(
      folded.rows.map((row) => ({ category: row.category, total: row.total, count: row.count })),
      [
        { category: "Transporte", total: 3600, count: 1 },
        { category: "Supermercado", total: 3215, count: 2 },
      ],
    );
  });

  it("leaves the USD leg unconverted when that month has no rate", () => {
    const folded = foldCombinedSpend(
      [{ category: "Netflix", slug: "streaming", month: "2026-06", count: 1, ars: 8, usd: 4 }],
      () => 0,
    );
    assert.equal(folded.total, 8);
    assert.equal(folded.rows[0]?.total, 8);
  });

  it("groups ARS and USD (including Fiwind) by month and converts them", () => {
    const db = openDb();
    seedHome(db);
    insertTx(db, { id: "ars", date: "2026-06-10", desc: "COTO", ars: "20" });
    insertTx(db, { id: "usd", date: "2026-06-11", desc: "NETFLIX", usd: "4", bank: "BBVA" });
    insertTx(db, { id: "usdt", date: "2026-05-20", desc: "PAGO A KIOSCO", usd: "2", bank: "Fiwind" });
    insertTx(db, { id: "old", date: "2026-03-01", desc: "LEJOS", ars: "999" });
    const query = spendingByCategoryCombinedQuery({
      today: "2026-06-15",
      window: { kind: "days", days: 30 },
      householdId: "h1",
      expenseSql: expense,
      visibilitySql: visibility.sql,
      visibilityBinds: visibility.binds,
    });
    assert.match(query.sql, /substr\(t\.date, 1, 7\) AS month/);
    assert.match(query.sql, /t\.date >= date\(\?, \?\) AND t\.date <= \?/);
    const rows = db.prepare(query.sql).all(...(query.params as never[])) as Array<{
      category: string;
      month: string;
      ars: number;
      usd: number;
    }>;
    const byMonth = Object.fromEntries(rows.map((row) => [row.month, row]));
    assert.equal(Number(byMonth["2026-06"]?.ars), 20);
    assert.equal(Number(byMonth["2026-06"]?.usd), 4);
    assert.equal(Number(byMonth["2026-05"]?.ars), 0);
    assert.equal(Number(byMonth["2026-05"]?.usd), 2);
    assert.equal(rows.some((row) => row.month === "2026-03"), false);
    const folded = foldCombinedSpend(
      rows.map((row) => ({
        category: row.category,
        slug: "supermercado",
        month: row.month,
        count: 1,
        ars: Number(row.ars),
        usd: Number(row.usd),
      })),
      (month) => (month === "2026-05" ? 900 : 1000),
    );
    // 20 + 4*1000 + 2*900 = 5820
    assert.equal(folded.total, 5820);
  });

  it("serves a combined total in ARS and keeps the single-currency path", async () => {
    const db = openDb();
    seedHome(db);
    insertTx(db, { id: "ars", date: "2026-06-10", desc: "COTO", ars: "20" });
    insertTx(db, { id: "usd", date: "2026-06-11", desc: "NETFLIX", usd: "4", bank: "BBVA" });
    primeFxForTests({ blue: 1100, byDate: new Map([["2026-06-15", 1000]]) });
    const combined = await handleSpendingByCategory(
      new Request("https://tarask.test/api/spending-by-category?currency=combined&period=1y", {
        headers: { cookie: "lc_household=h1" },
      }),
      envFor(db),
      user,
    );
    assert.equal(combined.status, 200);
    const body = (await combined.json()) as {
      currency: string;
      combined: boolean;
      period: string;
      total: number;
    };
    assert.equal(body.currency, "ARS");
    assert.equal(body.combined, true);
    assert.equal(body.period, "1y");
    assert.equal(body.total, 4020);

    const arsOnly = await handleSpendingByCategory(
      new Request("https://tarask.test/api/spending-by-category?currency=ARS&period=1y", {
        headers: { cookie: "lc_household=h1" },
      }),
      envFor(db),
      user,
    );
    const arsBody = (await arsOnly.json()) as { currency: string; combined?: boolean; total: number };
    assert.equal(arsBody.currency, "ARS");
    assert.equal(arsBody.combined, undefined);
    assert.equal(arsBody.total, 20);
    primeFxForTests(null);
  });

  it("folds internal transfers with the same monthly rate", () => {
    const aside = foldCombinedInternal(
      [
        { month: "2026-05", count: 1, ars: 0, usd: 10 },
        { month: "2026-06", count: 1, ars: 50, usd: 0 },
      ],
      (month) => (month === "2026-05" ? 900 : 1000),
    );
    assert.equal(aside.count, 2);
    assert.equal(aside.total, 9050);
  });
});

describe("insight handlers", () => {
  it("serves a private cache and keeps internal transfers out of income", async () => {
    const db = openDb();
    seedHome(db);
    insertTx(db, { id: "cafe", date: "2026-08-02", desc: "CAFE", ars: "100" });
    db.prepare(
      `INSERT INTO incomes (id, user_id, household_id, date, label, kind, amount_ars, amount_usd)
       VALUES ('in-1', 'user-a', 'h1', '2026-08-01', 'Sueldo', 'variable', '1000', '5')`,
    ).run();
    db.prepare(
      `INSERT INTO incomes (id, user_id, household_id, date, label, kind, amount_ars)
       VALUES ('in-2', 'user-a', 'h1', '2026-08-02', 'CUENTA TUYA demo', 'variable', '800')`,
    ).run();

    const spend = await handleSpendingByCategory(
      new Request("https://tarask.test/api/spending-by-category?currency=ARS&days=90", {
        headers: { cookie: "lc_household=h1" },
      }),
      envFor(db),
      user,
    );
    assert.equal(spend.status, 200);
    assert.equal(spend.headers.get("cache-control"), "private, max-age=30");

    const income = await handleIncomeByMonth(
      new Request("https://tarask.test/api/income-by-month?currency=ARS", {
        headers: { cookie: "lc_household=h1" },
      }),
      envFor(db),
      user,
    );
    assert.equal(income.headers.get("cache-control"), "private, max-age=30");
    const ars = (await income.json()) as { total: number; excludedCount: number; rows: Array<{ total: number }> };
    assert.equal(ars.excludedCount, 1);
    assert.equal(ars.total, 1000);

    const usd = await handleIncomeByMonth(
      new Request("https://tarask.test/api/income-by-month?currency=USD", {
        headers: { cookie: "lc_household=h1" },
      }),
      envFor(db),
      user,
    );
    const usdBody = (await usd.json()) as { total: number };
    assert.equal(usdBody.total, 5);

    const usdt = await handleIncomeByMonth(
      new Request("https://tarask.test/api/income-by-month?currency=USDT", {
        headers: { cookie: "lc_household=h1" },
      }),
      envFor(db),
      user,
    );
    const usdtBody = (await usdt.json()) as { total: number; rows: unknown[] };
    assert.equal(usdtBody.total, 0);
    assert.deepEqual(usdtBody.rows, []);

    const series = await handleSpendingSeries(
      new Request("https://tarask.test/api/spending-series?granularity=month&currency=ARS", {
        headers: { cookie: "lc_household=h1" },
      }),
      envFor(db),
      user,
    );
    assert.equal(series.headers.get("cache-control"), "private, max-age=30");
    const seriesBody = (await series.json()) as { granularity: string; rows: Array<{ bucket: string; total: number }> };
    assert.equal(seriesBody.granularity, "month");
    assert.ok(seriesBody.rows.some((row) => row.bucket === "2026-08" && row.total === 100));
  });

  it("accepts period=all and rejects an unknown period", async () => {
    const db = openDb();
    seedHome(db);
    insertTx(db, { id: "old", date: "2020-02-02", desc: "VIEJO", ars: "15" });
    const ok = await handleSpendingByCategory(
      new Request("https://tarask.test/api/spending-by-category?currency=ARS&period=all", {
        headers: { cookie: "lc_household=h1" },
      }),
      envFor(db),
      user,
    );
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { period: string; days: number | null; total: number };
    assert.equal(body.period, "all");
    assert.equal(body.days, null);
    assert.equal(body.total, 15);

    const bad = await handleSpendingByCategory(
      new Request("https://tarask.test/api/spending-by-category?currency=ARS&period=2y", {
        headers: { cookie: "lc_household=h1" },
      }),
      envFor(db),
      user,
    );
    assert.equal(bad.status, 400);
  });
});
