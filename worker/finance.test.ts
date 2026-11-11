import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { SessionUser } from "./auth";
import type { Env, WorkerContext } from "./env";
import {
  captureDailySnapshots,
  captureUserSnapshot,
  handleAhorros,
  handleDebtSettings,
  handleDebtStats,
  handlePatrimonio,
  handlePatrimonioSnapshot,
} from "./finance";
import { primeFxForTests } from "./fx";
import { todayAr } from "./http";
import worker from "./index";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const userA: SessionUser = {
  id: "user-a",
  email: "a@example.com",
  name: "Member A",
  image: null,
};
const userB: SessionUser = {
  id: "user-b",
  email: "b@example.com",
  name: "Member B",
  image: null,
};

type LogEntry = { kind: "all" | "first" | "run"; sql: string };

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
  ]) {
    db.exec(readFileSync(join(root, "migrations", file), "utf8"));
  }
  return db;
}

function isWrite(sql: string): boolean {
  return /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql);
}

function wrap(db: DatabaseSync, log: LogEntry[], opts?: { throwOnWrite?: boolean; breakSnapshots?: boolean }) {
  return {
    prepare(sql: string) {
      if (opts?.breakSnapshots && /savings_assets|patrimonio_snapshots|debt_settings/.test(sql)) {
        throw new Error("snapshot db down");
      }
      let params: unknown[] = [];
      const stmt = {
        bind(...values: unknown[]) {
          params = values;
          return stmt;
        },
        async all() {
          log.push({ kind: "all", sql });
          return { results: db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[] };
        },
        async first() {
          log.push({ kind: "first", sql });
          return (db.prepare(sql).get(...(params as never[])) as Record<string, unknown> | undefined) ?? null;
        },
        async run() {
          log.push({ kind: "run", sql });
          if (opts?.throwOnWrite && isWrite(sql)) throw new Error(`unexpected write: ${sql.slice(0, 80)}`);
          const info = db.prepare(sql).run(...(params as never[])) as { changes?: number };
          return { meta: { changes: Number(info.changes ?? 0) } };
        },
      };
      return stmt;
    },
    async batch() {
      throw new Error("batch unused");
    },
  };
}

function envFor(db: DatabaseSync, log: LogEntry[], opts?: { throwOnWrite?: boolean; breakSnapshots?: boolean }): Env {
  return {
    DB: wrap(db, log, opts) as Env["DB"],
    RECEIPTS: { put: async () => null, get: async () => null },
    AI: { toMarkdown: async () => null },
    ASSETS: { fetch: async () => new Response(null, { status: 404 }) },
  };
}

function ctxOf(): WorkerContext & { pending: Promise<unknown>[] } {
  const pending: Promise<unknown>[] = [];
  return {
    pending,
    waitUntil(promise) {
      pending.push(promise);
    },
  };
}

function seedHousehold(db: DatabaseSync) {
  db.prepare("INSERT INTO users (id, email, name) VALUES ('user-a', 'a@example.com', 'Member A')").run();
  db.prepare("INSERT INTO users (id, email, name) VALUES ('user-b', 'b@example.com', 'Member B')").run();
  db.prepare("INSERT INTO users (id, email, name) VALUES ('user-c', 'c@example.com', 'Member C')").run();
  db.prepare(
    "INSERT INTO households (id, name, invite_code) VALUES ('h1', 'Personal', 'CODE0001')",
  ).run();
  db.prepare(
    "INSERT INTO households (id, name, invite_code) VALUES ('h2', 'Otra', 'CODE0002')",
  ).run();
  db.prepare(
    "INSERT INTO household_members (household_id, user_id, role, joined_at) VALUES ('h1', 'user-a', 'owner', 1)",
  ).run();
  db.prepare(
    "INSERT INTO household_members (household_id, user_id, role, joined_at) VALUES ('h1', 'user-b', 'member', 2)",
  ).run();
  db.prepare(
    "INSERT INTO household_members (household_id, user_id, role, joined_at) VALUES ('h2', 'user-a', 'owner', 1)",
  ).run();
}

