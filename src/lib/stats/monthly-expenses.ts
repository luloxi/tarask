import { convertUsdToArs, type MonthEndRate } from "@/lib/fx/month-end-rates";
import { isBankAccountingEntry } from "@/lib/bbva/bank-entries";
import { isHogarUtilityCategory } from "@/lib/gasto-cubierto";
import { isPeriodDebtSource } from "@/lib/import/source";
import { isHogarReintegroDescription } from "@/lib/reintegro-hogar";
import { reintegroPayeeGroups } from "@/lib/reintegro-hogar-server";
import { isVisibleToUser } from "@/lib/transactions";
import {
  currentPeriodAr,
  formatArs,
  formatUsd,
  periodFromDateString,
} from "@/lib/utils";
import { formatPeriodLabel } from "@/lib/period-label";

export type ExpenseTx = {
  date: string;
  descriptionNormalized: string;
  amountArs: string | number | null;
  amountUsd: string | number | null;
  isPayment: boolean;
  isCredit?: boolean;
  categoryId: string | null;
  bank: string | null;
  ownership: string;
  paidByUserId: string | null;
  source?: string | null;
};

export type CategoryRef = { slug: string; name: string };

type Agg = {
  amountArs: number;
  amountUsd: number;
  count: number;
  categoryId: string | null;
};

export function toNumber(
  value: string | number | null | undefined,
): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * usd + arsLiq on the same row is one expense in two currencies.
 * Do not add them; keep USD and skip the ARS equivalent.
 */
export function splitExpenseAmounts(
  amountArs: string | number | null | undefined,
  amountUsd: string | number | null | undefined,
): { amountArs: number; amountUsd: number } {
  const ars = toNumber(amountArs);
  const usd = toNumber(amountUsd);
  const arsAbs = ars != null ? Math.abs(ars) : 0;
  const usdAbs = usd != null ? Math.abs(usd) : 0;
  if (arsAbs > 0 && usdAbs > 0) {
    return { amountArs: 0, amountUsd: usdAbs };
  }
  return { amountArs: arsAbs, amountUsd: usdAbs };
}

/** Real consumption only: skip card payments, credits, bank accounting, and period xls. */
export function isExpenseRow(r: {
  isPayment: boolean;
  isCredit?: boolean;
  descriptionNormalized: string;
  source?: string | null;
}): boolean {
  if (r.isPayment || r.isCredit) return false;
  if (isBankAccountingEntry(r.descriptionNormalized)) return false;
  if (isPeriodDebtSource(r.source)) return false;
  return true;
}

export function visibleExpenseRows<T extends ExpenseTx>(
  rows: T[],
  viewerUserId: string,
): T[] {
  return rows.filter(
    (r) => isVisibleToUser(r, viewerUserId) && isExpenseRow(r),
  );
}

/** Resumen / charts: Todos | Personal | Hogar (matches Consumos Lista chips). */
export function filterByOwnership<T extends { ownership: string }>(
  rows: T[],
  ownership: "all" | "personal" | "shared",
): T[] {
  if (ownership === "all") return rows;
  return rows.filter((r) => r.ownership === ownership);
}

export function aggregateByPeriod(
  rows: ExpenseTx[],
  categoryById: Map<string, CategoryRef>,
): {
  periods: string[];
  byPeriod: Map<string, Map<string, Agg>>;
} {
  const byPeriod = new Map<string, Map<string, Agg>>();
  const periodsSet = new Set<string>();

  for (const r of rows) {
    const p = periodFromDateString(r.date);
    periodsSet.add(p);

    const cat = r.categoryId ? categoryById.get(r.categoryId) : undefined;
    const slug = cat?.slug ?? "uncategorized";
    const name = cat?.name ?? "Sin categoría";
    const key = `${slug}||${name}||${r.categoryId ?? ""}`;

    if (!byPeriod.has(p)) byPeriod.set(p, new Map());
    const map = byPeriod.get(p)!;
    const cur = map.get(key) ?? {
      amountArs: 0,
      amountUsd: 0,
      count: 0,
      categoryId: r.categoryId ?? null,
    };
    const split = splitExpenseAmounts(r.amountArs, r.amountUsd);
    cur.amountArs += split.amountArs;
    cur.amountUsd += split.amountUsd;
    cur.count += 1;
    map.set(key, cur);
  }

  const periods = [...periodsSet].sort().reverse();
  return { periods, byPeriod };
}

