/**
 * Patrimonio series helpers. History is only what was stored.
 * The BBVA card ledger is incomplete (see INCOMPLETE_LEDGER_ARS in debt.ts),
 * so no month is backfilled as source "derived".
 */

export type PatrimonioSource = "snapshot" | "derived" | "manual";

export type PatrimonioPoint = {
  date: string;
  assetsArs: number;
  assetsUsd: number;
  debtArs: number;
  debtUsd: number;
  netWorthArs: number;
  fxRate: number | null;
  source: PatrimonioSource;
};

export type SeriesRange = "6m" | "1y" | "all";

export type DebtReading = {
  balanceArs: number;
  balanceUsd: number;
  settled: boolean;
  forceSettled: boolean;
  activeCard: boolean;
  /** Shown when the balance is zero and there is no active card. */
  cardStatus: "sin_tarjeta_activa" | "activa" | "sin_snapshot";
};

/** No historical month is trusted. Incomplete card imports invent millions. */
export const TRUSTED_DEBT_MONTHS: readonly string[] = [];

export function assetsEquivalent(input: {
  bankArs: number;
  bankUsd: number;
  walletUsd: number;
  fxRate: number | null;
}): { assetsArs: number; assetsUsd: number } {
  const bankArs = finite(input.bankArs);
  const bankUsd = finite(input.bankUsd);
  const walletUsd = finite(input.walletUsd);
  const assetsUsd = bankUsd + walletUsd;
  const rate = positiveRate(input.fxRate);
  return { assetsUsd, assetsArs: bankArs + assetsUsd * rate };
}

