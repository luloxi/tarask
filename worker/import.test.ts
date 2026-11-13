import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { Env } from "./env";
import { describe, it } from "node:test";
import { markdownToStatementText } from "../src/lib/bbva/parse-pdf";
import { buildImportPayloads } from "../src/lib/import/client";
import { parseStatementFile } from "../src/lib/import/parse-statement";
import type { SessionUser } from "./auth";
import { BANK_ACCOUNTING_SQL, EXPENSE_SQL } from "./sql";
import { envFor, fixture, openDb, other, owner } from "./test-helpers";
import {
  MAX_MOVEMENTS_PER_REQUEST,
  handleImportStatement,
  handlePdfText,
  parseImportRequest,
  pickPersonalHousehold,
} from "./import";

async function payloadFor(path: string, bank: string | null = null) {
  const parsed = await parseStatementFile(readFileSync(path), path.split("/").pop()!, { skipAi: true });
  return { parsed, payloads: buildImportPayloads({ ...parsed, fileName: path.split("/").pop()! }, bank) };
}

function post(user: SessionUser, env: Env, body: unknown) {
  return handleImportStatement(
    new Request("https://tarask.test/api/import/statement", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    user,
  );
}

const count = (db: DatabaseSync, sql: string, ...p: unknown[]) =>
  Number((db.prepare(sql).get(...(p as never[])) as { n: number }).n);

describe("pickPersonalHousehold", () => {
  const h = (id: string, name: string, joinedAt: number) => ({ id, name, role: "owner" as const, joinedAt });
  it("prefers Personal, then Mi espacio, never Casita or Invoice IOG", () => {
    assert.equal(pickPersonalHousehold([h("a", "Casita", 1), h("b", "Personal", 2)])?.id, "b");
    assert.equal(pickPersonalHousehold([h("a", "Casita", 1), h("b", "Mi espacio", 2)])?.id, "b");
    assert.equal(pickPersonalHousehold([h("a", "Casita", 1), h("b", "Invoice IOG", 2)]), null);
    assert.equal(pickPersonalHousehold([h("z", "Viaje", 5), h("a", "Casa", 1)])?.id, "a");
  });
});

describe("parseImportRequest", () => {
  const row = {
    date: "2026-08-31",
    descriptionNormalized: "Pago a DIA",
    descriptionRaw: "Pago a DIA",
    amountArs: 100,
    amountUsd: null,
    fingerprint: "a".repeat(32),
  };
  it("rejects malformed rows instead of writing them", () => {
    assert.throws(() => parseImportRequest({ movements: [{ ...row, date: "31/08/2026" }] }), /Fecha inválida/);
    assert.throws(() => parseImportRequest({ movements: [{ ...row, fingerprint: "xyz" }] }), /huella/);
    assert.throws(() => parseImportRequest({ movements: [{ ...row, amountArs: Number.NaN }] }), /Importe/);
    assert.throws(() => parseImportRequest({ movements: [{ ...row, amountArs: null }] }), /sin importe/);
    assert.throws(() => parseImportRequest({ movements: [{ ...row, descriptionNormalized: " " }] }), /descripción/);
    assert.throws(
      () => parseImportRequest({ movements: Array.from({ length: MAX_MOVEMENTS_PER_REQUEST + 1 }, () => row) }),
      /Demasiados/,
    );
    assert.throws(() => parseImportRequest(null), /Falta/);
    assert.equal(parseImportRequest({ movements: [row] }).movements.length, 1);
  });
});

describe("Fiwind Actividad import", () => {
  it("imports once, then re-uploading the same file adds nothing", async () => {
    const db = openDb();
    const { env, calls } = envFor(db);
    const { parsed, payloads } = await payloadFor(fixture("fiwind", "actividad-3.xlsx"));
    assert.equal(payloads.length, 1);
    const expectedUnique = new Set(parsed.movements.map((m) => m.fingerprint)).size;

    const first = (await (await post(owner, env, payloads[0])).json()) as Record<string, number | string>;
    assert.equal(first.error, undefined);
    assert.ok(Number(first.inserted) > 0);
    assert.ok(Number(first.inserted) <= expectedUnique);
    // Lands in Personal (not Casita), once, with one statement row.
    assert.equal(count(db, "SELECT COUNT(*) n FROM transactions WHERE household_id = 'hp'"), first.inserted);
    assert.equal(count(db, "SELECT COUNT(*) n FROM transactions WHERE household_id <> 'hp'"), 0);
    assert.equal(count(db, "SELECT COUNT(*) n FROM card_statements WHERE household_id = 'hp'"), 1);
    assert.equal(
      count(db, "SELECT row_count n FROM card_statements WHERE household_id = 'hp'"),
      first.inserted,
    );
    // The D1 calls for a whole month stay far below the free plan's 50 subrequests.
    assert.ok(calls.prepares < 30, `prepares=${calls.prepares}`);

    const before = count(db, "SELECT COUNT(*) n FROM transactions");
    const second = (await (await post(owner, env, payloads[0])).json()) as Record<string, number | boolean>;
    assert.equal(second.inserted, 0);
    assert.equal(second.fullyDuplicate, true);
    assert.equal(count(db, "SELECT COUNT(*) n FROM transactions"), before);
    assert.equal(count(db, "SELECT COUNT(*) n FROM card_statements"), 1);
  });

  it("keeps date, amount, currency and ownership fields faithful to the parser", async () => {
    const db = openDb();
    const { env } = envFor(db);
    const { parsed, payloads } = await payloadFor(fixture("fiwind", "actividad-3.xlsx"));
    await post(owner, env, payloads[0]);
    const rows = db
      .prepare(
        `SELECT date, description_normalized d, amount_ars, amount_usd, is_credit, is_payment, bank, source,
                paid_by_user_id, ownership, category_id
         FROM transactions`,
      )
      .all() as Array<Record<string, string | number | null>>;
    const byFp = new Map(parsed.movements.map((m) => [`${m.date}|${m.descriptionNormalized}`, m]));
    for (const r of rows) {
      const m = byFp.get(`${r.date}|${r.d}`);
      assert.ok(m, `row ${r.date} ${r.d} comes from the file`);
      assert.equal(r.amount_ars != null ? Number(r.amount_ars) : null, m.amountArs);
      assert.equal(r.amount_usd != null ? Number(r.amount_usd) : null, m.amountUsd);
      assert.equal(Boolean(r.is_credit), m.isCredit);
      assert.equal(r.bank, "Fiwind");
      assert.equal(r.paid_by_user_id, "u1");
      assert.equal(r.ownership, "personal");
    }
    // ARS and USD both present in the month.
    assert.ok(rows.some((r) => r.amount_usd != null));
    assert.ok(rows.some((r) => r.amount_ars != null));
    // Conversions / yields keep their non-expense category from the parser hint.
    const conv = rows.find((r) => String(r.d).toLowerCase().startsWith("conversión"));
    if (conv) assert.equal(conv.category_id, "c-conv");
  });

  it("another user's upload goes to their own space, never into the owner's", async () => {
    const db = openDb();
    const { env } = envFor(db);
    const { payloads } = await payloadFor(fixture("fiwind", "actividad-3.xlsx"));
    await post(other, env, payloads[0]);
    assert.equal(count(db, "SELECT COUNT(*) n FROM transactions WHERE household_id = 'hx'") > 0, true);
    assert.equal(count(db, "SELECT COUNT(*) n FROM transactions WHERE household_id IN ('hp', 'hc')"), 0);
  });

  it("applies learned merchant rules before the static suggestion", async () => {
    const db = openDb();
    db.prepare("INSERT INTO merchant_rules (id, household_id, pattern, category_id, priority) VALUES ('r1','hp','DIDI','c-learn',90)").run();
    const { env } = envFor(db);
    const { payloads } = await payloadFor(fixture("fiwind", "actividad-3.xlsx"));
    const body = await (await post(owner, env, payloads[0])).json() as { learnedHits: number };
    const didi = db.prepare("SELECT category_id FROM transactions WHERE UPPER(description_normalized) LIKE '%DIDI%'").all() as Array<{ category_id: string }>;
    assert.ok(didi.length > 0);
    assert.ok(didi.every((r) => r.category_id === "c-learn"));
    assert.equal(body.learnedHits, didi.length);
  });

  it("a failed batch leaves nothing half-written and a retry completes the import", async () => {
    const db = openDb();
    const { payloads } = await payloadFor(fixture("fiwind", "actividad-3.xlsx"));
    // The only batch is the debt/statement+rows one; fail the first batch call.
    const failing = envFor(db, { failBatchAt: 1 });
    await assert.rejects(() => post(owner, failing.env, payloads[0]), /D1 down/);
    assert.equal(count(db, "SELECT COUNT(*) n FROM transactions"), 0);
    assert.equal(count(db, "SELECT COUNT(*) n FROM card_statements"), 0);
    const ok = envFor(db);
    const r = (await (await post(owner, ok.env, payloads[0])).json()) as { inserted: number };
    assert.ok(r.inserted > 0);
  });

  it("chunks of one file share one statement row", async () => {
    const db = openDb();
    const { env } = envFor(db);
    const parsed = await parseStatementFile(readFileSync(fixture("fiwind", "actividad-2.xlsx")), "actividad-2.xlsx", { skipAi: true });
    const payloads = buildImportPayloads({ ...parsed, fileName: "actividad-2.xlsx" }, null, 50);
    assert.ok(payloads.length >= 3);
    let statementId: string | null = null;
    let inserted = 0;
    for (const p of payloads) {
      const r = (await (await post(owner, env, { ...p, statementId })).json()) as { statementId: string; inserted: number };
      statementId = r.statementId ?? statementId;
      inserted += r.inserted;
    }
    assert.equal(count(db, "SELECT COUNT(*) n FROM card_statements"), 1);
    assert.equal(count(db, "SELECT COUNT(*) n FROM transactions"), inserted);
    assert.equal(count(db, "SELECT row_count n FROM card_statements"), inserted);
    // Re-running the whole file: nothing new, no extra statement.
    for (const p of payloads) await post(owner, env, p);
    assert.equal(count(db, "SELECT COUNT(*) n FROM transactions"), inserted);
    assert.equal(count(db, "SELECT COUNT(*) n FROM card_statements"), 1);
    // Continuing someone else's statement is refused.
    const stolen = await post(other, env, { ...payloads[0], statementId });
    assert.equal(stolen.status, 400);
    assert.equal(count(db, "SELECT COUNT(*) n FROM transactions WHERE household_id = 'hp'"), inserted);
  });
});

describe("BBVA import", () => {
  it("imports a card export and is idempotent", async () => {
    const db = openDb();
    const { env } = envFor(db);
    const { payloads } = await payloadFor(fixture("bbva-card", "ultimos-movimientos.xlsx"));
    const a = (await (await post(owner, env, payloads[0])).json()) as { inserted: number; bank: string };
    assert.ok(a.inserted > 0);
    assert.equal(a.bank, "BBVA");
    const b = (await (await post(owner, env, payloads[0])).json()) as { inserted: number };
    assert.equal(b.inserted, 0);
    assert.equal(count(db, "SELECT COUNT(*) n FROM transactions"), a.inserted);
  });
});

describe("Fiwind Estado de Cuenta (PDF) import", () => {
  it("imports the broker statement as accounting rows, once", async () => {
    const db = openDb();
    const { env } = envFor(db);
    const md = readFileSync(fixture("fiwind", "estado-cuenta-ejemplo.markdown.txt"), "utf8");
    assert.ok(markdownToStatementText(md).length > 0);
    const parsed = await parseStatementFile(readFileSync(fixture("fiwind", "estado-cuenta-ejemplo.pdf")), "estado.pdf", {
      pdfMarkdown: async () => md,
      skipAi: true,
    });
    const payloads = buildImportPayloads({ ...parsed, fileName: "estado.pdf" }, null);
    const first = (await (await post(owner, env, payloads[0])).json()) as { inserted: number; bank: string };
    assert.equal(first.inserted, 4);
    assert.equal(first.bank, "Fiwind");
    const rows = db.prepare("SELECT description_normalized d, amount_ars, amount_usd, category_id, bank FROM transactions ORDER BY date").all() as Array<Record<string, string | null>>;
    assert.equal(rows.length, 4);
    assert.ok(rows.every((r) => String(r.d).startsWith("Transferencia interna - Cuenta comitente")));
    assert.ok(rows.every((r) => r.category_id === "c-conv"));
    assert.equal(rows.filter((r) => r.amount_usd != null).length, 1);
    // Read-time totals: nothing from the broker ledger is a gasto, and the deposit/coupon are not ingresos.
    assert.equal(
      count(db, `SELECT COUNT(*) n FROM transactions t WHERE ${EXPENSE_SQL}`),
      0,
      "broker ledger rows never count as gastos",
    );
    assert.equal(
      count(db, `SELECT COUNT(*) n FROM transactions t WHERE ${BANK_ACCOUNTING_SQL}`),
      4,
    );
    const again = (await (await post(owner, env, payloads[0])).json()) as { inserted: number };
    assert.equal(again.inserted, 0);
    assert.equal(count(db, "SELECT COUNT(*) n FROM transactions"), 4);
  });
});

describe("/api/import/pdf-text", () => {
  const pdfReq = (blob: Blob) => {
    const fd = new FormData();
    fd.set("file", new File([blob], "x.pdf", { type: "application/pdf" }));
    return new Request("https://tarask.test/api/import/pdf-text", { method: "POST", body: fd });
  };
  it("returns Workers AI markdown", async () => {
    const { env } = envFor(openDb());
    env.AI = { toMarkdown: async () => [{ format: "markdown", data: "# hola" }] };
    const res = await handlePdfText(pdfReq(new Blob(["%PDF-1.4"])), env);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { markdown: "# hola" });
  });
  it("fails clearly when the PDF cannot be read", async () => {
    const { env } = envFor(openDb());
    env.AI = { toMarkdown: async () => [{ format: "error", data: "" }] };
    const res = await handlePdfText(pdfReq(new Blob(["%PDF-1.4"])), env);
    assert.equal(res.status, 422);
  });
});
