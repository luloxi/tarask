import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import type { Env } from "./env";
import { aiReplyText, handleReceiptFile, handleReceipts, RECEIPT_VISION_MODEL } from "./receipts";
import { envFor, openDb, other, owner } from "./test-helpers";

const OCR_REPLY = JSON.stringify({
  merchant: "SUPERMERCADO EJEMPLO S.A.",
  date: "2026-11-07",
  total: 19040.5,
  currency: "ARS",
  items: [
    { name: "LECHE ENTERA 1L", quantity: 2, unit_price: 1200, line_total: 2400 },
    { name: "PAN LACTAL", quantity: 1, unit_price: 3150.5, line_total: 3150.5 },
  ],
});

function setup(reply: unknown = { response: OCR_REPLY }) {
  const db = openDb();
  const { env } = envFor(db);
  const stored = new Map<string, { body: Blob; contentType?: string }>();
  const aiCalls: Array<{ model: string; input: unknown }> = [];
  env.AI = {
    toMarkdown: async () => null,
    run: async (model: string, input: unknown) => {
      aiCalls.push({ model, input });
      if (reply instanceof Error) throw reply;
      return reply;
    },
  } as Env["AI"];
  env.RECEIPTS = {
    put: async (key: string, body: Blob, o?: { httpMetadata?: { contentType?: string } }) => {
      stored.set(key, { body, contentType: o?.httpMetadata?.contentType });
      return null;
    },
    get: async (key: string) => {
      const v = stored.get(key);
      return v ? { body: v.body.stream(), httpMetadata: { contentType: v.contentType } } : null;
    },
  } as unknown as Env["RECEIPTS"];
  return { db, env, stored, aiCalls };
}

const png = () => new File([new Uint8Array([1, 2, 3, 4])], "ticket 1.jpg", { type: "image/jpeg" });
const DATA_URL = "data:image/jpeg;base64,AAECAw==";

function upload(env: Env, user = owner, fields: Record<string, string | File> = {}, household = "hp") {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return handleReceipts(
    new Request("https://tarask.test/api/receipts", {
      method: "POST",
      body: fd,
      headers: { cookie: `lc_household=${household}` },
    }),
    env,
    user,
  );
}

const n = (db: DatabaseSync, sql: string, ...p: unknown[]) =>
  Number((db.prepare(sql).get(...(p as never[])) as { n: number }).n);

