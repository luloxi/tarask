/**
 * Classify expense transfers by data, not by the label text.
 *
 * An expense-eligible row (`is_payment = 0` and `is_credit = 0`) whose
 * accent-folded description is a transfer is one of three things:
 *
 * - internal: the description carries an own-account id, or a 1:1 incoming
 *   twin of the same signed amount exists within one calendar day in another
 *   account of the same user. Internal ids are dropped from expense totals
 *   and stay visible in Consumos.
 * - third party: a non-own CUIT, CBU/CVU, alias, or payee name is present,
 *   and there is no own id and no twin. It counts as spending. No flag.
 * - revisar: none of the above. It counts, stays on Consumos, and the
 *   Worker sets `revisar: true` on the row. The flag is computed per request.
 *
 * Own ids are `OWN_ACCOUNT_IDS` (comma-separated CUITs, CBUs/CVUs, aliases;
 * never committed) plus every CUIT/CBU/CVU found on the user's rows whose
 * description contains an own-account marker. No real id is hardcoded.
 *
 * Direction uses the row's own currency (USD when |USD| >= 0.005 and the
 * counted ARS is 0 the way `ARS_EXPR` is 0 when both sides are nonzero,
 * otherwise ARS). Outgoing is a positive amount with `is_credit = 0`.
 * Incoming is `is_credit = 1` with either sign, or a negative amount with
 * `is_credit = 0`. A twin must be the opposite direction. The incoming
 * description must be a transfer or an own-account credit (marker or own
 * id). An unrelated credit such as DEVOLUCION COMPRA does not cancel the
 * transfer.
 *
 * For `is_credit = 1`, compare absolute values, so +100 outgoing matches
 * -100 stored on a credit. A negative amount with `is_credit = 0` stays
 * incoming, but the signs disagree with a positive outgoing, so +100 does
 * not match -100 on that shape. +100 outgoing does not match +100 outgoing.
 * Tolerance is strictly under 0.01 ARS or 0.005 USD.
 *
 * Pairing is 1:1. Closest day first, then transfer date, transfer id, twin
 * date, twin id. Each incoming row cancels at most one transfer. Rows in a
 * household the user does not belong to are ignored.
 *
 * `classifyTransferRows` and `deriveOwnAccountIds` take plain arrays. They
 * do not touch D1. The loader is two extra indexed statements on top of the
 * Fiwind echo lookup: `household_members.user_id`, then
 * `tx_household_date_idx (household_id, date)`. D1 rejects a compound SELECT
 * with more than five terms, so income twins are a second statement. A
 * transfer-statement failure returns no internal ids, so those rows still
 * count. An income-twin failure keeps the transfer ids.
 *
 * The income twin (`pairIncomeInternalIds`) is separate from the expense
 * twin. It drops a variable income only when both sides are transfers: the
 * income label is transfer-shaped (`isTransferDescription`) or an
 * own-account credit (marker or own id), and the outgoing row is a transfer
 * or an own-account transfer. Sueldo next to Alquiler, or next to SU PAGO,
 * stays income. Incomes have no bank column. A missing income bank skips
 * the bank-difference check, but an empty bank never counts as another
 * account, so the same household matches only when the outgoing bank is
 * non-empty. A different household matches even if that bank is empty.
 */

import { loadFiwindEchoIds, type FiwindEchoDb } from "./fiwind-dups";
import { loadLogicalDupIds, type LogicalDupDb } from "./logical-dups";

const ARS_TOLERANCE = 0.01;
const USD_TOLERANCE = 0.005;
const USD_CURRENCY_MIN = 0.005;
const DAY_MS = 86_400_000;

const OWN_MARKERS = ["OWN ACCOUNT", "OWN CUIT", "CUENTA PROPIA", "CUENTA TUYA"] as const;

const GENERIC_PAYEES = new Set([
  "OUTGOING TRANSFER (PAYEE UNKNOWN)",
  "FIWIND (PROBABLE)",
  "PAYEE UNKNOWN",
  "OUTGOING TRANSFER",
  "TRANSFERENCIA",
  "TRANSFERENCIA INMEDIATA",
  "TRANSFER TO",
  "TRANSF A",
]);

const NAME_PREFIXES = ["TRANSFERENCIA A ", "TRANSFER TO ", "TRANSF A "] as const;

export type TransferClassRow = {
  id: string;
  householdId: string;
  date: string;
  bank?: string | null;
  description?: string | null;
  amountArs?: string | number | null;
  amountUsd?: string | number | null;
  isPayment?: number | boolean | null;
  isCredit?: number | boolean | null;
};

export type TransferClass = {
  internalIds: Set<string>;
  thirdPartyIds: Set<string>;
  revisarIds: Set<string>;
};

export type IncomeMatchRow = {
  id: string;
  householdId?: string | null;
  date: string;
  /** Income label. The twin runs only when this is a transfer or an own-account credit. */
  description?: string | null;
  /**
   * Incomes have no bank column, so callers leave this unset.
   * `undefined` or `null` means missing. `""` is an empty bank and cannot
   * satisfy "another account" inside the same household.
   */
  bank?: string | null;
  amountArs?: string | number | null;
  amountUsd?: string | number | null;
};

type Currency = "ARS" | "USD";
type Direction = "outgoing" | "incoming";

