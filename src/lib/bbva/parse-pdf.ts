import { fingerprint32 } from "@/lib/hash";
import {
  amountFingerprintKey,
  fingerprintParts,
  normalizeMovementCurrency,
  parseBbvaAmount,
} from "@/lib/money";
import type { BbvaMovement } from "@/lib/bbva/parse";

const MONTHS: Record<string, number> = {
  ene: 1,
  feb: 2,
  mar: 3,
  abr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  ago: 8,
  set: 9,
  sep: 9,
  oct: 10,
  nov: 11,
  dic: 12,
};

/** Argentine money: 1.234,56 or -180.000,00 (not 2,00%) */
const MONEY_RE = /-?\d{1,3}(?:\.\d{3})*,\d{2}|-?\d+,\d{2}/g;

const DATE_LINE_RE =
  /^(\d{1,2})-([A-Za-záéíóúÁÉÍÓÚ]{3})-(\d{2})\s+(.+)$/i;

function parseArMoney(token: string): number | null {
  let s = token.trim().replace(/\s/g, "");
  if (!s) return null;
  const neg = s.startsWith("-");
  s = s.replace(/-/g, "");
  if (s.includes(",") && s.includes(".")) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (s.includes(",")) {
    s = s.replace(",", ".");
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return neg ? -Math.abs(n) : n;
}

function parseBbvaPdfDate(day: string, mon: string, year: string): string | null {
  const m = MONTHS[mon.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "")];
  if (!m) return null;
  let y = Number(year);
  if (y < 100) y += 2000;
  const d = Number(day);
  if (d < 1 || d > 31) return null;
  const iso = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(iso.getTime())) return null;
  // reject overflow (e.g. 31-Feb)
  if (
    iso.getUTCFullYear() !== y ||
    iso.getUTCMonth() !== m - 1 ||
    iso.getUTCDate() !== d
  ) {
    return null;
  }
  return iso.toISOString().slice(0, 10);
}

function stripNoise(rest: string): string {
  return rest
    .replace(/Banco BBVA.*$/i, "")
    .replace(/Sobre\s*\(\d+\).*$/i, "")
    .replace(/Página\s+\d+\s+de\s+\d+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractInstallment(text: string): string | null {
  const m = text.match(/\bC\.?\s*0*(\d{1,2})\s*\/\s*0*(\d{1,2})\b/i);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a >= 1 && b >= 1 && a <= b && b <= 60) return `${a}/${b}`;
  return null;
}

function extractCupon(text: string): string | null {
  // 6-digit cupón not part of a larger number
  const matches = [...text.matchAll(/(?<![\d.,])(\d{6})(?![\d.,])/g)];
  if (matches.length === 0) return null;
  // Prefer the last cupón-like token (usually before amounts)
  return matches[matches.length - 1]?.[1] ?? null;
}

function findMoneyTokens(text: string): { raw: string; value: number; index: number }[] {
  const out: { raw: string; value: number; index: number }[] = [];
  MONEY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MONEY_RE.exec(text)) !== null) {
    // skip percentages like 2,00%
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 1);
    if (after === "%") continue;
    // skip if glued to letters (e.g. TC1220,000 shouldn't appear as pure money with TC)
    const before = text.slice(Math.max(0, m.index - 1), m.index);
    if (/[A-Za-zÁÉÍÓÚáéíóú]/.test(before)) continue;
    const value = parseArMoney(m[0]);
    if (value == null) continue;
    out.push({ raw: m[0], value, index: m.index });
  }
  return out;
}

function isPaymentDescription(desc: string): boolean {
  const u = desc.toUpperCase();
  return (
    u.includes("SU PAGO") ||
    u.includes("PAGO EN PESOS") ||
    u.includes("PAGO EN USD") ||
    u.includes("PAGO RECIBIDO") ||
    u.includes("TRANSFERENCIA DEUDA") ||
    u.startsWith("CR IVA") ||
    u.startsWith("DEV ")
  );
}