export type MonthCategory = {
  slug: string;
  name: string;
  categoryId: string | null;
  amountArs: number;
  amountUsd: number;
  amountArsFromUsd: number;
  amountArsCombined: number;
  count: number;
  pct: number;
};

export type CubiertoTotals = {
  amountArs: number;
  amountUsd: number;
  amountArsFromUsd: number;
  amountArsCombined: number;
  count: number;
};

export const EMPTY_CUBIERTO: CubiertoTotals = {
  amountArs: 0,
  amountUsd: 0,
  amountArsFromUsd: 0,
  amountArsCombined: 0,
  count: 0,
};

export type MonthView = {
  period: string;
  totalArs: number;
  totalUsd: number;
  totalArsFromUsd: number;
  totalArsCombined: number;
  totalCount: number;
  usdRate: { buy: number; asOf: string; source: string } | null;
  categories: MonthCategory[];
  /** Utility bills marked Cubierto (isPayment) — accounted outside neta. */
  cubierto: CubiertoTotals;
};

export function buildMonthFromAgg(
  period: string,
  map: Map<string, Agg> | undefined,
  fx: MonthEndRate | undefined,
  cubiertoAgg?: { amountArs: number; amountUsd: number; count: number },
): MonthView {
  const usdRate = fx?.buy ?? 0;

  const categories = [...(map ?? new Map()).entries()]
    .map(([key, agg]) => {
      const [slug, name, categoryId] = key.split("||");
      const amountArsFromUsd = convertUsdToArs(agg.amountUsd, usdRate);
      const amountArsCombined = agg.amountArs + amountArsFromUsd;
      return {
        slug,
        name,
        categoryId: categoryId || agg.categoryId || null,
        amountArs: agg.amountArs,
        amountUsd: agg.amountUsd,
        amountArsFromUsd,
        amountArsCombined,
        count: agg.count,
      };
    })
    .sort((a, b) => b.amountArsCombined - a.amountArsCombined);

  const totalArs = categories.reduce((s, c) => s + c.amountArs, 0);
  const totalUsd = categories.reduce((s, c) => s + c.amountUsd, 0);
  const totalArsFromUsd = categories.reduce(
    (s, c) => s + c.amountArsFromUsd,
    0,
  );
  const totalArsCombined = totalArs + totalArsFromUsd;
  const totalCount = categories.reduce((s, c) => s + c.count, 0);

  const cubiertoArs = cubiertoAgg?.amountArs ?? 0;
  const cubiertoUsd = cubiertoAgg?.amountUsd ?? 0;
  const cubiertoArsFromUsd = convertUsdToArs(cubiertoUsd, usdRate);
  const cubierto: CubiertoTotals = {
    amountArs: cubiertoArs,
    amountUsd: cubiertoUsd,
    amountArsFromUsd: cubiertoArsFromUsd,
    amountArsCombined: cubiertoArs + cubiertoArsFromUsd,
    count: cubiertoAgg?.count ?? 0,
  };

  return {
    period,
    totalArs,
    totalUsd,
    totalArsFromUsd,
    totalArsCombined,
    totalCount,
    usdRate: fx
      ? { buy: fx.buy, asOf: fx.asOf, source: fx.source }
      : null,
    categories: categories.map((c) => ({
      ...c,
      pct:
        totalArsCombined > 0
          ? (c.amountArsCombined / totalArsCombined) * 100
          : 0,
    })),
    cubierto,
  };
}