function seedTx(
  db: DatabaseSync,
  row: {
    id: string;
    household?: string;
    description: string;
    amount?: string;
    ownership: string;
    paidBy: string;
    installment?: string | null;
    payment?: number;
    date?: string;
  },
) {
  db.prepare(
    `INSERT INTO transactions (
       id, household_id, date, description_raw, description_normalized,
       amount_ars, is_payment, is_credit, ownership, paid_by_user_id,
       installment, external_fingerprint, source
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'manual')`,
  ).run(
    row.id,
    row.household ?? "h1",
    row.date ?? `${todayAr().slice(0, 7)}-10`,
    row.description,
    row.description,
    row.amount ?? "100.00",
    row.payment ?? 0,
    row.ownership,
    row.paidBy,
    row.installment === undefined ? "1/3" : row.installment,
    `fp-${row.id}`,
  );
}

function seedSavings(db: DatabaseSync, userId: string, ars: string, usd = "0.00", id = `s-${userId}`) {
  db.prepare(
    `INSERT INTO savings_assets (
       id, user_id, household_id, kind, label, amount_ars, amount_usd
     ) VALUES (?, ?, 'h1', 'bank', 'Caja', ?, ?)`,
  ).run(id, userId, ars, usd);
}

function writes(log: LogEntry[]): LogEntry[] {
  return log.filter((entry) => entry.kind === "run" && isWrite(entry.sql));
}

describe("household visibility on finance queries", () => {
  it("hides another member's personal cuotas and keeps shared ones", async () => {
    const db = openDb();
    seedHousehold(db);
    seedTx(db, { id: "t-a", description: "PERSONAL A", ownership: "personal", paidBy: "user-a", amount: "111.00" });
    seedTx(db, { id: "t-shared-a", description: "SHARED A", ownership: "shared", paidBy: "user-a", amount: "222.00" });
    seedTx(db, { id: "t-b", description: "PERSONAL B", ownership: "personal", paidBy: "user-b", amount: "333.00" });
    seedTx(db, { id: "t-shared-b", description: "SHARED B", ownership: "shared", paidBy: "user-b", amount: "444.00" });
    seedTx(db, {
      id: "t-other",
      household: "h2",
      description: "OTHER HOUSE",
      ownership: "personal",
      paidBy: "user-a",
      amount: "555.00",
    });
    const log: LogEntry[] = [];
    const res = await handleDebtStats(
      new Request("https://tarask.test/api/stats/deuda"),
      envFor(db, log),
      userB,
    );
    const body = (await res.json()) as {
      pastInstallments: Array<{ description: string; amountArs: number | null }>;
    };
    const names = body.pastInstallments.map((row) => row.description).sort();
    assert.deepEqual(names, ["PERSONAL B", "SHARED A", "SHARED B"]);
    const cuotaSql = log.find((entry) => entry.sql.includes("FROM transactions"));
    assert.ok(cuotaSql);
    assert.match(cuotaSql.sql, /t\.ownership = 'shared' OR t\.paid_by_user_id = \?/);
  });
});