function shouldSkipDescription(desc: string): boolean {
  const u = desc.toUpperCase();
  if (!u.trim()) return true;
  if (u.startsWith("TOTAL CONSUMOS")) return true;
  if (u.startsWith("SALDO ")) return true;
  if (u.includes("SALDO ACTUAL")) return true;
  if (u.includes("SALDO ANTERIOR")) return true;
  if (u.startsWith("CIERRE")) return true;
  if (u.startsWith("VENCIMIENTO")) return true;
  if (u.startsWith("PAGO MÍNIMO") || u.startsWith("PAGO MINIMO")) return true;
  if (u.startsWith("LÍMITES") || u.startsWith("LIMITES")) return true;
  if (u.includes("PLAN V:")) return true;
  if (u.includes("TNA FIJA")) return true;
  if (u.includes("CUOTAS DE $")) return true;
  if (u.includes("FECHA") && u.includes("DESCRIP")) return true;
  return false;
}

function isUsdOnlyLine(desc: string, moneys: { value: number }[]): boolean {
  const u = desc.toUpperCase();
  if (!u.includes("USD") && !u.includes("U$S")) return false;
  // Foreign spend: typically one small trailing amount and USD in description
  if (moneys.length === 1 && Math.abs(moneys[0].value) < 5000) return true;
  // Two identical-ish amounts (original FX + charged USD)
  if (moneys.length >= 2) {
    const last = moneys[moneys.length - 1];
    const prev = moneys[moneys.length - 2];
    if (
      Math.abs(last.value) < 5000 &&
      Math.abs(Math.abs(last.value) - Math.abs(prev.value)) < 0.02
    ) {
      return true;
    }
  }
  return false;
}

