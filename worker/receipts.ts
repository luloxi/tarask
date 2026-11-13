/**
 * `/api/receipts` — supermarket tickets for the active household.
 *
 * GET lists them (items included). POST reads a photo with Workers AI and, once
 * the user confirms, stores it in R2 and links it to the bank movement (or adds
 * the expense). Deletes stay off. The image is read from a data URL the browser
 * sends next to the file: base64-encoding here would burn the free plan's CPU.
 * `GET /api/receipts/file/...` serves the stored photo to household members.
 */

import { matchReceiptToTransactions, type MatchCandidate } from "../src/lib/receipts/match";
import {
  buildSystemPrompt,
  extractJsonObject,
  sanitizeReceiptOcr,
  todayIso,
  type ReceiptOcrResult,
} from "../src/lib/receipts/ocr-core";

import type { SessionUser } from "./auth";
import type { Env } from "./env";
import { activeHousehold, listHouseholds } from "./household";
import { json, num } from "./http";

type ReceiptRow = {
  id: string;
  merchant_name: string | null;
  receipt_date: string | null;
  total_ars: string | null;
  status: string;
  transaction_id: string | null;
};

type ItemRow = {
  id: string;
  receipt_id: string;
  name: string;
  quantity: string | null;
  line_total: string | null;
};

export const RECEIPT_VISION_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_DATA_URL_CHARS = 6 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const FILE_PREFIX = "/api/receipts/file/";

export async function handleReceipts(
  req: Request,
  env: Env,
  user: SessionUser,
): Promise<Response> {
  if (req.method === "POST") return handleReceiptUpload(req, env, user);
  if (req.method !== "GET") return json({ error: "Método no permitido" }, 405);
  const { active } = await activeHousehold(req, env, user.id);
  if (!active) return json({ error: "NO_HOUSEHOLD" }, 400);

  const receipts = await env.DB.prepare(
    `SELECT id, merchant_name, receipt_date, total_ars, status, transaction_id
     FROM receipts
     WHERE household_id = ?
     ORDER BY created_at DESC
     LIMIT 100`,
  )
    .bind(active.id)
    .all<ReceiptRow>();

  const rows = receipts.results ?? [];
  const itemsByReceipt = new Map<string, ItemRow[]>();
  if (rows.length > 0) {
    const marks = rows.map(() => "?").join(", ");
    const items = await env.DB.prepare(
      `SELECT id, receipt_id, name, quantity, line_total
       FROM receipt_items
       WHERE receipt_id IN (${marks})`,
    )
      .bind(...rows.map((row) => row.id))
      .all<ItemRow>();
    for (const item of items.results ?? []) {
      const list = itemsByReceipt.get(item.receipt_id) ?? [];
      list.push(item);
      itemsByReceipt.set(item.receipt_id, list);
    }
  }

  return json({
    receipts: rows.map((row) => ({
      id: row.id,
      merchantName: row.merchant_name,
      receiptDate: row.receipt_date,
      totalArs: row.total_ars == null || row.total_ars === "" ? null : num(row.total_ars),
      status: row.status,
      transactionId: row.transaction_id,
      items: (itemsByReceipt.get(row.id) ?? []).map((item) => ({
        id: item.id,
        name: item.name,
        quantity: item.quantity == null || item.quantity === "" ? null : num(item.quantity),
        lineTotal: item.line_total == null || item.line_total === "" ? null : num(item.line_total),
      })),
    })),
  });
}


