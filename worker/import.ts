/**
 * Statement imports on the Worker.
 *
 * The Workers free plan gives a request ~10 ms of CPU, which a spreadsheet or
 * PDF parse blows through. So the browser reads the file (same parsers as
 * before, `src/lib/import/client.ts`) and posts the parsed movements here. This
 * module only validates, de-duplicates against D1 and writes, with raw SQL and
 * batches. PDFs are the exception: text extraction is Workers AI, an awaited
 * subrequest that costs no CPU, so `/api/import/pdf-text` runs it server-side.
 *
 * Rules carried over from the old `importBbvaFile` (`src/lib/import/bbva.ts`):
 * lands in the user's Personal space (never Casita / Invoice IOG), one statement
 * row per file, fingerprint + logical-key de-duplication, owner-card filtering,
 * learned merchant rules before the static category rules, and the card saldo
 * written to `debt_settings`.
 */

import { filterToPrimaryCard, normalizeCardLast4, pickPrimaryCardLast4 } from "../src/lib/bbva/card-account";
import {
  amountDayKey,
  isAnonymousMerchant,
  logicalExpenseKey,
  logicalMerchantKey,
} from "../src/lib/import/dedupe";
import { buildImportMessage, otherCardNote } from "../src/lib/import/messages";
import {
  emptyParseMessage,
  isPeriodDebtSource,
  resolveImportBank,
  statementTxSource,
} from "../src/lib/import/source";
import type { SessionUser } from "./auth";
import type { D1Prepared, Env } from "./env";
import { listHouseholds, type HouseholdRow } from "./household";
import { json } from "./http";

export const MAX_MOVEMENTS_PER_REQUEST = 600;
const MAX_BODY_BYTES = 1_500_000;
const MAX_PDF_BYTES = 8 * 1024 * 1024;
/** D1 allows 100 bound parameters per statement: 5 rows × 18 columns = 90. */
const ROWS_PER_INSERT = 5;
const STATEMENTS_PER_BATCH = 25;
/** Fingerprints per `IN (...)`: one parameter is the household. */
const IN_CHUNK = 90;

const PROTECTED_NAMES = new Set(["casita", "invoice iog"]);
const PERSONAL_NAMES = ["personal", "mi espacio"];

export type ImportMovement = {
  date: string;
  descriptionRaw: string;
  descriptionNormalized: string;
  installment: string | null;
  amountArs: number | null;
  amountUsd: number | null;
  isPayment: boolean;
  isCredit: boolean;
  fingerprint: string;
  categoryHint: string | null;
  /** Suggested slug from the static rules, computed in the browser. */
  categorySlug: string | null;
  cardLast4: string | null;
};

export type ImportRequest = {
  fileName: string;
  bank: string | null;
  source: string;
  detectedBank: string | null;
  fileKind: string;
  cardSaldo: { ars: number; usd: number | null } | null;
  movements: ImportMovement[];
  /** Continue a statement created by an earlier chunk of the same file. */
  statementId: string | null;
  /** Rows the browser already dropped as repeated inside the file. */
  duplicatesInFile: number;
  /** Rows the file had before any filtering. */
  totalRows: number;
};

export type ImportResponse = {
  statementId: string | null;
  total: number;
  uniqueInFile: number;
  duplicatesInFile: number;
  alreadyExists: number;
  inserted: number;
  skipped: number;
  skippedOtherCard: number;
  primaryCardLast4: string | null;
  learnedHits: number;
  overlapPct: number;
  fullyDuplicate: boolean;
  warning: string | null;
  message: string;
  hint: string | null;
  source: string;
  bank: string;
};

class BadRequest extends Error {}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FP_RE = /^[a-f0-9]{32}$/;
const SLUG_RE = /^[a-z0-9-]{1,60}$/;

function str(v: unknown, max: number): string | null {
  return typeof v === "string" ? v.slice(0, max) : null;
}

