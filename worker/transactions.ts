import { normalizeBank } from "../src/lib/banks";
import {
  bumpOccurrenceFingerprint,
  expenseAmountText,
  isCalendarDate,
  manualFingerprintMaterial,
  nextOccurrenceFingerprint,
  occurrenceOfFingerprint,
  parseExpenseAmount,
} from "../src/lib/manual-expense";
import { queryMatchesBbvaInternalTransferTokens } from "../src/lib/bbva/search-tokens";
import type { SessionUser } from "./auth";
import { listVisibleCategories } from "./categories";
import type { Env, WorkerContext } from "./env";
import { activeHousehold, forceSharedOnly, isPersonalName, listMembers } from "./household";
import { json, num, periodRange, sha256Hex } from "./http";
import {
  OUTBOX_LATEST_JOIN,
  buildDeletePayload,
  buildUpsertPayload,
  enqueueOutboxStatements,
  flushOutbox,
  resolveBusinessAction,
  syncStatusFromOutbox,
  type OutboxDraft,
} from "./serpix-sync";
import { reintegroFlags } from "./reintegro-flags";
import { loadExcludedMovementIds } from "./transfer-class";
import {
  similarBinds,
  similarCountFromProbe,
  similarCountSql,
  similarUpdateSql,
  type SimilarFilter,
  type SimilarKey,
} from "./similar-sql";
import { consumosVisibleSql } from "./sql";

const MAX_LIMIT = 100;

type TxRow = {
  id: string;
  date: string;
  description_normalized: string;
  amount_ars: string | null;
  amount_usd: string | null;
  installment: string | null;
  is_payment: number;
  ownership: string;
  paid_by_user_id: string | null;
  source: string;
  bank: string | null;
  category_id: string | null;
  category_slug: string | null;
  category_name: string | null;
  is_business: number;
  sync_type: string | null;
  sync_sent_at: number | null;
  sync_failed_at: number | null;
};

export async function handleTransactions(
  req: Request,
  env: Env,
  user: SessionUser,
  ctx?: WorkerContext,
): Promise<Response> {
  if (req.method === "GET") return listTransactions(req, env, user);
  if (req.method === "POST") return createTransaction(req, env, user);
  if (req.method === "PATCH") return patchTransaction(req, env, user, ctx);
  return json({ error: "Método no permitido" }, 405);
}

export type ServiceMovement = {
  date: string;
  description: string;
  amountArs: number | null;
  amountUsd: number | null;
  category: string | null;
  bank: string | null;
  source: string;
  isPayment: boolean;
  ownership: "shared" | "personal";
};

/** Same listing query as Consumos, without receipts, ids, or sync fields. */
export async function listServiceMovements(
  req: Request,
  env: Env,
  user: SessionUser,
  opts: { limit: number },
): Promise<Response | { total: number; movements: ServiceMovement[] }> {
  const page = await loadTransactionPage(req, env, user, { limit: opts.limit, offset: 0 });
  if (page instanceof Response) return page;
  return {
    total: page.total,
    movements: page.rows.map((row) => ({
      date: row.date,
      description: row.description_normalized,
      amountArs: row.amount_ars != null ? num(row.amount_ars) : null,
      amountUsd: row.amount_usd != null ? num(row.amount_usd) : null,
      category: row.category_name,
      bank: row.bank,
      source: row.source,
      isPayment: Boolean(row.is_payment),
      ownership: row.ownership === "shared" ? "shared" : "personal",
    })),
  };
}

async function listTransactions(req: Request, env: Env, user: SessionUser): Promise<Response> {
  const page = await loadTransactionPage(req, env, user);
  if (page instanceof Response) return page;
  const { active, rows, movements } = page;
  const receipts = await receiptsFor(env, rows.map((row) => row.id));
  const transactions = rows.map((row) => {
    const receipt = receipts.get(row.id) ?? null;
    const category = row.category_id
      ? {
          id: row.category_id,
          slug: row.category_slug ?? "uncategorized",
          name: row.category_name ?? "Sin categoría",
        }
      : null;
    return {
      id: row.id,
      date: row.date,
      descriptionNormalized: row.description_normalized,
      amountArs: row.amount_ars != null ? num(row.amount_ars) : null,
      amountUsd: row.amount_usd != null ? num(row.amount_usd) : null,
      installment: row.installment,
      isPayment: Boolean(row.is_payment),
      ownership: row.ownership === "shared" ? "shared" : "personal",
      paidByUserId: row.paid_by_user_id,
      source: row.source,
      bank: row.bank,
      category,
      hasTicket: Boolean(receipt) || row.source === "receipt",
      receipt,
      canEdit: row.ownership === "shared" || row.paid_by_user_id === user.id,
      isBusiness: Boolean(row.is_business),
      syncStatus: syncStatusFromOutbox(row),
      revisar: movements.revisarIds.has(row.id),
      ...reintegroFlags(row.description_normalized, env.REINTEGRO_PAYEES),
    };
  });

  return json({
    transactions,
    total: page.total,
    limit: page.limit,
    offset: page.offset,
    periods: page.periods,
    categories: page.categories,
    members: page.members,
    viewerUserId: user.id,
    householdId: active.id,
    householdName: active.name,
  });
}