/** Model reply → text. Workers AI returns `{ response }` or an OpenAI-style `choices` list. */
export function aiReplyText(result: unknown): string {
  if (typeof result === "string") return result;
  const r = (result ?? {}) as {
    response?: unknown;
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  if (typeof r.response === "string") return r.response;
  if (r.response && typeof r.response === "object") return JSON.stringify(r.response);
  const content = r.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : "";
}

export async function readReceiptWithAi(
  env: Env,
  dataUrl: string,
  now = new Date(),
): Promise<ReceiptOcrResult> {
  if (typeof env.AI.run !== "function") throw new Error("El lector de tickets no está disponible");
  const result = await env.AI.run(RECEIPT_VISION_MODEL, {
    messages: [
      { role: "system", content: buildSystemPrompt(now) },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Extraé los datos del ticket de supermercado. Hoy es ${todayIso(now)}. La fecha del ticket debe ser coherente con el año actual si el ticket es reciente.`,
          },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    temperature: 0,
    max_tokens: 2000,
  });
  return sanitizeReceiptOcr(extractJsonObject(aiReplyText(result)), now);
}

function wantsFlag(v: FormDataEntryValue | null): boolean {
  return v === "1" || v === "true";
}

async function handleReceiptUpload(req: Request, env: Env, user: SessionUser): Promise<Response> {
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > MAX_DATA_URL_CHARS + MAX_IMAGE_BYTES + 65_536) {
    return json({ error: "La foto es demasiado grande. Sacá otra o usá una resolución menor." }, 413);
  }
  const { active } = await activeHousehold(req, env, user.id);
  if (!active) return json({ error: "NO_HOUSEHOLD" }, 400);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "Pedido inválido" }, 400);
  }
  const dryRun = wantsFlag(form.get("dryRun"));
  const createExpense = !(form.get("createExpense") === "0" || form.get("createExpense") === "false");
  const dataUrl = typeof form.get("imageDataUrl") === "string" ? (form.get("imageDataUrl") as string) : "";
  const file = form.get("file");

  // 1. Read the ticket (preview), or take the values the user confirmed.
  let ocr: ReceiptOcrResult;
  const status = "parsed" as const;
  const confirmed = form.get("ocr");
  if (!dryRun && typeof confirmed === "string" && confirmed) {
    try {
      ocr = sanitizeReceiptOcr(JSON.parse(confirmed));
    } catch {
      return json({ error: "Los datos del ticket no son válidos" }, 400);
    }
  } else {
    if (!/^data:image\/(jpeg|png|webp);base64,/.test(dataUrl) || dataUrl.length > MAX_DATA_URL_CHARS) {
      return json({ error: "Falta la imagen del ticket (JPG, PNG o WebP)." }, 400);
    }
    try {
      ocr = await readReceiptWithAi(env, dataUrl);
    } catch (err) {
      console.error("receipt ocr failed", err instanceof Error ? err.message : "error");
      return json(
        { error: "No pudimos leer el ticket. Probá con otra foto, más cerca y con buena luz." },
        422,
      );
    }
  }

  // 2. Which bank movement is this? (read-only, so the preview can show it too)
  let candidates: MatchCandidate[] = [];
  if (ocr.date) {
    const d = new Date(`${ocr.date}T12:00:00Z`);
    const from = new Date(d);
    from.setUTCDate(from.getUTCDate() - 1);
    const to = new Date(d);
    to.setUTCDate(to.getUTCDate() + 2);
    const txs = await env.DB.prepare(
      `SELECT t.id, t.date, t.description_normalized, t.amount_ars, c.slug AS category_slug,
              EXISTS (SELECT 1 FROM receipts r WHERE r.transaction_id = t.id) AS has_receipt
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.household_id = ? AND t.date >= ? AND t.date <= ?`,
    )
      .bind(active.id, from.toISOString().slice(0, 10), to.toISOString().slice(0, 10))
      .all<{
        id: string;
        date: string;
        description_normalized: string;
        amount_ars: string | null;
        category_slug: string | null;
        has_receipt: number;
      }>();
    candidates = (txs.results ?? []).map((t) => ({
      id: t.id,
      date: t.date,
      descriptionNormalized: t.description_normalized,
      amountArs: t.amount_ars != null && t.amount_ars !== "" ? Number(t.amount_ars) : null,
      categorySlug: t.category_slug,
      hasReceipt: Boolean(t.has_receipt),
    }));
  }
  const match = matchReceiptToTransactions(
    { merchantName: ocr.merchant, receiptDate: ocr.date, totalArs: ocr.total },
    candidates,
  );
  const willCreate =
    !match.transactionId && match.candidates.length === 0 && ocr.total != null && Boolean(ocr.date);

  if (dryRun) {
    return json({ dryRun: true, status, ocr, match, willCreateExpense: willCreate });
  }

  // 3. Save. A photo of the same ticket twice must not add a second one.
  if (!(file instanceof File) || file.size === 0) return json({ error: "Falta la imagen" }, 400);
  if (file.size > MAX_IMAGE_BYTES) {
    return json({ error: "La foto es demasiado grande. Sacá otra o usá una resolución menor." }, 413);
  }
  if (!IMAGE_TYPES.has(file.type)) return json({ error: "La foto tiene que ser JPG, PNG o WebP." }, 400);
  if (ocr.total != null && ocr.date) {
    const same = await env.DB.prepare(
      `SELECT id FROM receipts
       WHERE household_id = ? AND receipt_date = ? AND total_ars = ?
         AND COALESCE(merchant_name, '') = ? LIMIT 1`,
    )
      .bind(active.id, ocr.date, String(ocr.total), ocr.merchant ?? "")
      .first<{ id: string }>();
    if (same) {
      return json({ duplicate: true, receiptId: same.id, ocr, match, error: "Este ticket ya estaba cargado." }, 409);
    }
  }

  const receiptId = crypto.randomUUID();
  const safeName =
    file.name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 80) || "ticket";
  const key = `receipts/${active.id}/${Date.now()}-${safeName}`;
  await env.RECEIPTS.put(key, file, { httpMetadata: { contentType: file.type } });
  const imageUrl = `${FILE_PREFIX}${key.split("/").map(encodeURIComponent).join("/")}`;

  const stmts = [
    env.DB.prepare(
      `INSERT INTO receipts (id, household_id, image_url, merchant_name, receipt_date, total_ars, currency, ocr_raw, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      receiptId,
      active.id,
      imageUrl,
      ocr.merchant,
      ocr.date,
      ocr.total != null ? String(ocr.total) : null,
      ocr.currency,
      JSON.stringify(ocr),
      status,
      user.id,
    ),
  ];
  for (let i = 0; i < ocr.items.length; i += 12) {
    const part = ocr.items.slice(i, i + 12);
    stmts.push(
      env.DB.prepare(
        `INSERT INTO receipt_items (id, receipt_id, name, quantity, unit_price, line_total) VALUES ${part
          .map(() => "(?, ?, ?, ?, ?, ?)")
          .join(", ")}`,
      ).bind(
        ...part.flatMap((item) => [
          crypto.randomUUID(),
          receiptId,
          item.name,
          item.quantity != null ? String(item.quantity) : "1",
          item.unit_price != null ? String(item.unit_price) : null,
          item.line_total != null ? String(item.line_total) : null,
        ]),
      ),
    );
  }
  await env.DB.batch(stmts);

  const superCat = await env.DB.prepare(
    "SELECT id FROM categories WHERE slug = 'supermercado' AND (household_id IS NULL OR household_id = ?) LIMIT 1",
  )
    .bind(active.id)
    .first<{ id: string }>();

  let transactionId = match.transactionId;
  let createdTransaction = false;
  if (transactionId) {
    const link = [
      env.DB.prepare("UPDATE receipts SET transaction_id = ?, status = 'matched' WHERE id = ?").bind(
        transactionId,
        receiptId,
      ),
    ];
    if (superCat) {
      link.push(
        env.DB.prepare(
          "UPDATE transactions SET category_id = ?, updated_at = ? WHERE id = ? AND household_id = ?",
        ).bind(superCat.id, Date.now(), transactionId, active.id),
      );
    }
    await env.DB.batch(link);
  } else if (willCreate && createExpense) {
    const merchant = ocr.merchant || "Supermercado";
    const fp = (await sha256Short(`receipt|${ocr.date}|${merchant}|${ocr.total}`)).slice(0, 32);
    const inserted = await env.DB.prepare(
      `INSERT OR IGNORE INTO transactions
         (id, household_id, date, description_raw, description_normalized, amount_ars, category_id,
          ownership, paid_by_user_id, external_fingerprint, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'shared', ?, ?, 'receipt')`,
    )
      .bind(crypto.randomUUID(), active.id, ocr.date, merchant, merchant, String(ocr.total), superCat?.id ?? null, user.id, fp)
      .run();
    const row = await env.DB.prepare(
      "SELECT id FROM transactions WHERE household_id = ? AND external_fingerprint = ?",
    )
      .bind(active.id, fp)
      .first<{ id: string }>();
    if (row) {
      transactionId = row.id;
      createdTransaction = Number(inserted.meta?.changes ?? 0) > 0;
      await env.DB.prepare("UPDATE receipts SET transaction_id = ?, status = 'matched' WHERE id = ?")
        .bind(transactionId, receiptId)
        .run();
    }
  }

  return json({
    receipt: {
      id: receiptId,
      merchantName: ocr.merchant,
      receiptDate: ocr.date,
      totalArs: ocr.total,
      status: transactionId ? "matched" : status,
      transactionId,
    },
    ocr,
    match,
    createdTransaction,
    imageUrl,
  });
}

async function sha256Short(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `GET /api/receipts/file/receipts/<householdId>/<name>`: only for members of that household. */
export async function handleReceiptFile(req: Request, env: Env, user: SessionUser): Promise<Response> {
  if (req.method !== "GET") return json({ error: "Método no permitido" }, 405);
  const path = new URL(req.url).pathname;
  const rest = path.slice(FILE_PREFIX.length);
  let key: string;
  try {
    key = rest.split("/").map((part) => decodeURIComponent(part)).join("/");
  } catch {
    return json({ error: "No encontrado" }, 404);
  }
  const parts = key.split("/");
  if (parts.length < 3 || parts[0] !== "receipts" || parts.some((p) => !p || p === "." || p === "..")) {
    return json({ error: "No encontrado" }, 404);
  }
  const households = await listHouseholds(env, user.id);
  if (!households.some((h) => h.id === parts[1])) return json({ error: "No encontrado" }, 404);
  const object = await env.RECEIPTS.get(key);
  if (!object) return json({ error: "No encontrado" }, 404);
  return new Response(object.body, {
    headers: {
      "content-type": object.httpMetadata?.contentType || "application/octet-stream",
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
    },
  });
}
