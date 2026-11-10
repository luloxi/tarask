/** Calendar YYYY-MM-DD. Rejects 2026-02-31 and anything with a time zone. */
export function isCalendarDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

const AMOUNT_RE = /^-?(?:\d+|\d+\.\d+)$/;
/** Reject junk that would become Infinity or wipe a stored amount. */
const MAX_AMOUNT = 1_000_000_000_000;

/**
 * Manual / API / MCP amounts. Placeholder in the form is "0,00".
 * Last mixed separator wins (1.234,56 AR vs 1,234.56 US). A lone comma
 * is decimal. "1e6" / Infinity stay invalid.
 */
function normalizeManualAmount(raw: string): string {
  let s = raw.trim().replace(/\s/g, "");
  if (!s) return s;
  if (s.startsWith("(") && s.endsWith(")") && s.length > 2) {
    s = `-${s.slice(1, -1)}`;
  }
  s = s.replace(/^\$/, "").replace(/\$$/, "");
  const negative = s.startsWith("-") || s.endsWith("-");
  s = s.replace(/-/g, "");
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    s =
      lastComma > lastDot
        ? s.replace(/\./g, "").replace(",", ".")
        : s.replace(/,/g, "");
  } else if (lastComma >= 0) {
    s = s.replace(",", ".");
  }
  return negative ? `-${s}` : s;
}

export function parseExpenseAmount(
  value: unknown,
): { ok: true; amount: number | null } | { ok: false } {
  if (value == null || value === "") return { ok: true, amount: null };
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Math.abs(value) > MAX_AMOUNT) return { ok: false };
    return { ok: true, amount: Math.abs(value) };
  }
  if (typeof value !== "string") return { ok: false };
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, amount: null };
  const normalized = normalizeManualAmount(trimmed);
  if (!AMOUNT_RE.test(normalized)) return { ok: false };
  const n = Number(normalized);
  if (!Number.isFinite(n) || Math.abs(n) > MAX_AMOUNT) return { ok: false };
  return { ok: true, amount: Math.abs(n) };
}

/** TEXT money with 2 decimal places so fingerprints do not drift on "10" vs "10.00". */
export function expenseAmountText(amount: number | null): string | null {
  if (amount == null) return null;
  const cents = Math.round(amount * 100);
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.trunc(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${sign}${whole}.${frac}`;
}

export function manualFingerprintMaterial(input: {
  householdId: string;
  date: string;
  description: string;
  amountArs: string | null;
  amountUsd: string | null;
}): string {
  const description = input.description.trim().replace(/\s+/g, " ");
  return [
    "manual",
    input.householdId,
    input.date,
    description,
    input.amountArs ?? "",
    input.amountUsd ?? "",
  ].join("|");
}

/**
 * Occurrence 1 is the material hashed for the first insert (prod rows depend
 * on that exact string). Later copies of the same expense append `#2`, `#3`, …
 */
export function manualOccurrenceMaterial(material: string, occurrence: number): string {
  if (occurrence <= 1) return material;
  return `${material}#${occurrence}`;
}

/**
 * Stored fingerprint. The first copy is the 32-char hash of the base material.
 * The next copies keep that hash and append `#2`, `#3`, so the family can be
 * counted without changing the hash of rows already in prod.
 */
export function occurrenceFingerprint(baseFingerprint: string, occurrence: number): string {
  if (occurrence <= 1) return baseFingerprint;
  return `${baseFingerprint}#${occurrence}`;
}

export function occurrenceOfFingerprint(
  fingerprint: string,
  baseFingerprint: string,
): number | null {
  if (fingerprint === baseFingerprint) return 1;
  const prefix = `${baseFingerprint}#`;
  if (!fingerprint.startsWith(prefix)) return null;
  const suffix = fingerprint.slice(prefix.length);
  if (!/^[1-9][0-9]*$/.test(suffix)) return null;
  const n = Number(suffix);
  return n >= 2 ? n : null;
}

/**
 * `takenFingerprints` are rows already stored for this material (base and
 * `#N`). No base row → the unsuffixed hash. Otherwise start at count + 1 and
 * walk up until the suffix is free.
 */
export function nextOccurrenceFingerprint(
  baseFingerprint: string,
  takenFingerprints: readonly string[],
): { fingerprint: string; occurrence: number; possibleDuplicate: boolean } {
  const used = new Set<string>();
  for (const fp of takenFingerprints) {
    if (occurrenceOfFingerprint(fp, baseFingerprint) != null) used.add(fp);
  }
  if (!used.has(baseFingerprint)) {
    return { fingerprint: baseFingerprint, occurrence: 1, possibleDuplicate: false };
  }
  let occurrence = used.size + 1;
  if (occurrence < 2) occurrence = 2;
  let fingerprint = occurrenceFingerprint(baseFingerprint, occurrence);
  while (used.has(fingerprint)) {
    occurrence += 1;
    fingerprint = occurrenceFingerprint(baseFingerprint, occurrence);
  }
  return { fingerprint, occurrence, possibleDuplicate: true };
}

/** One step past a fingerprint that just lost a UNIQUE race. */
export function bumpOccurrenceFingerprint(
  baseFingerprint: string,
  failedFingerprint: string,
): string {
  const current = occurrenceOfFingerprint(failedFingerprint, baseFingerprint) ?? 1;
  return occurrenceFingerprint(baseFingerprint, current + 1);
}