type Side = {
  id: string;
  householdId: string;
  bank: string;
  date: string;
  day: number;
  ars: number;
  usd: number;
  isCredit: boolean;
  isPayment: boolean;
  description: string;
};

type Pair = {
  distance: number;
  tDate: string;
  tId: string;
  mDate: string;
  mId: string;
};

export function foldTransferText(value: string | null | undefined): string {
  return (value ?? "")
    .toUpperCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function hasOwnAccountMarker(description: string | null | undefined): boolean {
  const folded = foldTransferText(description);
  if (!folded) return false;
  return OWN_MARKERS.some((marker) => folded.includes(marker));
}

/** CUIT (11) and CBU/CVU (22). Dashes and spaces between digits are ignored. */
export function extractAccountIds(description: string | null | undefined): string[] {
  const text = description ?? "";
  const found = new Set<string>();
  const ids: string[] = [];
  const push = (digits: string) => {
    if (found.has(digits)) return;
    found.add(digits);
    ids.push(digits);
  };
  const occupied: Array<[number, number]> = [];
  const cbu = /(?<!\d)\d(?:[\s-]?\d){21}(?!\d)/g;
  for (const match of text.matchAll(cbu)) {
    const digits = match[0].replace(/\D/g, "");
    if (digits.length !== 22) continue;
    push(digits);
    const start = match.index ?? 0;
    occupied.push([start, start + match[0].length]);
  }
  const overlaps = (start: number, end: number) => occupied.some(([from, to]) => start < to && end > from);
  const cuit = /(?<!\d)\d{2}[\s-]?\d{8}[\s-]?\d(?!\d)/g;
  for (const match of text.matchAll(cuit)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (overlaps(start, end)) continue;
    const digits = match[0].replace(/\D/g, "");
    if (digits.length === 11) push(digits);
  }
  return ids;
}

/** Comma-separated digit strings or aliases. Dashes inside a digit id are ignored. */
export function parseOwnAccountIds(raw: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!raw) return out;
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const digits = trimmed.replace(/[\s-]/g, "");
    if (/^\d{11}$/.test(digits) || /^\d{22}$/.test(digits)) {
      out.add(digits);
      continue;
    }
    const alias = foldTransferText(trimmed);
    if (alias) out.add(alias);
  }
  return out;
}

/**
 * Config ids plus every CUIT/CBU/CVU on a row whose description contains an
 * own-account marker. Aliases come from config only.
 */
export function deriveOwnAccountIds(
  rows: readonly { description?: string | null }[],
  configured?: string | null | ReadonlySet<string>,
): Set<string> {
  const own =
    configured instanceof Set
      ? new Set(configured)
      : parseOwnAccountIds(typeof configured === "string" ? configured : null);
  for (const row of rows) {
    if (!hasOwnAccountMarker(row.description)) continue;
    for (const id of extractAccountIds(row.description)) own.add(id);
  }
  return own;
}

export function isTransferDescription(description: string | null | undefined): boolean {
  const folded = foldTransferText(description);
  if (!folded) return false;
  if (folded.includes("TRANSFERENCIA INMEDIATA")) return true;
  if (folded === "TRANSFERENCIA" || folded.startsWith("TRANSFERENCIA")) return true;
  if (folded.includes("OUTGOING TRANSFER")) return true;
  if (folded.includes("TRANSFER TO")) return true;
  if (folded.includes("TRANSF A")) return true;
  return false;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function aliasesIn(description: string | null | undefined): string[] {
  const folded = foldTransferText(description);
  if (!folded) return [];
  return [...folded.matchAll(/[A-Z][A-Z0-9]*(?:\.[A-Z0-9]+)+/g)].map((match) => match[0]);
}

function hasAliasToken(folded: string, alias: string): boolean {
  const needle = foldTransferText(alias);
  if (!needle) return false;
  const re = new RegExp(`(?:^|[^A-Z0-9.])${escapeRegExp(needle)}(?:[^A-Z0-9.]|$)`);
  return re.test(folded);
}

/** True when the text contains a CUIT/CBU/CVU or alias from `ownIds`. */
export function descriptionHasOwnId(description: string | null | undefined, ownIds: ReadonlySet<string>): boolean {
  if (ownIds.size === 0) return false;
  for (const id of extractAccountIds(description)) {
    if (ownIds.has(id)) return true;
  }
  const folded = foldTransferText(description);
  for (const alias of aliasesIn(description)) {
    if (ownIds.has(alias)) return true;
  }
  for (const id of ownIds) {
    if (/^\d{11}$/.test(id) || /^\d{22}$/.test(id)) continue;
    if (hasAliasToken(folded, id)) return true;
  }
  return false;
}

function payeeSegment(description: string | null | undefined): string | null {
  const raw = description ?? "";
  if (raw.includes("|")) return foldTransferText(raw.split("|")[0] ?? "");
  const folded = foldTransferText(raw);
  for (const prefix of NAME_PREFIXES) {
    const at = folded.indexOf(prefix);
    if (at >= 0) return folded.slice(at + prefix.length).trim();
  }
  return null;
}

function isGenericPayee(segment: string): boolean {
  if (!segment) return true;
  if (GENERIC_PAYEES.has(segment)) return true;
  return segment.includes("PAYEE UNKNOWN");
}

/** Non-own CUIT/CBU/CVU/alias, or a payee name that is not a generic placeholder. */
export function transferHasCounterpart(description: string | null | undefined, ownIds: ReadonlySet<string>): boolean {
  for (const id of extractAccountIds(description)) {
    if (!ownIds.has(id)) return true;
  }
  for (const alias of aliasesIn(description)) {
    if (!ownIds.has(alias)) return true;
  }
  const segment = payeeSegment(description);
  return segment != null && !isGenericPayee(segment);
}

/** Transfer label with no own id, no marker, and no counterpart. */
export function isUndeterminedTransfer(description: string | null | undefined, ownIds: ReadonlySet<string>): boolean {
  if (!isTransferDescription(description)) return false;
  if (hasOwnAccountMarker(description)) return false;
  if (descriptionHasOwnId(description, ownIds)) return false;
  if (transferHasCounterpart(description, ownIds)) return false;
  return true;
}

function parseAmount(value: string | number | null | undefined): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (value == null) return 0;
  const text = String(value).trim();
  if (!text) return 0;
  const amount = Number(text);
  return Number.isFinite(amount) ? amount : 0;
}