/**
 * Utility bill marked Cubierto / Pagado: isPayment + hogar utility category.
 * Distinct from roommate Reintegro hogar (payee description).
 * These stay out of neta (isExpenseRow) but are tallied for Resumen transparency.
 */
export function isCubiertoUtilityRow(
  r: {
    isPayment: boolean;
    descriptionNormalized: string;
    categoryId: string | null;
  },
  categoryById: Map<string, CategoryRef>,
  groups: string[][] = reintegroPayeeGroups(),
): boolean {
  if (!r.isPayment) return false;
  if (isHogarReintegroDescription(r.descriptionNormalized, groups)) return false;
  const cat = r.categoryId ? categoryById.get(r.categoryId) : undefined;
  return isHogarUtilityCategory({
    slug: cat?.slug,
    name: cat?.name,
  });
}

export function visibleCubiertoRows<T extends ExpenseTx>(
  rows: T[],
  viewerUserId: string,
  categoryById: Map<string, CategoryRef>,
  groups: string[][] = reintegroPayeeGroups(),
): T[] {
  return rows.filter(
    (r) =>
      isVisibleToUser(r, viewerUserId) &&
      isCubiertoUtilityRow(r, categoryById, groups),
  );
}

/** Sum Cubierto (fuera de neta) amounts by YYYY-MM period. */
export function aggregateCubiertoByPeriod(
  rows: ExpenseTx[],
): Map<string, { amountArs: number; amountUsd: number; count: number }> {
  const byPeriod = new Map<
    string,
    { amountArs: number; amountUsd: number; count: number }
  >();
  for (const r of rows) {
    const p = periodFromDateString(r.date);
    const cur = byPeriod.get(p) ?? { amountArs: 0, amountUsd: 0, count: 0 };
    const split = splitExpenseAmounts(r.amountArs, r.amountUsd);
    cur.amountArs += split.amountArs;
    cur.amountUsd += split.amountUsd;
    cur.count += 1;
    byPeriod.set(p, cur);
  }
  return byPeriod;
}

export function mergePeriodLists(...lists: string[][]): string[] {
  const set = new Set<string>();
  for (const list of lists) {
    for (const p of list) set.add(p);
  }
  return [...set].sort().reverse();
}

export type BankAgg = {
  bank: string;
  amountArs: number;
  amountUsd: number;
  count: number;
};

export function aggregateByBank(rows: ExpenseTx[]): BankAgg[] {
  const map = new Map<string, BankAgg>();
  for (const r of rows) {
    const bank = r.bank?.trim() || "Sin banco";
    const cur = map.get(bank) ?? {
      bank,
      amountArs: 0,
      amountUsd: 0,
      count: 0,
    };
    const split = splitExpenseAmounts(r.amountArs, r.amountUsd);
    cur.amountArs += split.amountArs;
    cur.amountUsd += split.amountUsd;
    cur.count += 1;
    map.set(bank, cur);
  }
  return [...map.values()].sort(
    (a, b) => b.amountArs + b.amountUsd - (a.amountArs + a.amountUsd),
  );
}

export function formatGastosHeadline(month: MonthView): string {
  const label = formatPeriodLabel(month.period);
  const total = formatArs(month.totalArsCombined);
  const n = month.totalCount;
  if (n === 0) {
    return `No hay gastos registrados en ${label}.`;
  }
  const mov = n === 1 ? "1 movimiento" : `${n} movimientos`;
  if (month.totalUsd > 0 && month.totalArs > 0) {
    return `En ${label} gastaste ${total} (${formatArs(month.totalArs)} + ${formatUsd(month.totalUsd)} convertidos a ${formatArs(month.totalArsFromUsd)}; ${mov}).`;
  }
  if (month.totalUsd > 0 && month.totalArs === 0) {
    return `En ${label} gastaste ${formatUsd(month.totalUsd)} (${total} al tipo de cambio; ${mov}).`;
  }
  return `En ${label} gastaste ${total} (${mov}).`;
}

export { currentPeriodAr, formatPeriodLabel };