function cleanDescription(
  rest: string,
  installment: string | null,
  cupon: string | null,
  moneys: { raw: string; index: number }[],
): string {
  // Strip from the original string using original indices first (end → start)
  let d = rest;
  for (const m of [...moneys].sort((a, b) => b.index - a.index)) {
    d = `${d.slice(0, m.index)} ${d.slice(m.index + m.raw.length)}`;
  }
  if (cupon) {
    d = d.replace(new RegExp(`(?<![\\d.,])${cupon}(?![\\d.,])`), " ");
  }
  if (installment) {
    d = d.replace(/\bC\.?\s*0*\d{1,2}\s*\/\s*0*\d{1,2}\b/i, " ");
  }
  // Drop rate codes before any residual money sweep
  d = d
    .replace(/\bTC\d+(?:[.,]\d+)?\b/gi, " ")
    .replace(/\bUSD\b/gi, " ")
    .replace(/\bU\$S\b/gi, " ")
    // Merchant codes glued to USD e.g. P69852833USD / A84450689USD
    .replace(/[A-Z0-9*]{4,}USD\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Residual AR money tokens (same rules as findMoneyTokens)
  for (const m of [...findMoneyTokens(d)].sort((a, b) => b.index - a.index)) {
    d = `${d.slice(0, m.index)} ${d.slice(m.index + m.raw.length)}`;
  }
  // Drop dangling punctuation / empty parens left after stripping base amounts
  d = d
    .replace(/\(\s*\)/g, " ")
    .replace(/\bD[OÓ]LARES?\b/gi, "DOLARES")
    .replace(/^[,.*\-\s]+|[,.*\-\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // Normalize payment labels cut mid-word by PDF extract
  if (/^SU PAGO EN$/i.test(d)) d = "SU PAGO EN DOLARES";
  return d;
}

function assignAmounts(
  desc: string,
  moneys: { value: number }[],
): { amountArs: number | null; amountUsd: number | null } {
  if (moneys.length === 0) return { amountArs: null, amountUsd: null };

  const last = moneys[moneys.length - 1];
  const prev = moneys.length >= 2 ? moneys[moneys.length - 2] : null;

  let amountArs: number | null = null;
  let amountUsd: number | null = null;

  // Transfer / dual currency: ... 17.299,60 -14,18
  if (prev && last.value < 0 && prev.value > 0 && Math.abs(last.value) < 1000) {
    amountArs = prev.value;
    amountUsd = last.value;
  } else if (isUsdOnlyLine(desc, moneys)) {
    amountArs = null;
    amountUsd = Math.abs(last.value);
  } else {
    // Tax lines with base + charge: take last as the booked amount
    // Payments: last (possibly negative)
    amountArs = last.value;
    amountUsd = null;
  }

  return normalizeMovementCurrency({
    descriptionNormalized: desc,
    amountArs,
    amountUsd,
  });
}

function makeFingerprint(m: Omit<BbvaMovement, "fingerprint">, cupon: string | null): string {
  const base = fingerprintParts([
    m.date,
    m.descriptionNormalized,
    amountFingerprintKey(m.amountArs, m.amountUsd),
    m.installment ?? "",
    // cupón distinguishes same-day same-merchant same-amount (common with Ubers)
    cupon ?? "",
  ]);
  return fingerprint32(base);
}

/** Workers AI is missing, or it could not read the PDF. */
export class PdfImportUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfImportUnavailableError";
  }
}

export const PDF_WORKERS_MESSAGE =
  "No se pudo leer el PDF con Workers AI. Subí un Excel o CSV, o pegá el texto del resumen.";

const DATE_START_RE =
  /^(?:\d{1,2}-[A-Za-záéíóúÁÉÍÓÚ]{3}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b/;
const EMBEDDED_DATE_RE = /\d{1,2}-[A-Za-záéíóúÁÉÍÓÚ]{3}-\d{2}/g;

/**
 * toMarkdown glues the next section onto the last movement:
 * "7.841,12SALDO ACTUAL …" and "-145.000,00Consumos … FECHA DESCRIPCIÓN".
 * Cut before those trailers so the movement itself still parses.
 */
const STATEMENT_TRAILER_RE =
  /TOTAL\s+CONSUMOS|SALDO\s+ACTUAL|Banco BBVA|Legales y avisos|R[eé]gimen de Transparencia|FECHA\s+DESCRIP|Consumos\s+[A-Za-zÁÉÍÓÚáéíóú]/i;

function cutStatementTrailer(segment: string): string {
  return segment.split(STATEMENT_TRAILER_RE)[0]!.trim();
}

/**
 * Same-day payments sometimes have no second date:
 * "05-Sep-25 SU PAGO EN PESOS -11.000,00SU PAGO EN PESOS -145.000,00".
 * Keep the segment date on every piece.
 */
function explodeRepeatedPayments(segment: string): string[] {
  const dated = segment.match(DATE_START_RE);
  if (!dated) return [segment];
  const rest = segment.slice(dated[0].length).trim();
  const parts = rest.split(/(?=SU PAGO EN PESOS\b)/i).map((part) => part.trim()).filter(Boolean);
  if (parts.length <= 1) return [segment];
  return parts.map((part) => `${dated[0]} ${part}`.replace(/\s+/g, " ").trim());
}

/**
 * Turn Workers AI `toMarkdown` output into the line shape the BBVA / generic
 * parsers already expect. Headings and markdown tables become plain lines.
 * Asterisks stay (MERPAGO*FOO). A continuation line is joined onto the
 * previous line when that previous line starts with a date and this one does not.
 */
export function markdownToStatementText(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const kept: string[] = [];
  let inMetadata = false;

  for (const raw of lines) {
    const line = raw.replace(/\u0000/g, "").replace(/\t/g, " ");
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (/^#{1,6}\s+Metadata\b/i.test(trimmed)) {
      inMetadata = true;
      continue;
    }
    if (inMetadata) {
      if (/^#{1,6}\s+/.test(trimmed)) inMetadata = false;
      else continue;
    }
    if (/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(trimmed)) continue;

    let text = trimmed;
    if (trimmed.includes("|")) {
      const cells = trimmed
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim())
        .filter(Boolean);
      if (cells.length >= 2) text = cells.join(" ");
    }
    text = text.replace(/^#{1,6}\s+/, "").replace(/\s+/g, " ").trim();
    if (text) kept.push(text);
  }

  // toMarkdown often glues a whole table into one line:
  // "01-Ago-25 SU PAGO -286.000,0005-Ago-25 OTRO 1.000,00"
  const expanded: string[] = [];
  for (const line of kept) {
    const indexes: number[] = [];
    for (const match of line.matchAll(new RegExp(EMBEDDED_DATE_RE.source, "g"))) {
      if (match.index != null) indexes.push(match.index);
    }
    if (indexes.length === 0) {
      expanded.push(line);
      continue;
    }
    if (indexes[0]! > 0) {
      const prefix = line.slice(0, indexes[0]).trim();
      if (prefix) expanded.push(prefix);
    }
    for (let i = 0; i < indexes.length; i++) {
      const start = indexes[i]!;
      const end = i + 1 < indexes.length ? indexes[i + 1]! : line.length;
      let segment = line.slice(start, end).trim();
      segment = cutStatementTrailer(segment);
      for (const piece of explodeRepeatedPayments(segment)) {
        if (piece) expanded.push(piece);
      }
    }
  }

  const joined: string[] = [];
  for (const line of expanded) {
    const prev = joined[joined.length - 1];
    const section =
      /^(DETALLE|CONSUMOS|SUS PAGOS|IMPUESTOS|LEGALES|PLAN V|Fecha)\b/i.test(
        line,
      );
    const prevHasAmount = Boolean(prev && /,\d{2}\s*$/.test(prev));
    if (
      prev &&
      DATE_START_RE.test(prev) &&
      !DATE_START_RE.test(line) &&
      !section &&
      !prevHasAmount
    ) {
      joined[joined.length - 1] = `${prev} ${line}`;
      continue;
    }
    joined.push(line);
  }
  return joined.join("\n");
}

/**
 * Where the PDF text comes from. The browser import flow passes a function that
 * posts the file to `/api/import/pdf-text` (the Worker runs Workers AI
 * `toMarkdown`). Without one, fall back to the legacy OpenNext runtime, which
 * is loaded lazily so browser bundles never include it.
 */
export type PdfMarkdownSource = (data: ArrayBuffer | Uint8Array) => Promise<string>;

async function legacyAiMarkdown(data: ArrayBuffer | Uint8Array): Promise<string> {
  if (process.env.NEXT_PHASE === "phase-production-build") {
    throw new PdfImportUnavailableError(PDF_WORKERS_MESSAGE);
  }
  let ai: { toMarkdown?: (input: unknown) => Promise<unknown> } | undefined;
  try {
    const moduleName = "@opennextjs/cloudflare";
    const mod = (await import(
      /* webpackIgnore: true */ /* turbopackIgnore: true */ moduleName
    )) as {
      getCloudflareContext: (opts: { async: true }) => Promise<{ env: { AI?: typeof ai } }>;
    };
    const { env } = await mod.getCloudflareContext({ async: true });
    ai = env.AI;
  } catch {
    ai = undefined;
  }
  if (!ai || typeof ai.toMarkdown !== "function") {
    throw new PdfImportUnavailableError(PDF_WORKERS_MESSAGE);
  }

  const source = data instanceof Uint8Array ? data : new Uint8Array(data);
  const bytes = new Uint8Array(source.byteLength);
  bytes.set(source);
  const blob = new Blob([bytes], { type: "application/pdf" });
  const result = await ai.toMarkdown({ name: "statement.pdf", blob });
  const doc = (Array.isArray(result) ? result[0] : result) as
    | { format?: string; data?: string }
    | undefined;
  if (!doc || doc.format === "error" || !doc.data?.trim()) {
    throw new PdfImportUnavailableError(PDF_WORKERS_MESSAGE);
  }
  return doc.data;
}

export async function extractPdfText(
  data: ArrayBuffer | Uint8Array,
  source: PdfMarkdownSource = legacyAiMarkdown,
): Promise<string> {
  const markdown = await source(data);
  return markdownToStatementText(markdown);
}

/**
 * Parse already-extracted text of a BBVA Visa "Resumen con vencimiento".
 */
export function parseBbvaPdfText(text: string): BbvaMovement[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\u0000/g, "").trim())
    .filter(Boolean);

  // Only parse detail sections (pagos / consumos / impuestos)
  let inDetail = false;
  const out: BbvaMovement[] = [];
  const seenFp = new Set<string>();

  for (const line of lines) {
    const upper = line.toUpperCase();

    if (
      upper.includes("SUS PAGOS Y AJUSTES") ||
      upper.includes("DETALLE") ||
      /^CONSUMOS\b/i.test(line) ||
      upper.includes("IMPUESTOS, CARGOS")
    ) {
      inDetail = true;
    }
    if (
      upper.includes("LEGALES Y AVISOS") ||
      upper.includes("PLAN V:") ||
      upper.includes("RÉGIMEN DE TRANSPARENCIA") ||
      upper.includes("REGIMEN DE TRANSPARENCIA")
    ) {
      inDetail = false;
      continue;
    }

    // Before DETALLE, summary block has undated totals — skip.
    // Some extracts put movement lines only after first dated pago.
    const dateMatch = line.match(DATE_LINE_RE);
    if (!dateMatch) continue;

    // Once we see a solid movement line, allow parse even if DETALLE header was messy
    const restRaw = stripNoise(dateMatch[4] ?? "");
    if (!restRaw) continue;

    const date = parseBbvaPdfDate(dateMatch[1], dateMatch[2], dateMatch[3]);
    if (!date) continue;

    const installment = extractInstallment(restRaw);
    const moneys = findMoneyTokens(restRaw);
    if (moneys.length === 0) continue;

    // Cupón before stripping moneys
    const cupon = extractCupon(restRaw);
    // Avoid treating money thousands as cupón (shouldn't with 6 digits only)

    const { amountArs, amountUsd } = assignAmounts(restRaw, moneys);
    if (amountArs == null && amountUsd == null) continue;

    const descriptionRaw = cleanDescription(restRaw, installment, cupon, moneys);
    if (shouldSkipDescription(descriptionRaw)) continue;

    // If we haven't entered detail yet, only accept if it looks like a real movement
    // (has cupón or payment keyword or installment) — avoids header period dates
    if (!inDetail) {
      const looksLikeMovement =
        Boolean(cupon) ||
        Boolean(installment) ||
        isPaymentDescription(descriptionRaw) ||
        /MERPAGO|PAYU|UBER|SPOTIFY|COTO|DIA |RAPPI|OPENAI|GITHUB/i.test(
          descriptionRaw,
        );
      if (!looksLikeMovement) continue;
      inDetail = true;
    }

    const descriptionNormalized = descriptionRaw.replace(/\s+/g, " ").trim();
    if (!descriptionNormalized) continue;

    const payment = isPaymentDescription(descriptionNormalized);
    const arsNeg = (amountArs ?? 0) < 0;
    const partial: Omit<BbvaMovement, "fingerprint"> = {
      date,
      descriptionRaw: descriptionNormalized,
      descriptionNormalized,
      installment,
      amountArs,
      amountUsd,
      isPayment: payment || arsNeg,
      isCredit: arsNeg && !payment,
    };

    const fingerprint = makeFingerprint(partial, cupon);
    if (seenFp.has(fingerprint)) continue;
    seenFp.add(fingerprint);

    out.push({ ...partial, fingerprint });
  }

  return out;
}

/**
 * Parse BBVA Visa "Resumen con vencimiento" PDF (formato de resumen mensual clásico).
 */
export async function parseBbvaStatementPdf(
  data: ArrayBuffer | Buffer,
): Promise<BbvaMovement[]> {
  const text = await extractPdfText(data);
  return parseBbvaPdfText(text);
}

const GENERIC_DATE_DMY_RE =
  /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})\s+(.+)$/;