function amount(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > 1e11) {
    throw new BadRequest("Importe inválido en el archivo");
  }
  return v;
}

export function parseImportRequest(raw: unknown): ImportRequest {
  if (!raw || typeof raw !== "object") throw new BadRequest("Falta el contenido del archivo");
  const o = raw as Record<string, unknown>;
  const list = Array.isArray(o.movements) ? o.movements : null;
  if (!list) throw new BadRequest("Faltan los movimientos");
  if (list.length > MAX_MOVEMENTS_PER_REQUEST) {
    throw new BadRequest(`Demasiados movimientos juntos (máximo ${MAX_MOVEMENTS_PER_REQUEST} por envío)`);
  }
  const movements = list.map((item, i): ImportMovement => {
    const m = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const date = str(m.date, 10);
    const fingerprint = str(m.fingerprint, 64);
    const desc = str(m.descriptionNormalized, 300)?.trim();
    if (!date || !DATE_RE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
      throw new BadRequest(`Fecha inválida en la fila ${i + 1}`);
    }
    if (!fingerprint || !FP_RE.test(fingerprint)) throw new BadRequest(`Fila ${i + 1} sin huella válida`);
    if (!desc) throw new BadRequest(`Fila ${i + 1} sin descripción`);
    const amountArs = amount(m.amountArs);
    const amountUsd = amount(m.amountUsd);
    if (amountArs == null && amountUsd == null) throw new BadRequest(`Fila ${i + 1} sin importe`);
    const hint = str(m.categoryHint, 60);
    const slug = str(m.categorySlug, 60);
    return {
      date,
      descriptionRaw: str(m.descriptionRaw, 300)?.trim() || desc,
      descriptionNormalized: desc,
      installment: str(m.installment, 20) || null,
      amountArs,
      amountUsd,
      isPayment: m.isPayment === true,
      isCredit: m.isCredit === true,
      fingerprint,
      categoryHint: hint && SLUG_RE.test(hint) ? hint : null,
      categorySlug: slug && SLUG_RE.test(slug) ? slug : null,
      cardLast4: normalizeCardLast4(str(m.cardLast4, 12)),
    };
  });
  const saldo = o.cardSaldo && typeof o.cardSaldo === "object" ? (o.cardSaldo as Record<string, unknown>) : null;
  const cardSaldo =
    saldo && typeof saldo.ars === "number" && Number.isFinite(saldo.ars)
      ? {
          ars: saldo.ars,
          usd: typeof saldo.usd === "number" && Number.isFinite(saldo.usd) ? saldo.usd : null,
        }
      : null;
  const statementId = str(o.statementId, 64);
  return {
    fileName: str(o.fileName, 200)?.trim() || "archivo",
    bank: str(o.bank, 40),
    source: str(o.source, 30)?.trim() || "xlsx",
    detectedBank: str(o.detectedBank, 40),
    fileKind: str(o.fileKind, 10) ?? "unknown",
    cardSaldo,
    movements,
    statementId: statementId && /^[A-Za-z0-9-]{8,64}$/.test(statementId) ? statementId : null,
    duplicatesInFile:
      typeof o.duplicatesInFile === "number" && o.duplicatesInFile >= 0 && o.duplicatesInFile < 1e6
        ? Math.floor(o.duplicatesInFile)
        : 0,
    totalRows:
      typeof o.totalRows === "number" && o.totalRows >= 0 && o.totalRows < 1e6 ? Math.floor(o.totalRows) : 0,
  };
}

/**
 * Personal space for bank loads: "Personal", then "Mi espacio", then the oldest
 * space that is not Casita / Invoice IOG. Null when there is none.
 */
export function pickPersonalHousehold(list: HouseholdRow[]): HouseholdRow | null {
  for (const name of PERSONAL_NAMES) {
    const hit = list.find((h) => h.name.trim().toLowerCase() === name);
    if (hit) return hit;
  }
  const open = list
    .filter((h) => !PROTECTED_NAMES.has(h.name.trim().toLowerCase()))
    .sort((a, b) => (a.joinedAt ?? 0) - (b.joinedAt ?? 0) || a.id.localeCompare(b.id));
  return open[0] ?? null;
}