describe("patrimonio snapshots", () => {
  it("does not store a snapshot when blue is missing, zero, or non-finite", async () => {
    const db = openDb();
    seedHousehold(db);
    seedSavings(db, "user-a", "100.00", "5.00");
    const log: LogEntry[] = [];
    const env = envFor(db, log);
    assert.equal(await captureUserSnapshot(env, "user-a", null), "missing_fx");
    assert.equal(await captureUserSnapshot(env, "user-a", 0), "missing_fx");
    assert.equal(await captureUserSnapshot(env, "user-a", Number.NaN), "missing_fx");
    assert.equal(await captureUserSnapshot(env, "user-a", Number.POSITIVE_INFINITY), "missing_fx");
    assert.deepEqual(await captureDailySnapshots(env, null), { written: 0, unchanged: 0, missingFx: true });
    const count = db.prepare("SELECT COUNT(*) AS n FROM patrimonio_snapshots").get() as { n: number };
    assert.equal(count.n, 0);
    assert.equal(writes(log).length, 0);

    primeFxForTests({ blue: null });
    const res = await handlePatrimonioSnapshot(
      new Request("https://tarask.test/api/patrimonio/snapshot", { method: "POST" }),
      env,
      userA,
    );
    const body = (await res.json()) as {
      snapshot: string;
      current: { fxAvailable: boolean; fxRate: number | null; netWorthArs: number | null };
    };
    assert.equal(body.snapshot, "missing_fx");
    assert.equal(body.current.fxAvailable, false);
    assert.equal(body.current.fxRate, null);
    assert.equal(body.current.netWorthArs, null);
    assert.equal(writes(log).length, 0);
    const ahorros = await handleAhorros(new Request("https://tarask.test/api/ahorros"), env, userA);
    const summary = ((await ahorros.json()) as { summary: { netArs: number | null; blueRate: number | null } }).summary;
    assert.equal(summary.blueRate, null);
    assert.equal(summary.netArs, null);
  });

  it("keeps a stored snapshot when a later quote is missing", async () => {
    const db = openDb();
    seedHousehold(db);
    seedSavings(db, "user-a", "100.00", "5.00");
    const log: LogEntry[] = [];
    const env = envFor(db, log);
    assert.equal(await captureUserSnapshot(env, "user-a", 1000), "written");
    assert.equal(await captureUserSnapshot(env, "user-a", null), "missing_fx");
    const row = db.prepare("SELECT assets_ars, fx_rate, net_worth_ars FROM patrimonio_snapshots").get() as {
      assets_ars: string;
      fx_rate: string;
      net_worth_ars: string;
    };
    assert.equal(row.fx_rate, "1000.00");
    assert.equal(row.assets_ars, "5100.00");
    assert.notEqual(row.net_worth_ars, "0.00");
  });

  it("skips an identical day and replaces the row when figures change", async () => {
    const db = openDb();
    seedHousehold(db);
    seedSavings(db, "user-a", "100.00", "0.00");
    db.prepare(
      `INSERT INTO debt_settings (user_id, force_settled, saldo_deuda_ars, saldo_deuda_usd, card_last4)
       VALUES ('user-a', 0, '0.00', '10.00', '4242')`,
    ).run();
    const log: LogEntry[] = [];
    const env = envFor(db, log);
    assert.equal(await captureUserSnapshot(env, "user-a", 1000), "written");
    log.length = 0;
    assert.equal(await captureUserSnapshot(env, "user-a", 1000), "unchanged");
    assert.equal(writes(log).length, 0);
    db.prepare("UPDATE savings_assets SET amount_ars = '250.00' WHERE user_id = 'user-a'").run();
    assert.equal(await captureUserSnapshot(env, "user-a", 1000), "written");
    const rows = db.prepare(
      "SELECT id, assets_ars, debt_usd, net_worth_ars, date FROM patrimonio_snapshots",
    ).all() as Array<{ id: string; assets_ars: string; debt_usd: string; net_worth_ars: string; date: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].date, todayAr());
    assert.equal(rows[0].assets_ars, "250.00");
    assert.equal(rows[0].debt_usd, "10.00");
    assert.equal(rows[0].net_worth_ars, "-9750.00");
  });

  it("writes one snapshot per user with savings or debt and skips unchanged days", async () => {
    const db = openDb();
    seedHousehold(db);
    seedSavings(db, "user-a", "80.00");
    db.prepare(
      `INSERT INTO debt_settings (user_id, force_settled, saldo_deuda_ars, saldo_deuda_usd)
       VALUES ('user-b', 0, '40.00', '0.00')`,
    ).run();
    const log: LogEntry[] = [];
    const env = envFor(db, log);
    const first = await captureDailySnapshots(env, 500);
    assert.equal(first.missingFx, false);
    assert.equal(first.written, 2);
    assert.equal(first.unchanged, 0);
    const count = db.prepare("SELECT COUNT(*) AS n FROM patrimonio_snapshots").get() as { n: number };
    assert.equal(count.n, 2);
    log.length = 0;
    const second = await captureDailySnapshots(env, 500);
    assert.deepEqual(second, { written: 0, unchanged: 2, missingFx: false });
    assert.equal(writes(log).length, 0);
  });

  it("stores zero debt when the card is force settled", async () => {
    const db = openDb();
    seedHousehold(db);
    seedSavings(db, "user-a", "1000.00");
    db.prepare(
      `INSERT INTO debt_settings (user_id, force_settled, saldo_deuda_ars, saldo_deuda_usd, card_last4)
       VALUES ('user-a', 1, '90000.00', '30.00', '8958')`,
    ).run();
    db.prepare(
      `INSERT INTO card_statements (id, household_id, source, status, closed_at)
       VALUES ('st1', 'h1', 'bbva_xlsx', 'closed', 1)`,
    ).run();
    seedTx(db, { id: "t-cuota", description: "CUOTA VIEJA", ownership: "personal", paidBy: "user-a", amount: "400.00" });
    const env = envFor(db, []);
    assert.equal(await captureUserSnapshot(env, "user-a", 1500), "written");
    const row = db.prepare("SELECT debt_ars, debt_usd, net_worth_ars FROM patrimonio_snapshots").get() as {
      debt_ars: string;
      debt_usd: string;
      net_worth_ars: string;
    };
    assert.equal(row.debt_ars, "0.00");
    assert.equal(row.debt_usd, "0.00");
    assert.equal(row.net_worth_ars, "1000.00");
  });

  it("GET /api/patrimonio does not write", async () => {
    const db = openDb();
    seedHousehold(db);
    seedSavings(db, "user-a", "100.00", "5.00");
    db.prepare(
      `INSERT INTO patrimonio_snapshots (
         id, user_id, date, assets_ars, assets_usd, debt_ars, debt_usd, net_worth_ars, fx_rate, source, created_at
       ) VALUES ('p1', 'user-a', '2026-01-02', '10.00', '0.00', '0.00', '0.00', '10.00', '1000.00', 'snapshot', 1)`,
    ).run();
    const log: LogEntry[] = [];
    primeFxForTests({ blue: 1000 });
    const res = await handlePatrimonio(
      new Request("https://tarask.test/api/patrimonio"),
      envFor(db, log, { throwOnWrite: true }),
      userA,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      series: Array<{ date: string }>;
      current: { fxAvailable: boolean; netWorthArs: number };
      flujo: Array<{ month: string }>;
    };
    assert.equal(writes(log).length, 0);
    assert.deepEqual(body.series.map((point) => point.date), ["2026-01-02"]);
    assert.equal(body.current.fxAvailable, true);
    assert.equal(body.current.netWorthArs, 100 + 5 * 1000);
    assert.equal(body.flujo.length, 24);
    const still = db.prepare("SELECT COUNT(*) AS n FROM patrimonio_snapshots").get() as { n: number };
    assert.equal(still.n, 1);
  });

  it("GET /api/patrimonio plots Visa statement totals down to settled zero", async () => {
    const db = openDb();
    seedHousehold(db);
    seedSavings(db, "user-a", "100.00", "0.00");
    const cleared = Date.parse("2026-07-15T12:00:00.000-03:00");
    db.prepare(
      `INSERT INTO debt_settings (user_id, force_settled, saldo_deuda_ars, saldo_deuda_usd, cleared_at)
       VALUES ('user-a', 1, '0.00', '0.00', ?)`,
    ).run(cleared);
    db.prepare(
      `INSERT INTO card_statements (id, household_id, source, file_name, imported_at, row_count, status)
       VALUES ('visa-may', 'h1', 'bbva_pdf', 'resumen-visa-2025-05.pdf', 1, 2, 'closed')`,
    ).run();
    db.prepare(
      `INSERT INTO card_statements (id, household_id, source, file_name, imported_at, row_count, status)
       VALUES ('visa-jun', 'h1', 'bbva_period', 'periodo-2026-06.xls', 2, 2, 'closed')`,
    ).run();
    db.exec(
      `INSERT INTO transactions (
         id, household_id, statement_id, date, description_raw, description_normalized,
         amount_ars, is_payment, is_credit, ownership, paid_by_user_id, external_fingerprint, source
       ) VALUES
         ('t-may-1', 'h1', 'visa-may', '2025-05-10', 'SUPER', 'SUPER', '200.00', 0, 0, 'personal', 'user-a', 'fp-may-1', 'bbva_pdf'),
         ('t-may-2', 'h1', 'visa-may', '2025-05-31', 'PAGO', 'PAGO', '50.00', 1, 0, 'personal', 'user-a', 'fp-may-2', 'bbva_pdf'),
         ('t-jun-1', 'h1', 'visa-jun', '2026-06-02', 'DIA', 'DIA', '40.00', 0, 0, 'personal', 'user-a', 'fp-jun-1', 'bbva_period')`,
    );
    db.prepare(
      `INSERT INTO patrimonio_snapshots (
         id, user_id, date, assets_ars, assets_usd, debt_ars, debt_usd, net_worth_ars, fx_rate, source, created_at
       ) VALUES ('p-now', 'user-a', '2026-10-31', '100.00', '0.00', '0.00', '0.00', '100.00', '1000.00', 'snapshot', 1)`,
    ).run();
    primeFxForTests({ blue: 1000 });
    const res = await handlePatrimonio(
      new Request("https://tarask.test/api/patrimonio"),
      envFor(db, []),
      userA,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      derived: boolean;
      series: Array<{ date: string; debtArs: number; source: string; debtKind?: string }>;
      note: string;
    };
    assert.equal(body.derived, true);
    const byDate = Object.fromEntries(body.series.map((point) => [point.date, point]));
    assert.equal(byDate["2025-05-31"]?.debtArs, 150);
    assert.equal(byDate["2025-05-31"]?.debtKind, "statement_total");
    assert.equal(byDate["2026-06-02"]?.debtArs, 40);
    assert.equal(byDate["2026-07-15"]?.debtArs, 0);
    assert.equal(byDate["2026-10-31"]?.debtArs, 0);
    assert.equal(byDate["2026-10-31"]?.source, "snapshot");
    assert.match(body.note, /total del resumen Visa/);
  });

  it("cron writes once and ignores a later blue move", async () => {
    const db = openDb();
    seedHousehold(db);
    seedSavings(db, "user-a", "100.00", "5.00");
    const log: LogEntry[] = [];
    const env = envFor(db, log);
    const first = await captureDailySnapshots(env, 1000);
    assert.deepEqual(first, { written: 1, unchanged: 0, missingFx: false });
    log.length = 0;
    const second = await captureDailySnapshots(env, 1600);
    assert.deepEqual(second, { written: 0, unchanged: 1, missingFx: false });
    assert.equal(writes(log).length, 0);
    const stored = db.prepare(
      "SELECT assets_ars, assets_usd, fx_rate, net_worth_ars FROM patrimonio_snapshots",
    ).get() as { assets_ars: string; assets_usd: string; fx_rate: string; net_worth_ars: string };
    assert.equal(stored.assets_ars, "5100.00");
    assert.equal(stored.assets_usd, "5.00");
    assert.equal(stored.fx_rate, "1000.00");
    assert.equal(stored.net_worth_ars, "5100.00");
    assert.equal(await captureUserSnapshot(env, "user-a", 1600, "change"), "unchanged");
    assert.equal(writes(log).length, 0);

    db.prepare("UPDATE savings_assets SET amount_ars = '250.00' WHERE user_id = 'user-a'").run();
    assert.equal(await captureUserSnapshot(env, "user-a", 1600, "change"), "written");
    const saved = db.prepare(
      "SELECT assets_ars, fx_rate, net_worth_ars FROM patrimonio_snapshots",
    ).get() as { assets_ars: string; fx_rate: string; net_worth_ars: string };
    assert.equal(saved.assets_ars, "8250.00");
    assert.equal(saved.fx_rate, "1600.00");
    assert.equal(saved.net_worth_ars, "8250.00");

    primeFxForTests({ blue: 2000 });
    const res = await handlePatrimonioSnapshot(
      new Request("https://tarask.test/api/patrimonio/snapshot", { method: "POST" }),
      env,
      userA,
    );
    const body = (await res.json()) as { snapshot: string };
    assert.equal(body.snapshot, "written");
    const forced = db.prepare(
      "SELECT assets_ars, fx_rate, net_worth_ars FROM patrimonio_snapshots",
    ).get() as { assets_ars: string; fx_rate: string; net_worth_ars: string };
    assert.equal(forced.assets_ars, "10250.00");
    assert.equal(forced.fx_rate, "2000.00");
    assert.equal(forced.net_worth_ars, "10250.00");
    const count = db.prepare("SELECT COUNT(*) AS n FROM patrimonio_snapshots").get() as { n: number };
    assert.equal(count.n, 1);
  });

  it("change mode keeps USD debt priced at the stored blue until force", async () => {
    const db = openDb();
    seedHousehold(db);
    seedSavings(db, "user-a", "100.00", "0.00");
    db.prepare(
      `INSERT INTO debt_settings (user_id, force_settled, saldo_deuda_ars, saldo_deuda_usd, card_last4)
       VALUES ('user-a', 0, '0.00', '10.00', '4242')`,
    ).run();
    const log: LogEntry[] = [];
    const env = envFor(db, log);
    assert.equal(await captureUserSnapshot(env, "user-a", 1000, "change"), "written");
    log.length = 0;
    assert.equal(await captureUserSnapshot(env, "user-a", 1800, "change"), "unchanged");
    assert.equal(writes(log).length, 0);
    const held = db.prepare(
      "SELECT fx_rate, net_worth_ars, debt_usd FROM patrimonio_snapshots",
    ).get() as { fx_rate: string; net_worth_ars: string; debt_usd: string };
    assert.equal(held.fx_rate, "1000.00");
    assert.equal(held.debt_usd, "10.00");
    assert.equal(held.net_worth_ars, "-9900.00");
    assert.equal(await captureUserSnapshot(env, "user-a", 1800, "force"), "written");
    const forced = db.prepare(
      "SELECT fx_rate, net_worth_ars FROM patrimonio_snapshots",
    ).get() as { fx_rate: string; net_worth_ars: string };
    assert.equal(forced.fx_rate, "1800.00");
    assert.equal(forced.net_worth_ars, "-17900.00");
  });
});

