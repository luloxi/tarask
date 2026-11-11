import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { handleAgentToken } from "./agent-token";
import { handleAllowedEmails } from "./allowed-emails";
import type { SessionUser } from "./auth";
import { ADMIN_EMAIL } from "./auth";
import { handleBillingSubscription } from "./billing";
import { handleCargas } from "./cargas";
import { handleCompartidoStats } from "./compartido";
import type { Env } from "./env";
import { primeFxForTests } from "./fx";
import { handleGrupo } from "./grupo";
import { handleIncomes } from "./incomes-api";
import { handleMesAMes } from "./mes-a-mes";
import { handleReceipts } from "./receipts";
import worker from "./index";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const user: SessionUser = { id: "user-a", email: "a@example.com", name: "Member A", image: null };

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

function wrap(db: DatabaseSync) {
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
  };
}

function envFor(db: DatabaseSync, extra?: Partial<Env>): Env {
  return {
    DB: wrap(db) as Env["DB"],
    RECEIPTS: { put: async () => null, get: async () => null },
    AI: { toMarkdown: async () => null },
    ASSETS: { fetch: async () => new Response(null, { status: 404 }) },
    ...extra,
  };
}

function seed(db: DatabaseSync) {
  const now = Date.now();
  db.prepare("INSERT INTO users (id, email, name) VALUES ('user-a', 'a@example.com', 'Member A')").run();
  db.prepare("INSERT INTO users (id, email, name) VALUES ('user-b', 'b@example.com', 'Member B')").run();
  db.prepare("INSERT INTO households (id, name, invite_code) VALUES ('h1', 'Personal', 'CODE0001')").run();
  db.prepare("INSERT INTO households (id, name, invite_code) VALUES ('h2', 'Otra', 'CODE0002')").run();
  db.prepare(
    "INSERT INTO household_members (household_id, user_id, role, joined_at) VALUES ('h1', 'user-a', 'owner', 1)",
  ).run();
  db.prepare(
    "INSERT INTO household_members (household_id, user_id, role, joined_at) VALUES ('h1', 'user-b', 'member', 2)",
  ).run();
  db.prepare(
    "INSERT INTO household_members (household_id, user_id, role, joined_at) VALUES ('h2', 'user-a', 'owner', 3)",
  ).run();
  db.prepare(
    "INSERT INTO categories (id, slug, name, kind, is_system) VALUES ('cat-comida', 'comida', 'Comida', 'expense', 1)",
  ).run();
  db.prepare(
    `INSERT INTO incomes (id, user_id, household_id, date, label, kind, amount_ars, created_at, updated_at)
     VALUES ('inc-h1', 'user-a', 'h1', '2026-08-10', 'Sueldo', 'variable', '500000', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO incomes (id, user_id, household_id, date, label, kind, amount_ars, created_at, updated_at)
     VALUES ('inc-h1-jul', 'user-a', 'h1', '2026-07-10', 'Extra julio', 'variable', '80000', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO incomes (id, user_id, household_id, date, label, kind, amount_ars, created_at, updated_at)
     VALUES ('inc-h2', 'user-a', 'h2', '2026-08-10', 'Otro hogar', 'variable', '700000', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO incomes (id, user_id, household_id, date, label, kind, frequency, amount_ars, created_at, updated_at)
     VALUES ('inc-rec', 'user-a', 'h1', '2026-06-05', 'Sueldo mensual', 'recurring', 'mensual', '100000', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO card_statements (id, household_id, source, file_name, imported_at, row_count)
     VALUES ('st1', 'h1', 'bbva_xlsx', 'ultimos-movimientos.xlsx', ?, 4)`,
  ).run(now);
  db.prepare(
    `INSERT INTO receipts (id, household_id, image_url, merchant_name, receipt_date, status, created_at)
     VALUES ('rc1', 'h1', 'r2://ticket-demo', 'SUPER DEMO', '2026-08-02', 'parsed', ?)`,
  ).run(now);
  db.prepare(
    `INSERT INTO receipt_items (id, receipt_id, name, quantity, line_total)
     VALUES ('ri1', 'rc1', 'Cafe demo', '1', '1200')`,
  ).run();
  const tx = db.prepare(
    `INSERT INTO transactions (
       id, household_id, date, description_raw, description_normalized,
       amount_ars, is_payment, is_credit, ownership, paid_by_user_id,
       category_id, external_fingerprint, source, statement_id, bank
     ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?)`,
  );
  tx.run(
    "tx-stmt",
    "h1",
    "2026-08-01",
    "SUPER DEMO",
    "SUPER DEMO",
    "1400.00",
    "personal",
    "user-a",
    "cat-comida",
    "fp-stmt",
    "bbva_xlsx",
    "st1",
    "BBVA",
  );
  tx.run(
    "tx-manual",
    "h1",
    "2026-08-03",
    "Kiosco demo",
    "Kiosco demo",
    "900.00",
    "personal",
    "user-a",
    "cat-comida",
    "fp-manual",
    "manual",
    null,
    null,
  );
  tx.run(
    "tx-shared",
    "h1",
    "2026-08-12",
    "Almacen demo",
    "Almacen demo",
    "3200.00",
    "shared",
    "user-a",
    "cat-comida",
    "fp-shared",
    "manual",
    null,
    null,
  );
  tx.run(
    "tx-shared-jul",
    "h1",
    "2026-07-12",
    "Verduleria demo",
    "Verduleria demo",
    "1100.00",
    "shared",
    "user-b",
    "cat-comida",
    "fp-shared-jul",
    "manual",
    null,
    null,
  );
  db.prepare(
    `INSERT INTO subscriptions (polar_subscription_id, user_id, status, current_period_end, updated_at)
     VALUES ('sub_demo', 'user-a', 'active', ?, ?)`,
  ).run(now + 86400000, now);
}