function normalizeMerchantText(description: string): string {
  return description
    .toUpperCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}

type DbRow = Record<string, unknown>;

async function all<T = DbRow>(stmt: D1Prepared): Promise<T[]> {
  return ((await stmt.all<T>()).results ?? []) as T[];
}

export async function importStatement(
  env: Env,
  user: SessionUser,
  household: HouseholdRow,
  req: ImportRequest,
  now = Date.now(),
): Promise<ImportResponse> {
  const householdId = household.id;
  const source = req.source;
  const bank = resolveImportBank({
    selected: req.bank,
    detected: req.detectedBank,
    fileName: req.fileName,
  });
  const total = req.totalRows > 0 ? req.totalRows : req.movements.length + req.duplicatesInFile;

  const settings = await env.DB.prepare(
    "SELECT card_last4 FROM debt_settings WHERE user_id = ?",
  )
    .bind(user.id)
    .first<{ card_last4: string | null }>();
  const preferredLast4 = settings?.card_last4 ?? null;

  // Only a period file with several cards needs the owner's own descriptions to
  // tell them apart. Reading them is the one expensive query, so skip it otherwise.
  const distinctCards = new Set(req.movements.map((m) => m.cardLast4).filter(Boolean));
  let known: string[] = [];
  if (distinctCards.size > 1) {
    known = (
      await all<{ description_normalized: string }>(
        env.DB.prepare(
          `SELECT description_normalized FROM transactions
           WHERE household_id = ? AND paid_by_user_id = ? LIMIT 4000`,
        ).bind(householdId, user.id),
      )
    ).map((r) => r.description_normalized);
  }
  const primaryCardLast4 = pickPrimaryCardLast4(req.movements, {
    preferredLast4,
    knownDescriptions: known,
  });
  const movements = filterToPrimaryCard(req.movements, primaryCardLast4);
  const skippedOtherCard = req.movements.length - movements.length;

  const writes: D1Prepared[] = [];
  if (primaryCardLast4 && !preferredLast4) {
    writes.push(
      env.DB.prepare(
        `INSERT INTO debt_settings (user_id, card_last4, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET card_last4 = excluded.card_last4, updated_at = excluded.updated_at`,
      ).bind(user.id, primaryCardLast4, now),
    );
  }
  if (req.cardSaldo && req.cardSaldo.ars > 0) {
    const usd = req.cardSaldo.usd != null && req.cardSaldo.usd > 0 ? req.cardSaldo.usd.toFixed(2) : null;
    writes.push(
      env.DB.prepare(
        `INSERT INTO debt_settings (user_id, card_last4, saldo_deuda_ars, saldo_deuda_usd, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           saldo_deuda_ars = excluded.saldo_deuda_ars,
           saldo_deuda_usd = excluded.saldo_deuda_usd,
           updated_at = excluded.updated_at,
           card_last4 = COALESCE(debt_settings.card_last4, excluded.card_last4)`,
      ).bind(user.id, primaryCardLast4 ?? preferredLast4, req.cardSaldo.ars.toFixed(2), usd, now),
    );
  }
  if (writes.length > 0) await env.DB.batch(writes);

  const base = { source, bank, primaryCardLast4, skippedOtherCard, learnedHits: 0 };

  if (movements.length === 0) {
    const empty = emptyParseMessage({ fileName: req.fileName, fileKind: req.fileKind });
    const meta = buildImportMessage({
      total: 0,
      uniqueInFile: 0,
      duplicatesInFile: 0,
      alreadyExists: 0,
      inserted: 0,
    });
    return {
      statementId: null,
      total,
      uniqueInFile: 0,
      duplicatesInFile: req.duplicatesInFile,
      alreadyExists: 0,
      inserted: 0,
      skipped: skippedOtherCard,
      ...base,
      ...meta,
      message:
        empty.message +
        (skippedOtherCard > 0 && primaryCardLast4
          ? ` Se omitió la otra tarjeta (no es ****${primaryCardLast4}).`
          : ""),
      hint: empty.hint,
    };
  }

  // Fingerprints repeated inside this request.
  const seenInFile = new Set<string>();
  const unique: ImportMovement[] = [];
  let duplicatesInFile = req.duplicatesInFile;
  for (const m of movements) {
    if (seenInFile.has(m.fingerprint)) {
      duplicatesInFile++;
      continue;
    }
    seenInFile.add(m.fingerprint);
    unique.push(m);
  }

  const existingFp = new Set<string>();
  for (const part of chunk(unique.map((m) => m.fingerprint), IN_CHUNK)) {
    const rows = await all<{ fp: string }>(
      env.DB.prepare(
        `SELECT external_fingerprint AS fp FROM transactions
         WHERE household_id = ? AND external_fingerprint IN (${placeholders(part.length)})`,
      ).bind(householdId, ...part),
    );
    for (const r of rows) existingFp.add(r.fp);
  }

  type LogicalRow = {
    date: string;
    description_normalized: string;
    amount_ars: string | null;
    amount_usd: string | null;
    installment: string | null;
    is_payment: number | null;
  };
  const dates = [...new Set(unique.map((m) => m.date))];
  const existingLogical: LogicalRow[] = [];
  for (const part of chunk(dates, IN_CHUNK)) {
    existingLogical.push(
      ...(await all<LogicalRow>(
        env.DB.prepare(
          `SELECT date, description_normalized, amount_ars, amount_usd, installment, is_payment
           FROM transactions WHERE household_id = ? AND date IN (${placeholders(part.length)})`,
        ).bind(householdId, ...part),
      )),
    );
  }
  const numOrNull = (v: string | null) => (v != null && v !== "" ? Number(v) : null);
  const existingLogicalKeys = new Set<string>();
  const existingMerchantKeys = new Set<string>();
  const existingNamedAmountKeys = new Set<string>();
  for (const r of existingLogical) {
    const row = {
      date: r.date,
      descriptionNormalized: r.description_normalized,
      amountArs: numOrNull(r.amount_ars),
      amountUsd: numOrNull(r.amount_usd),
      installment: r.installment,
      isPayment: Boolean(r.is_payment),
    };
    existingLogicalKeys.add(logicalExpenseKey(row));
    const merchantKey = logicalMerchantKey(row);
    if (merchantKey) existingMerchantKeys.add(merchantKey);
    if (!isAnonymousMerchant(row.descriptionNormalized)) {
      const key = amountDayKey(row);
      if (key) existingNamedAmountKeys.add(key);
    }
  }

  const insertedLogical = new Set<string>();
  const insertedMerchant = new Set<string>();
  const insertedNamedAmount = new Set<string>();
  const toInsert = unique.filter((m) => {
    if (existingFp.has(m.fingerprint)) return false;
    const key = logicalExpenseKey(m);
    if (existingLogicalKeys.has(key) || insertedLogical.has(key)) return false;
    const merchantKey = logicalMerchantKey(m);
    if (merchantKey && (existingMerchantKeys.has(merchantKey) || insertedMerchant.has(merchantKey))) {
      return false;
    }
    const dayAmount = amountDayKey(m);
    if (
      isAnonymousMerchant(m.descriptionNormalized) &&
      dayAmount &&
      (existingNamedAmountKeys.has(dayAmount) || insertedNamedAmount.has(dayAmount))
    ) {
      return false;
    }
    insertedLogical.add(key);
    if (merchantKey) insertedMerchant.add(merchantKey);
    if (dayAmount && !isAnonymousMerchant(m.descriptionNormalized)) insertedNamedAmount.add(dayAmount);
    return true;
  });
  const alreadyExists = unique.length - toInsert.length;

  if (toInsert.length === 0) {
    const meta = buildImportMessage({
      total,
      uniqueInFile: unique.length,
      duplicatesInFile,
      alreadyExists,
      inserted: 0,
    });
    return {
      statementId: null,
      total,
      uniqueInFile: unique.length,
      duplicatesInFile,
      alreadyExists,
      inserted: 0,
      skipped: alreadyExists + duplicatesInFile + skippedOtherCard,
      ...base,
      ...meta,
      message: meta.message + otherCardNote(skippedOtherCard, primaryCardLast4, source),
      hint: null,
    };
  }

  // Categories: global + this household's. Rules map category ids back to slugs.
  const cats = await all<{ id: string; slug: string }>(
    env.DB.prepare(
      "SELECT id, slug FROM categories WHERE household_id IS NULL OR household_id = ?",
    ).bind(householdId),
  );
  const idBySlug = new Map(cats.map((c) => [c.slug, c.id]));
  const slugById = new Map(cats.map((c) => [c.id, c.slug]));
  const rules = (
    await all<{ pattern: string; category_id: string; priority: number }>(
      env.DB.prepare(
        "SELECT pattern, category_id, priority FROM merchant_rules WHERE household_id = ? ORDER BY priority DESC",
      ).bind(householdId),
    )
  )
    .map((r) => ({ pattern: r.pattern.toUpperCase(), categoryId: r.category_id, priority: r.priority }))
    .filter((r) => r.pattern.length >= 3)
    .sort((a, b) => b.priority - a.priority || b.pattern.length - a.pattern.length);

  let learnedHits = 0;
  const txSource = statementTxSource(source);
  const rows = toInsert.map((m) => {
    let categoryId: string | null = null;
    if (m.categoryHint) {
      categoryId = idBySlug.get(m.categoryHint) ?? null;
    } else {
      const u = normalizeMerchantText(m.descriptionNormalized);
      for (const rule of rules) {
        if (!u.includes(rule.pattern)) continue;
        const slug = slugById.get(rule.categoryId);
        if (!slug || slug === "uncategorized") continue;
        categoryId = rule.categoryId;
        learnedHits++;
        break;
      }
      if (!categoryId && m.categorySlug) categoryId = idBySlug.get(m.categorySlug) ?? null;
    }
    categoryId ??= idBySlug.get("uncategorized") ?? null;
    return { m, categoryId };
  });

  let statementId = req.statementId;
  const statements: D1Prepared[] = [];
  if (statementId) {
    const owned = await env.DB.prepare(
      "SELECT id FROM card_statements WHERE id = ? AND household_id = ? AND imported_by = ?",
    )
      .bind(statementId, householdId, user.id)
      .first<{ id: string }>();
    if (!owned) throw new BadRequest("El resumen de este archivo ya no existe");
  } else {
    statementId = crypto.randomUUID();
    statements.push(
      env.DB.prepare(
        `INSERT INTO card_statements (id, household_id, source, file_name, imported_by, imported_at, row_count)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
      ).bind(statementId, householdId, source, req.fileName, user.id, now),
    );
  }

  const insertCols =
    "(id, household_id, statement_id, date, description_raw, description_normalized, amount_ars, amount_usd, installment, is_payment, is_credit, category_id, ownership, paid_by_user_id, external_fingerprint, source, bank, card_last4)";
  const oneRow = `(${placeholders(18)})`;
  for (const part of chunk(rows, ROWS_PER_INSERT)) {
    const values: unknown[] = [];
    for (const { m, categoryId } of part) {
      values.push(
        crypto.randomUUID(),
        householdId,
        statementId,
        m.date,
        m.descriptionRaw,
        m.descriptionNormalized,
        m.amountArs != null ? String(m.amountArs) : null,
        m.amountUsd != null ? String(m.amountUsd) : null,
        m.installment,
        m.isPayment ? 1 : 0,
        m.isCredit ? 1 : 0,
        categoryId,
        "personal",
        user.id,
        m.fingerprint,
        txSource,
        bank,
        m.cardLast4 ?? primaryCardLast4,
      );
    }
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO transactions ${insertCols} VALUES ${part.map(() => oneRow).join(", ")}`,
      ).bind(...values),
    );
  }

  // The first statement of a fresh import is the card_statements row; the rest are inserts.
  let inserted = 0;
  const firstInsertIndex = statements.length - Math.ceil(rows.length / ROWS_PER_INSERT);
  for (const part of chunk(statements, STATEMENTS_PER_BATCH)) {
    const results = (await env.DB.batch(part)) as Array<{ meta?: { changes?: number } }>;
    const offset = statements.indexOf(part[0]!);
    results.forEach((r, i) => {
      if (offset + i >= firstInsertIndex) inserted += Number(r.meta?.changes ?? 0);
    });
  }
  // Row count only after the inserts: INSERT OR IGNORE skips rows that raced in.
  await env.DB.prepare("UPDATE card_statements SET row_count = row_count + ? WHERE id = ?")
    .bind(inserted, statementId)
    .run();
  const insertFailed = rows.length - inserted;

  const finalAlreadyExists = alreadyExists + insertFailed;
  const meta = buildImportMessage({
    total,
    uniqueInFile: unique.length,
    duplicatesInFile,
    alreadyExists: finalAlreadyExists,
    inserted,
  });
  return {
    statementId,
    total,
    uniqueInFile: unique.length,
    duplicatesInFile,
    alreadyExists: finalAlreadyExists,
    inserted,
    skipped: finalAlreadyExists + duplicatesInFile + skippedOtherCard,
    ...base,
    learnedHits,
    ...meta,
    message: meta.message + otherCardNote(skippedOtherCard, primaryCardLast4, source),
    hint: isPeriodDebtSource(source)
      ? "Este Excel es el período de la tarjeta: va a Deuda (cuotas), no a la neta de gastos."
      : null,
  };
}