const GENERIC_DATE_ISO_RE = /^(\d{4})-(\d{2})-(\d{2})\s+(.+)$/;

const GENERIC_MONEY_RE =
  /-?\d{1,3}(?:\.\d{3})*,\d{2}|-?\d+,\d{2}|-?\d{1,3}(?:,\d{3})*\.\d{2}|-?\d+\.\d{2}/g;

function parseGenericPdfDate(
  day: string,
  month: string,
  year: string,
): string | null {
  let y = Number(year);
  if (y < 100) y += 2000;
  const m = Number(month);
  const d = Number(day);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const iso = new Date(Date.UTC(y, m - 1, d));
  if (
    Number.isNaN(iso.getTime()) ||
    iso.getUTCFullYear() !== y ||
    iso.getUTCMonth() !== m - 1 ||
    iso.getUTCDate() !== d
  ) {
    return null;
  }
  return iso.toISOString().slice(0, 10);
}

function findGenericMoneyTokens(
  text: string,
): { raw: string; value: number; index: number }[] {
  const out: { raw: string; value: number; index: number }[] = [];
  GENERIC_MONEY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = GENERIC_MONEY_RE.exec(text)) !== null) {
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 1);
    if (after === "%") continue;
    const before = text.slice(Math.max(0, m.index - 1), m.index);
    if (/[A-Za-zÁÉÍÓÚáéíóú]/.test(before)) continue;
    const parsed = parseBbvaAmount(m[0]);
    if (!parsed) continue;
    out.push({ raw: m[0], value: parsed.value, index: m.index });
  }
  return out;
}

