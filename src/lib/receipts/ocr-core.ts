/**
 * Pure receipt helpers (no OpenAI, no zod): the Worker uses them with Workers AI,
 * the legacy route with OpenAI. Keep this file free of runtime imports.
 */

export type ReceiptOcrResult = {
  merchant: string | null;
  /** ISO YYYY-MM-DD */
  date: string | null;
  total: number | null;
  currency: "ARS" | "USD";
  items: Array<{
    name: string;
    quantity: number | null;
    unit_price: number | null;
    line_total: number | null;
  }>;
};

export function todayIso(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function buildSystemPrompt(now = new Date()): string {
  const today = todayIso(now);
  const year = now.getUTCFullYear();
  return `Sos un extractor de tickets de supermercado de Argentina.
Analizá la imagen del ticket y devolvé SOLO un JSON válido (sin markdown) con esta forma:
{
  "merchant": "nombre del comercio o null",
  "date": "YYYY-MM-DD o null",
  "total": número o null,
  "currency": "ARS" o "USD",
  "items": [
    { "name": "producto", "quantity": 1, "unit_price": 100, "line_total": 100 }
  ]
}
Reglas:
- total es el monto final a pagar (incl. descuentos si aplica el total cobrado).
- Fechas en formato argentino DD/MM/YYYY o DD/MM/YY → convertí a YYYY-MM-DD.
- Hoy es ${today}. El año actual es ${year}.
- Si el ticket muestra año de 2 dígitos (ej. 26, 25), interpretá 00–39 como 2000–2039 (26 = ${year >= 2026 ? 2026 : year}). Nunca inventes 2020–2023 si el ticket es reciente.
- No uses el formato estadounidense MM/DD.
- Montos con coma decimal argentina → número JS (punto decimal).
- Si no podés leer un campo, usá null.
- Incluí tantos ítems como puedas leer del ticket.`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function toIso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function expandTwoDigitYear(yy: number): number {
  // 00–39 → 2000–2039, 40–99 → 1940–1999 (tickets actuales casi siempre 00–39)
  if (yy >= 100) return yy;
  if (yy <= 39) return 2000 + yy;
  return 1900 + yy;
}

function daysFromNow(iso: string, now: Date): number {
  const t = new Date(iso + "T12:00:00Z").getTime();
  const n = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    12,
  );
  return (t - n) / (1000 * 60 * 60 * 24);
}

/** Receipt dates should be recent — not years in the past / future. */
function isPlausibleReceiptDate(iso: string, now: Date): boolean {
  const diff = daysFromNow(iso, now);
  // allow up to ~18 months back, 2 days forward (timezone)
  return diff <= 2 && diff >= -550;
}

/**
 * Parse OCR date strings and fix common year mistakes (e.g. 2022 instead of 2026).
 * Thermal tickets often print YY; models invent wrong full years.
 */
export function normalizeReceiptDate(
  raw: string | null | undefined,
  now = new Date(),
): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;

  let y: number | null = null;
  let m: number | null = null;
  let d: number | null = null;

  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    y = Number(iso[1]);
    m = Number(iso[2]);
    d = Number(iso[3]);
  } else {
    // DD/MM/YYYY or DD/MM/YY (Argentine) — not MM/DD
    const dmy = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/);
    if (dmy) {
      d = Number(dmy[1]);
      m = Number(dmy[2]);
      const yr = Number(dmy[3]);
      y = yr < 100 ? expandTwoDigitYear(yr) : yr;
    }
  }

  if (y == null || m == null || d == null) return null;

  const primary = toIso(y, m, d);
  if (primary && isPlausibleReceiptDate(primary, now)) return primary;

  // OCR often keeps day/month but invents year (2022 vs 2026). Try nearby years.
  const cy = now.getUTCFullYear();
  for (const year of [cy, cy - 1, cy + 1]) {
    const candidate = toIso(year, m, d);
    if (candidate && isPlausibleReceiptDate(candidate, now)) return candidate;
  }

  // Last resort: keep primary if valid calendar date (better than null)
  return primary;
}

/** Offline/dev fixture when no API key */
export function mockReceiptOcr(): ReceiptOcrResult {
  return {
    merchant: "DIA TIENDA 536",
    date: todayIso(),
    total: 30277,
    currency: "ARS",
    items: [
      { name: "LECHE ENTERA 1L", quantity: 2, unit_price: 1800, line_total: 3600 },
      { name: "PAN LACTAL", quantity: 1, unit_price: 3200, line_total: 3200 },
      { name: "YERBA 1KG", quantity: 1, unit_price: 8500, line_total: 8500 },
      { name: "ACEITE GIRASOL", quantity: 1, unit_price: 7200, line_total: 7200 },
      { name: "VARIOS", quantity: 1, unit_price: 7777, line_total: 7777 },
    ],
  };
}


function finiteOrNull(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v.replace(",", ".")) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** Validate model output (or user-edited preview) into a ReceiptOcrResult. Never throws on shape. */
export function sanitizeReceiptOcr(raw: unknown, now = new Date()): ReceiptOcrResult {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const merchantRaw = typeof o.merchant === "string" ? o.merchant.replace(/\s+/g, " ").trim() : "";
  const total = finiteOrNull(o.total);
  const itemsRaw = Array.isArray(o.items) ? o.items.slice(0, 200) : [];
  const items = itemsRaw.flatMap((it) => {
    const r = (it && typeof it === "object" ? it : {}) as Record<string, unknown>;
    const name = typeof r.name === "string" ? r.name.replace(/\s+/g, " ").trim().slice(0, 160) : "";
    if (!name) return [];
    return [
      {
        name,
        quantity: finiteOrNull(r.quantity) ?? 1,
        unit_price: finiteOrNull(r.unit_price),
        line_total: finiteOrNull(r.line_total),
      },
    ];
  });
  return {
    merchant: merchantRaw ? merchantRaw.slice(0, 120) : null,
    date: normalizeReceiptDate(typeof o.date === "string" ? o.date : null, now),
    total: total != null && total >= 0 && total < 1e10 ? total : null,
    currency: o.currency === "USD" ? "USD" : "ARS",
    items,
  };
}

/** Pull the first JSON object out of a model reply (it may add prose or fences). */
export function extractJsonObject(text: string): unknown {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("No se pudo leer la respuesta del lector de tickets");
  return JSON.parse(m[0]);
}