describe("monthly cash flow", () => {
  it("subtracts visible expenses from income for the active household", async () => {
    const db = openDb();
    seedHousehold(db);
    const month = todayAr().slice(0, 7);
    seedTx(db, { id: "exp-a", description: "KIOSCO A", ownership: "personal", paidBy: "user-a", amount: "500.00", installment: null });
    seedTx(db, { id: "exp-shared", description: "KIOSCO SHARED", ownership: "shared", paidBy: "user-a", amount: "200.00", installment: null });
    seedTx(db, { id: "exp-b", description: "KIOSCO B", ownership: "personal", paidBy: "user-b", amount: "100.00", installment: null });
    seedTx(db, { id: "exp-pay", description: "PAGO TARJETA", ownership: "personal", paidBy: "user-b", amount: "9999.00", installment: null, payment: 1 });
    db.prepare(
      `INSERT INTO incomes (id, user_id, household_id, date, label, kind, amount_ars)
       VALUES ('inc-b', 'user-b', 'h1', ?, 'Sueldo', 'variable', '1000.00')`,
    ).run(`${month}-05`);
    const log: LogEntry[] = [];
    primeFxForTests({ blue: 1000, byDate: new Map([[`${month}-28`, 1000]]) });
    const res = await handlePatrimonio(
      new Request("https://tarask.test/api/patrimonio"),
      envFor(db, log),
      userB,
    );
    const body = (await res.json()) as {
      flujo: Array<{ month: string; incomeArs: number; expenseArs: number; flowArs: number }>;
    };
    const point = body.flujo.find((row) => row.month === month);
    assert.ok(point);
    assert.equal(point.incomeArs, 1000);
    assert.equal(point.expenseArs, 300);
    assert.equal(point.flowArs, 700);
    const grouped = log.filter((entry) => entry.sql.includes("GROUP BY month"));
    assert.equal(grouped.length, 1);
    assert.match(grouped[0].sql, /t\.ownership = 'shared' OR t\.paid_by_user_id = \?/);
    assert.match(grouped[0].sql, /SUM\(/);
  });

  it("counts only shared rows in a shared household", async () => {
    const db = openDb();
    db.prepare("INSERT INTO users (id, email, name) VALUES ('user-b', 'b@example.com', 'Member B')").run();
    db.prepare("INSERT INTO households (id, name, invite_code) VALUES ('h1', 'Casa', 'CODE0001')").run();
    db.prepare(
      "INSERT INTO household_members (household_id, user_id, role, joined_at) VALUES ('h1', 'user-b', 'owner', 1)",
    ).run();
    const month = todayAr().slice(0, 7);
    seedTx(db, { id: "exp-b", description: "KIOSCO B", ownership: "personal", paidBy: "user-b", amount: "100.00", installment: null });
    seedTx(db, { id: "exp-shared", description: "KIOSCO SHARED", ownership: "shared", paidBy: "user-b", amount: "40.00", installment: null });
    const log: LogEntry[] = [];
    primeFxForTests({ blue: 1000 });
    const res = await handlePatrimonio(
      new Request("https://tarask.test/api/patrimonio"),
      envFor(db, log),
      userB,
    );
    const body = (await res.json()) as { flujo: Array<{ month: string; expenseArs: number }> };
    const point = body.flujo.find((row) => row.month === month);
    assert.equal(point?.expenseArs, 40);
    const grouped = log.filter((entry) => entry.sql.includes("GROUP BY month"));
    assert.equal(grouped.length, 1);
    assert.match(grouped[0].sql, /t\.ownership = 'shared'/);
    assert.doesNotMatch(grouped[0].sql, /paid_by_user_id/);
  });
});

describe("savings note and snapshot triggers", () => {
  it("keeps the saved-balance note for refresh=1", async () => {
    const db = openDb();
    seedHousehold(db);
    primeFxForTests({ blue: 1000 });
    const env = envFor(db, []);
    const refreshed = await handleAhorros(
      new Request("https://tarask.test/api/ahorros?refresh=1"),
      env,
      userA,
    );
    const plain = await handleAhorros(new Request("https://tarask.test/api/ahorros"), env, userA);
    const note = "Saldos guardados, sin sync en vivo.";
    assert.equal(((await refreshed.json()) as { summary: { balanceNote: string } }).summary.balanceNote, note);
    assert.equal(((await plain.json()) as { summary: { balanceNote: string } }).summary.balanceNote, note);
  });

  it("upserts today's snapshot when savings or debt settings are saved", async () => {
    const db = openDb();
    seedHousehold(db);
    primeFxForTests({ blue: 1000 });
    const env = envFor(db, []);
    const created = await handleAhorros(
      new Request("https://tarask.test/api/ahorros", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "bank", label: "Caja", amountArs: 100, amountUsd: 0 }),
      }),
      env,
      userA,
    );
    assert.equal(created.status, 201);
    const id = ((await created.json()) as { id: string }).id;
    const row = db.prepare("SELECT assets_ars, net_worth_ars FROM patrimonio_snapshots").get() as {
      assets_ars: string;
      net_worth_ars: string;
    };
    assert.equal(row.assets_ars, "100.00");
    assert.equal(row.net_worth_ars, "100.00");

    const patched = await handleAhorros(
      new Request("https://tarask.test/api/ahorros", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, amountArs: 180, amountUsd: 0 }),
      }),
      env,
      userA,
    );
    assert.equal(patched.status, 200);
    const saved = await handleDebtSettings(
      new Request("https://tarask.test/api/debt-settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ saldoDeudaArs: 30, saldoDeudaUsd: 2, cardLast4: "4242" }),
      }),
      env,
      userA,
    );
    assert.equal(saved.status, 200);
    const count = db.prepare("SELECT COUNT(*) AS n FROM patrimonio_snapshots").get() as { n: number };
    assert.equal(count.n, 1);
    const point = db.prepare("SELECT assets_ars, debt_ars, debt_usd, net_worth_ars FROM patrimonio_snapshots").get() as {
      assets_ars: string;
      debt_ars: string;
      debt_usd: string;
      net_worth_ars: string;
    };
    assert.equal(point.assets_ars, "180.00");
    assert.equal(point.debt_ars, "30.00");
    assert.equal(point.debt_usd, "2.00");
    assert.equal(point.net_worth_ars, "-1850.00");
  });
});

describe("patrimonio cron", () => {
  it("runs the snapshot job beside the outbox flush", async () => {
    const db = openDb();
    seedHousehold(db);
    seedSavings(db, "user-a", "40.00");
    primeFxForTests({ blue: 800 });
    const log: LogEntry[] = [];
    const ctx = ctxOf();
    await worker.scheduled({}, envFor(db, log), ctx);
    await Promise.all(ctx.pending);
    const count = db.prepare("SELECT COUNT(*) AS n FROM patrimonio_snapshots").get() as { n: number };
    assert.equal(count.n, 1);
  });

  it("still finishes the outbox flush when the snapshot job throws", async () => {
    const db = openDb();
    seedHousehold(db);
    primeFxForTests({ blue: 800 });
    const log: LogEntry[] = [];
    const env = envFor(db, log, { breakSnapshots: true });
    env.CUENTIX_SYNC_SECRET = "test-secret-not-real";
    env.SERPIX_SYNC_URL = "https://serpix-sync.test/events";
    const ctx = ctxOf();
    await worker.scheduled({}, env, ctx);
    await Promise.all(ctx.pending);
    assert.ok(log.some((entry) => entry.sql.includes("serpix_outbox")));
  });
});
