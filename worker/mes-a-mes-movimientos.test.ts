import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { SessionUser } from "./auth";
import type { Env } from "./env";
import { primeFxForTests } from "./fx";
import { handleMesAMes, handleMesAMesMovimientos } from "./mes-a-mes";
import { handleTransactions } from "./transactions";
import {
  categoryExpandMismatches,
  groupTxsByCategorySlug,
} from "../src/lib/category-expand";

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

function envFor(db: DatabaseSync): Env {
  return {
    DB: wrap(db) as Env["DB"],
    RECEIPTS: { put: async () => null, get: async () => null },
    AI: { toMarkdown: async () => null },
    ASSETS: { fetch: async () => new Response(null, { status: 404 }) },
  };
}

function seed(db: DatabaseSync) {
  db.prepare("INSERT INTO users (id, email, name) VALUES ('user-a', 'a@example.com', 'Member A')").run();
  db.prepare("INSERT INTO users (id, email, name) VALUES ('user-b', 'b@example.com', 'Member B')").run();
  db.prepare("INSERT INTO households (id, name, invite_code) VALUES ('h1', 'Personal', 'CODE0001')").run();
  db.prepare(
    "INSERT INTO household_members (household_id, user_id, role, joined_at) VALUES ('h1', 'user-a', 'owner', 1)",
  ).run();
  db.prepare(
    "INSERT INTO household_members (household_id, user_id, role, joined_at) VALUES ('h1', 'user-b', 'member', 2)",
  ).run();
  db.prepare(
    "INSERT INTO categories (id, slug, name, kind, is_system) VALUES ('cat-jardin', 'jardineria', 'Jardinería', 'expense', 1)",
  ).run();
  db.prepare(
    "INSERT INTO categories (id, slug, name, kind, is_system) VALUES ('cat-unc', 'uncategorized', 'Uncategorized', 'expense', 1)",
  ).run();

  const insert = db.prepare(
    `INSERT INTO transactions (
       id, household_id, date, description_raw, description_normalized,
       amount_ars, amount_usd, is_payment, is_credit, ownership, paid_by_user_id,
       category_id, external_fingerprint, source
     ) VALUES (?, 'h1', ?, ?, ?, ?, ?, 0, 0, ?, 'user-a', ?, ?, 'manual')`,
  );
  // 12 jardinería (more than the default API page of 10)
  for (let i = 1; i <= 12; i += 1) {
    const day = String(i).padStart(2, "0");
    insert.run(
      `tx-j-${i}`,
      `2026-10-${day}`,
      `Jardin ${i}`,
      `Jardin ${i}`,
      `${1000 * i}.00`,
      null,
      "personal",
      "cat-jardin",
      `fp-j-${i}`,
    );
  }
  // 5 without a usable category: 3 with Uncategorized, 2 with NULL
  for (let i = 1; i <= 3; i += 1) {
    insert.run(
      `tx-u-${i}`,
      `2026-10-${10 + i}`,
      `Sin cat ${i}`,
      `Sin cat ${i}`,
      `${200 + i}.00`,
      null,
      "personal",
      "cat-unc",
      `fp-u-${i}`,
    );
  }
  for (let i = 1; i <= 2; i += 1) {
    insert.run(
      `tx-n-${i}`,
      `2026-10-${20 + i}`,
      `Nulo ${i}`,
      `Nulo ${i}`,
      `${50 + i}.00`,
      null,
      "personal",
      null,
      `fp-n-${i}`,
    );
  }
  // USD-only row in jardinería + a payment and a statement row that must stay out
  insert.run(
    "tx-j-usd",
    "2026-10-28",
    "Jardin usd",
    "Jardin usd",
    null,
    "10.00",
    "personal",
    "cat-jardin",
    "fp-j-usd",
  );
  db.prepare(
    `INSERT INTO transactions (
       id, household_id, date, description_raw, description_normalized,
       amount_ars, is_payment, is_credit, ownership, paid_by_user_id,
       category_id, external_fingerprint, source
     ) VALUES ('tx-pay', 'h1', '2026-10-29', 'PAGO', 'PAGO', '99999.00', 1, 0, 'personal', 'user-a', 'cat-jardin', 'fp-pay', 'manual')`,
  ).run();
  db.prepare(
    `INSERT INTO transactions (
       id, household_id, date, description_raw, description_normalized,
       amount_ars, is_payment, is_credit, ownership, paid_by_user_id,
       category_id, external_fingerprint, source
     ) VALUES ('tx-period', 'h1', '2026-10-30', 'RESUMEN', 'RESUMEN', '88888.00', 0, 0, 'personal', 'user-a', 'cat-jardin', 'fp-period', 'bbva_period')`,
  ).run();
  // Someone else's personal row should not appear
  db.prepare(
    `INSERT INTO transactions (
       id, household_id, date, description_raw, description_normalized,
       amount_ars, is_payment, is_credit, ownership, paid_by_user_id,
       category_id, external_fingerprint, source
     ) VALUES ('tx-b', 'h1', '2026-10-15', 'Ajeno', 'Ajeno', '777.00', 0, 0, 'personal', 'user-b', 'cat-jardin', 'fp-b', 'manual')`,
  ).run();
}

