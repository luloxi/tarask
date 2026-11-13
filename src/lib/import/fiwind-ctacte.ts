/**
 * Fiwind Capital "Estado de Cuenta" (cuenta comitente), the monthly PDF Fiwind
 * emails from no-reply@fiwind.capital ("Cuenta Corriente").
 *
 * Layout (one block per currency):
 *
 *   Pesos - $   Saldo Anterior -20.0700 $
 *   29/9/2026 29/9/2026  Movimiento Manual / Ajuste de saldo residual (ARS)  20.07  20.07  $
 *   Saldo al 30/09/2026 $
 *
 * Columns: Concertación, Liquidación, Detalle, Valor Nominal, Importe Bruto,
 * Precio, Importe Neto, Saldo, Símbolo, IVA/derechos. A month without
 * operations prints "No existen movimientos para la cuenta corriente".
 *
 * The text comes either from Workers AI `toMarkdown` (cells glued onto one
 * line, details wrapped) or from a plain PDF text extractor (details above or
 * below the dates). Both are handled: a row is "the two dates plus everything
 * until the next dated row or section marker".
 *
 * Everything here is accounting on the broker account (ajustes, compra/venta de
 * títulos, giros): the description is prefixed with "Cuenta comitente" so
 * `classifyFiwindTipo` keeps it out of gastos and ingresos.
 */

import { makeFingerprint, type BbvaMovement } from "@/lib/bbva/parse";
import {
  categoryHintForFiwindKind,
  classifyFiwindTipo,
  flagsForFiwindKind,
} from "@/lib/import/fiwind";

export type FiwindCtaCteResult = {
  movements: BbvaMovement[];
  /** The statement said the period has no movements. */
  emptyPeriod: boolean;
  /** Skipped rows we could not read (shown to the user, never silently dropped). */
  unreadable: string[];
};

const DATE = String.raw`\d{1,2}/\d{1,2}/\d{4}`;
const ROW_START_RE = new RegExp(`^(${DATE})\\s+(${DATE})(?:\\s+|$)(.*)$`);
const SECTION_END_RE =
  /Saldo\s+al\s+\d|Sistema\s+aprobado|Domicilio:|Hoja\s+N[°º]|Saldo\s+Anterior|^Disponible\b/i;
const HAS_WORDS_RE = /[A-Za-zÁÉÍÓÚáéíóú]{3,}/;
const AMOUNT_RE = /^-?(?:\d{1,3}(?:[.,]\d{3})+|\d+)(?:[.,]\d+)?$/;

export function looksLikeFiwindCtaCte(text: string): boolean {
  return (
    /Estado\s+de\s+Cuenta/i.test(text) &&
    /Fiwind\s+Capital|Concertaci[oó]n\s+Liquidaci[oó]n/i.test(text) &&
    /Simbolo|S[ií]mbolo|Saldo\s+Anterior|No\s+existen\s+movimientos/i.test(text)
  );
}