/** Blue quote that can price USD. Null, 0, and non-finite are missing. */
export function usableFxRate(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

/** Pesos net of ARS debt and USD debt at `fxRate`. A missing rate prices USD debt at 0. */
export function netWorthArs(
  assetsArs: number,
  debtArs: number,
  debtUsd = 0,
  fxRate: number | null = null,
): number {
  return finite(assetsArs) - finite(debtArs) - finite(debtUsd) * positiveRate(fxRate);
}

/**
 * Full net worth only when every USD leg can be priced.
 * Missing blue does not become a zero rate.
 */
export function pricedNetWorth(input: {
  assetsArs: number;
  assetsUsd: number;
  debtArs: number;
  debtUsd: number;
  fxRate: number | null;
}): { netWorthArs: number | null; fxAvailable: boolean } {
  const rate = usableFxRate(input.fxRate);
  const needsFx = finite(input.assetsUsd) > 0 || finite(input.debtUsd) > 0;
  if (rate == null && needsFx) return { netWorthArs: null, fxAvailable: false };
  return {
    netWorthArs: netWorthArs(input.assetsArs, input.debtArs, input.debtUsd, rate),
    fxAvailable: rate != null,
  };
}

/**
 * Current debt for the lite screens. A forced settle, or a stored saldo of
 * zero with no card last4, is "sin tarjeta activa" and balance 0.
 * A null saldo is not settled: there is no snapshot yet.
 */
export function readDebt(input: {
  forceSettled: boolean;
  saldoArs: number | null;
  saldoUsd: number | null;
  cardLast4: string | null;
  /** card_statements for the user's households (status closed / not closed). */
  closedStatements?: number;
  openStatements?: number;
}): DebtReading {
  const allClosed = (input.closedStatements ?? 0) > 0 && (input.openStatements ?? 0) === 0;
  if (input.forceSettled || allClosed) {
    return {
      balanceArs: 0,
      balanceUsd: 0,
      settled: true,
      forceSettled: input.forceSettled,
      activeCard: false,
      cardStatus: "sin_tarjeta_activa",
    };
  }
  if (input.saldoArs == null && input.saldoUsd == null) {
    return {
      balanceArs: 0,
      balanceUsd: 0,
      settled: false,
      forceSettled: false,
      activeCard: false,
      cardStatus: "sin_snapshot",
    };
  }
  const ars = Math.abs(finite(input.saldoArs));
  const usd = Math.abs(finite(input.saldoUsd));
  const settled = ars < 50 && usd < 0.01;
  const noCard = settled && !input.cardLast4;
  return {
    balanceArs: settled ? 0 : ars,
    balanceUsd: settled ? 0 : usd,
    settled,
    forceSettled: false,
    activeCard: Boolean(input.cardLast4) && !settled,
    cardStatus: noCard ? "sin_tarjeta_activa" : input.cardLast4 ? "activa" : "sin_snapshot",
  };
}

export function filterPatrimonioSeries(
  points: PatrimonioPoint[],
  range: SeriesRange,
  today: string,
): PatrimonioPoint[] {
  const sorted = [...points].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (range === "all") return sorted;
  const months = range === "6m" ? 6 : 12;
  const start = shiftYmd(monthStart(today), -(months - 1));
  return sorted.filter((point) => point.date >= start && point.date <= today);
}

/**
 * Sparkline y values: stored points, then live net worth.
 * Same calendar day is one point (live replaces stored). One point per day.
 */
export function sparklineNetWorths(
  series: readonly PatrimonioPoint[],
  currentDate: string,
  currentNet: number | null,
): number[] {
  const values = series.map((point) => point.netWorthArs);
  if (currentNet == null || !Number.isFinite(currentNet)) return values;
  const last = series[series.length - 1];
  if (last && last.date === currentDate) {
    values[values.length - 1] = currentNet;
    return values;
  }
  values.push(currentNet);
  return values;
}

/**
 * After the card was marked settled, later points must show debt 0.
 * Earlier stored points stay as they were (Visa going down).
 * Without a settle date we do not rewrite history.
 */
export function applySettledDebtHistory(
  points: readonly PatrimonioPoint[],
  opts: { settled: boolean; clearedOn: string | null },
): PatrimonioPoint[] {
  if (!opts.settled || !opts.clearedOn) return [...points];
  return points.map((point) => {
    if (point.date < opts.clearedOn!) return point;
    return {
      ...point,
      debtArs: 0,
      debtUsd: 0,
      netWorthArs: point.assetsArs,
    };
  });
}

export function historyStartsAt(points: PatrimonioPoint[]): string | null {
  if (points.length === 0) return null;
  return [...points].sort((a, b) => (a.date < b.date ? -1 : 1))[0].date;
}

/** Spanish note. No em dash. */
export function historyNote(firstDate: string | null): string {
  if (!firstDate) {
    return "Todavía no hay puntos. El de hoy se guarda una vez por día. La deuda vieja de la Visa solo aparece si se guardó un saldo en ese momento; no la inventamos.";
  }
  const [year, month, day] = firstDate.split("-");
  return `El historial arranca el ${day}/${month}/${year}. Un punto por día.`;
}

export type NetWorthChange = {
  date: string;
  netWorthArs: number;
  deltaArs: number;
};

/**
 * Live net worth versus stored points.
 * Previous month: the latest point in the previous calendar month.
 * Year start: the earliest point on or after 1 January of the current year,
 * strictly before `currentDate`. Missing data is null. A null live net is null.
 */
export function netWorthDeltas(
  currentDate: string,
  currentNet: number | null,
  series: readonly PatrimonioPoint[],
): { vsPreviousMonth: NetWorthChange | null; vsYearStart: NetWorthChange | null } {
  if (currentNet == null || !Number.isFinite(currentNet)) {
    return { vsPreviousMonth: null, vsYearStart: null };
  }
  const month = currentDate.slice(0, 7);
  const prevMonth = shiftMonth(month, -1);
  const year = currentDate.slice(0, 4);
  return {
    vsPreviousMonth: toChange(currentNet, latestInMonth(series, prevMonth)),
    vsYearStart: toChange(currentNet, earliestBetween(series, `${year}-01-01`, currentDate)),
  };
}

function toChange(currentNet: number, point: PatrimonioPoint | null): NetWorthChange | null {
  if (!point) return null;
  return {
    date: point.date,
    netWorthArs: point.netWorthArs,
    deltaArs: currentNet - point.netWorthArs,
  };
}

function latestInMonth(series: readonly PatrimonioPoint[], month: string): PatrimonioPoint | null {
  let best: PatrimonioPoint | null = null;
  for (const point of series) {
    if (!point.date.startsWith(`${month}-`)) continue;
    if (!best || point.date > best.date) best = point;
  }
  return best;
}

/** Earliest point with `start <= date < before`. */
function earliestBetween(
  series: readonly PatrimonioPoint[],
  start: string,
  before: string,
): PatrimonioPoint | null {
  let best: PatrimonioPoint | null = null;
  for (const point of series) {
    if (point.date < start || point.date >= before) continue;
    if (!best || point.date < best.date) best = point;
  }
  return best;
}

function shiftMonth(period: string, delta: number): string {
  const [year, month] = period.split("-").map(Number);
  if (!year || !month) return period;
  const date = new Date(Date.UTC(year, month - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function finite(value: number | null | undefined): number {
  return value != null && Number.isFinite(value) ? value : 0;
}

function positiveRate(value: number | null | undefined): number {
  return value != null && Number.isFinite(value) && value > 0 ? value : 0;
}

function monthStart(ymd: string): string {
  const match = /^(\d{4})-(\d{2})/.exec(ymd);
  if (!match) return ymd;
  return `${match[1]}-${match[2]}-01`;
}

function shiftYmd(ymd: string, months: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!match) return ymd;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1 + months, Number(match[3])));
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