async function readJsonBody(req: Request): Promise<unknown> {
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > MAX_BODY_BYTES) throw new BadRequest("El archivo es demasiado grande.");
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new BadRequest("El archivo es demasiado grande.");
  try {
    return JSON.parse(text);
  } catch {
    throw new BadRequest("Contenido inválido");
  }
}

export async function handleImportStatement(
  req: Request,
  env: Env,
  user: SessionUser,
): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  try {
    const parsed = parseImportRequest(await readJsonBody(req));
    const household = pickPersonalHousehold(await listHouseholds(env, user.id));
    if (!household) {
      return json({ error: "Creá tu espacio Personal primero para poder cargar resúmenes." }, 400);
    }
    return json(await importStatement(env, user, household, parsed));
  } catch (err) {
    if (err instanceof BadRequest) return json({ error: err.message }, 400);
    throw err;
  }
}

/** PDF → markdown through Workers AI. No parsing here (CPU); the browser parses the text. */
export async function handlePdfText(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > MAX_PDF_BYTES + 4096) {
    return json({ error: "El PDF es demasiado grande (máximo 8 MB)." }, 413);
  }
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return json({ error: "Falta el PDF" }, 400);
  if (file.size > MAX_PDF_BYTES) return json({ error: "El PDF es demasiado grande (máximo 8 MB)." }, 413);
  try {
    const result = await env.AI.toMarkdown({ name: "statement.pdf", blob: file });
    const doc = (Array.isArray(result) ? result[0] : result) as
      | { format?: string; data?: string }
      | null
      | undefined;
    if (!doc || doc.format === "error" || !doc.data?.trim()) {
      return json({ error: "No se pudo leer el PDF. Subí el Excel o CSV del banco." }, 422);
    }
    return json({ markdown: doc.data });
  } catch {
    return json({ error: "No se pudo leer el PDF. Subí el Excel o CSV del banco." }, 502);
  }
}