function countedArsAbs(ars: number, usd: number): number {
  if (Math.abs(usd) > 0 && Math.abs(ars) > 0) return 0;
  return Math.abs(ars);
}

function ownCurrency(ars: number, usd: number): Currency {
  if (Math.abs(usd) >= USD_CURRENCY_MIN && countedArsAbs(ars, usd) === 0) return "USD";
  return "ARS";
}

function tolerance(currency: Currency): number {
  return currency === "ARS" ? ARS_TOLERANCE : USD_TOLERANCE;
}

function withinTolerance(left: number, right: number, tol: number): boolean {
  const scale = 1_000_000;
  return Math.abs(Math.round(left * scale) - Math.round(right * scale)) < Math.round(tol * scale);
}

function dayIndex(iso: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const utc = Date.UTC(year, month - 1, day);
  const check = new Date(utc);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null;
  }
  return Math.floor(utc / DAY_MS);
}

function cmpText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function flag(value: number | boolean | null | undefined): boolean {
  return value === true || value === 1;
}

function amountIn(side: Side, currency: Currency): number {
  return currency === "USD" ? side.usd : side.ars;
}

/** Outgoing or incoming in the row's own currency. Null when the amount is 0. */
export function transferDirection(row: TransferClassRow): Direction | null {
  const side = toSide(row);
  if (!side) return null;
  return directionOf(side);
}

function directionOf(side: Side): Direction | null {
  const amount = amountIn(side, ownCurrency(side.ars, side.usd));
  if (amount === 0) return null;
  // A credit column is incoming even when the stored amount is negative.
  if (side.isCredit) return "incoming";
  if (amount > 0) return "outgoing";
  return "incoming";
}

function toSide(row: TransferClassRow): Side | null {
  if (!row.id || !row.householdId || !row.date) return null;
  const day = dayIndex(row.date);
  if (day == null) return null;
  return {
    id: row.id,
    householdId: row.householdId,
    bank: row.bank ?? "",
    date: row.date,
    day,
    ars: parseAmount(row.amountArs),
    usd: parseAmount(row.amountUsd),
    isCredit: flag(row.isCredit),
    isPayment: flag(row.isPayment),
    description: row.description ?? "",
  };
}

function otherAccount(left: Side, right: Side, homes: ReadonlySet<string>): boolean {
  if (!homes.has(left.householdId) || !homes.has(right.householdId)) return false;
  if (left.householdId !== right.householdId) return true;
  return left.bank !== right.bank;
}

function expenseTransfer(side: Side, homes: ReadonlySet<string>): boolean {
  if (!homes.has(side.householdId)) return false;
  if (side.isPayment || side.isCredit) return false;
  if (directionOf(side) !== "outgoing") return false;
  return isTransferDescription(side.description);
}

function incomingTwinLeg(side: Side, homes: ReadonlySet<string>, ownIds: ReadonlySet<string>): boolean {
  if (!homes.has(side.householdId)) return false;
  if (directionOf(side) !== "incoming") return false;
  return transferOrOwnAccount(side.description, ownIds);
}

/** Signed amount, or the absolute value when the row is a credit. */
function pairAmount(side: Side, currency: Currency): number {
  const raw = amountIn(side, currency);
  return side.isCredit ? Math.abs(raw) : raw;
}

/**
 * Ids of outgoing transfers cancelled by an incoming twin. Own-id matches are
 * not included; pass them in `skipIds` so they do not consume the twin.
 * The incoming leg must be a transfer or an own-account credit.
 */
