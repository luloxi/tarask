/**
 * Fiwind Actividad (Excel): Tipo-based classification.
 *
 * The export mixes real spends (Pago a X, Retiro a X, QR/tarjeta) with
 * wallet noise: USDC↔ARS conversions, Compra/Venta KO, tiny yields.
 * Those must not inflate gastos — and a convert-then-pay flow is one spend.
 */

export type FiwindKind =
  | "spend"
  | "conversion"
  | "investment"
  | "yield"
  | "deposit"
  | "refund"
  | "crypto_out"
  | "transfer"
  | "numeric";

export function foldFiwind(s: string): string {
  return s
    .toUpperCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Strip “Pago a …” / “Cargo extra de …” so merchant rules can match. */
export function extractFiwindMerchant(tipo: string): string {
  const s = String(tipo ?? "").replace(/\s+/g, " ").trim();
  const m = s.match(
    /^(?:Pago a|Cargo extra de|Devoluci[oó]n de)\s+(.+)$/i,
  );
  return m?.[1]?.trim() || s;
}

/**
 * Exact short merchants that substring rules miss (“Pago a DIA” ≠ “DIA ”).
 * Values are category slugs.
 */
const EXACT_MERCHANT_SLUG: Record<string, string> = {
  DIA: "supermercado",
};

export function exactFiwindMerchantSlug(
  tipo: string,
): string | undefined {
  const merchant = foldFiwind(extractFiwindMerchant(tipo));
  return EXACT_MERCHANT_SLUG[merchant];
}

/** Tipo that is only an amount (legacy parse used Monto as Descripción). */
export function isFiwindNumericTipo(tipo: string): boolean {
  return /^\d+(\.\d+)?$/.test(String(tipo ?? "").trim());
}

/**
 * Wallet TRANSFERENCIA ARS / USDC / … — not a household spend.
 * Does not match “TRANSFERENCIA A Nombre” (person payment).
 */
export function isFiwindWalletTransferTipo(tipo: string): boolean {
  const u = foldFiwind(tipo);
  return /^TRANSFERENCIA(\s+[A-Z0-9.]{2,10})*$/.test(u);
}

export function classifyFiwindTipo(tipo: string): FiwindKind {
  if (isFiwindNumericTipo(tipo)) return "numeric";
  const u = foldFiwind(tipo);
  // Own wallet / own bank: “A/De una cuenta tuya” — not spend or income.
  if (/\b(A|DE)\s+(UNA\s+)?CUENTA\s+TUYA\b/.test(u)) return "transfer";
  // Grocery (“COMPRA SUPER ARS”), not Compra KO / Compra USDC.
  if (/^COMPRA\s+SUPER\b/.test(u)) return "spend";
  // Fiwind Capital "Estado de Cuenta" (cuenta comitente, PDF): broker ledger
  // lines (ajustes, compra/venta de títulos, cupones, giros). Never consumer
  // spend, so they stay out of gastos like the other wallet noise.
  if (/^CUENTA COMITENTE\b/.test(u)) return "transfer";
  if (/^CONVERSION\b/.test(u)) return "conversion";
  if (/^(GANANCIA|RENDIMIENTO)\b/.test(u)) return "yield";
  if (
    /^(COMPRA|VENTA)\s+(?!SUPER\b)[A-Z0-9.]{1,10}$/.test(u) ||
    /^(COMPRA|VENTA)\s+KO\b/.test(u)
  ) {
    return "investment";
  }
  if (isFiwindWalletTransferTipo(u)) return "transfer";
  if (/^DEPOSITO\b/.test(u)) return "deposit";
  if (/^DEVOLUCION\b/.test(u)) return "refund";
  // Bare “Retiro” (no “a Nombre”) = crypto/cash out of the wallet, not a gasto.
  if (/^RETIRO$/.test(u)) return "crypto_out";
  return "spend";
}

export function isFiwindNonExpenseKind(kind: FiwindKind): boolean {
  return (
    kind === "conversion" ||
    kind === "investment" ||
    kind === "yield" ||
    kind === "deposit" ||
    kind === "crypto_out" ||
    kind === "transfer" ||
    kind === "numeric"
  );
}

/** True for Fiwind Tipo lines that must not count as household spend. */
export function isFiwindNonExpenseTipo(tipo: string): boolean {
  return isFiwindNonExpenseKind(classifyFiwindTipo(tipo));
}

/** Dust yields: 0 USDC, 0.00005 USDT, $0.27 ARS… keep meaningful rendimientos. */
export function isDustYield(
  kind: FiwindKind,
  amountArs: number | null | undefined,
  amountUsd: number | null | undefined,
): boolean {
  if (kind !== "yield") return false;
  const a = amountArs != null && Number.isFinite(amountArs) ? Math.abs(amountArs) : 0;
  const u = amountUsd != null && Number.isFinite(amountUsd) ? Math.abs(amountUsd) : 0;
  return a < 1 && u < 0.05;
}

export const FIWIND_CATEGORY_SLUG: Record<
  Extract<
    FiwindKind,
    | "conversion"
    | "investment"
    | "yield"
    | "crypto_out"
    | "transfer"
    | "numeric"
  >,
  string
> = {
  conversion: "conversiones",
  investment: "crypto-inversiones",
  yield: "rendimientos",
  crypto_out: "conversiones",
  // Wallet TRANSFERENCIA ARS/USDC/USDT/USD. “A/De una cuenta tuya” shares this
  // kind but is Transferencia interna via isInternalTransferDescription.
  transfer: "conversiones",
  numeric: "conversiones",
};

export function categoryHintForFiwindKind(kind: FiwindKind): string | undefined {
  if (
    kind === "conversion" ||
    kind === "investment" ||
    kind === "yield" ||
    kind === "crypto_out" ||
    kind === "transfer" ||
    kind === "numeric"
  ) {
    return FIWIND_CATEGORY_SLUG[kind];
  }
  return undefined;
}

/**
 * Category slug for a one-shot cleanup of already-imported Fiwind noise.
 * Spends / refunds / deposits are left alone. Does not delete rows.
 */
export function reclassifyTargetForDescription(
  description: string,
): string | undefined {
  return categoryHintForFiwindKind(classifyFiwindTipo(description));
}

export function flagsForFiwindKind(kind: FiwindKind): {
  isPayment: boolean;
  isCredit: boolean;
} {
  switch (kind) {
    case "deposit":
    case "refund":
      return { isPayment: false, isCredit: true };
    default:
      // Spends, conversions, investments, yields, crypto-out: not card payments.
      // Non-spend kinds are excluded from gastos via isBankAccountingEntry.
      return { isPayment: false, isCredit: false };
  }
}

function absOrZero(n: number | null | undefined): number {
  return n != null && Number.isFinite(n) ? Math.abs(n) : 0;
}

function amountsMatch(
  a: { amountArs: number | null; amountUsd: number | null },
  b: { amountArs: number | null; amountUsd: number | null },
): boolean {
  const arsA = absOrZero(a.amountArs);
  const arsB = absOrZero(b.amountArs);
  const usdA = absOrZero(a.amountUsd);
  const usdB = absOrZero(b.amountUsd);
  if (arsA > 0 && arsB > 0 && Math.abs(arsA - arsB) <= 1) return true;
  if (usdA > 0 && usdB > 0 && Math.abs(usdA - usdB) <= 0.05) return true;
  return false;
}

export type FiwindPairRow = {
  date: string;
  kind: FiwindKind;
  amountArs: number | null;
  amountUsd: number | null;
};

/**
 * Convert-then-pay (or convert-then-retiro) is one economic event.
 * If a conversion shares date + amount with a real spend, the conversion
 * must not be counted as a second expense (caller already treats it as
 * accounting — this is the explicit pairing check for tests / summaries).
 */
export function conversionPairedWithSpend(
  conversion: FiwindPairRow,
  rows: FiwindPairRow[],
): boolean {
  if (conversion.kind !== "conversion") return false;
  return rows.some(
    (r) =>
      r !== conversion &&
      r.date === conversion.date &&
      (r.kind === "spend" || r.kind === "crypto_out") &&
      amountsMatch(conversion, r),
  );
}