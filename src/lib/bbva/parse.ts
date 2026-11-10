import * as XLSX from "xlsx";
import { createHash } from "crypto";
import {
  amountFingerprintKey,
  fingerprintParts,
  normalizeMovementCurrency,
  parseBbvaAmount,
} from "@/lib/money";
import {
  detectBankFromText,
  detectFiwindActividadLayout,
} from "@/lib/import/source";
import {
  categoryHintForFiwindKind,
  classifyFiwindTipo,
  flagsForFiwindKind,
  isDustYield,
} from "@/lib/import/fiwind";
import { isInternalTransferDescription } from "@/lib/bbva/bank-entries";

export type BbvaSheetLayout = "period" | "ultimos" | "table";

export type BbvaMovement = {
  date: string; // YYYY-MM-DD
  descriptionRaw: string;
  descriptionNormalized: string;
  installment: string | null;
  amountArs: number | null;
  amountUsd: number | null;
  isPayment: boolean;
  isCredit: boolean;
  fingerprint: string;
  /** Suggested category slug (Fiwind Tipo: conversiones / crypto / rendimientos). */
  categoryHint?: string;
  /** Last 4 of the BBVA card when the period xls lists more than one. */
  cardLast4?: string | null;
};

function normalizeDescription(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function ymd(year: number, month: number, day: number): string | null {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(d.getTime())) return null;
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return d.toISOString().slice(0, 10);
}

function parseDate(raw: unknown): string | null {
  if (raw == null) return null;
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return ymd(raw.getUTCFullYear(), raw.getUTCMonth() + 1, raw.getUTCDate());
  }
  const s = String(raw).trim();
  // ISO first: "2026-08-31" must not be read as day 2026.
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return ymd(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  // DD/MM/YY or DD/MM/YYYY — also "-" / "." (Fiwind "31-08-2026", "31.08.2026")
  const m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})(?:\s|$|T)/);
  if (m) {
    let year = Number(m[3]);
    if (year < 100) year += 2000;
    return ymd(year, Number(m[2]), Number(m[1]));
  }
  // Excel serial date as number
  if (typeof raw === "number") {
    const parsed = XLSX.SSF.parse_date_code(raw);
    if (parsed) return ymd(parsed.y, parsed.m, parsed.d);
  }
  return null;
}

function validInstallment(a: number, b: number): string | null {
  // Real cuotas: 1/3, 2/6… not tax codes like 5463/5465
  if (a >= 1 && b >= 1 && a <= b && b <= 60) return `${a}/${b}`;
  return null;
}

