import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { SessionUser } from "./auth";
import type { Env } from "./env";
import { buildSheetsExport, handleSheetsExport } from "./sheets-export";
import worker from "./index";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const userA: SessionUser = { id: "user-a", email: "a@example.com", name: "Ana", image: null };

function openDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(join(root, "migrations")).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(root, "migrations", file), "utf8"));
  }
  return db;
}

function envFor(db: DatabaseSync, extra: Partial<Env> = {}): Env {
  const DB = {
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
          if (/^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)) throw new Error("export must not write");
          db.prepare(sql).run(...(params as never[]));
          return { meta: { changes: 0 } };
        },
      };
      return stmt;
    },
    async batch() {
      throw new Error("batch unused");
    },
  };
  return {
    DB: DB as Env["DB"],
    RECEIPTS: { put: async () => null, get: async () => null },
    AI: { toMarkdown: async () => null },
    ASSETS: { fetch: async () => new Response(null, { status: 404 }) },
    ...extra,
  };
}

function seed(db: DatabaseSync) {
  for (const [id, name] of [["user-a", "Ana"], ["user-b", "Beto"]]) {
    db.prepare("INSERT INTO users (id, email, name) VALUES (?, ?, ?)").run(id, `${id}@example.com`, name);
  }
  db.prepare("INSERT INTO households (id, name, invite_code) VALUES ('h1', 'Casita', 'C1')").run();
  db.prepare("INSERT INTO households (id, name, invite_code) VALUES ('h2', 'Otra', 'C2')").run();
  db.prepare("INSERT INTO household_members (household_id, user_id, role, joined_at) VALUES ('h1', 'user-a', 'owner', 1)").run();
  db.prepare("INSERT INTO household_members (household_id, user_id, role, joined_at) VALUES ('h1', 'user-b', 'member', 2)").run();
  db.prepare("INSERT INTO household_members (household_id, user_id, role, joined_at) VALUES ('h2', 'user-b', 'owner', 1)").run();
  const tx = db.prepare(
    `INSERT INTO transactions (id, household_id, date, description_raw, description_normalized, amount_ars,
       ownership, paid_by_user_id, external_fingerprint, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual')`,
  );
  tx.run("t1", "h1", "2026-11-01", "Super compartido", "super", "1000.50", "shared", "user-b", "fp1");
  tx.run("t2", "h1", "2026-11-02", "Cafe de Ana", "cafe", "200", "personal", "user-a", "fp2");
  tx.run("t3", "h1", "2026-11-03", "Regalo secreto de Beto", "regalo", "999", "personal", "user-b", "fp3");
  tx.run("t4", "h2", "2026-11-04", "Gasto de otro hogar", "otro", "50", "shared", "user-b", "fp4");
  tx.run("t5", "h1", "2026-11-05", "=HYPERLINK(\"x\")", "f", "1", "shared", "user-a", "fp5");
  const inc = db.prepare(
    "INSERT INTO incomes (id, user_id, household_id, date, label, amount_ars) VALUES (?, ?, ?, ?, ?, ?)",
  );
  inc.run("i1", "user-a", "h1", "2026-11-01", "Sueldo Ana", "5000");
  inc.run("i2", "user-b", "h1", "2026-11-01", "Sueldo Beto", "7000");
  db.prepare(
    "INSERT INTO savings_assets (id, user_id, household_id, kind, label, amount_ars) VALUES ('s1', 'user-b', 'h1', 'bank', 'Ahorro Beto', '1')",
  ).run();
  db.prepare("INSERT INTO debt_settings (user_id, saldo_deuda_ars) VALUES ('user-b', '123')").run();
  db.prepare(
    "INSERT INTO patrimonio_snapshots (id, user_id, date, net_worth_ars) VALUES ('p1', 'user-b', '2026-11-01', '9')",
  ).run();
}

describe("sheets export scope", () => {
  it("exports shared rows plus the viewer's own, never another member's personal data", async () => {
    const db = openDb();
    seed(db);
    const data = await buildSheetsExport(envFor(db, { GOOGLE_CLIENT_ID: "123-abc.apps.googleusercontent.com" }), userA, {
      id: "h1",
      name: "Casita",
    });
    const flat = JSON.stringify(data.tabs);
    assert.match(flat, /Super compartido/);
    assert.match(flat, /Cafe de Ana/);
    assert.match(flat, /Sueldo Ana/);
    for (const leaked of ["Regalo secreto de Beto", "Gasto de otro hogar", "Sueldo Beto", "Ahorro Beto"]) {
      assert.doesNotMatch(flat, new RegExp(leaked));
    }
    const debt = data.tabs.find((t) => t.title === "Deuda");
    const patrimonio = data.tabs.find((t) => t.title === "Patrimonio");
    assert.equal(debt?.rows.length, 0);
    assert.equal(patrimonio?.rows.length, 0);
    const movs = data.tabs.find((t) => t.title === "Movimientos");
    assert.equal(movs?.rows.length, 3);
    const shared = movs?.rows.find((r) => r[1] === "Super compartido");
    assert.equal(shared?.[3], 1000.5);
    assert.equal(shared?.[6], "Compartido");
    assert.equal(shared?.[7], "Beto");
    assert.equal(data.fileTitle, "Tarask – Casita");
    assert.equal(data.clientId, "123-abc.apps.googleusercontent.com");
    assert.match(data.exportKey, /^[0-9a-f]{40}$/);
    assert.doesNotMatch(data.exportKey, /user-a|h1/);
  });

  it("gives each member a different key for the same hogar", async () => {
    const db = openDb();
    seed(db);
    const env = envFor(db);
    const a = await buildSheetsExport(env, userA, { id: "h1", name: "Casita" });
    const b = await buildSheetsExport(env, { ...userA, id: "user-b" }, { id: "h1", name: "Casita" });
    assert.notEqual(a.exportKey, b.exportKey);
    assert.equal(a.clientId, null);
  });

  it("uses the active hogar from the cookie only if the viewer belongs to it", async () => {
    const db = openDb();
    seed(db);
    const req = new Request("https://tarask.lulox.com.ar/api/export/sheets", { headers: { cookie: "lc_household=h2" } });
    const res = await handleSheetsExport(req, envFor(db), userA);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { fileTitle: string; tabs: { rows: unknown[][] }[] };
    assert.equal(body.fileTitle, "Tarask – Casita");
    assert.doesNotMatch(JSON.stringify(body.tabs), /Gasto de otro hogar/);
    assert.equal(res.headers.get("cache-control"), "no-store");
  });

  it("is behind the session like every other /api route", async () => {
    const db = openDb();
    const res = await worker.fetch(new Request("https://tarask.lulox.com.ar/api/export/sheets"), envFor(db));
    assert.equal(res.status, 401);
  });
});
