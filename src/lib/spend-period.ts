/**
 * Period options for the home spending pie.
 * Default is the last 30 days. The choice is stored on the device.
 */

export const SPEND_PERIOD_IDS = ["30d", "90d", "6m", "1y", "all"] as const;

export type SpendPeriodId = (typeof SPEND_PERIOD_IDS)[number];

export const DEFAULT_SPEND_PERIOD: SpendPeriodId = "30d";

/** Same `lc:` prefix as the other home preferences. */
export const SPEND_PERIOD_STORAGE_KEY = "lc:home-spend-period";

export const SPEND_PERIODS: Array<{
  id: SpendPeriodId;
  label: string;
  title: string;
  empty: string;
}> = [
  { id: "30d", label: "30 días", title: "Últimos 30 días", empty: "Todavía no hay gastos en 30 días." },
  { id: "90d", label: "90 días", title: "Últimos 90 días", empty: "Todavía no hay gastos en 90 días." },
  { id: "6m", label: "6 meses", title: "Últimos 6 meses", empty: "Todavía no hay gastos en 6 meses." },
  { id: "1y", label: "1 año", title: "Último año", empty: "Todavía no hay gastos en el último año." },
  { id: "all", label: "Todo", title: "Todo el historial", empty: "Todavía no hay gastos." },
];

export function isSpendPeriodId(value: string | null | undefined): value is SpendPeriodId {
  return value != null && (SPEND_PERIOD_IDS as readonly string[]).includes(value);
}

export function parseSpendPeriod(raw: string | null | undefined): SpendPeriodId {
  return isSpendPeriodId(raw) ? raw : DEFAULT_SPEND_PERIOD;
}

export function spendPeriodMeta(id: SpendPeriodId) {
  return SPEND_PERIODS.find((period) => period.id === id)!;
}

export function readStoredSpendPeriod(): SpendPeriodId {
  try {
    return parseSpendPeriod(window.localStorage.getItem(SPEND_PERIOD_STORAGE_KEY));
  } catch {
    return DEFAULT_SPEND_PERIOD;
  }
}

export function writeStoredSpendPeriod(id: SpendPeriodId) {
  try {
    window.localStorage.setItem(SPEND_PERIOD_STORAGE_KEY, id);
  } catch {
    // Private mode or a blocked store: the choice lasts for this visit only.
  }
}

export type SpendWindowKind =
  | { kind: "days"; days: number }
  | { kind: "months"; months: number }
  | { kind: "years"; years: number }
  | { kind: "all" };

export function windowForPeriod(period: SpendPeriodId): SpendWindowKind {
  switch (period) {
    case "30d":
      return { kind: "days", days: 30 };
    case "90d":
      return { kind: "days", days: 90 };
    case "6m":
      return { kind: "months", months: 6 };
    case "1y":
      return { kind: "years", years: 1 };
    case "all":
      return { kind: "all" };
  }
}