async function loadTransactionPage(
  req: Request,
  env: Env,
  user: SessionUser,
  bounds?: { limit: number; offset: number },
) {
  const { active } = await activeHousehold(req, env, user.id);
  if (!active) return json({ error: "NO_HOUSEHOLD" }, 400);
  const url = new URL(req.url);
  const sharedOnly =
    url.searchParams.get("shared") === "1" ||
    url.searchParams.get("shared") === "true" ||
    forceSharedOnly(active.name);
  const limit = bounds ? bounds.limit : clampInt(url.searchParams.get("limit"), 10, 1, MAX_LIMIT);
  const offset = bounds ? bounds.offset : clampInt(url.searchParams.get("offset"), 0, 0, 100_000);
  const movements = await loadExcludedMovementIds(env.DB, user.id, env.OWN_ACCOUNT_IDS);
  const { where, binds } = buildWhere(url, {
    householdId: active.id,
    userId: user.id,
    sharedOnly,
    reintegroPayees: env.REINTEGRO_PAYEES,
    excludedIds: movements.excludedIds,
    internalIds: movements.internalIds,
  });

  const [page, countRow, periods, categories, members] = await Promise.all([
    env.DB.prepare(
      `SELECT t.id, t.date, t.description_normalized, t.amount_ars, t.amount_usd,
              t.installment, t.is_payment, t.ownership, t.paid_by_user_id, t.source,
              t.bank, t.category_id,
              c.slug AS category_slug, c.name AS category_name,
              t.is_business, sx.type AS sync_type, sx.sent_at AS sync_sent_at,
              sx.failed_at AS sync_failed_at
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       ${OUTBOX_LATEST_JOIN}
       WHERE ${where}
       ORDER BY t.date DESC, t.id DESC
       LIMIT ? OFFSET ?`,
    )
      .bind(...binds, limit, offset)
      .all<TxRow>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS n
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       WHERE ${where}`,
    )
      .bind(...binds)
      .first<{ n: number }>(),
    env.DB.prepare(
      `SELECT DISTINCT substr(t.date, 1, 7) AS period
       FROM transactions t
       WHERE t.household_id = ?
         AND ${sharedOnly ? "t.ownership = 'shared'" : "(t.ownership = 'shared' OR t.paid_by_user_id = ?)"}
       ORDER BY period DESC`,
    )
      .bind(...(sharedOnly ? [active.id] : [active.id, user.id]))
      .all<{ period: string }>(),
    listVisibleCategories(env, active.id),
    listMembers(env, active.id),
  ]);

  return {
    active,
    rows: page.results ?? [],
    total: num(countRow?.n),
    limit,
    offset,
    movements,
    periods: (periods.results ?? []).map((row) => row.period).filter(Boolean),
    categories,
    members,
  };
}

function buildWhere(
  url: URL,
  scope: {
    householdId: string;
    userId: string;
    sharedOnly: boolean;
    reintegroPayees?: string;
    excludedIds?: readonly string[];
    internalIds?: readonly string[];
  },
): { where: string; binds: unknown[] } {
  const binds: unknown[] = [];
  const ph = (value: unknown) => {
    binds.push(value);
    return "?";
  };
  const parts = [
    `t.household_id = ${ph(scope.householdId)}`,
    consumosVisibleSql(scope.reintegroPayees, scope.excludedIds, scope.internalIds),
  ];
  if (scope.sharedOnly) parts.push("t.ownership = 'shared'");
  else parts.push(`(t.ownership = 'shared' OR t.paid_by_user_id = ${ph(scope.userId)})`);

  const ownership = url.searchParams.get("ownership");
  if (ownership === "personal" || ownership === "shared") {
    parts.push(`t.ownership = ${ph(ownership)}`);
  }
  const period = url.searchParams.get("period");
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 80);
  if (period && !q) {
    const range = periodRange(period);
    if (range) {
      parts.push(`t.date >= ${ph(range.start)} AND t.date < ${ph(range.end)}`);
    }
  }
  const categoryId = url.searchParams.get("categoryId");
  if (categoryId) parts.push(`t.category_id = ${ph(categoryId)}`);
  if (url.searchParams.get("uncategorized") === "1") {
    parts.push("(t.category_id IS NULL OR c.slug = 'uncategorized')");
  }
  const ticket = url.searchParams.get("ticket");
  if (ticket === "ticket") {
    parts.push(
      "(t.source = 'receipt' OR EXISTS (SELECT 1 FROM receipts r WHERE r.transaction_id = t.id))",
    );
  } else if (ticket === "no-ticket") {
    parts.push(
      "(IFNULL(t.source, '') != 'receipt' AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.transaction_id = t.id))",
    );
  }
  const currency = url.searchParams.get("currency");
  if (currency === "ars") parts.push("ABS(CAST(IFNULL(t.amount_ars, '0') AS REAL)) > 0");
  else if (currency === "usd") parts.push("ABS(CAST(IFNULL(t.amount_usd, '0') AS REAL)) > 0");
  if (q) {
    const needle = `%${q.toUpperCase().replaceAll("%", "").replaceAll("_", "")}%`;
    const onlyDigits = digitsOf(q);
    const ors = [`upper(t.description_normalized) LIKE ${ph(needle)}`];
    if (queryMatchesBbvaInternalTransferTokens(q)) {
      ors.push(`IFNULL(c.slug, '') = 'transferencia-interna'`);
      ors.push(`upper(t.description_normalized) LIKE '%CUENTA TUYA%'`);
      ors.push(`upper(t.description_normalized) LIKE '%CUENTA PROPIA%'`);
      ors.push(`upper(t.description_normalized) LIKE '%TRANSFERENCIA INMEDIATA%'`);
    }
    if (onlyDigits) {
      const digitNeedle = `%${onlyDigits}%`;
      ors.push(
        `replace(replace(replace(IFNULL(t.amount_ars, ''), '.', ''), ',', ''), '-', '') LIKE ${ph(digitNeedle)}`,
      );
      ors.push(
        `replace(replace(replace(IFNULL(t.amount_usd, ''), '.', ''), ',', ''), '-', '') LIKE ${ph(digitNeedle)}`,
      );
    }
    parts.push(`(${ors.join(" OR ")})`);
  }
  return { where: parts.join(" AND "), binds };
}

async function receiptsFor(env: Env, ids: string[]) {
  const map = new Map<string, {
    id: string;
    merchantName: string | null;
    receiptDate: string | null;
    totalArs: number | null;
    items: Array<{
      id: string;
      name: string;
      quantity: number | null;
      unitPrice: number | null;
      lineTotal: number | null;
      productCategory: string | null;
    }>;
  }>();
  if (ids.length === 0) return map;
  const placeholders = ids.map(() => "?").join(", ");
  const receipts = await env.DB.prepare(
    `SELECT id, transaction_id, merchant_name, receipt_date, total_ars
     FROM receipts WHERE transaction_id IN (${placeholders})`,
  )
    .bind(...ids)
    .all<{
      id: string;
      transaction_id: string;
      merchant_name: string | null;
      receipt_date: string | null;
      total_ars: string | null;
    }>();
  const found = receipts.results ?? [];
  if (found.length === 0) return map;
  const receiptIds = found.map((row) => row.id);
  const itemPlaceholders = receiptIds.map(() => "?").join(", ");
  const items = await env.DB.prepare(
    `SELECT id, receipt_id, name, quantity, unit_price, line_total, product_category
     FROM receipt_items WHERE receipt_id IN (${itemPlaceholders})`,
  )
    .bind(...receiptIds)
    .all<{
      id: string;
      receipt_id: string;
      name: string;
      quantity: string | null;
      unit_price: string | null;
      line_total: string | null;
      product_category: string | null;
    }>();
  const byReceipt = new Map<string, Array<{
    id: string;
    name: string;
    quantity: number | null;
    unitPrice: number | null;
    lineTotal: number | null;
    productCategory: string | null;
  }>>();
  for (const item of items.results ?? []) {
    const list = byReceipt.get(item.receipt_id) ?? [];
    list.push({
      id: item.id,
      name: item.name,
      quantity: item.quantity != null ? num(item.quantity) : null,
      unitPrice: item.unit_price != null ? num(item.unit_price) : null,
      lineTotal: item.line_total != null ? num(item.line_total) : null,
      productCategory: item.product_category,
    });
    byReceipt.set(item.receipt_id, list);
  }
  for (const receipt of found) {
    if (!receipt.transaction_id || map.has(receipt.transaction_id)) continue;
    map.set(receipt.transaction_id, {
      id: receipt.id,
      merchantName: receipt.merchant_name,
      receiptDate: receipt.receipt_date,
      totalArs: receipt.total_ars != null ? num(receipt.total_ars) : null,
      items: byReceipt.get(receipt.id) ?? [],
    });
  }
  return map;
}

async function createTransaction(req: Request, env: Env, user: SessionUser): Promise<Response> {
  const { active } = await activeHousehold(req, env, user.id);
  if (!active) return json({ error: "NO_HOUSEHOLD" }, 400);
  const body = (await req.json().catch(() => null)) as {
    date?: string;
    description?: string;
    amountArs?: number | string | null;
    amountUsd?: number | string | null;
    categoryId?: string | null;
    paidByUserId?: string | null;
    ownership?: string;
    bank?: string | null;
    items?: Array<{
      name?: string;
      quantity?: number | null;
      unitPrice?: number | null;
      lineTotal?: number | null;
      productCategory?: string | null;
    }>;
  } | null;
  if (!body) return json({ error: "JSON inválido" }, 400);
  const date = (body.date ?? "").trim();
  const description = (body.description ?? "").trim().replace(/\s+/g, " ");
  if (!isCalendarDate(date)) {
    return json({ error: "Fecha inválida (YYYY-MM-DD)" }, 400);
  }
  if (!description || description.length > 180) {
    return json({ error: "Falta la descripción" }, 400);
  }

  const items = Array.isArray(body.items) ? body.items.filter((item) => item?.name?.trim()) : [];
  const parsedArs = parseExpenseAmount(body.amountArs);
  const parsedUsd = parseExpenseAmount(body.amountUsd);
  if (!parsedArs.ok || !parsedUsd.ok) {
    return json({ error: "Monto inválido" }, 400);
  }
  let amountArs = parsedArs.amount;
  const amountUsd = parsedUsd.amount;
  if (items.length > 0 && (amountArs == null || amountArs === 0)) {
    const sum = items.reduce((acc, item) => {
      const line = item.lineTotal != null
        ? Number(item.lineTotal)
        : item.unitPrice != null && item.quantity != null
          ? Number(item.unitPrice) * Number(item.quantity)
          : 0;
      return acc + (Number.isFinite(line) ? Math.abs(line) : 0);
    }, 0);
    if (sum > 0) amountArs = sum;
  }
  if ((amountArs == null || amountArs === 0) && (amountUsd == null || amountUsd === 0)) {
    return json({ error: "Indicá un monto en $ o USD" }, 400);
  }

  const members = await listMembers(env, active.id);
  const paidBy = body.paidByUserId && members.some((m) => m.userId === body.paidByUserId)
    ? body.paidByUserId
    : user.id;
  let categoryId = body.categoryId ?? null;
  if (categoryId) {
    const cat = await env.DB.prepare(
      `SELECT id FROM categories
       WHERE id = ? AND (household_id IS NULL OR household_id = ?)
       LIMIT 1`,
    )
      .bind(categoryId, active.id)
      .first<{ id: string }>();
    if (!cat) categoryId = null;
  }
  if (!categoryId && items.length > 0) {
    categoryId = await categoryIdBySlug(env, "supermercado");
  }
  if (!categoryId) categoryId = await categoryIdBySlug(env, "uncategorized");

  const amountArsText = expenseAmountText(amountArs);
  const amountUsdText = expenseAmountText(amountUsd);
  const material = manualFingerprintMaterial({
    householdId: active.id,
    date,
    description,
    amountArs: amountArsText,
    amountUsd: amountUsdText,
  });
  let alloc = await allocateManualFingerprint(env, active.id, material, null);
  const txId = crypto.randomUUID();
  const now = Date.now();
  const ownership = body.ownership === "shared" ? "shared" : "personal";
  const source = items.length > 0 ? "receipt" : "manual";
  const insertTx = (fingerprint: string) =>
    env.DB.prepare(
      `INSERT INTO transactions (
         id, household_id, date, description_raw, description_normalized,
         amount_ars, amount_usd, category_id, ownership, paid_by_user_id,
         external_fingerprint, source, bank, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        txId,
        active.id,
        date,
        description,
        description,
        amountArsText,
        amountUsdText,
        categoryId,
        ownership,
        paidBy,
        fingerprint,
        source,
        normalizeBank(body.bank),
        now,
        now,
      )
      .run();
  try {
    await insertTx(alloc.fingerprint);
  } catch (err) {
    if (!isUniqueConstraint(err)) {
      if (isConstraint(err)) return json({ error: "Ese gasto ya está cargado" }, 409);
      throw err;
    }
    const again = await allocateManualFingerprint(env, active.id, material, null);
    const fingerprint =
      again.fingerprint === alloc.fingerprint
        ? bumpOccurrenceFingerprint(alloc.base, alloc.fingerprint)
        : again.fingerprint;
    alloc = {
      ...again,
      fingerprint,
      possibleDuplicate: true,
      duplicateOf: again.duplicateOf ?? alloc.duplicateOf,
    };
    try {
      await insertTx(fingerprint);
    } catch (err2) {
      if (isConstraint(err2)) return json({ error: "Ese gasto ya está cargado" }, 409);
      throw err2;
    }
  }

  let receipt: { id: string } | null = null;
  if (items.length > 0) {
    const receiptId = crypto.randomUUID();
    const statements = [
      env.DB.prepare(
        `INSERT INTO receipts (
           id, household_id, image_url, merchant_name, receipt_date, total_ars,
           currency, ocr_raw, status, transaction_id, created_by, created_at
         ) VALUES (?, ?, 'manual://expense', ?, ?, ?, 'ARS', ?, 'matched', ?, ?, ?)`,
      ).bind(
        receiptId,
        active.id,
        description,
        date,
        amountArsText,
        JSON.stringify({ source: "manual", items }),
        txId,
        user.id,
        now,
      ),
    ];
    for (const item of items) {
      const qty = item.quantity != null ? Number(item.quantity) : 1;
      const unit = item.unitPrice != null ? Number(item.unitPrice) : null;
      let line = item.lineTotal != null ? Number(item.lineTotal) : null;
      if (line == null && unit != null && Number.isFinite(qty)) line = unit * qty;
      statements.push(
        env.DB.prepare(
          `INSERT INTO receipt_items
             (id, receipt_id, name, quantity, unit_price, line_total, product_category)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          crypto.randomUUID(),
          receiptId,
          item.name!.trim(),
          Number.isFinite(qty) ? String(qty) : "1",
          unit != null && Number.isFinite(unit) ? String(unit) : null,
          line != null && Number.isFinite(line) ? String(line) : null,
          item.productCategory?.trim() || null,
        ),
      );
    }
    await env.DB.batch(statements);
    receipt = { id: receiptId };
  }
  const movements = await loadExcludedMovementIds(env.DB, user.id, env.OWN_ACCOUNT_IDS);
  return json({
    transaction: {
      id: txId,
      date,
      descriptionNormalized: description,
      amountArs,
      amountUsd: amountUsdText != null ? Number(amountUsdText) : null,
      ownership,
      categoryId,
      revisar: movements.revisarIds.has(txId),
      ...reintegroFlags(description, env.REINTEGRO_PAYEES),
    },
    receipt,
    ...(alloc.possibleDuplicate
      ? { possibleDuplicate: true, duplicateOf: alloc.duplicateOf }
      : {}),
  }, 201);
}

type TxBefore = {
  id: string;
  ownership: string;
  paid_by_user_id: string | null;
  category_id: string | null;
  description_normalized: string;
  external_fingerprint: string;
  is_payment: number;
  is_credit: number;
  is_business: number;
  business_version: number | null;
  date: string;
  amount_ars: string | null;
  amount_usd: string | null;
  source: string;
  category_name: string | null;
  category_slug: string | null;
};

async function patchTransaction(
  req: Request,
  env: Env,
  user: SessionUser,
  ctx?: WorkerContext,
): Promise<Response> {
  const { active, list } = await activeHousehold(req, env, user.id);
  if (!active) return json({ error: "NO_HOUSEHOLD" }, 400);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.id !== "string") return json({ error: "Falta id" }, 400);

  const before = await env.DB.prepare(
    `SELECT t.id, t.ownership, t.paid_by_user_id, t.category_id, t.description_normalized,
            t.external_fingerprint, t.is_payment, t.is_credit, t.is_business, t.business_version,
            t.date, t.amount_ars, t.amount_usd, t.source, c.name AS category_name, c.slug AS category_slug
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.id = ? AND t.household_id = ?
     LIMIT 1`,
  )
    .bind(body.id, active.id)
    .first<TxBefore>();
  if (!before) return json({ error: "No encontrado" }, 404);
  if (before.ownership !== "shared" && before.paid_by_user_id !== user.id) {
    return json({ error: "Sin permiso" }, 403);
  }

  const targetHouseholdId = typeof body.targetHouseholdId === "string" ? body.targetHouseholdId.trim() : "";
  const wantsPersonalMove = body.ownership === "personal" && !targetHouseholdId;
  if (targetHouseholdId && targetHouseholdId !== active.id) {
    return moveTransaction(env, user, before, active.id, targetHouseholdId, list, ctx);
  }
  if (wantsPersonalMove) {
    const personal = list.find((row) => isPersonalName(row.name) && row.id !== active.id);
    if (personal) return moveTransaction(env, user, before, active.id, personal.id, list, ctx);
  }

  const sets: string[] = [];
  const binds: unknown[] = [];
  const set = (column: string, value: unknown) => {
    sets.push(`${column} = ?`);
    binds.push(value);
  };

  if ("categoryId" in body) set("category_id", body.categoryId || null);
  if (body.ownership === "personal" || body.ownership === "shared") {
    set("ownership", body.ownership);
    if (body.ownership === "personal") set("paid_by_user_id", user.id);
  }
  if ("paidByUserId" in body && body.ownership !== "personal") {
    set("paid_by_user_id", typeof body.paidByUserId === "string" ? body.paidByUserId : null);
  }
  let nextDate = before.date;
  let nextArs = before.amount_ars;
  let nextUsd = before.amount_usd;
  if ("date" in body) {
    if (typeof body.date !== "string" || !isCalendarDate(body.date)) {
      return json({ error: "Fecha inválida (YYYY-MM-DD)" }, 400);
    }
    nextDate = body.date;
    set("date", body.date);
  }
  let nextDescription = before.description_normalized;
  if (typeof body.description === "string" && body.description.trim()) {
    const description = [...body.description.trim()].slice(0, 500).join("");
    nextDescription = description;
    set("description_normalized", description);
    set("description_raw", description);
  }
  if ("amountArs" in body) {
    const parsed = parseExpenseAmount(body.amountArs);
    if (!parsed.ok) return json({ error: "Monto inválido" }, 400);
    nextArs = expenseAmountText(parsed.amount);
    set("amount_ars", nextArs);
  }
  if ("amountUsd" in body) {
    const parsed = parseExpenseAmount(body.amountUsd);
    if (!parsed.ok) return json({ error: "Monto inválido" }, 400);
    nextUsd = expenseAmountText(parsed.amount);
    set("amount_usd", nextUsd);
  }
  if (
    (nextArs == null || nextArs === "0.00") &&
    (nextUsd == null || nextUsd === "0.00") &&
    ("amountArs" in body || "amountUsd" in body)
  ) {
    return json({ error: "Indicá un monto en $ o USD" }, 400);
  }
  if ("bank" in body) set("bank", normalizeBank(typeof body.bank === "string" ? body.bank : null));
  if ("splitPct" in body) {
    const pct = body.splitPct;
    if (typeof pct !== "number" || !Number.isInteger(pct) || pct < 0 || pct > 100) {
      return json({ error: "Porcentaje inválido" }, 400);
    }
    set("split_pct", pct);
  }
  let alloc: ManualFingerprint | null = null;
  let fingerprintSlot: number | null = null;
  if (
    (before.source === "manual" || before.source === "receipt") &&
    (nextDate !== before.date ||
      nextArs !== before.amount_ars ||
      nextUsd !== before.amount_usd ||
      nextDescription !== before.description_normalized)
  ) {
    alloc = await allocateManualFingerprint(
      env,
      active.id,
      manualFingerprintMaterial({
        householdId: active.id,
        date: nextDate,
        description: nextDescription,
        amountArs: nextArs,
        amountUsd: nextUsd,
      }),
      before.id,
    );
    fingerprintSlot = binds.length;
    set("external_fingerprint", alloc.fingerprint);
  }
  if (body.isPayment === true || body.isPayment === false) set("is_payment", body.isPayment ? 1 : 0);

  const wantsInternal = body.internalTransfer === true || body.internalTransfer === 1 || body.internalTransfer === "true";
  const wantsReintegro = body.householdReimbursement === true || body.householdReimbursement === 1 || body.householdReimbursement === "true";
  const wantsCubierto = body.householdBillCovered === true || body.householdBillCovered === 1 || body.householdBillCovered === "true";
  if (wantsInternal || wantsReintegro || wantsCubierto) set("is_payment", 1);
  if (wantsInternal && !("categoryId" in body)) {
    const internal = await categoryIdBySlug(env, "transferencia-interna");
    if (internal) set("category_id", internal);
    set("is_credit", 0);
  }

  const now = Date.now();
  const nextIsPayment =
    wantsInternal || wantsReintegro || wantsCubierto || body.isPayment === true
      ? 1
      : body.isPayment === false
        ? 0
        : before.is_payment;
  const nextOwnership =
    body.ownership === "personal" || body.ownership === "shared" ? body.ownership : before.ownership;
  const syncFields =
    "date" in body ||
    "amountArs" in body ||
    "amountUsd" in body ||
    "categoryId" in body ||
    typeof body.description === "string";
  const mark = body.isBusiness === true ? true : body.isBusiness === false ? false : null;
  const action = resolveBusinessAction({
    isBusiness: before.is_business,
    businessVersion: before.business_version,
    mark,
    nextIsPayment,
    nextOwnership,
    syncFields,
    now,
  });
  if (action.kind === "reject") return json({ error: action.error }, action.status);

  let nextCategoryName = before.category_name;
  let nextCategorySlug = before.category_slug;
  if ("categoryId" in body && !body.categoryId) {
    nextCategoryName = null;
    nextCategorySlug = null;
  } else if (
    action.kind === "upsert" &&
    typeof body.categoryId === "string" &&
    body.categoryId !== before.category_id
  ) {
    const cat = await env.DB.prepare(
      "SELECT name, slug FROM categories WHERE id = ? LIMIT 1",
    )
      .bind(body.categoryId)
      .first<{ name: string; slug: string }>();
    nextCategoryName = cat?.name ?? null;
    nextCategorySlug = cat?.slug ?? null;
  }

  let draft: OutboxDraft | null = null;
  if (action.kind === "upsert" || action.kind === "delete") {
    const eventId = crypto.randomUUID();
    const outboxId = crypto.randomUUID();
    if (action.kind === "delete") {
      draft = {
        id: outboxId,
        txId: before.id,
        eventId,
        type: "delete",
        payload: buildDeletePayload({
          eventId,
          sourceId: before.id,
          version: action.version,
        }),
        createdAt: now,
      };
    } else {
      const nextDate =
        "date" in body && typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
          ? body.date
          : before.date;
      const nextDescription =
        typeof body.description === "string" && body.description.trim()
          ? [...body.description.trim()].slice(0, 500).join("")
          : before.description_normalized;
      const built = buildUpsertPayload({
        eventId,
        sourceId: before.id,
        version: action.version,
        occurredAt: nextDate,
        isCredit: wantsInternal ? 0 : before.is_credit,
        amountArs: "amountArs" in body ? moneyOrNull(body.amountArs) : before.amount_ars,
        amountUsd: "amountUsd" in body ? moneyOrNull(body.amountUsd) : before.amount_usd,
        description: nextDescription,
        categoryName: nextCategoryName,
        categorySlug: nextCategorySlug,
      });
      if (!built.ok) return json({ error: built.error }, 400);
      draft = {
        id: outboxId,
        txId: before.id,
        eventId,
        type: "upsert",
        payload: built.body,
        createdAt: now,
      };
    }
    set("is_business", action.isBusiness);
    set("business_version", action.version);
  }

  let possibleDuplicate = alloc?.possibleDuplicate ?? false;
  let duplicateOf = alloc?.duplicateOf ?? null;
  if (sets.length > 0) {
    set("updated_at", now);
    const runUpdate = async () => {
      const update = env.DB.prepare(
        `UPDATE transactions SET ${sets.join(", ")} WHERE id = ? AND household_id = ?`,
      ).bind(...binds, before.id, active.id);
      if (draft) {
        await env.DB.batch([update, ...enqueueOutboxStatements(env.DB, draft)]);
        const push = flushOutbox(env, [draft.id]);
        if (ctx) ctx.waitUntil(push);
        else void push;
      } else {
        await update.run();
      }
    };
    try {
      await runUpdate();
    } catch (err) {
      if (!(alloc && fingerprintSlot != null && isUniqueConstraint(err))) {
        if (isConstraint(err)) return json({ error: "Ese gasto ya está cargado" }, 409);
        throw err;
      }
      const again = await allocateManualFingerprint(env, active.id, alloc.material, before.id);
      let fingerprint = again.fingerprint;
      if (fingerprint === binds[fingerprintSlot]) {
        fingerprint = bumpOccurrenceFingerprint(alloc.base, String(fingerprint));
      }
      binds[fingerprintSlot] = fingerprint;
      possibleDuplicate = true;
      duplicateOf = again.duplicateOf ?? duplicateOf;
      try {
        await runUpdate();
      } catch (err2) {
        if (isConstraint(err2)) return json({ error: "Ese gasto ya está cargado" }, 409);
        throw err2;
      }
    }
  }

  let similarUpdated = 0;
  let similarCount = 0;
  let similarCapped = false;
  const categoryId = typeof body.categoryId === "string" ? body.categoryId : null;
  const applyToSimilar =
    body.applyToSimilar === true || body.applyToSimilar === 1 || body.applyToSimilar === "true";
  const sharedOnly = forceSharedOnly(active.name);
  const similarKey: SimilarKey = {
    householdId: active.id,
    description: before.description_normalized,
    excludeId: before.id,
    userId: user.id,
  };
  if (
    categoryId &&
    before.description_normalized &&
    (categoryId !== before.category_id || applyToSimilar)
  ) {
    const filter: SimilarFilter = { sharedOnly, extra: "category_id IS NOT ?" };
    const probe = await readSimilar(env, filter, similarKey, [categoryId]);
    similarCount = probe.total;
    similarCapped = probe.capped;
    if (applyToSimilar) {
      similarUpdated = await writeSimilar(
        env,
        "category_id = ?, updated_at = ?",
        [categoryId, now],
        filter,
        similarKey,
        [categoryId],
      );
    }
  }

  let reintegroCount = 0;
  let cubiertoCount = 0;
  if ((wantsReintegro || wantsCubierto) && before.description_normalized) {
    const filter: SimilarFilter = { sharedOnly, extra: "is_payment = 0" };
    const probe = await readSimilar(env, filter, similarKey, []);
    if (wantsReintegro) reintegroCount = probe.total;
    if (wantsCubierto) cubiertoCount = probe.total;
    if (applyToSimilar) {
      similarUpdated = await writeSimilar(
        env,
        "is_payment = 1, updated_at = ?",
        [now],
        filter,
        similarKey,
        [],
      );
      similarCount = probe.total;
      similarCapped = probe.capped;
    }
  }

  return json({
    ok: true,
    learned: 0,
    similarUpdated,
    similarCount,
    reintegroCount,
    cubiertoCount,
    appliedToSimilar: applyToSimilar,
    moved: false,
    householdReimbursement: wantsReintegro,
    householdBillCovered: wantsCubierto,
    ...(similarCapped ? { similarCapped: true } : {}),
    ...(possibleDuplicate ? { possibleDuplicate: true, duplicateOf } : {}),
  });
}

async function readSimilar(
  env: Env,
  filter: SimilarFilter,
  key: SimilarKey,
  extra: readonly unknown[],
): Promise<{ total: number; capped: boolean }> {
  const row = await env.DB.prepare(similarCountSql(filter))
    .bind(...similarBinds(filter, key, extra))
    .first<{ n: number }>();
  return similarCountFromProbe(num(row?.n));
}

async function writeSimilar(
  env: Env,
  setSql: string,
  setBinds: readonly unknown[],
  filter: SimilarFilter,
  key: SimilarKey,
  extra: readonly unknown[],
): Promise<number> {
  const updated = await env.DB.prepare(similarUpdateSql(setSql, filter))
    .bind(...setBinds, ...similarBinds(filter, key, extra))
    .run();
  return num(updated.meta?.changes);
}

async function moveTransaction(
  env: Env,
  user: SessionUser,
  before: TxBefore,
  fromId: string,
  toId: string,
  list: Array<{ id: string; name: string }>,
  ctx?: WorkerContext,
): Promise<Response> {
  const dest = list.find((row) => row.id === toId);
  if (!dest) return json({ error: "No pertenecés a ese hogar" }, 403);
  const ownership = isPersonalName(dest.name) ? "personal" : "shared";
  const now = Date.now();
  const clearBusiness = before.is_business === 1;
  try {
    const version = clearBusiness
      ? resolveBusinessAction({
          isBusiness: 1,
          businessVersion: before.business_version,
          mark: false,
          nextIsPayment: before.is_payment,
          nextOwnership: "personal",
          syncFields: false,
          now,
        })
      : null;
    const update = clearBusiness
      ? env.DB.prepare(
          `UPDATE transactions
           SET household_id = ?, ownership = ?, paid_by_user_id = ?, updated_at = ?,
               is_business = 0, business_version = ?
           WHERE id = ? AND household_id = ?`,
        ).bind(
          toId,
          ownership,
          user.id,
          now,
          version && version.kind === "delete" ? version.version : now,
          before.id,
          fromId,
        )
      : env.DB.prepare(
          `UPDATE transactions
           SET household_id = ?, ownership = ?, paid_by_user_id = ?, updated_at = ?
           WHERE id = ? AND household_id = ?`,
        ).bind(toId, ownership, user.id, now, before.id, fromId);
    if (clearBusiness && version && version.kind === "delete") {
      const eventId = crypto.randomUUID();
      const draft: OutboxDraft = {
        id: crypto.randomUUID(),
        txId: before.id,
        eventId,
        type: "delete",
        payload: buildDeletePayload({
          eventId,
          sourceId: before.id,
          version: version.version,
        }),
        createdAt: now,
      };
      await env.DB.batch([update, ...enqueueOutboxStatements(env.DB, draft)]);
      const push = flushOutbox(env, [draft.id]);
      if (ctx) ctx.waitUntil(push);
      else void push;
    } else {
      await update.run();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (/UNIQUE|constraint/i.test(message)) {
      return json({ error: "Ese movimiento ya existe en el hogar destino" }, 409);
    }
    return json({ error: "No se pudo mover" }, 500);
  }
  return json({
    ok: true,
    moved: true,
    targetHouseholdId: toId,
    learned: 0,
    similarUpdated: 0,
    similarCount: 0,
    appliedToSimilar: false,
  });
}

type ManualFingerprint = {
  material: string;
  base: string;
  fingerprint: string;
  possibleDuplicate: boolean;
  duplicateOf: string | null;
};

function isConstraint(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /UNIQUE|constraint/i.test(message);
}

function isUniqueConstraint(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /UNIQUE/i.test(message);
}

async function allocateManualFingerprint(
  env: Env,
  householdId: string,
  material: string,
  excludeId: string | null,
): Promise<ManualFingerprint> {
  const base = (await sha256Hex(material)).slice(0, 32);
  const res = await env.DB.prepare(
    `SELECT id, external_fingerprint
     FROM transactions
     WHERE household_id = ?
       AND (? IS NULL OR id <> ?)
       AND (
         external_fingerprint = ?
         OR external_fingerprint GLOB ?
       )`,
  )
    .bind(householdId, excludeId, excludeId, base, `${base}#[0-9]*`)
    .all<{ id: string; external_fingerprint: string }>();
  const family = (res.results ?? []).filter(
    (row) => occurrenceOfFingerprint(row.external_fingerprint, base) != null,
  );
  const next = nextOccurrenceFingerprint(
    base,
    family.map((row) => row.external_fingerprint),
  );
  const baseRow = family.find((row) => row.external_fingerprint === base);
  return {
    material,
    base,
    fingerprint: next.fingerprint,
    possibleDuplicate: next.possibleDuplicate,
    duplicateOf: next.possibleDuplicate ? (baseRow?.id ?? null) : null,
  };
}

async function categoryIdBySlug(env: Env, slug: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT id FROM categories WHERE slug = ? AND household_id IS NULL LIMIT 1",
  )
    .bind(slug)
    .first<{ id: string }>();
  return row?.id ?? null;
}



function moneyOrNull(value: unknown): string | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return String(n);
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = raw == null ? fallback : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function digitsOf(value: string): string {
  let out = "";
  for (const ch of value) {
    if (ch >= "0" && ch <= "9") out += ch;
  }
  return out;
}
