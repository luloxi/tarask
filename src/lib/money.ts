/**
 * Parse amounts from BBVA AR exports.
 * Examples: "$ 30.277,00" | "$ -28.818,86" | "USD 20,00" | "USD -102,48"
 */
export type ParsedAmount = {
  currency: "ARS" | "USD";
  value: number;
};

export function parseBbvaAmount(raw: unknown): ParsedAmount | null {
  if (raw == null) return null;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return { currency: "ARS", value: raw };
  }

  let s = String(raw).trim();
  if (!s || s === "-") return null;

  const isUsd =
    /^USD\b/i.test(s) ||
    /\bU\$S\b/i.test(s) ||
    s.toUpperCase().includes("USD");
  s = s
    .replace(/^USD\s*/i, "")
    .replace(/^U\$S\s*/i, "")
    .replace(/^\$\s*/, "")
    .trim();

  // Remove spaces used as thousand separators sometimes
  s = s.replace(/\s/g, "");

  // Argentine format: 1.234.567,89  or US-like 1,234.56 (last separator wins)
  const negative = s.startsWith("-") || s.includes("-");
  s = s.replace(/-/g, "");
  s = normalizeGroupedNumber(s);

  const value = Number(s);
  if (!Number.isFinite(value)) return null;

  return {
    currency: isUsd ? "USD" : "ARS",
    value: negative ? -Math.abs(value) : value,
  };
}

/**
 * Dots/commas as thousands vs decimal. Last mixed separator wins.
 * Groups of three with no cents ("1.234.567", "$ 30.277") are pesos, not 1.234.
 * "0.50" / "20.00" stay decimals. "0.123" is not thousands.
 */
function normalizeGroupedNumber(s: string): string {
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) {
      return s.replace(/\./g, "").replace(",", ".");
    }
    return s.replace(/,/g, "");
  }
  if (s.includes(",")) {
    const parts = s.split(",");
    if (isThousandGroups(parts)) return parts.join("");
    return s.replace(",", ".");
  }
  if (s.includes(".")) {
    const parts = s.split(".");
    if (isThousandGroups(parts)) return parts.join("");
  }
  return s;
}

function isThousandGroups(parts: string[]): boolean {
  if (parts.length < 2) return false;
  const head = parts[0] ?? "";
  if (!head || head === "0" || head.length > 3 || !/^\d+$/.test(head)) return false;
  return parts.slice(1).every((p) => /^\d{3}$/.test(p));
}

/**
 * Merchants that almost always charge in USD on AR cards.
 * BBVA "Últimos movimientos" sometimes parks the USD figure in the $ column
 * until settlement — those look like tiny ARS spends (e.g. VULTR 24,00).
 */
const LIKELY_USD_MERCHANT_RE =
  /\b(?:OPENAI|ANTHROPIC|CLAUDE\.?AI|CHATGPT|CURSOR|GITHUB|VERCEL|DIGITALOCEAN|VULTR|RAILWAY|HEROKU|NETLIFY|CLOUDFLARE|NAMECHEAP|GODADDY|AWS|AMAZON\s*WEB|GOOGLE\s*\*|GOOGLE\s*ONE|GOOGLE\s*CLOUD|MICROSOFT\s*\*|X\s*CORP|TWITTER|FIGMA|NOTION|LINEAR|SUPABASE|NEON\.TECH|RENDER\.COM|PAPER\.DESIGN|NOUS\s*RESEARCH|MIDJOURNEY|PERPLEXITY|GROK\s*XAI|SPOTIFY|APPLE\.COM|STEAM\s*GAMES|PAYPAL|STRIPE|ADOBE|ZOOM\.US|DROPBOX|SLACK|DISCORD|JETBRAINS|NPM\s*INC|MONGODB|DATADOG|SENTRY|POSTHOG|HETZNER|LINODE|OVH)\b/i;

/** Amount-only key so ARS↔USD reclassification keeps the same fingerprint. */
export function amountFingerprintKey(
  amountArs: number | null | undefined,
  amountUsd: number | null | undefined,
): string {
  const a =
    amountArs != null && Number.isFinite(amountArs) && Math.abs(amountArs) > 0.0001
      ? Math.abs(amountArs).toFixed(2)
      : "";
  const u =
    amountUsd != null && Number.isFinite(amountUsd) && Math.abs(amountUsd) > 0.0001
      ? Math.abs(amountUsd).toFixed(2)
      : "";
  if (a && !u) return a;
  if (u && !a) return u;
  if (a && u) return `${a}|${u}`;
  return "";
}

export function isLikelyForeignUsdSpend(
  description: string,
  amountArsAbs: number,
): boolean {
  if (!Number.isFinite(amountArsAbs) || amountArsAbs <= 0) return false;
  // Real peso spends are almost never this small on a credit card; SaaS USD is.
  // Keep a soft cap so we never reclassify a café as USD without merchant cues.
  if (amountArsAbs >= 500) return false;

  const d = description.toUpperCase();
  if (/\bUSD\b|\bU\$S\b|\bDOLARES?\b|\bDÓLARES?\b/.test(d)) return true;
  if (LIKELY_USD_MERCHANT_RE.test(description)) return true;

  // Foreign-looking merchant + modest amount
  if (
    amountArsAbs < 150 &&
    (/\.COM\b/i.test(description) ||
      /\bINC\.?\b/i.test(description) ||
      /\bLLC\b/i.test(description) ||
      /\bLTD\.?\b/i.test(description))
  ) {
    // Avoid AR tax lines / local acronyms that mention "DIGITALES"
    if (/PERC\.|IIBB|IVA\b|RG\s*\d|IMPUESTO|AFIP/.test(d)) return false;
    return true;
  }

  return false;
}

/**
 * Fix BBVA quirks: USD parked in the ARS column, zero noise, dual same-value cells.
 */
export function normalizeMovementCurrency(input: {
  descriptionNormalized: string;
  amountArs: number | null;
  amountUsd: number | null;
}): { amountArs: number | null; amountUsd: number | null } {
  let amountArs = input.amountArs;
  let amountUsd = input.amountUsd;

  if (amountArs != null && Math.abs(amountArs) < 0.0001) amountArs = null;
  if (amountUsd != null && Math.abs(amountUsd) < 0.0001) amountUsd = null;

  // Same figure in both columns → keep USD for foreign merchants
  if (
    amountArs != null &&
    amountUsd != null &&
    Math.abs(Math.abs(amountArs) - Math.abs(amountUsd)) < 0.02
  ) {
    if (isLikelyForeignUsdSpend(input.descriptionNormalized, Math.abs(amountArs))) {
      amountUsd = Math.abs(amountArs);
      amountArs = null;
    }
  }

  // Only ARS, but clearly a foreign USD charge sitting in $ column
  if (amountArs != null && amountUsd == null) {
    if (isLikelyForeignUsdSpend(input.descriptionNormalized, Math.abs(amountArs))) {
      amountUsd = Math.abs(amountArs);
      amountArs = null;
    }
  }

  return { amountArs, amountUsd };
}

export function amountsClose(
  a: number,
  b: number,
  opts: { absTol?: number; pctTol?: number } = {},
): boolean {
  const absTol = opts.absTol ?? 50;
  const pctTol = opts.pctTol ?? 0.02;
  const diff = Math.abs(a - b);
  if (diff <= absTol) return true;
  const base = Math.max(Math.abs(a), Math.abs(b), 1);
  return diff / base <= pctTol;
}

export function fingerprintParts(parts: Array<string | number | null | undefined>): string {
  return parts
    .map((p) => (p == null ? "" : String(p).trim().toUpperCase()))
    .join("|");
}