export function pairInternalTransferIds(
  rows: readonly TransferClassRow[],
  userHouseholdIds: ReadonlySet<string>,
  skipIds?: ReadonlySet<string>,
  ownIds?: ReadonlySet<string>,
): Set<string> {
  const ids = ownIds ?? new Set<string>();
  const sides: Side[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.id || seen.has(row.id)) continue;
    const side = toSide(row);
    if (!side) continue;
    seen.add(row.id);
    sides.push(side);
  }
  const outgoing = sides.filter(
    (side) => expenseTransfer(side, userHouseholdIds) && !skipIds?.has(side.id),
  );
  if (outgoing.length === 0) return new Set();

  const buckets = new Map<string, Side[]>();
  const pushBucket = (currency: Currency, amount: number, row: Side) => {
    if (amount === 0) return;
    const key = `${currency}:${Math.round(amount / tolerance(currency))}`;
    const list = buckets.get(key);
    if (list) list.push(row);
    else buckets.set(key, [row]);
  };
  for (const row of sides) {
    if (!incomingTwinLeg(row, userHouseholdIds, ids)) continue;
    pushBucket("ARS", pairAmount(row, "ARS"), row);
    pushBucket("USD", pairAmount(row, "USD"), row);
  }

  const pairs: Pair[] = [];
  for (const transfer of outgoing) {
    const currency = ownCurrency(transfer.ars, transfer.usd);
    const amount = amountIn(transfer, currency);
    if (amount === 0) continue;
    const tol = tolerance(currency);
    const key = Math.round(amount / tol);
    for (let delta = -1; delta <= 1; delta += 1) {
      const list = buckets.get(`${currency}:${key + delta}`);
      if (!list) continue;
      for (const twin of list) {
        if (twin.id === transfer.id) continue;
        if (!otherAccount(transfer, twin, userHouseholdIds)) continue;
        if (!incomingTwinLeg(twin, userHouseholdIds, ids)) continue;
        const twinAmount = pairAmount(twin, currency);
        // Non-credit incoming keeps its sign, so +100 does not match -100.
        // A credit compares absolute values, including a negative stored amount.
        if (!twin.isCredit && amount * twinAmount <= 0) continue;
        if (!withinTolerance(Math.abs(amount), Math.abs(twinAmount), tol)) continue;
        const distance = Math.abs(transfer.day - twin.day);
        if (distance > 1) continue;
        pairs.push({
          distance,
          tDate: transfer.date,
          tId: transfer.id,
          mDate: twin.date,
          mId: twin.id,
        });
      }
    }
  }

  pairs.sort(
    (a, b) =>
      a.distance - b.distance ||
      cmpText(a.tDate, b.tDate) ||
      cmpText(a.tId, b.tId) ||
      cmpText(a.mDate, b.mDate) ||
      cmpText(a.mId, b.mId),
  );

  const usedTransfer = new Set<string>();
  const usedTwin = new Set<string>();
  const internal = new Set<string>();
  for (const pair of pairs) {
    if (usedTransfer.has(pair.tId) || usedTwin.has(pair.mId)) continue;
    usedTransfer.add(pair.tId);
    usedTwin.add(pair.mId);
    internal.add(pair.tId);
  }
  return internal;
}

export function classifyTransferRows(
  rows: readonly TransferClassRow[],
  ownIds: ReadonlySet<string>,
  userHouseholdIds: ReadonlySet<string>,
): TransferClass {
  const internalIds = new Set<string>();
  const thirdPartyIds = new Set<string>();
  const revisarIds = new Set<string>();
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.id || seen.has(row.id)) continue;
    const side = toSide(row);
    if (!side || !expenseTransfer(side, userHouseholdIds)) continue;
    seen.add(row.id);
    if (descriptionHasOwnId(side.description, ownIds)) internalIds.add(side.id);
  }
  for (const id of pairInternalTransferIds(rows, userHouseholdIds, internalIds, ownIds)) {
    internalIds.add(id);
  }
  seen.clear();
  for (const row of rows) {
    if (!row.id || seen.has(row.id)) continue;
    const side = toSide(row);
    if (!side || !expenseTransfer(side, userHouseholdIds)) continue;
    seen.add(row.id);
    if (internalIds.has(side.id)) continue;
    if (transferHasCounterpart(side.description, ownIds)) thirdPartyIds.add(side.id);
    else if (isUndeterminedTransfer(side.description, ownIds)) revisarIds.add(side.id);
  }
  return { internalIds, thirdPartyIds, revisarIds };
}

type IncomeSide = {
  id: string;
  householdId: string;
  /** `undefined` or `null`: incomes have no bank. `""`: empty, not another account. */
  bank: string | null | undefined;
  date: string;
  day: number;
  ars: number;
  usd: number;
};

function bankText(bank: string | null | undefined): string {
  return (bank ?? "").trim();
}

/** Transfer label, or an own-account credit (marker or configured/derived id). */
function transferOrOwnAccount(description: string | null | undefined, ownIds: ReadonlySet<string>): boolean {
  return (
    isTransferDescription(description) ||
    hasOwnAccountMarker(description) ||
    descriptionHasOwnId(description, ownIds)
  );
}

/**
 * Another account of the same user, for the income twin.
 *
 * Choice: incomes have no bank column. When `incomeBank` is missing
 * (`undefined` or `null`), skip the bank-difference check. An empty bank
 * never counts as another account, so a same-household pair still requires
 * a non-empty outgoing bank, and an explicit empty income bank does not
 * match inside that household. A different household matches even when a
 * bank is empty. Callers must already have required both sides to be
 * transfers.
 */
function incomeOtherAccount(
  incomeHousehold: string,
  incomeBank: string | null | undefined,
  tx: Side,
  homes: ReadonlySet<string>,
): boolean {
  if (!homes.has(incomeHousehold) || !homes.has(tx.householdId)) return false;
  if (incomeHousehold !== tx.householdId) return true;
  if (!bankText(tx.bank)) return false;
  if (incomeBank == null) return true;
  const known = bankText(incomeBank);
  if (!known) return false;
  return known !== bankText(tx.bank);
}