describe("section apis", { concurrency: false }, () => {
  it("GET /api/incomes is period-aware and household-scoped", async () => {
    const db = openDb();
    seed(db);
    primeFxForTests({ blue: 1000 });
    const august = await handleIncomes(
      new Request("https://tarask.test/api/incomes?period=2026-08", {
        headers: { cookie: "lc_household=h1" },
      }),
      envFor(db),
      user,
    );
    assert.equal(august.status, 200);
    const body = (await august.json()) as {
      period: string;
      incomes: Array<{ id: string; label: string; kind: string }>;
      periodEntries: Array<{ sourceId: string; expected: boolean }>;
      monthlyEvolution: Array<{ period: string; amountArs: number }>;
    };
    assert.equal(body.period, "2026-08");
    const ids = body.incomes.map((row) => row.id).sort();
    assert.deepEqual(ids, ["inc-h1", "inc-rec"]);
    assert.equal(body.incomes.some((row) => row.id === "inc-h2"), false);
    assert.equal(body.incomes.some((row) => row.id === "inc-h1-jul"), false);
    assert.ok(body.periodEntries.some((row) => row.sourceId === "inc-h1" && !row.expected));
    assert.ok(body.periodEntries.some((row) => row.sourceId === "inc-rec" && row.expected));
    const augustChart = body.monthlyEvolution.find((row) => row.period === "2026-08");
    assert.ok((augustChart?.amountArs ?? 0) >= 600000);

    const other = await handleIncomes(
      new Request("https://tarask.test/api/incomes?period=2026-08", {
        headers: { cookie: "lc_household=h2" },
      }),
      envFor(db),
      user,
    );
    const otherBody = (await other.json()) as { incomes: Array<{ id: string }> };
    assert.deepEqual(otherBody.incomes.map((row) => row.id), ["inc-h2"]);

    const july = await handleIncomes(
      new Request("https://tarask.test/api/incomes?period=2026-07", {
        headers: { cookie: "lc_household=h1" },
      }),
      envFor(db),
      user,
    );
    const julyBody = (await july.json()) as { incomes: Array<{ id: string }> };
    const julyIds = julyBody.incomes.map((row) => row.id).sort();
    assert.deepEqual(julyIds, ["inc-h1-jul", "inc-rec"]);
  });

  it("POST /api/incomes writes into the active household and DELETE removes it", async () => {
    const db = openDb();
    seed(db);
    const created = await handleIncomes(
      new Request("https://tarask.test/api/incomes", {
        method: "POST",
        headers: { cookie: "lc_household=h1", "content-type": "application/json" },
        body: JSON.stringify({
          date: "2026-08-20",
          label: "Freelance demo",
          amountArs: 15000,
          kind: "variable",
        }),
      }),
      envFor(db),
      user,
    );
    assert.equal(created.status, 200);
    const createdBody = (await created.json()) as { income: { id: string; label: string } };
    assert.equal(createdBody.income.label, "Freelance demo");
    const row = db.prepare("SELECT household_id AS hid FROM incomes WHERE id = ?").get(createdBody.income.id) as {
      hid: string;
    };
    assert.equal(row.hid, "h1");

    const removed = await handleIncomes(
      new Request(`https://tarask.test/api/incomes?id=${createdBody.income.id}`, {
        method: "DELETE",
        headers: { cookie: "lc_household=h1" },
      }),
      envFor(db),
      user,
    );
    assert.equal(removed.status, 200);
    const gone = db.prepare("SELECT id FROM incomes WHERE id = ?").get(createdBody.income.id);
    assert.equal(gone, undefined);
  });

  it("GET /api/cargas lists statements, receipts and manuals", async () => {
    const db = openDb();
    seed(db);
    const res = await handleCargas(
      new Request("https://tarask.test/api/cargas", { headers: { cookie: "lc_household=h1" } }),
      envFor(db),
      user,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      items: Array<{
        kind: string;
        typeLabel: string;
        count: number;
        fileName: string | null;
        periodFrom: string | null;
        periodTo: string | null;
      }>;
    };
    const kinds = new Set(body.items.map((item) => item.kind));
    assert.equal(kinds.has("manual"), true);
    assert.equal(kinds.has("receipt"), true);
    assert.equal(kinds.has("statement"), true);
    const statement = body.items.find((item) => item.kind === "statement");
    assert.match(statement?.typeLabel ?? "", /BBVA/);
    assert.equal(statement?.count, 4);
    assert.ok(statement?.periodFrom);
    assert.ok(statement?.periodTo);
    const receipt = body.items.find((item) => item.kind === "receipt");
    assert.equal(receipt?.fileName, "SUPER DEMO");
    assert.equal(receipt?.count, 1);
  });

  it("GET /api/stats/compartido returns household-scoped shared spend", async () => {
    const db = openDb();
    seed(db);
    primeFxForTests({ blue: 1000 });
    const res = await handleCompartidoStats(
      new Request("https://tarask.test/api/stats/compartido?period=2026-08", {
        headers: { cookie: "lc_household=h1" },
      }),
      envFor(db),
      user,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      householdName: string;
      period: string;
      prevPeriod: string;
      prevTotalArs: number;
      inviteCode: string;
      expenses: Array<{ description: string; amountCombined: number }>;
      categories: Array<{ slug: string; total: number }>;
      summary: { totalArsCombined: number };
    };
    assert.equal(body.householdName, "Personal");
    assert.equal(body.period, "2026-08");
    assert.equal(body.prevPeriod, "2026-07");
    assert.equal(body.inviteCode, "CODE0001");
    assert.equal(body.summary.totalArsCombined, 3200);
    assert.equal(body.prevTotalArs, 1100);
    assert.equal(body.expenses.length, 1);
    assert.equal(body.expenses[0]?.description, "Almacen demo");
    assert.equal(body.categories[0]?.slug, "comida");
  });

  it("GET /api/billing/subscription returns the plan and stored row", async () => {
    const db = openDb();
    seed(db);
    const res = await handleBillingSubscription(
      new Request("https://tarask.test/api/billing/subscription"),
      envFor(db),
      user,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      configured: boolean;
      plan: { name: string; amountArs: number };
      subscription: { status: string; polarSubscriptionId: string };
    };
    assert.equal(body.configured, false);
    assert.equal(body.plan.name, "Pro");
    assert.equal(body.plan.amountArs, 9990);
    assert.equal(body.subscription.status, "active");
    assert.equal(body.subscription.polarSubscriptionId, "sub_demo");
    const text = JSON.stringify(body);
    assert.equal(/sk_|whsec_|POLAR_ACCESS_TOKEN/.test(text), false);
  });

  it("GET /api/stats/mes-a-mes aggregates the active household", async () => {
    const db = openDb();
    seed(db);
    primeFxForTests({ blue: 1000 });
    db.prepare(
      `INSERT INTO transactions (
         id, household_id, date, description_raw, description_normalized,
         amount_ars, is_payment, is_credit, ownership, paid_by_user_id,
         category_id, external_fingerprint, source
       ) VALUES ('tx-pay', 'h1', '2026-08-20', 'PAGO TARJETA', 'PAGO TARJETA', '99999.00', 1, 0, 'personal', 'user-a', 'cat-comida', 'fp-pay', 'manual')`,
    ).run();
    db.prepare(
      `INSERT INTO transactions (
         id, household_id, date, description_raw, description_normalized,
         amount_ars, is_payment, is_credit, ownership, paid_by_user_id,
         category_id, external_fingerprint, source
       ) VALUES ('tx-period', 'h1', '2026-08-21', 'RESUMEN', 'RESUMEN', '88888.00', 0, 0, 'personal', 'user-a', 'cat-comida', 'fp-period', 'bbva_period')`,
    ).run();
    db.prepare(
      `INSERT INTO transactions (
         id, household_id, date, description_raw, description_normalized,
         amount_ars, is_payment, is_credit, ownership, paid_by_user_id,
         category_id, external_fingerprint, source
       ) VALUES
         ('tx-h2-own', 'h2', '2026-08-02', 'Privado', 'Privado', '9999.00', 0, 0, 'personal', 'user-a', 'cat-comida', 'fp-h2-own', 'manual'),
         ('tx-h2-shared', 'h2', '2026-08-04', 'Hogar demo', 'Hogar demo', '50.00', 0, 0, 'shared', 'user-a', 'cat-comida', 'fp-h2-shared', 'manual')`,
    ).run();

    const august = await handleMesAMes(
      new Request("https://tarask.test/api/stats/mes-a-mes?period=2026-08", {
        headers: { cookie: "lc_household=h1" },
      }),
      envFor(db),
      user,
    );
    assert.equal(august.status, 200);
    const body = (await august.json()) as {
      periods: string[];
      months: Array<{ period: string; totalArsCombined: number; totalCount: number; categories: Array<{ slug: string }> }>;
      chart: { periods: string[]; totals: Array<{ period: string; amountArs: number }> };
      sharedBalance: { period: string; byUser: Record<string, number> };
      coupleBalance: { period: string };
    };
    assert.deepEqual(body.periods, ["2026-08", "2026-07"]);
    assert.equal(body.months.length, 1);
    assert.equal(body.months[0]?.period, "2026-08");
    assert.equal(body.months[0]?.totalArsCombined, 5500);
    assert.equal(body.months[0]?.totalCount, 3);
    assert.equal(body.months[0]?.categories[0]?.slug, "comida");
    assert.equal(body.chart.periods[0], "2026-07");
    assert.equal(body.chart.totals.find((row) => row.period === "2026-07")?.amountArs, 1100);
    assert.equal(body.sharedBalance.period, "2026-08");
    assert.equal(body.sharedBalance.byUser["user-a"], 3200);
    assert.equal(body.coupleBalance.period, "2026-08");

    const personal = await handleMesAMes(
      new Request("https://tarask.test/api/stats/mes-a-mes?period=all&ownership=personal", {
        headers: { cookie: "lc_household=h1" },
      }),
      envFor(db),
      user,
    );
    const personalBody = (await personal.json()) as {
      months: Array<{ period: string; totalArsCombined: number }>;
    };
    assert.equal(personalBody.months.find((month) => month.period === "2026-08")?.totalArsCombined, 2300);

    const other = await handleMesAMes(
      new Request("https://tarask.test/api/stats/mes-a-mes?period=all", {
        headers: { cookie: "lc_household=h2" },
      }),
      envFor(db),
      user,
    );
    const otherBody = (await other.json()) as {
      months: Array<{ totalArsCombined: number }>;
    };
    assert.equal(otherBody.months.length, 1);
    assert.equal(otherBody.months[0]?.totalArsCombined, 50);

    const bad = await handleMesAMes(
      new Request("https://tarask.test/api/stats/mes-a-mes?period=2026-13"),
      envFor(db),
      user,
    );
    assert.equal(bad.status, 400);
    const posted = await handleMesAMes(
      new Request("https://tarask.test/api/stats/mes-a-mes", { method: "POST" }),
      envFor(db),
      user,
    );
    assert.equal(posted.status, 405);
  });

  it("GET /api/grupo is household-scoped", async () => {
    const db = openDb();
    seed(db);
    const home = await handleGrupo(
      new Request("https://tarask.test/api/grupo", { headers: { cookie: "lc_household=h1" } }),
      envFor(db),
      user,
    );
    assert.equal(home.status, 200);
    const body = (await home.json()) as {
      householdName: string;
      inviteCode: string;
      members: Array<{ userId: string; role: string }>;
    };
    assert.equal(body.householdName, "Personal");
    assert.equal(body.inviteCode, "CODE0001");
    assert.equal(body.members.length, 2);
    assert.equal(body.members.some((member) => member.userId === "user-b"), true);

    const other = await handleGrupo(
      new Request("https://tarask.test/api/grupo", { headers: { cookie: "lc_household=h2" } }),
      envFor(db),
      user,
    );
    const otherBody = (await other.json()) as { inviteCode: string; members: Array<{ userId: string }> };
    assert.equal(otherBody.inviteCode, "CODE0002");
    assert.equal(otherBody.members.some((member) => member.userId === "user-b"), false);
    const posted = await handleGrupo(
      new Request("https://tarask.test/api/grupo", { method: "POST" }),
      envFor(db),
      user,
    );
    assert.equal(posted.status, 405);
  });

  it("GET /api/receipts lists tickets without the image key", async () => {
    const db = openDb();
    seed(db);
    const res = await handleReceipts(
      new Request("https://tarask.test/api/receipts", { headers: { cookie: "lc_household=h1" } }),
      envFor(db),
      user,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      receipts: Array<{
        merchantName: string;
        items: Array<{ name: string; lineTotal: number }>;
        imageUrl?: string;
      }>;
    };
    assert.equal(body.receipts.length, 1);
    assert.equal(body.receipts[0]?.merchantName, "SUPER DEMO");
    assert.equal(body.receipts[0]?.items[0]?.name, "Cafe demo");
    assert.equal(body.receipts[0]?.items[0]?.lineTotal, 1200);
    const text = JSON.stringify(body);
    assert.equal(text.includes("r2://"), false);
    assert.equal(text.includes("image_url"), false);

    const other = await handleReceipts(
      new Request("https://tarask.test/api/receipts", { headers: { cookie: "lc_household=h2" } }),
      envFor(db),
      user,
    );
    const otherBody = (await other.json()) as { receipts: unknown[] };
    assert.equal(otherBody.receipts.length, 0);
    const posted = await handleReceipts(
      new Request("https://tarask.test/api/receipts", { method: "POST" }),
      envFor(db),
      user,
    );
    assert.equal(posted.status, 405);
  });

  it("GET /api/admin/allowed-emails is admin-only and read-only", async () => {
    const db = openDb();
    seed(db);
    const now = Date.now();
    db.prepare("INSERT INTO allowed_emails (email, created_at, created_by) VALUES ('guest@example.com', ?, 'user-a')").run(now);
    const denied = await handleAllowedEmails(
      new Request("https://tarask.test/api/admin/allowed-emails"),
      envFor(db),
      user,
    );
    assert.equal(denied.status, 403);

    const res = await handleAllowedEmails(
      new Request("https://tarask.test/api/admin/allowed-emails"),
      envFor(db, { ALLOWED_EMAILS: "extra@example.com" }),
      { ...user, email: ADMIN_EMAIL },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      emails: Array<{ email: string; source: string }>;
    };
    const sources = new Map(body.emails.map((row) => [row.email, row.source]));
    assert.equal(sources.get(ADMIN_EMAIL), "admin");
    assert.equal(sources.get("guest@example.com"), "db");
    assert.equal(sources.get("extra@example.com"), "env");
    assert.equal(JSON.stringify(body).includes("created_by"), false);
    const posted = await handleAllowedEmails(
      new Request("https://tarask.test/api/admin/allowed-emails", { method: "POST" }),
      envFor(db),
      { ...user, email: ADMIN_EMAIL },
    );
    assert.equal(posted.status, 405);
  });

  it("GET /api/household/agent-token returns prefix only", async () => {
    const db = openDb();
    seed(db);
    const hash = "cafebabe-test-hash-not-a-token";
    db.prepare(
      `INSERT INTO household_api_tokens (id, household_id, token_hash, token_prefix, created_by, created_at)
       VALUES ('tok1', 'h1', ?, 'pref', 'user-a', 10)`,
    ).run(hash);
    db.prepare(
      `INSERT INTO household_api_tokens (id, household_id, token_hash, token_prefix, created_at, revoked_at)
       VALUES ('tok-old', 'h1', 'old-hash', 'gone', 1, 2)`,
    ).run();
    const res = await handleAgentToken(
      new Request("https://tarask.test/api/household/agent-token", {
        headers: { cookie: "lc_household=h1" },
      }),
      envFor(db),
      user,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      hasToken: boolean;
      prefix: string | null;
      token: string | null;
      household: { name: string } | null;
    };
    assert.equal(body.hasToken, true);
    assert.equal(body.prefix, "pref");
    assert.equal(body.token, null);
    assert.equal(body.household?.name, "Personal");
    const text = JSON.stringify(body);
    assert.equal(text.includes(hash), false);
    assert.equal(text.includes("token_hash"), false);

    const none = await handleAgentToken(
      new Request("https://tarask.test/api/household/agent-token"),
      envFor(db),
      { ...user, id: "user-missing" },
    );
    const noneBody = (await none.json()) as { hasToken: boolean; token: null };
    assert.equal(none.status, 200);
    assert.equal(noneBody.hasToken, false);
    assert.equal(noneBody.token, null);
    const posted = await handleAgentToken(
      new Request("https://tarask.test/api/household/agent-token", { method: "DELETE" }),
      envFor(db),
      user,
    );
    assert.equal(posted.status, 405);
  });

  it("rejects unauthenticated calls to the new routes", async () => {
    const db = openDb();
    const env = envFor(db);
    for (const path of [
      "/api/incomes?period=2026-08",
      "/api/cargas",
      "/api/stats/compartido",
      "/api/billing/subscription",
      "/api/stats/mes-a-mes",
      "/api/grupo",
      "/api/receipts",
      "/api/admin/allowed-emails",
      "/api/household/agent-token",
    ]) {
      const res = await worker.fetch(new Request(`https://tarask.test${path}`), env);
      assert.equal(res.status, 401, path);
    }
  });

  it("routes an authenticated GET /api/grupo through the worker", async () => {
    const db = openDb();
    seed(db);
    const token = "tarask-section-test";
    const hash = createHash("sha256").update(token).digest("hex");
    const now = Date.now();
    db.prepare(
      `INSERT INTO auth_user (id, name, email, created_at, updated_at)
       VALUES ('user-a', 'Member A', 'a@example.com', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO auth_session (id, expires_at, token, created_at, updated_at, user_id)
       VALUES ('sess-1', ?, ?, ?, ?, 'user-a')`,
    ).run(now + 60_000, hash, now, now);
    const res = await worker.fetch(
      new Request("https://tarask.test/api/grupo", {
        headers: { cookie: `tarask_session=${token}` },
      }),
      envFor(db),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { inviteCode: string };
    assert.equal(body.inviteCode, "CODE0001");
  });
});
