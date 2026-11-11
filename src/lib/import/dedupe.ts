/** Stable key for “same expense” even if fingerprint algorithm changed. */
export function logicalExpenseKey(m: {
  date: string;
  descriptionNormalized: string;
  amountArs: number | null;
  amountUsd: number | null;
  installment: string | null;
  isPayment?: boolean;
}): string {
  const ars =
    m.amountArs != null && Number.isFinite(m.amountArs)
      ? Math.abs(m.amountArs).toFixed(2)
      : "";
  const usd =
    m.amountUsd != null && Number.isFinite(m.amountUsd)
      ? Math.abs(m.amountUsd).toFixed(2)
      : "";
  return [
    m.date,
    m.descriptionNormalized.trim().toUpperCase(),
    ars,
    usd,
    m.installment ?? "",
    m.isPayment ? "1" : "0",
  ].join("|");
}

const NOISE =
  /\b(?:COMPRA|PAGO|DEBITO|CREDITO|DEB|CRED|EST|TARJETA|VISA|MASTER|MASTERCARD)\b/g;

/** Same shop across email alerts, statements and Fiwind. */
export function foldMerchant(description: string | null | undefined): string {
  return (description ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(NOISE, " ")
    .replace(/\b\d{3,}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function compactMerchant(description: string | null | undefined): string {
  return foldMerchant(description).replace(/\s+/g, "");
}

export function isNumericMerchant(description: string | null | undefined): boolean {
  const text = (description ?? "").trim().toUpperCase();
  if (!/^[0-9]/.test(text)) return false;
  return !/[^0-9.]/.test(text);
}

function amountPart(
  amountArs: number | null | undefined,
  amountUsd: number | null | undefined,
): string {
  const ars =
    amountArs != null && Number.isFinite(amountArs) && Math.abs(amountArs) >= 0.005
      ? Math.abs(amountArs).toFixed(2)
      : "";
  const usd =
    amountUsd != null && Number.isFinite(amountUsd) && Math.abs(amountUsd) >= 0.005
      ? Math.abs(amountUsd).toFixed(2)
      : "";
  if (usd && Number(ars || 0) === 0) return `USD:${usd}`;
  if (ars) return `ARS:${ars}`;
  if (usd) return `USD:${usd}`;
  return "";
}

/**
 * Same calendar day + same amount + same folded merchant.
 * Numeric-only Fiwind rows keep an empty merchant so they pair on date+amount.
 */
export function logicalMerchantKey(m: {
  date: string;
  descriptionNormalized: string;
  amountArs: number | null;
  amountUsd: number | null;
}): string | null {
  const amount = amountPart(m.amountArs, m.amountUsd);
  if (!amount) return null;
  const merchant = isNumericMerchant(m.descriptionNormalized)
    ? ""
    : compactMerchant(m.descriptionNormalized);
  if (!merchant && !isNumericMerchant(m.descriptionNormalized)) return null;
  return `${m.date}|${amount}|${merchant}`;
}

/** True when two named shops are the same movement. */
export function merchantsMatch(left: string, right: string): boolean {
  const a = compactMerchant(left);
  const b = compactMerchant(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return shorter.length >= 3 && longer.startsWith(shorter);
}