/**
 * Variable income ids cancelled by an outgoing transfer of the same signed
 * amount within one day, in another account of the same user.
 *
 * Both sides must be transfers. The income label is transfer-shaped or an
 * own-account credit. The outgoing row is a transfer or an own-account
 * transfer. A salary next to rent, or next to a card payment, stays.
 *
 * 1:1, closest day first, then income date, income id, transaction date,
 * transaction id. Each outgoing row cancels at most one income.
 */
export function pairIncomeInternalIds(
  incomes: readonly IncomeMatchRow[],
  outgoing: readonly TransferClassRow[],
  userHouseholdIds: ReadonlySet<string>,
  ownIds?: ReadonlySet<string>,
): Set<string> {
  const ids = ownIds ?? new Set<string>();
  const incomesSides: IncomeSide[] = [];
  const seenIncome = new Set<string>();
  for (const row of incomes) {
    if (!row.id || !row.householdId || seenIncome.has(row.id)) continue;
    if (!userHouseholdIds.has(row.householdId)) continue;
    if (!transferOrOwnAccount(row.description, ids)) continue;
    const day = dayIndex(row.date);
    if (day == null) continue;
    seenIncome.add(row.id);
    incomesSides.push({
      id: row.id,
      householdId: row.householdId,
      bank: row.bank,
      date: row.date,
      day,
      ars: parseAmount(row.amountArs),
      usd: parseAmount(row.amountUsd),
    });
  }
  const txs: Side[] = [];
  const seenTx = new Set<string>();
  for (const row of outgoing) {
    if (!row.id || seenTx.has(row.id)) continue;
    const side = toSide(row);
    if (!side || !userHouseholdIds.has(side.householdId)) continue;
    if (!transferOrOwnAccount(side.description, ids)) continue;
    if (directionOf(side) !== "outgoing") continue;
    seenTx.add(row.id);
    txs.push(side);
  }
  if (incomesSides.length === 0 || txs.length === 0) return new Set();

  const pairs: Pair[] = [];
  for (const income of incomesSides) {
    const currency = ownCurrency(income.ars, income.usd);
    const amount = currency === "USD" ? income.usd : income.ars;
    if (amount <= 0) continue;
    const tol = tolerance(currency);
    for (const tx of txs) {
      const txAmount = amountIn(tx, currency);
      if (amount * txAmount <= 0) continue;
      if (!withinTolerance(amount, txAmount, tol)) continue;
      const distance = Math.abs(income.day - tx.day);
      if (distance > 1) continue;
      if (!incomeOtherAccount(income.householdId, income.bank, tx, userHouseholdIds)) continue;
      pairs.push({
        distance,
        tDate: income.date,
        tId: income.id,
        mDate: tx.date,
        mId: tx.id,
      });
    }
  }

  pairs.sort(
    (a, b) =>
      a.distance - b.distance ||
      cmpText(a.tDate, b.tDate) ||
      cmpText(a.tId, b.tId) ||
      cmpText(a.mDate, b.mDate) ||
      cmpText(a.mId, b.mId),
  );

  const usedIncome = new Set<string>();
  const usedTx = new Set<string>();
  const internal = new Set<string>();
  for (const pair of pairs) {
    if (usedIncome.has(pair.tId) || usedTx.has(pair.mId)) continue;
    usedIncome.add(pair.tId);
    usedTx.add(pair.mId);
    internal.add(pair.tId);
  }
  return internal;
}

/**
 * D1 allows at most five terms in a compound SELECT. These are two
 * statements so the loader stays under that limit. node:sqlite allows 500,
 * which is why the term count is checked in tests.
 *
 * `TRANSFER_CANDIDATE_SQL` binds `user_id` once (membership) and returns
 * `hh`, `tx`, `marker`, and two `near` arms. Transaction reads are
 * `household_id` equality plus a ±1 day range on `tx_household_date_idx`.
 * There is no date-only predicate.
 *
 * `INCOME_TWIN_SQL` has its own `user_households` CTE. It binds `user_id`
 * three times (membership, then the user's incomes twice) and returns the
 * two `inc` arms: outgoing transfers that can cancel a transfer-shaped
 * income row. The description filter drops rent, card payments, and other
 * non-transfers before they reach JS.
 *
 * `hh` is one row per household. `tx` is an expense-eligible transfer-shaped
 * row. `marker` is a row that can contribute an own-account id. `near` is a
 * possible twin in the date window. `inc` is an outgoing transaction that
 * can cancel an income row.
 */
