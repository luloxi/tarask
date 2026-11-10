import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { SessionUser } from "./auth";
import type { Env } from "./env";
import { handleIncomeByMonth, handleSpendingByCategory, handleSpendingSeries } from "./insights";
import { internalAsideQuery, spendingByCategoryQuery, spendingSeriesQuery } from "./insights-sql";
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
      days: 90,
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
      days: 90,
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
      days: 90,
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
      days: 90,
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
      days: 90,
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
      days: 90,
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
});