describe("receipt upload", () => {
  it("previews with dryRun without writing anything", async () => {
    const { db, env, stored, aiCalls } = setup();
    const res = await upload(env, owner, { dryRun: "1", imageDataUrl: DATA_URL, file: png() });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ocr: { merchant: string; total: number; date: string; items: unknown[] } };
    assert.equal(body.ocr.merchant, "SUPERMERCADO EJEMPLO S.A.");
    assert.equal(body.ocr.total, 19040.5);
    assert.equal(body.ocr.date, "2026-11-07");
    assert.equal(aiCalls[0].model, RECEIPT_VISION_MODEL);
    assert.equal(stored.size, 0);
    assert.equal(n(db, "SELECT COUNT(*) n FROM receipts"), 0);
    assert.equal(n(db, "SELECT COUNT(*) n FROM transactions"), 0);
  });

  it("saves the confirmed values, stores the photo and creates the expense once", async () => {
    const { db, env, stored, aiCalls } = setup();
    const ocr = JSON.stringify({ merchant: "Coto", date: "2026-11-07", total: 5000, currency: "ARS", items: [{ name: "Leche", quantity: 1, unit_price: 5000, line_total: 5000 }] });
    const res = await upload(env, owner, { ocr, file: png() });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { createdTransaction: boolean; imageUrl: string; receipt: { transactionId: string } };
    assert.equal(body.createdTransaction, true);
    assert.equal(aiCalls.length, 0, "confirmed values are not re-read");
    assert.equal(stored.size, 1);
    assert.match(body.imageUrl, /^\/api\/receipts\/file\/receipts\/hp\/\d+-ticket_1\.jpg$/);
    const tx = db.prepare("SELECT household_id, date, amount_ars, category_id, source FROM transactions").get() as Record<string, string>;
    assert.deepEqual({ ...tx }, { household_id: "hp", date: "2026-11-07", amount_ars: "5000", category_id: "c-super", source: "receipt" });
    assert.equal(n(db, "SELECT COUNT(*) n FROM receipt_items"), 1);

    // Same ticket again (even another photo): no second receipt, no second expense.
    const dup = await upload(env, owner, { ocr, file: png() });
    assert.equal(dup.status, 409);
    assert.equal(n(db, "SELECT COUNT(*) n FROM receipts"), 1);
    assert.equal(n(db, "SELECT COUNT(*) n FROM transactions"), 1);
    assert.equal(stored.size, 1);
  });

  it("links to the matching bank movement instead of adding a second expense", async () => {
    const { db, env } = setup();
    db.prepare(
      `INSERT INTO transactions (id, household_id, date, description_raw, description_normalized, amount_ars, category_id, ownership, paid_by_user_id, external_fingerprint, source)
       VALUES ('t1','hp','2026-11-08','COTO CICSA','COTO CICSA','5000','c-unc','shared','u1','f'||hex(randomblob(8)),'bbva')`,
    ).run();
    const ocr = JSON.stringify({ merchant: "Coto", date: "2026-11-07", total: 5000, currency: "ARS", items: [] });
    const res = await upload(env, owner, { ocr, file: png() });
    const body = (await res.json()) as { createdTransaction: boolean; receipt: { transactionId: string } };
    assert.equal(body.receipt.transactionId, "t1");
    assert.equal(body.createdTransaction, false);
    assert.equal(n(db, "SELECT COUNT(*) n FROM transactions"), 1);
    assert.equal((db.prepare("SELECT category_id c FROM transactions WHERE id='t1'").get() as { c: string }).c, "c-super");
  });

  it("rejects bad input without calling the model or writing", async () => {
    const { db, env, aiCalls } = setup();
    assert.equal((await upload(env, owner, { dryRun: "1" })).status, 400);
    assert.equal((await upload(env, owner, { dryRun: "1", imageDataUrl: "data:text/html;base64,AAAA" })).status, 400);
    const pdf = new File([new Uint8Array([1])], "x.pdf", { type: "application/pdf" });
    const ocr = JSON.stringify({ merchant: "A", date: "2026-11-07", total: 1, items: [] });
    assert.equal((await upload(env, owner, { ocr, file: pdf })).status, 400);
    assert.equal((await upload(env, owner, { ocr: "{nope", file: png() })).status, 400);
    assert.equal(aiCalls.length, 0);
    assert.equal(n(db, "SELECT COUNT(*) n FROM receipts"), 0);
  });

  it("reports an unreadable ticket as 422, not a crash", async () => {
    const { env } = setup({ response: "no se puede leer" });
    assert.equal((await upload(env, owner, { dryRun: "1", imageDataUrl: DATA_URL })).status, 422);
    const failing = setup(new Error("AI down"));
    assert.equal((await upload(failing.env, owner, { dryRun: "1", imageDataUrl: DATA_URL })).status, 422);
  });

  it("only household members can fetch the photo", async () => {
    const { env, stored } = setup();
    stored.set("receipts/hp/1-a.jpg", { body: new Blob(["img"]), contentType: "image/jpeg" });
    const get = (user: typeof owner, path: string) =>
      handleReceiptFile(new Request(`https://tarask.test${path}`), env, user);
    const ok = await get(owner, "/api/receipts/file/receipts/hp/1-a.jpg");
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "image/jpeg");
    assert.equal((await get(other, "/api/receipts/file/receipts/hp/1-a.jpg")).status, 404);
    assert.equal((await get(owner, "/api/receipts/file/receipts/hp/..%2F..%2Fx")).status, 404);
    assert.equal((await get(owner, "/api/receipts/file/other/hp/1-a.jpg")).status, 404);
  });

  it("reads both Workers AI reply shapes", () => {
    assert.equal(aiReplyText({ response: "a" }), "a");
    assert.equal(aiReplyText({ choices: [{ message: { content: "b" } }] }), "b");
    assert.equal(aiReplyText({ response: { x: 1 } }), '{"x":1}');
    assert.equal(aiReplyText(null), "");
  });
});
