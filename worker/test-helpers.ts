import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { SessionUser } from "./auth";
import type { Env } from "./env";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const fixture = (...p: string[]) => join(root, "fixtures", ...p);

export const owner: SessionUser = { id: "u1", email: "owner@example.com", name: "Owner", image: null };
export const other: SessionUser = { id: "u2", email: "other@example.com", name: "Other", image: null };

export function openDb(): DatabaseSync {
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
  db.prepare("INSERT INTO users (id, email, name) VALUES ('u1', 'owner@example.com', 'Owner')").run();
  db.prepare("INSERT INTO users (id, email, name) VALUES ('u2', 'other@example.com', 'Other')").run();
  const house = (id: string, name: string, code: string) =>
    db.prepare("INSERT INTO households (id, name, invite_code) VALUES (?, ?, ?)").run(id, name, code);
  house("hp", "Personal", "CODEP001");
  house("hc", "Casita", "CODEC001");
  house("hx", "Mi espacio", "CODEX001");
  const member = (h: string, u: string, joined: number) =>
    db.prepare("INSERT INTO household_members (household_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)").run(h, u, joined);
  member("hc", "u1", 1);
  member("hp", "u1", 2);
  member("hx", "u2", 1);
  for (const [id, slug] of [
    ["c-unc", "uncategorized"],
    ["c-conv", "conversiones"],
    ["c-rend", "rendimientos"],
    ["c-super", "supermercado"],
    ["c-rest", "restaurante"],
    ["c-trans", "transporte"],
    ["c-int", "transferencia-interna"],
    ["c-learn", "kiosco"],
  ] as const) {
    db.prepare(
      "INSERT INTO categories (id, slug, name, kind, default_ownership, is_system) VALUES (?, ?, ?, 'expense', 'personal', 1)",
    ).run(id, slug, slug);
  }
  return db;
}

export function envFor(db: DatabaseSync, opts?: { failBatchAt?: number }): { env: Env; calls: { prepares: number; batches: number } } {
  const calls = { prepares: 0, batches: 0 };
  type Stmt = {
    bind(...v: unknown[]): Stmt;
    all(): Promise<{ results: Record<string, unknown>[] }>;
    first(): Promise<Record<string, unknown> | null>;
    run(): Promise<{ meta: { changes: number } }>;
    sql: string;
    params: unknown[];
  };
  const prepare = (sql: string): Stmt => {
    calls.prepares++;
    const stmt: Stmt = {
      sql,
      params: [],
      bind(...v) {
        stmt.params = v;
        return stmt;
      },
      async all() {
        return { results: db.prepare(sql).all(...(stmt.params as never[])) as Record<string, unknown>[] };
      },
      async first() {
        return (db.prepare(sql).get(...(stmt.params as never[])) as Record<string, unknown> | undefined) ?? null;
      },
      async run() {
        const info = db.prepare(sql).run(...(stmt.params as never[]));
        return { meta: { changes: Number((info as { changes: number | bigint }).changes) } };
      },
    };
    return stmt;
  };
  const DB = {
    prepare,
    async batch(list: Stmt[]) {
      calls.batches++;
      if (opts?.failBatchAt === calls.batches) throw new Error("D1 down");
      db.exec("BEGIN");
      try {
        const out = list.map((s) => {
          const info = db.prepare(s.sql).run(...(s.params as never[]));
          return { meta: { changes: Number((info as { changes: number | bigint }).changes) } };
        });
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return {
    calls,
    env: {
      DB: DB as unknown as Env["DB"],
      RECEIPTS: { put: async () => null, get: async () => null },
      AI: { toMarkdown: async () => null },
      ASSETS: { fetch: async () => new Response(null, { status: 404 }) },
    },
  };
}