export const TRANSFER_CANDIDATE_SQL = `
WITH user_households AS (
  SELECT household_id FROM household_members WHERE user_id = ?
),
transfers AS (
  SELECT
    t.id,
    t.household_id,
    t.date,
    t.bank,
    t.description_normalized,
    t.amount_ars,
    t.amount_usd,
    t.is_payment,
    t.is_credit
  FROM user_households uh
  INNER JOIN transactions t ON t.household_id = uh.household_id
  WHERE t.is_payment = 0
    AND t.is_credit = 0
    AND (
      upper(IFNULL(t.description_normalized, '')) LIKE '%TRANSFERENCIA%'
      OR upper(IFNULL(t.description_normalized, '')) LIKE '%OUTGOING TRANSFER%'
      OR upper(IFNULL(t.description_normalized, '')) LIKE '%TRANSFER TO%'
      OR upper(IFNULL(t.description_normalized, '')) LIKE '%TRANSF A%'
    )
)
SELECT
  'hh' AS kind,
  uh.household_id AS id,
  uh.household_id AS household_id,
  NULL AS date,
  NULL AS bank,
  NULL AS description_normalized,
  NULL AS amount_ars,
  NULL AS amount_usd,
  NULL AS is_payment,
  NULL AS is_credit
FROM user_households uh
UNION ALL
SELECT
  'tx',
  tr.id,
  tr.household_id,
  tr.date,
  tr.bank,
  tr.description_normalized,
  tr.amount_ars,
  tr.amount_usd,
  tr.is_payment,
  tr.is_credit
FROM transfers tr
UNION ALL
SELECT
  'marker',
  t.id,
  t.household_id,
  t.date,
  t.bank,
  t.description_normalized,
  t.amount_ars,
  t.amount_usd,
  t.is_payment,
  t.is_credit
FROM user_households uh
INNER JOIN transactions t ON t.household_id = uh.household_id
WHERE upper(IFNULL(t.description_normalized, '')) LIKE '%CUENTA PROPIA%'
   OR upper(IFNULL(t.description_normalized, '')) LIKE '%CUENTA TUYA%'
   OR upper(IFNULL(t.description_normalized, '')) LIKE '%OWN ACCOUNT%'
   OR upper(IFNULL(t.description_normalized, '')) LIKE '%OWN CUIT%'
UNION ALL
SELECT
  'near',
  m.id,
  m.household_id,
  m.date,
  m.bank,
  m.description_normalized,
  m.amount_ars,
  m.amount_usd,
  m.is_payment,
  m.is_credit
FROM transfers n
INNER JOIN transactions m
  ON m.household_id = n.household_id
 AND m.date >= date(n.date, '-1 days')
 AND m.date <= date(n.date, '+1 days')
 AND m.id <> n.id
 AND IFNULL(m.bank, '') <> IFNULL(n.bank, '')
 AND (
   (
     abs(CAST(IFNULL(n.amount_ars, '0') AS REAL)) >= 0.01
     AND abs(abs(CAST(IFNULL(m.amount_ars, '0') AS REAL)) - abs(CAST(IFNULL(n.amount_ars, '0') AS REAL))) < 0.01
   )
   OR (
     abs(CAST(IFNULL(n.amount_usd, '0') AS REAL)) >= 0.005
     AND abs(abs(CAST(IFNULL(m.amount_usd, '0') AS REAL)) - abs(CAST(IFNULL(n.amount_usd, '0') AS REAL))) < 0.005
   )
 )
UNION ALL
SELECT
  'near',
  m.id,
  m.household_id,
  m.date,
  m.bank,
  m.description_normalized,
  m.amount_ars,
  m.amount_usd,
  m.is_payment,
  m.is_credit
FROM transfers n
INNER JOIN user_households uh ON uh.household_id <> n.household_id
INNER JOIN transactions m
  ON m.household_id = uh.household_id
 AND m.date >= date(n.date, '-1 days')
 AND m.date <= date(n.date, '+1 days')
 AND m.id <> n.id
 AND (
   (
     abs(CAST(IFNULL(n.amount_ars, '0') AS REAL)) >= 0.01
     AND abs(abs(CAST(IFNULL(m.amount_ars, '0') AS REAL)) - abs(CAST(IFNULL(n.amount_ars, '0') AS REAL))) < 0.01
   )
   OR (
     abs(CAST(IFNULL(n.amount_usd, '0') AS REAL)) >= 0.005
     AND abs(abs(CAST(IFNULL(m.amount_usd, '0') AS REAL)) - abs(CAST(IFNULL(n.amount_usd, '0') AS REAL))) < 0.005
   )
 )
`;

/**
 * Outgoing transfers that can cancel a transfer-shaped income row.
 * Separate from `TRANSFER_CANDIDATE_SQL` so neither statement exceeds five
 * compound terms. The income label and the outgoing description must look
 * like a transfer or an own-account move, and the outgoing row is not a
 * credit (`is_credit = 0`). `is_payment` is not a hard filter: SU PAGO fails
 * the description predicate, and an own-account transfer may be stored with
 * `is_payment = 1`. The same-household arm requires a non-empty bank. An
 * empty bank is not another account. The other arm is a different household
 * of the same user. Both read `tx_household_date_idx`. Column names match
 * the transfer statement so the loader can merge rows.
 */
const INCOME_TWIN_LABEL_SQL = `
  i.kind != 'recurring'
  AND (
    upper(IFNULL(i.label, '')) LIKE '%TRANSFERENCIA%'
    OR upper(IFNULL(i.label, '')) LIKE '%OUTGOING TRANSFER%'
    OR upper(IFNULL(i.label, '')) LIKE '%TRANSFER TO%'
    OR upper(IFNULL(i.label, '')) LIKE '%TRANSF A%'
    OR upper(IFNULL(i.label, '')) LIKE '%CUENTA PROPIA%'
    OR upper(IFNULL(i.label, '')) LIKE '%CUENTA TUYA%'
    OR upper(IFNULL(i.label, '')) LIKE '%OWN ACCOUNT%'
    OR upper(IFNULL(i.label, '')) LIKE '%OWN CUIT%'
  )`;

