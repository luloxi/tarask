import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { SSO_OFF_COOKIE, handleGoogleStart, handleLogout, isUser, requireUser } from "./auth";
import type { Env } from "./env";
import { signSso } from "./lulox-sso";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = "s".repeat(48);
const LUCIANO = "lucianoolivabianco@gmail.com";
const EOTH = "lulox.eth@gmail.com";
const KATHO = "kathonejo@gmail.com";

function openDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const f of ["0001_app.sql", "0002_auth.sql"]) db.exec(readFileSync(join(root, "migrations", f), "utf8"));
  return db;
}

function wrap(db: DatabaseSync) {
  return {
    prepare(sql: string) {
      let params: unknown[] = [];
      const stmt = {
        bind(...v: unknown[]) {
          params = v;
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

const envFor = (db: DatabaseSync, extra?: Partial<Env>): Env =>
  ({ DB: wrap(db) as Env["DB"], LULOX_SSO_SECRET: SECRET, RECEIPTS: {}, AI: {}, ASSETS: {}, ...extra }) as unknown as Env;

function addUser(db: DatabaseSync, id: string, email: string, token?: string) {
  const now = Date.now();
  db.prepare("INSERT INTO auth_user (id, name, email, email_verified, image, created_at, updated_at) VALUES (?, ?, ?, 1, NULL, ?, ?)").run(id, email, email, now, now);
  if (token) {
    const hash = createHash("sha256").update(token).digest("hex");
    db.prepare("INSERT INTO auth_session (id, expires_at, token, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?, ?)").run(`s-${id}`, now + 3600_000, hash, now, now, id);
  }
}

async function request(cookies: Record<string, string>) {
  const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  return new Request("https://tarask.lulox.com.ar/api/me", { headers: { cookie } });
}
const sso = (email: string) => signSso({ email, name: email, picture: "" }, SECRET, 60_000);
const sessionCookieName = () => {
  const src = readFileSync(join(root, "worker", "http.ts"), "utf8");
  return /const COOKIE = "([^"]+)"/.exec(src)![1]!;
};

describe("Tarask session follows the current Genkilulox identity", () => {
  it("a session of another account is dropped when lulox_sso says someone else (never shows the old account)", async () => {
    const db = openDb();
    addUser(db, "u-l", LUCIANO, "tok-luciano");
    addUser(db, "u-e", EOTH);
    const env = envFor(db, { ALLOWED_EMAILS: `${EOTH},${KATHO}` });
    const req = await request({ [sessionCookieName()]: "tok-luciano", lulox_sso: await sso(EOTH) });
    const res = await requireUser(req, env);
    assert.ok(isUser(res));
    assert.equal(res.email, EOTH, "gets lulox.eth's own account, not Luciano's");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM auth_session").get() as { n: number }).n, 0, "the old session is deleted");
  });

  it("if the Genki identity has no Tarask account yet, the old session is dropped and the answer is 401 with the cookie cleared", async () => {
    const db = openDb();
    addUser(db, "u-l", LUCIANO, "tok-luciano");
    const env = envFor(db, { ALLOWED_EMAILS: `${EOTH},${KATHO}` });
    const res = await requireUser(await request({ [sessionCookieName()]: "tok-luciano", lulox_sso: await sso(KATHO) }), env);
    assert.ok(!isUser(res));
    assert.equal(res.status, 401);
    assert.match(res.headers.get("set-cookie") ?? "", /Max-Age=0/);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM auth_session").get() as { n: number }).n, 0);
  });

  it("a non-allowed Genki identity never gets in, and Luciano's session does not survive it", async () => {
    const db = openDb();
    addUser(db, "u-l", LUCIANO, "tok-luciano");
    addUser(db, "u-x", "stranger@example.com");
    const res = await requireUser(await request({ [sessionCookieName()]: "tok-luciano", lulox_sso: await sso("stranger@example.com") }), envFor(db));
    assert.ok(!isUser(res));
    assert.equal(res.status, 401);
  });

  it("the same identity keeps its session; no lulox_sso keeps working as before", async () => {
    const db = openDb();
    addUser(db, "u-l", LUCIANO, "tok-luciano");
    const env = envFor(db);
    const same = await requireUser(await request({ [sessionCookieName()]: "tok-luciano", lulox_sso: await sso(LUCIANO) }), env);
    assert.ok(isUser(same) && same.email === LUCIANO);
    const plain = await requireUser(await request({ [sessionCookieName()]: "tok-luciano" }), env);
    assert.ok(isUser(plain) && plain.email === LUCIANO);
  });

  it("after logout the SSO cookie cannot sign anyone back in until a deliberate sign-in", async () => {
    const db = openDb();
    addUser(db, "u-l", LUCIANO, "tok-luciano");
    const env = envFor(db);
    const out = await handleLogout(await request({ [sessionCookieName()]: "tok-luciano", lulox_sso: await sso(LUCIANO) }), env);
    const set = out.headers.getSetCookie().join(" | ");
    assert.match(set, new RegExp(`${SSO_OFF_COOKIE}=1`));
    assert.match(set, /lulox_sso=;/);
    const back = await requireUser(await request({ lulox_sso: await sso(LUCIANO), [SSO_OFF_COOKIE]: "1" }), env);
    assert.ok(!isUser(back), "SSO is off");
    const start = await handleGoogleStart(new Request("https://tarask.lulox.com.ar/api/auth/google", { headers: { cookie: `${SSO_OFF_COOKIE}=1` } }), envFor(db, { GOOGLE_CLIENT_ID: "x" }));
    assert.match(start.headers.getSetCookie().join(" | "), new RegExp(`${SSO_OFF_COOKIE}=;.*Max-Age=0`));
  });

  it("lulox.eth and kathonejo are allowed by config (Luciano always), a stranger is not", async () => {
    const db = openDb();
    addUser(db, "u-e", EOTH);
    addUser(db, "u-k", KATHO);
    addUser(db, "u-x", "stranger@example.com");
    const env = envFor(db, { ALLOWED_EMAILS: `${EOTH},${KATHO}` });
    for (const email of [EOTH, KATHO]) assert.ok(isUser(await requireUser(await request({ lulox_sso: await sso(email) }), env)), email);
    assert.ok(!isUser(await requireUser(await request({ lulox_sso: await sso("stranger@example.com") }), env)));
    const cfg = JSON.parse(readFileSync(join(root, "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, "")) as { vars: { ALLOWED_EMAILS: string } };
    assert.deepEqual(cfg.vars.ALLOWED_EMAILS.split(","), [EOTH, KATHO]);
  });
});
