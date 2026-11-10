/**
 * Compact port of `periodIncomeEntries` + `sumPeriodIncomeArs`.
 *
 * Variable rows are skipped when the label is a non-income transfer
 * (`isNonIncomeTransferLabel`: cuenta tuya, entre cuentas, transferencia
 * interna, BBNK self-move, TRANSF CLIENTE CTA, FX, DEBIN, CR TBE, …), when
 * it contains an own-account marker, or when it contains an own-account id
 * from `OWN_ACCOUNT_IDS` plus ids derived from the user's rows.
 *
 * A generic TRANSFERENCIA / TRANSFERENCIA INMEDIATA with no own id, no
 * marker, and no counterpart is income. `annotateIncomeRows` sets
 * `revisar: true` on that payload. The twin drops that variable row only
 * when both sides are transfers: the label is transfer-shaped or an
 * own-account credit, and the outgoing row is a transfer or an own-account
 * transfer, same signed amount, within one day, in another account of the
 * same user. Incomes have no bank. A missing income bank skips the bank
 * difference check, but an empty bank never counts as another account, so
 * the same household matches only when the outgoing bank is non-empty.
 * Sueldo next to Alquiler or SU PAGO stays. Recurring rows are not
 * label-skipped and are not twinned.
 */

import { isNonIncomeTransferLabel } from "../src/lib/bbva/bank-entries";
import {
  descriptionHasOwnId,
  hasOwnAccountMarker,
  isUndeterminedTransfer,
  pairIncomeInternalIds,
  type IncomeMatchRow,
  type TransferClassRow,
} from "./transfer-class";

export type IncomeRow = {
  id?: string;
  household_id?: string | null;
  householdId?: string | null;
  date: string;
  label: string;
  kind: string | null;
  frequency: string | null;
  amount_ars: string | null;
  amount_usd: string | null;
};

export type IncomeContext = {
  ownIds?: ReadonlySet<string>;
  userHouseholdIds?: ReadonlySet<string>;
  outgoing?: readonly TransferClassRow[];
};

export type AnnotatedIncome = IncomeRow & {
  /** Dropped from the income total. */
  internal: boolean;
  /** Generic transfer whose origin cannot be determined. Counts as income. */
  revisar: boolean;
};

function num(value: string | null): number {
  if (value == null || value === "") return 0;
  const n = Number(value);
  return Number.isFinite(n) ? Math.abs(n) : 0;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function addDays(ymd: string, days: number): string {
  const [year, month, day] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function foldLabel(label: string): string {
  return label
    .toUpperCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

/**
 * Labels that are not ingreso. Same detector as the Ingresos page
 * (`isNonIncomeTransferLabel`), plus the substring list so a "Depósito de
 * cuenta propia" credit still drops (the own-account detector treats a
 * leading DEPOSITO as a wallet credit, not a pocket move).
 */
function skipPhrase(label: string): boolean {
  if (isNonIncomeTransferLabel(label)) return true;
  const u = foldLabel(label);
  return (
    u.includes("CUENTA TUYA") ||
    u.includes("CUENTA PROPIA") ||
    u.includes("CAMBIO DE MONEDA") ||
    u.includes("CAMBIO MONEDA") ||
    u.includes("DEBIN") ||
    u.includes("CR TBE") ||
    u.includes("CR TRF") ||
    u.includes("INM COE") ||
    u.includes("PAGO VISA") ||
    u.includes("PAGO MASTER") ||
    u.includes("SU PAGO") ||
    /^DEVOLUCION\b/.test(u.trim())
  );
}

function labelInternal(label: string, ownIds: ReadonlySet<string>): boolean {
  return skipPhrase(label) || hasOwnAccountMarker(label) || descriptionHasOwnId(label, ownIds);
}

function householdOf(row: IncomeRow): string | null {
  return row.household_id ?? row.householdId ?? null;
}

/**
 * Income rows with `internal` and `revisar`. This is the payload builder:
 * a list endpoint should return these objects rather than the raw rows.
 */
export function annotateIncomeRows(rows: IncomeRow[], ctx?: IncomeContext): AnnotatedIncome[] {
  const ownIds = ctx?.ownIds ?? new Set<string>();
  const homes = ctx?.userHouseholdIds ?? new Set<string>();
  const variable: IncomeMatchRow[] = [];
  rows.forEach((row, index) => {
    if (row.kind === "recurring") return;
    const householdId = householdOf(row);
    variable.push({
      id: row.id ?? `idx:${index}`,
      householdId,
      date: row.date,
      description: row.label,
      amountArs: row.amount_ars,
      amountUsd: row.amount_usd,
    });
  });
  const twins = pairIncomeInternalIds(variable, ctx?.outgoing ?? [], homes, ownIds);
  return rows.map((row, index) => {
    const id = row.id ?? `idx:${index}`;
    const variableRow = row.kind !== "recurring";
    const internal = variableRow && (labelInternal(row.label, ownIds) || twins.has(id));
    const revisar = !internal && isUndeterminedTransfer(row.label, ownIds);
    return { ...row, internal, revisar };
  });
}

function recurringDates(anchor: string, frequency: string, period: string): string[] {
  const [year, month] = period.split("-").map(Number);
  const last = daysInMonth(year, month);
  const start = `${period}-01`;
  const end = `${period}-${String(last).padStart(2, "0")}`;
  if (anchor > end) return [];
  if (frequency === "mensual") {
    const day = Math.min(Number(anchor.slice(8, 10)) || 1, last);
    const candidate = `${period}-${String(day).padStart(2, "0")}`;
    return candidate >= anchor && candidate <= end ? [candidate] : [];
  }
  const step = frequency === "semanal" ? 7 : frequency === "quincenal" ? 14 : 0;
  if (!step) return [];
  let cursor = anchor;
  const out: string[] = [];
  let guard = 0;
  while (cursor < start && guard < 400) {
    cursor = addDays(cursor, step);
    guard += 1;
  }
  while (cursor <= end && guard < 500) {
    if (cursor >= anchor) out.push(cursor);
    cursor = addDays(cursor, step);
    guard += 1;
  }
  return out;
}

export type IncomeParts = { ars: number; usd: number; totalArs: number };

/**
 * ARS, USD, and the ARS equivalent for one month.
 * `totalArs` is added per row, same as the previous `sumIncomeArs` loop.
 */
export function incomeParts(
  rows: IncomeRow[],
  period: string,
  buyRate: number,
  ctx?: IncomeContext,
): IncomeParts {
  let ars = 0;
  let usd = 0;
  let totalArs = 0;
  for (const row of annotateIncomeRows(rows, ctx)) {
    const kind = row.kind === "recurring" ? "recurring" : "variable";
    let times = 0;
    if (kind === "variable") {
      if (!row.date.startsWith(period)) continue;
      if (row.internal) continue;
      times = 1;
    } else {
      times = recurringDates(row.date, row.frequency ?? "", period).length;
      if (times === 0) continue;
    }
    const rowArs = times * num(row.amount_ars);
    const rowUsd = times * num(row.amount_usd);
    ars += rowArs;
    usd += rowUsd;
    totalArs += rowArs;
    if (buyRate > 0) totalArs += rowUsd * buyRate;
  }
  return { ars, usd, totalArs };
}

export function sumIncomeArs(
  rows: IncomeRow[],
  period: string,
  buyRate: number,
  ctx?: IncomeContext,
): number {
  return incomeParts(rows, period, buyRate, ctx).totalArs;
}