const INCOME_TWIN_OUTGOING_SQL = `
  m.is_credit = 0
  AND (
    upper(IFNULL(m.description_normalized, '')) LIKE '%TRANSFERENCIA%'
    OR upper(IFNULL(m.description_normalized, '')) LIKE '%OUTGOING TRANSFER%'
    OR upper(IFNULL(m.description_normalized, '')) LIKE '%TRANSFER TO%'
    OR upper(IFNULL(m.description_normalized, '')) LIKE '%TRANSF A%'
    OR upper(IFNULL(m.description_normalized, '')) LIKE '%CUENTA PROPIA%'
    OR upper(IFNULL(m.description_normalized, '')) LIKE '%CUENTA TUYA%'
    OR upper(IFNULL(m.description_normalized, '')) LIKE '%OWN ACCOUNT%'
    OR upper(IFNULL(m.description_normalized, '')) LIKE '%OWN CUIT%'
  )`;

const INCOME_TWIN_AMOUNT_SQL = `
  (
    (
      CAST(IFNULL(m.amount_ars, '0') AS REAL) * CAST(IFNULL(i.amount_ars, '0') AS REAL) > 0
      AND abs(CAST(IFNULL(m.amount_ars, '0') AS REAL) - CAST(IFNULL(i.amount_ars, '0') AS REAL)) < 0.01
    )
    OR (
      CAST(IFNULL(m.amount_usd, '0') AS REAL) * CAST(IFNULL(i.amount_usd, '0') AS REAL) > 0
      AND abs(CAST(IFNULL(m.amount_usd, '0') AS REAL) - CAST(IFNULL(i.amount_usd, '0') AS REAL)) < 0.005
    )
  )`;

export const INCOME_TWIN_SQL = `
WITH user_households AS (
  SELECT household_id FROM household_members WHERE user_id = ?
)
SELECT
  'inc' AS kind,
  m.id AS id,
  m.household_id AS household_id,
  m.date AS date,
  m.bank AS bank,
  m.description_normalized AS description_normalized,
  m.amount_ars AS amount_ars,
  m.amount_usd AS amount_usd,
  m.is_payment AS is_payment,
  m.is_credit AS is_credit
FROM user_households uh
INNER JOIN incomes i ON i.household_id = uh.household_id AND i.user_id = ?
INNER JOIN transactions m
  ON m.household_id = i.household_id
 AND m.date >= date(i.date, '-1 days')
 AND m.date <= date(i.date, '+1 days')
WHERE ${INCOME_TWIN_LABEL_SQL}
  AND ${INCOME_TWIN_OUTGOING_SQL}
  AND IFNULL(m.bank, '') <> ''
  AND ${INCOME_TWIN_AMOUNT_SQL}
UNION ALL
SELECT
  'inc' AS kind,
  m.id AS id,
  m.household_id AS household_id,
  m.date AS date,
  m.bank AS bank,
  m.description_normalized AS description_normalized,
  m.amount_ars AS amount_ars,
  m.amount_usd AS amount_usd,
  m.is_payment AS is_payment,
  m.is_credit AS is_credit
FROM user_households home
INNER JOIN incomes i ON i.household_id = home.household_id AND i.user_id = ?
INNER JOIN user_households uh ON uh.household_id <> i.household_id
INNER JOIN transactions m
  ON m.household_id = uh.household_id
 AND m.date >= date(i.date, '-1 days')
 AND m.date <= date(i.date, '+1 days')
WHERE ${INCOME_TWIN_LABEL_SQL}
  AND ${INCOME_TWIN_OUTGOING_SQL}
  AND ${INCOME_TWIN_AMOUNT_SQL}
`;

export type TransferCandidateRow = {
  kind: string;
  id: string | null;
  household_id: string | null;
  date: string | null;
  bank: string | null;
  description_normalized: string | null;
  amount_ars: string | number | null;
  amount_usd: string | number | null;
  is_payment: number | null;
  is_credit: number | null;
};

export type TransferClassDb = {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all<T = TransferCandidateRow>(): Promise<{ results?: T[] }>;
    };
  };
};

export type MovementExclusion = {
  /** Fiwind echo ids plus internal-transfer ids. Safe to pass to `expenseSql`. */
  excludedIds: string[];
  /** Internal transfers only. Consumos keeps these visible. */
  internalIds: string[];
  revisarIds: ReadonlySet<string>;
  ownIds: ReadonlySet<string>;
  userHouseholdIds: ReadonlySet<string>;
  incomeOutgoing: TransferClassRow[];
};

type TransferSnapshot = Omit<MovementExclusion, "excludedIds"> & {
  /** Set only when the transfer statement threw and this is the empty fallback. */
  transferLoadFailed?: boolean;
};

function emptyTransfer(raw: string | null | undefined): TransferSnapshot {
  return {
    internalIds: [],
    revisarIds: new Set(),
    ownIds: parseOwnAccountIds(raw),
    userHouseholdIds: new Set(),
    incomeOutgoing: [],
    transferLoadFailed: true,
  };
}