function isGenericPayment(desc: string): boolean {
  const u = desc.toUpperCase();
  return (
    isPaymentDescription(desc) ||
    u.includes("RECARGA") ||
    u.includes("CARGA DE SALDO") ||
    u.includes("PAGO RECIBIDO")
  );
}

/**
 * Conservative line parser for Fiwind / other AR statements:
 *   01/08/2026  DIA TIENDA 99  15.420,50
 *   2026-08-01  OPENAI  USD 20.00
 */
export function parseGenericPdfText(text: string): BbvaMovement[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\u0000/g, "").trim())
    .filter(Boolean);

  const out: BbvaMovement[] = [];
  const seenFp = new Set<string>();

  for (const line of lines) {
    const upper = line.toUpperCase();
    if (
      upper.includes("LEGALES") ||
      upper.includes("TNA FIJA") ||
      upper.includes("PLAN V:") ||
      (upper.includes("FECHA") && upper.includes("DESCRIP"))
    ) {
      continue;
    }
    if (/\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}\s*[-–]\s*\d{1,2}[/\-.]/.test(line)) {
      // Period range in the header, not a movement
      continue;
    }

    let date: string | null = null;
    let restRaw = "";

    const iso = line.match(GENERIC_DATE_ISO_RE);
    const dmy = line.match(GENERIC_DATE_DMY_RE);
    if (iso) {
      date = `${iso[1]}-${iso[2]}-${iso[3]}`;
      restRaw = iso[4] ?? "";
    } else if (dmy) {
      date = parseGenericPdfDate(dmy[1], dmy[2], dmy[3]);
      restRaw = dmy[4] ?? "";
    }
    if (!date || !restRaw) continue;

    restRaw = stripNoise(restRaw);
    if (!restRaw) continue;

    const installment = extractInstallment(restRaw);
    const moneys = findGenericMoneyTokens(restRaw);
    if (moneys.length === 0) continue;

    const cupon = extractCupon(restRaw);
    const { amountArs, amountUsd } = assignAmounts(restRaw, moneys);
    if (amountArs == null && amountUsd == null) continue;

    const descriptionRaw = cleanDescription(restRaw, installment, cupon, moneys);
    if (shouldSkipDescription(descriptionRaw)) continue;
    if (descriptionRaw.length < 3) continue;

    const descriptionNormalized = descriptionRaw.replace(/\s+/g, " ").trim();
    const payment = isGenericPayment(descriptionNormalized);
    const arsNeg = (amountArs ?? 0) < 0;
    const partial: Omit<BbvaMovement, "fingerprint"> = {
      date,
      descriptionRaw: descriptionNormalized,
      descriptionNormalized,
      installment,
      amountArs,
      amountUsd,
      isPayment: payment || arsNeg,
      isCredit: arsNeg && !payment,
    };
    const fingerprint = makeFingerprint(partial, cupon);
    if (seenFp.has(fingerprint)) continue;
    seenFp.add(fingerprint);
    out.push({ ...partial, fingerprint });
  }

  return out;
}

export function looksLikePdf(buffer: Buffer, fileName?: string): boolean {
  if (fileName && /\.pdf$/i.test(fileName)) return true;
  return buffer.length >= 5 && buffer.subarray(0, 5).toString("ascii") === "%PDF-";
}