export function detectBbvaSheetLayout(opts: {
  fileName?: string;
  sheetName?: string;
  previewText?: string;
}): BbvaSheetLayout {
  const name = `${opts.fileName ?? ""} ${opts.sheetName ?? ""}`
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
  const preview = (opts.previewText ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
  if (
    /mov[_-]?periodo/.test(name) ||
    /movimientos del periodo/.test(preview)
  ) {
    return "period";
  }
  if (
    /ultimos[_-]?movimientos/.test(name) ||
    /ultimos movimientos/.test(preview)
  ) {
    return "ultimos";
  }
  return "table";
}

function extractCardLast4FromTotalRow(row: unknown[] | null | undefined): string | null {
  if (!row) return null;
  const joined = row.map((c) => String(c ?? "")).join(" ");
  const m = joined.match(/total\s+tarjeta\s+nro\.?\s*\*{0,8}(\d{4})/i);
  return m ? m[1] : null;
}

/** Rows before each “Total Tarjeta Nro ****XXXX” belong to that card. */
function cardLast4ByRowIndex(rows: unknown[][]): Map<number, string> {
  const totals: Array<{ idx: number; last4: string }> = [];
  for (let i = 0; i < rows.length; i++) {
    const last4 = extractCardLast4FromTotalRow(rows[i]);
    if (last4) totals.push({ idx: i, last4 });
  }
  const map = new Map<number, string>();
  let start = 0;
  for (const t of totals) {
    for (let i = start; i < t.idx; i++) map.set(i, t.last4);
    start = t.idx + 1;
  }
  return map;
}

function isPeriodTotalRow(description: string, col0: unknown): boolean {
  const a = String(col0 ?? "");
  const d = description;
  if (/^total\s+tarjeta\b/i.test(a) || /^total\s+tarjeta\b/i.test(d)) return true;
  if (/monto total de los movimientos/i.test(a) || /monto total de los movimientos/i.test(d)) {
    return true;
  }
  return false;
}

function extractInstallment(description: string, cuotaCol: unknown): string | null {
  const fromCol = cuotaCol != null ? String(cuotaCol).trim() : "";
  // BBVA uses "/" alone when there is no installment
  if (fromCol && fromCol !== "-" && fromCol !== "/") {
    const m = fromCol.match(/(\d+)\s*\/\s*(\d+)/);
    if (m) {
      const hit = validInstallment(Number(m[1]), Number(m[2]));
      if (hit) return hit;
    }
  }
  const m = description.match(/cuota\s*0*(\d+)\s*\/\s*0*(\d+)/i);
  if (m) return validInstallment(Number(m[1]), Number(m[2]));
  return null;
}

function foldDesc(desc: string): string {
  return desc
    .toUpperCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

function isPaymentDescription(desc: string): boolean {
  const u = foldDesc(desc);
  return (
    u.includes("SU PAGO") ||
    u.includes("PAGO EN PESOS") ||
    u.includes("PAGO EN USD") ||
    u.includes("PAGO RECIBIDO") ||
    u.includes("PAGO DE TARJETA") ||
    u.includes("RECARGA") ||
    u.includes("CARGA DE SALDO") ||
    u.includes("CARGA SALDO")
  );
}

function makeFingerprint(m: Omit<BbvaMovement, "fingerprint">): string {
  const base = fingerprintParts([
    m.date,
    m.descriptionNormalized,
    // Amount without currency so ARS↔USD fixes keep the same fingerprint
    amountFingerprintKey(m.amountArs, m.amountUsd),
    m.installment ?? "",
  ]);
  return createHash("sha256").update(base).digest("hex").slice(0, 32);
}

function normalizeHeaderCell(c: unknown): string {
  return String(c ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isDateHeader(h: string): boolean {
  if (h.includes("fecha")) return true;
  if (h === "date" || h.startsWith("date ") || h.endsWith(" date")) return true;
  return false;
}

function isTipoHeader(h: string): boolean {
  return h === "tipo" || h.startsWith("tipo ") || h.startsWith("tipo de");
}

function isMerchantHeader(h: string): boolean {
  return (
    h.includes("establecimiento") ||
    h.includes("movimiento") ||
    h.includes("descrip") ||
    h.includes("comercio") ||
    h.includes("detalle") ||
    h.includes("concepto") ||
    h.includes("merchant") ||
    h === "narration" ||
    h === "detalle operacion" ||
    h === "detalle de operacion" ||
    isTipoHeader(h)
  );
}

function isHeaderRow(row: (string | number | Date | null)[]): boolean {
  const cells = row.map((c) => normalizeHeaderCell(c));
  const joined = cells.join("|");
  if (!cells.some(isDateHeader)) return false;
  // BBVA: Fecha | Establecimiento | Importe en $ | Importe en U$S
  // Fiwind / others: Concepto, Descripción, Merchant + Monto / Débito
  return (
    cells.some(isMerchantHeader) ||
    joined.includes("importe") ||
    joined.includes("monto") ||
    joined.includes("amount") ||
    joined.includes("debito") ||
    joined.includes("credito")
  );
}

function isUsdHeader(h: string): boolean {
  return (
    h.includes("u$s") ||
    h.includes("usd") ||
    h.includes("us$") ||
    h.includes("dolar") ||
    h.includes("dólar")
  );
}

function isArsHeader(h: string): boolean {
  if (isUsdHeader(h)) return false;
  return (
    h.includes("importe") ||
    h.includes("monto") ||
    h.includes("peso") ||
    h.includes("amount") ||
    h.includes("$")
  );
}

function isDebitHeader(h: string): boolean {
  return (
    h.includes("debito") ||
    h.includes("débito") ||
    h === "cargo" ||
    h.includes("cargo ") ||
    h.startsWith("debe") ||
    h === "debit"
  );
}

function isCreditHeader(h: string): boolean {
  return (
    h.includes("credito") ||
    h.includes("crédito") ||
    h === "abono" ||
    h.includes("abono") ||
    h.startsWith("haber") ||
    h === "credit"
  );
}

function isCurrencyHeader(h: string): boolean {
  return h === "moneda" || h === "currency" || h === "divisa" || h === "curr";
}

/** Parse ARS/USD columns; honor USD markers inside either cell. */
function parseArsUsdColumns(
  arsRaw: unknown,
  usdRaw: unknown,
): { amountArs: number | null; amountUsd: number | null } {
  const arsParsed = parseBbvaAmount(arsRaw);
  const usdParsed = parseBbvaAmount(usdRaw);

  let amountArs: number | null = null;
  let amountUsd: number | null = null;

  if (usdParsed) {
    // Value in the U$S column is always USD, even if Excel typed it as a bare number
    amountUsd = usdParsed.value;
  }
  if (arsParsed) {
    if (arsParsed.currency === "USD") {
      // Cell in $ column but labeled "USD …"
      amountUsd = amountUsd ?? arsParsed.value;
    } else {
      amountArs = arsParsed.value;
    }
  }

  return { amountArs, amountUsd };
}

function decodeSpreadsheetText(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.toString("utf16le").replace(/^\uFEFF/, "");
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(buf).replace(/^\uFEFF/, "");
  }
  return buf.toString("utf8").replace(/^\uFEFF/, "");
}

function detectCsvDelimiter(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim()) ?? "";
  const counts: Array<[string, number]> = [
    [";", (line.match(/;/g) ?? []).length],
    ["\t", (line.match(/\t/g) ?? []).length],
    [",", (line.match(/,/g) ?? []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ",";
}

function sniffTableKind(
  buf: Buffer,
  fileName?: string,
): "xlsx" | "xls" | "csv" | "unknown" {
  const name = fileName?.toLowerCase() ?? "";
  if (name.endsWith(".csv") || name.endsWith(".txt")) return "csv";
  if (name.endsWith(".xlsx")) return "xlsx";
  if (name.endsWith(".xls")) return "xls";
  if (buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b) return "xlsx";
  if (
    buf.length >= 8 &&
    buf[0] === 0xd0 &&
    buf[1] === 0xcf &&
    buf[2] === 0x11 &&
    buf[3] === 0xe0
  ) {
    return "xls";
  }
  const sample = buf.subarray(0, Math.min(buf.length, 800));
  if (!sample.includes(0) && /[\r\n]/.test(sample.toString("utf8")) && /[;,\t]/.test(sample.toString("utf8"))) {
    return "csv";
  }
  return "unknown";
}

function currencyFromCell(raw: unknown): "USD" | "ARS" | null {
  if (raw == null || raw === "") return null;
  const u = String(raw)
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
  if (!u) return null;
  if (
    u === "USD" ||
    u === "USDT" ||
    u === "USDC" ||
    u === "US$" ||
    u === "U$S" ||
    /\b(USD|USDT|USDC|U\$S|DOLAR)\b/.test(u)
  ) {
    return "USD";
  }
  if (u === "ARS" || u === "$" || /\b(ARS|PESO)\b/.test(u)) return "ARS";
  return null;
}

function pickStatementSheet(names: string[]): string | undefined {
  const skip = (n: string) => /^(balance|saldos?|resumen)$/i.test(n.trim());
  const usable = names.filter((n) => !skip(n));
  const pool = usable.length > 0 ? usable : names;
  return (
    pool.find((n) => /actividad/i.test(n)) ??
    pool.find((n) => /mov/i.test(n)) ??
    pool.find((n) => /periodo|period|consumo/i.test(n)) ??
    pool[0]
  );
}

export type StatementWorkbookMeta = {
  movements: BbvaMovement[];
  classicBbva: boolean;
  detectedBank: string | null;
  fileKind: "xlsx" | "xls" | "csv" | "unknown";
  layout: BbvaSheetLayout;
};

/**
 * Parse BBVA "Últimos movimientos" and similar bank tables (.xls / .xlsx / .csv).
 * Classic BBVA: Nro. Tarjeta | Fecha | Establecimiento | Cuota | Importe en $ | Importe en U$S
 * Also: Fecha + Concepto/Descripción + Monto/Moneda, or Débito/Crédito (Fiwind y otros).
 */
export function parseStatementWorkbook(
  data: ArrayBuffer | Buffer,
  fileName?: string,
): StatementWorkbookMeta {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(new Uint8Array(data));
  const fileKind = sniffTableKind(buf, fileName);

  let wb: XLSX.WorkBook;
  try {
    if (fileKind === "csv") {
      const text = decodeSpreadsheetText(buf);
      wb = XLSX.read(text, {
        type: "string",
        FS: detectCsvDelimiter(text),
        cellDates: true,
        raw: true,
      });
    } else {
      wb = XLSX.read(buf, { type: "buffer", cellDates: true });
    }
  } catch {
    return {
      movements: [],
      classicBbva: false,
      detectedBank: null,
      fileKind,
      layout: "table",
    };
  }

  const sheetName = pickStatementSheet(wb.SheetNames);
  if (!sheetName) {
    return {
      movements: [],
      classicBbva: false,
      detectedBank: null,
      fileKind,
      layout: "table",
    };
  }

  const rows = XLSX.utils.sheet_to_json<(string | number | Date | null)[]>(
    wb.Sheets[sheetName],
    { header: 1, defval: null, raw: true },
  );

  const previewText = [
    fileName ?? "",
    sheetName,
    ...rows.slice(0, 20).map((r) =>
      (r ?? []).map((c) => String(c ?? "")).join(" "),
    ),
  ].join("\n");

  // Find header row (title row may sit above it)
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    if (isHeaderRow(rows[i] ?? [])) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) {
    // Last resort: first row that has "fecha"
    for (let i = 0; i < Math.min(rows.length, 25); i++) {
      const cells = (rows[i] ?? []).map((c) => normalizeHeaderCell(c));
      if (cells.some(isDateHeader)) {
        headerIdx = i;
        break;
      }
    }
  }
  if (headerIdx < 0) headerIdx = 0;

  const header = (rows[headerIdx] ?? []).map(normalizeHeaderCell);

  const colDate = header.findIndex(isDateHeader);
  const colMov = header.findIndex(isMerchantHeader);
  const colCuota = header.findIndex((h) => h.includes("cuota"));
  const colUsd = header.findIndex(
    (h) => (h.includes("importe") || h.includes("monto") || h.includes("amount")) && isUsdHeader(h),
  );
  let colArs = header.findIndex(
    (h) =>
      (h.includes("importe") || h.includes("monto") || h.includes("amount") || h.includes("$")) &&
      isArsHeader(h),
  );
  // If only one "importe" and it's not USD, use it as ARS
  if (colArs < 0) {
    colArs = header.findIndex(
      (h, i) =>
        i !== colUsd &&
        (h.includes("importe") || h.includes("monto") || h.includes("peso") || h.includes("amount")),
    );
  }
  const colDebit = header.findIndex(isDebitHeader);
  const colCredit = header.findIndex(isCreditHeader);
  const colCurrency = header.findIndex((h) => h === "moneda" || isCurrencyHeader(h));
  const colMontoOrigen = header.findIndex(
    (h) => h.includes("monto origen") || h.includes("importe origen"),
  );
  const colMonedaOrigen = header.findIndex(
    (h) => h.includes("moneda origen") || h.includes("divisa origen"),
  );

  const classicBbva =
    header.some((h) => h.includes("establecimiento")) &&
    (header.some((h) => h.includes("importe en") || h.includes("u$s")) ||
      (colArs >= 0 && colUsd >= 0));

  const fiwindLayout = detectFiwindActividadLayout({
    fileName,
    sheetNames: wb.SheetNames,
    headers: header,
  });
  const detectedBank = fiwindLayout
    ? "Fiwind"
    : detectBankFromText(previewText);

  const layout = detectBbvaSheetLayout({
    fileName,
    sheetName,
    previewText,
  });
  const last4ByRow = cardLast4ByRowIndex(rows);

  const useSplit = colArs < 0 && (colDebit >= 0 || colCredit >= 0);

  // Layout fallback for classic BBVA export (no reliable header match):
  // 0 card, 1 date, 2 merchant, 3 cuota, 4 ARS, 5 USD
  // Do NOT apply that fallback to Fiwind Actividad (Fecha|Tipo|Monto|Moneda).
  const useClassicFallback =
    classicBbva ||
    (!fiwindLayout && colMov < 0 && colArs < 0 && colDebit < 0 && colCredit < 0);
  const dateIdx = colDate >= 0 ? colDate : useClassicFallback ? 1 : 0;
  const movIdx = colMov >= 0 ? colMov : useClassicFallback ? 2 : header.findIndex(isTipoHeader);
  const cuotaIdx = colCuota >= 0 ? colCuota : useClassicFallback ? 3 : -1;
  const arsIdx = colArs >= 0 ? colArs : useClassicFallback ? 4 : -1;
  const usdIdx = colUsd >= 0 ? colUsd : useClassicFallback ? 5 : -1;

  const out: BbvaMovement[] = [];

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every((c) => c == null || String(c).trim() === "")) continue;

    const descriptionRaw = String(movIdx >= 0 ? (row[movIdx] ?? "") : "").trim();
    if (!descriptionRaw) continue;
    // Skip totals / footer rows
    if (/^total\b/i.test(descriptionRaw)) continue;
    if (/monto total/i.test(descriptionRaw)) continue;
    if (isPeriodTotalRow(descriptionRaw, row[0])) continue;

    const date = parseDate(row[dateIdx]);
    if (!date) continue;

    let descriptionNormalized = normalizeDescription(descriptionRaw);
    const installment = extractInstallment(
      descriptionRaw,
      colCuota >= 0 || classicBbva ? row[cuotaIdx] : null,
    );

    let amountArs: number | null = null;
    let amountUsd: number | null = null;

    if (useSplit) {
      const debit = colDebit >= 0 ? parseBbvaAmount(row[colDebit]) : null;
      const credit = colCredit >= 0 ? parseBbvaAmount(row[colCredit]) : null;
      if (debit && Math.abs(debit.value) > 0) {
        amountArs = Math.abs(debit.value);
      } else if (credit && Math.abs(credit.value) > 0) {
        amountArs = -Math.abs(credit.value);
      }
    } else {
      ({ amountArs, amountUsd } = parseArsUsdColumns(
        arsIdx >= 0 ? row[arsIdx] : null,
        usdIdx >= 0 ? row[usdIdx] : null,
      ));
    }

    const monedaRaw = colCurrency >= 0 ? row[colCurrency] : null;
    const moneda = currencyFromCell(monedaRaw);
    if (moneda === "USD" && amountUsd == null && amountArs != null) {
      amountUsd = amountArs;
      amountArs = null;
    } else if (moneda === "ARS" && amountArs == null && amountUsd != null) {
      amountArs = amountUsd;
      amountUsd = null;
    }

    // Unknown currency (ADA, etc.): don't park it as pesos.
    if (
      moneda == null &&
      monedaRaw != null &&
      String(monedaRaw).trim() &&
      !/^ars$/i.test(String(monedaRaw).trim())
    ) {
      const code = String(monedaRaw).trim().toUpperCase();
      if (code && !/^\d/.test(code)) {
        descriptionNormalized = normalizeDescription(
          `${descriptionNormalized} (${code})`,
        );
        amountArs = null;
        amountUsd = null;
      }
    }

    if (amountArs == null && amountUsd == null && colMontoOrigen >= 0) {
      const originAmt = parseBbvaAmount(row[colMontoOrigen]);
      const originCur =
        colMonedaOrigen >= 0
          ? currencyFromCell(row[colMonedaOrigen])
          : null;
      if (originAmt) {
        if (originCur === "USD") amountUsd = originAmt.value;
        else amountArs = originAmt.value;
      }
    }

    ({ amountArs, amountUsd } = normalizeMovementCurrency({
      descriptionNormalized,
      amountArs,
      amountUsd,
    }));
    if (amountArs == null && amountUsd == null) continue;

    const negative = (amountArs ?? amountUsd ?? 0) < 0;
    let payment = isPaymentDescription(descriptionNormalized) || negative;
    let credit =
      negative && !isPaymentDescription(descriptionNormalized);
    let categoryHint: string | undefined;

    if (fiwindLayout) {
      const kind = classifyFiwindTipo(descriptionNormalized);
      if (isDustYield(kind, amountArs, amountUsd)) continue;
      const flags = flagsForFiwindKind(kind);
      // Keep SU PAGO / PAGO RECIBIDO as payments even on a Fiwind-named file.
      payment = isPaymentDescription(descriptionNormalized) || flags.isPayment;
      credit = flags.isCredit || (negative && !payment);
      categoryHint = categoryHintForFiwindKind(kind);
    }

    // Explicit own-account / own FX → Transferencia interna (never Ingresos).
    // A bare TRANSFERENCIA or TRANSFERENCIA INMEDIATA stays is_payment 0 so
    // the worker can classify the new row. Assign, don't fill: Fiwind kind
    // "transfer" hints Conversiones (TRANSFERENCIA ARS/USDC), and
    // “A/De una cuenta tuya” must still win.
    if (isInternalTransferDescription(descriptionNormalized)) {
      payment = true;
      credit = false;
      categoryHint = "transferencia-interna";
    }

    const partial = {
      date,
      descriptionRaw:
        descriptionNormalized !== normalizeDescription(descriptionRaw)
          ? descriptionNormalized
          : descriptionRaw,
      descriptionNormalized,
      installment,
      amountArs,
      amountUsd,
      isPayment: payment,
      isCredit: credit,
      categoryHint,
      cardLast4: last4ByRow.get(i) ?? null,
    };

    out.push({ ...partial, fingerprint: makeFingerprint(partial) });
  }

  return { movements: out, classicBbva, detectedBank, fileKind, layout };
}

/**
 * Parse BBVA "Últimos movimientos" (.xls / .xlsx) buffer.
 * Supports the home-banking export and similar Fecha/Descripción/Importe tables.
 */
export function parseBbvaWorkbook(
  data: ArrayBuffer | Buffer,
  fileName?: string,
): BbvaMovement[] {
  return parseStatementWorkbook(data, fileName).movements;
}

/**
 * Parse Transparencia "Consumos" sheet for historical migration.
 */
export type TransparenciaConsumo = {
  period: string;
  date: string;
  description: string;
  amountArs: number | null;
  amountUsd: number | null;
  categoryName: string;
  fingerprint: string;
};

function parseMoneyLoose(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  let s = String(raw).trim();
  if (!s || s === "-") return null;
  s = s.replace(/USD/gi, "").replace(/\$/g, "").replace(/\s/g, "");
  const negative = s.startsWith("-");
  s = s.replace(/-/g, "");
  if (s.includes(",") && s.includes(".")) {
    // AR: 1.234,56
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (s.includes(",")) {
    // 1234,56
    s = s.replace(",", ".");
  }
  // plain "14681.86" keeps the decimal point
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -Math.abs(n) : n;
}

export function parseTransparenciaConsumos(
  data: ArrayBuffer | Buffer,
): TransparenciaConsumo[] {
  const wb = XLSX.read(data, { type: "buffer", cellDates: true });
  const sheet =
    wb.Sheets["Consumos"] ??
    wb.Sheets[wb.SheetNames.find((n) => n.toLowerCase().includes("consumo")) ?? ""];
  if (!sheet) return [];

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: null,
    raw: true,
  });

  const out: TransparenciaConsumo[] = [];
  for (const r of rows) {
    const desc = String(r["Descripción"] ?? r["Descripcion"] ?? "").trim();
    if (!desc) continue;

    let dateStr: string | null = null;
    const fecha = r["Fecha"];
    if (fecha instanceof Date) dateStr = fecha.toISOString().slice(0, 10);
    else dateStr = parseDate(fecha);

    if (!dateStr) continue;

    let period = "";
    const per = r["Período"] ?? r["Periodo"];
    if (per instanceof Date) period = per.toISOString().slice(0, 7);
    else if (per) period = String(per).slice(0, 7);

    const amountArs = parseMoneyLoose(r["Monto $"]);
    let amountUsd: number | null = null;
    const usdRaw = r["Monto USD"];
    if (usdRaw != null && String(usdRaw).trim() && String(usdRaw).trim() !== "-") {
      const s = String(usdRaw).replace(/USD/gi, "").trim();
      amountUsd = parseMoneyLoose(s);
    }

    const categoryName = String(r["Categoría"] ?? r["Categoria"] ?? "Uncategorized").trim();
    const description = normalizeDescription(desc);
    const fp = createHash("sha256")
      .update(
        fingerprintParts([
          dateStr,
          description,
          amountArs?.toFixed(2) ?? "",
          amountUsd?.toFixed(2) ?? "",
          categoryName,
        ]),
      )
      .digest("hex")
      .slice(0, 32);

    out.push({
      period,
      date: dateStr,
      description,
      amountArs,
      amountUsd,
      categoryName,
      fingerprint: fp,
    });
  }
  return out;
}