function mapCandidate(row: TransferCandidateRow): TransferClassRow | null {
  if (!row.id || !row.household_id || !row.date) return null;
  return {
    id: String(row.id),
    householdId: String(row.household_id),
    date: String(row.date),
    bank: row.bank,
    description: row.description_normalized,
    amountArs: row.amount_ars,
    amountUsd: row.amount_usd,
    isPayment: row.is_payment,
    isCredit: row.is_credit,
  };
}

/** Income twins are optional. A failure keeps the transfer half. */
async function loadIncomeTwinRows(db: TransferClassDb, userId: string): Promise<TransferCandidateRow[]> {
  try {
    const res = await db.prepare(INCOME_TWIN_SQL).bind(userId, userId, userId).all<TransferCandidateRow>();
    return res.results ?? [];
  } catch (err) {
    const message = err instanceof Error ? err.message : "error";
    console.error("income twin load failed", message.slice(0, 180));
    return [];
  }
}

export async function loadTransferSnapshot(
  db: TransferClassDb,
  userId: string,
  ownAccountIdsRaw: string | null | undefined,
): Promise<TransferSnapshot> {
  try {
    const [res, incomeRows] = await Promise.all([
      db.prepare(TRANSFER_CANDIDATE_SQL).bind(userId).all<TransferCandidateRow>(),
      loadIncomeTwinRows(db, userId),
    ]);
    const homes = new Set<string>();
    const rows: TransferClassRow[] = [];
    const seen = new Set<string>();
    const markers: Array<{ description: string | null }> = [];
    const outgoing: TransferClassRow[] = [];
    const seenOut = new Set<string>();
    for (const row of [...(res.results ?? []), ...incomeRows]) {
      if (row.kind === "hh") {
        if (row.household_id) homes.add(String(row.household_id));
        continue;
      }
      const mapped = mapCandidate(row);
      if (!mapped) continue;
      if (row.kind === "marker") markers.push({ description: mapped.description ?? null });
      if (row.kind === "inc") {
        if (!seenOut.has(mapped.id)) {
          seenOut.add(mapped.id);
          outgoing.push(mapped);
        }
        continue;
      }
      if (seen.has(mapped.id)) continue;
      seen.add(mapped.id);
      rows.push(mapped);
    }
    const ownIds = deriveOwnAccountIds(markers, parseOwnAccountIds(ownAccountIdsRaw));
    const classified = classifyTransferRows(rows, ownIds, homes);
    return {
      internalIds: [...classified.internalIds].sort(),
      revisarIds: classified.revisarIds,
      ownIds,
      userHouseholdIds: homes,
      incomeOutgoing: outgoing,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "error";
    console.error("transfer class load failed", message.slice(0, 180));
    return emptyTransfer(ownAccountIdsRaw);
  }
}

const EXCLUDED_MOVEMENT_TTL_MS = 60_000;

const excludedMovementCache = new Map<string, { at: number; value: MovementExclusion }>();

/** Drops cached exclusion loads. The 60s TTL covers writes that do not call this. */
export function clearExcludedMovementCache(): void {
  excludedMovementCache.clear();
}

function excludedMovementCacheKey(userId: string, ownAccountIdsRaw: string | null | undefined): string {
  return `${userId}|${ownAccountIdsRaw ?? ""}`;
}

/**
 * Fiwind echo ids union same-day merchant copies union internal-transfer ids.
 * One Fiwind statement, one logical-dup statement, plus the transfer and
 * income-twin statements, in parallel. A Fiwind, logical-dup or income-twin
 * failure leaves that half empty, so the rows it could not classify still
 * count. A transfer-statement failure returns no internal ids.
 *
 * A successful load is reused for 60 seconds per isolate, keyed by user and
 * `OWN_ACCOUNT_IDS`. The empty fallback from a failed transfer statement is
 * not cached.
 */
export async function loadExcludedMovementIds(
  db: FiwindEchoDb & TransferClassDb & LogicalDupDb,
  userId: string,
  ownAccountIdsRaw: string | null | undefined,
): Promise<MovementExclusion> {
  const key = excludedMovementCacheKey(userId, ownAccountIdsRaw);
  const cached = excludedMovementCache.get(key);
  if (cached) {
    if (Date.now() - cached.at < EXCLUDED_MOVEMENT_TTL_MS) return cached.value;
    excludedMovementCache.delete(key);
  }

  const [echoIds, logicalIds, transfer] = await Promise.all([
    loadFiwindEchoIds(db, userId),
    loadLogicalDupIds(db, userId),
    loadTransferSnapshot(db, userId, ownAccountIdsRaw),
  ]);
  const excluded = new Set<string>(echoIds);
  for (const id of logicalIds) excluded.add(id);
  for (const id of transfer.internalIds) excluded.add(id);
  const value: MovementExclusion = {
    excludedIds: [...excluded].sort(),
    internalIds: transfer.internalIds,
    revisarIds: transfer.revisarIds,
    ownIds: transfer.ownIds,
    userHouseholdIds: transfer.userHouseholdIds,
    incomeOutgoing: transfer.incomeOutgoing,
  };
  if (!transfer.transferLoadFailed) {
    excludedMovementCache.set(key, { at: Date.now(), value });
  }
  return value;
}