/** "1.234,50" → 1234.5, "20.0700" → 20.07, "-5.000" → -5000 (3 digits after a lone dot = thousands). */
export function parseCtaCteAmount(raw: string): number | null {
  const s = raw.trim();
  if (!AMOUNT_RE.test(s)) return null;
  const negative = s.startsWith("-");
  const body = s.replace(/^-/, "");
  const lastDot = body.lastIndexOf(".");
  const lastComma = body.lastIndexOf(",");
  let normalized: string;
  if (lastDot >= 0 && lastComma >= 0) {
    const decimalSep = lastDot > lastComma ? "." : ",";
    const thousandSep = decimalSep === "." ? "," : ".";
    normalized = body.split(thousandSep).join("").replace(decimalSep, ".");
  } else if (lastComma >= 0) {
    // "1,234" is ambiguous; Argentine statements use the comma for decimals.
    const parts = body.split(",");
    normalized = parts.length > 2 ? parts.join("") : body.replace(",", ".");
  } else if (lastDot >= 0) {
    const parts = body.split(".");
    const tail = parts[parts.length - 1]!;
    // Fiwind prints decimals with a dot and up to 4 digits ("20.0700"). Several
    // dots mean thousands ("1.234.567").
    normalized = parts.length > 2 && tail.length === 3 ? parts.join("") : body;
  } else {
    normalized = body;
  }
  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

type CurrencyCtx = { label: string; usd: boolean };

function currencyFromHeader(line: string): CurrencyCtx | null {
  const m = line.match(
    /(Pesos|D[oó]lares?(?:\s+[A-Za-z]+)?|Cripto(?:moneda)?s?(?:\s+[A-Za-z]+)?|[A-Z]{3,6})\s+-\s+(\$|U\$S|US\$|USD[A-Z]*|[A-Z]{3,6})\s*(?:Saldo\s+Anterior|$)/,
  );
  if (!m) return null;
  const label = m[1]!.trim();
  const symbol = m[2]!;
  const usd = /^(U\$S|US\$|USD)/.test(symbol) || /^D[oó]lar/i.test(label);
  const ars = symbol === "$" || /^Pesos/i.test(label);
  if (!usd && !ars) {
    // Other assets (crypto, bonds in nominal units) are not pesos. USD-pegged
    // stablecoins count as dollars; anything else is reported as unreadable.
    if (/^(USDT|USDC|DAI|BUSD)$/i.test(symbol)) return { label, usd: true };
    return { label: `${label} ${symbol}`, usd: false };
  }
  return { label, usd };
}

function cleanDetail(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(/\bcuenta\s+\d{3,}\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s*\(ARS\)\s*$/i, "")
    .trim();
}

function approx(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.011;
}

/** Importe Neto of a row, using the running balance to tell it from the Saldo column. */
export function pickImporteNeto(nums: number[], prevSaldo: number | null): number | null {
  if (nums.length === 0) return null;
  if (nums.length === 1) return nums[0]!;
  const last = nums[nums.length - 1]!;
  const beforeLast = nums[nums.length - 2]!;
  if (prevSaldo != null && approx(prevSaldo + beforeLast, last)) return beforeLast;
  // Saldo is blank when it is zero, so a trailing number is the Neto, unless a
  // full row (nominal, bruto, precio, neto, saldo) was printed.
  return nums.length >= 5 ? beforeLast : last;
}

export function parseFiwindCtaCteText(text: string): FiwindCtaCteResult {
  const lines = text
    .split(/\r?\n/)
    .map((l) =>
      l
        .replace(/\u0000/g, "")
        // toMarkdown glues the symbol to the last amount: "149979.93$", "12.50USD".
        .replace(/(\d)(\$|U\$S|US\$|USD[A-Z]*)(?=\s|$)/g, "$1 $2")
        .trim(),
    )
    .filter(Boolean);

  const movements: BbvaMovement[] = [];
  const unreadable: string[] = [];
  const emptyPeriod = /No\s+existen\s+movimientos/i.test(text);

  let currency: CurrencyCtx = { label: "Pesos", usd: false };
  let prevSaldo: number | null = null;
  let block: { date: string; text: string } | null = null;
  // Lines between rows. Some extractors print the detail above the dates.
  let pre: string[] = [];

  const flush = () => {
    if (!block) return;
    const b = block;
    block = null;
    const symbolMatch = b.text.match(/\s(\$|U\$S|US\$|USD[A-Z]*|[A-Z]{3,6})\s*$/);
    let body = b.text;
    let symbol: string | null = null;
    if (symbolMatch) {
      symbol = symbolMatch[1]!;
      body = body.slice(0, symbolMatch.index).trim();
    }
    const tokens = body.split(/\s+/);
    const nums: number[] = [];
    while (tokens.length > 0) {
      const n = parseCtaCteAmount(tokens[tokens.length - 1]!);
      if (n == null) break;
      nums.unshift(n);
      tokens.pop();
    }
    const detail = cleanDetail(tokens.join(" "));
    const neto = pickImporteNeto(nums, prevSaldo);
    if (neto == null || !detail) {
      unreadable.push(`${b.date} ${detail || b.text.slice(0, 40)}`.trim());
      return;
    }
    const symbolUsd = symbol != null && /^(U\$S|US\$|USD)/.test(symbol);
    const symbolArs = symbol === "$";
    const isUsd = symbol ? symbolUsd || (!symbolArs && currency.usd) : currency.usd;
    if (symbol && !symbolUsd && !symbolArs && !currency.usd) {
      unreadable.push(`${b.date} ${detail} (${symbol})`);
      return;
    }
    const description = `Cuenta comitente: ${detail}`;
    const abs = Math.abs(neto);
    if (abs < 0.0001) return;
    const kind = classifyFiwindTipo(description);
    const flags = flagsForFiwindKind(kind);
    const partial = {
      date: b.date,
      descriptionRaw: description,
      descriptionNormalized: description,
      installment: null,
      amountArs: isUsd ? null : abs,
      amountUsd: isUsd ? abs : null,
      isPayment: flags.isPayment,
      isCredit: flags.isCredit || neto > 0,
      categoryHint: categoryHintForFiwindKind(kind),
      cardLast4: null,
    };
    movements.push({ ...partial, fingerprint: makeFingerprint(partial) });
    prevSaldo = prevSaldo != null ? prevSaldo + neto : prevSaldo;
  };

  /** Currency header / "Saldo Anterior" (may be glued after a "Saldo al …" tail). */
  const handleSection = (text: string): boolean => {
    const header = currencyFromHeader(text);
    const saldoAnterior = text.match(/Saldo\s+Anterior\s+(-?[\d.,]+)/i);
    if (!header && !saldoAnterior) return false;
    flush();
    pre = [];
    if (header) currency = header;
    if (saldoAnterior) prevSaldo = parseCtaCteAmount(saldoAnterior[1]!);
    return true;
  };

  for (const line of lines) {
    const row = line.match(ROW_START_RE);
    if (row) {
      flush();
      const [d, m, y] = row[1]!.split("/").map(Number);
      const date = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      let rest = row[3] ?? "";
      // The extractor can glue the next section onto the row
      // ("… $ Saldo al … $ Dolares - USD Saldo Anterior …").
      const cut = rest.search(SECTION_END_RE);
      const tail = cut >= 0 ? rest.slice(cut) : "";
      if (cut >= 0) rest = rest.slice(0, cut).trim();
      // Detail printed above the dates: the row itself only has numbers.
      if (!HAS_WORDS_RE.test(rest.replace(/\b(USD[A-Z]*|U\$S|US\$)\b/g, "")) && pre.length > 0) {
        rest = `${pre.join(" ")} ${rest}`;
      }
      pre = [];
      block = { date, text: rest };
      if (cut >= 0) {
        flush();
        handleSection(tail);
      }
      continue;
    }
    if (handleSection(line)) continue;
    if (SECTION_END_RE.test(line)) {
      // Keep text before the marker ("… $Saldo al 30/09/2026 $Sistema aprobado…").
      const cut = line.search(SECTION_END_RE);
      if (block && cut > 0) block.text = `${block.text} ${line.slice(0, cut)}`.trim();
      flush();
      pre = [];
      continue;
    }
    if (block) {
      const complete = /\d\s+(\$|U\$S|US\$|USD[A-Z]*)\s*$/.test(block.text);
      if (complete && HAS_WORDS_RE.test(line)) {
        // Text after a finished row belongs to the next row's detail.
        flush();
        pre.push(line);
      } else {
        block.text = `${block.text} ${line}`.trim();
      }
    } else {
      pre.push(line);
    }
  }
  flush();

  return { movements, emptyPeriod, unreadable };
}