type MonthCat = {
  slug: string;
  name: string;
  count: number;
  amountArs: number;
  amountUsd: number;
};
type Tx = {
  id: string;
  date: string;
  amountArs: number | null;
  amountUsd: number | null;
  category: { slug: string; name: string } | null;
  canEdit?: boolean;
};

describe("GET /api/stats/mes-a-mes/movimientos", () => {
  it("devuelve todos los gastos del mes: count y suma coinciden con el agregado, Uncategorized en español", async () => {
    const db = openDb();
    seed(db);
    primeFxForTests({ blue: 1000 });
    const env = envFor(db);
    const headers = { cookie: "lc_household=h1" };

    const stats = await handleMesAMes(
      new Request("https://tarask.test/api/stats/mes-a-mes?period=2026-10", { headers }),
      env,
      user,
    );
    assert.equal(stats.status, 200);
    const statsBody = (await stats.json()) as {
      months: Array<{ categories: MonthCat[]; totalCount: number }>;
    };
    const month = statsBody.months[0];
    assert.ok(month);
    const jardin = month.categories.find((c) => c.slug === "jardineria");
    const uncat = month.categories.find((c) => c.slug === "uncategorized");
    assert.equal(jardin?.count, 13);
    assert.equal(jardin?.amountArs, 78000);
    assert.equal(jardin?.amountUsd, 10);
    assert.equal(uncat?.count, 5);
    assert.equal(uncat?.name, "Sin categoría");
    assert.equal(uncat?.amountArs, 201 + 202 + 203 + 51 + 52);

    const listed = await handleMesAMesMovimientos(
      new Request("https://tarask.test/api/stats/mes-a-mes/movimientos?period=2026-10", { headers }),
      env,
      user,
    );
    assert.equal(listed.status, 200);
    const listBody = (await listed.json()) as { transactions: Tx[]; total: number };
    assert.equal(listBody.total, 18);
    assert.equal(listBody.transactions.every((t) => t.canEdit), true);
    assert.equal(
      listBody.transactions.some((t) => t.id === "tx-pay" || t.id === "tx-period" || t.id === "tx-b"),
      false,
    );
    const uncatNames = listBody.transactions
      .filter((t) => (t.category?.slug ?? "uncategorized") === "uncategorized")
      .map((t) => t.category?.name);
    assert.equal(uncatNames.every((n) => n === "Sin categoría"), true);

    const mismatches = categoryExpandMismatches(
      month.categories.map((c) => ({
        slug: c.slug,
        count: c.count,
        amountArs: c.amountArs,
        amountUsd: c.amountUsd,
      })),
      groupTxsByCategorySlug(listBody.transactions),
    );
    assert.deepEqual(mismatches, []);

    // The generic list endpoint still pages at 10 if no limit is sent — the bug this fixes.
    const paged = await handleTransactions(
      new Request("https://tarask.test/api/transactions?period=2026-10", { headers }),
      env,
      user,
    );
    const pagedBody = (await paged.json()) as { transactions: Tx[]; total: number; limit: number };
    assert.equal(pagedBody.limit, 10);
    assert.equal(pagedBody.transactions.length, 10);
    assert.equal(pagedBody.total > 10, true);
  });

  it("respeta el filtro Personal y rechaza período o método inválidos", async () => {
    const db = openDb();
    seed(db);
    db.prepare(
      `INSERT INTO transactions (
         id, household_id, date, description_raw, description_normalized,
         amount_ars, is_payment, is_credit, ownership, paid_by_user_id,
         category_id, external_fingerprint, source
       ) VALUES ('tx-shared', 'h1', '2026-10-16', 'Hogar', 'Hogar', '500.00', 0, 0, 'shared', 'user-a', 'cat-jardin', 'fp-shared', 'manual')`,
    ).run();
    const env = envFor(db);
    const headers = { cookie: "lc_household=h1" };
    const personal = await handleMesAMesMovimientos(
      new Request("https://tarask.test/api/stats/mes-a-mes/movimientos?period=2026-10&ownership=personal", { headers }),
      env,
      user,
    );
    const body = (await personal.json()) as { transactions: Array<{ id: string; ownership: string }> };
    assert.equal(body.transactions.some((t) => t.id === "tx-shared"), false);
    assert.equal(body.transactions.every((t) => t.ownership === "personal"), true);

    const bad = await handleMesAMesMovimientos(
      new Request("https://tarask.test/api/stats/mes-a-mes/movimientos?period=2026-13"),
      env,
      user,
    );
    assert.equal(bad.status, 400);
    const posted = await handleMesAMesMovimientos(
      new Request("https://tarask.test/api/stats/mes-a-mes/movimientos", { method: "POST" }),
      env,
      user,
    );
    assert.equal(posted.status, 405);
  });
});
