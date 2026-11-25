/**
 * GROUP BY queries for the v2 charts.
 * One currency per statement. ARS, USDT, and USD are never added.
 * `today` is YYYY-MM-DD in America/Argentina/Buenos_Aires.
 */

import type { Currency, Granularity } from "../src/lib/stats/currency";
import type { SpendWindowKind } from "../src/lib/spend-period";
import { ARS_EXPR, INTERNAL_ASIDE_SQL, USD_EXPR } from "./sql";

export type SpendWindow = SpendWindowKind;

export const SPENDING_WINDOW_DAYS = 90;

/**
 * Lower/upper date bounds. `household_id` plus this range uses
 * `tx_household_date_idx`. "All" still filters `date <= today` so the
 * query does not scan future rows or other households.
 */
export function dateWindowSql(today: string, window: SpendWindow): { sql: string; params: unknown[] } {
  if (window.kind === "all") {
    return { sql: "t.date <= ?", params: [today] };
  }
  const modifier =
    window.kind === "days"
      ? `-${window.days} days`
      : window.kind === "months"
        ? `-${window.months} months`
        : `-${window.years} years`;
  return { sql: "t.date >= date(?, ?) AND t.date <= ?", params: [today, modifier, today] };
}

/** About 26 Monday-start weeks. */
export const SERIES_WEEK_DAYS = 182;
/** Current month plus the previous 23. */
export const SERIES_MONTH_COUNT = 24;

export const WEEK_BUCKET_SQL = "date(t.date, 'weekday 0', '-6 days')";
export const MONTH_BUCKET_SQL = "substr(t.date, 1, 7)";

/** Fiwind's USD column is the wallet (USDT/USDC). Other banks' USD column is USD. */
const FIWIND_SQL = `(
  lower(IFNULL(t.bank, '')) = 'fiwind'
  OR lower(IFNULL(t.source, '')) LIKE '%fiwind%'
)`;

/** Same CASE as `ARS_EXPR`. Kept in one place so the pie matches the dashboard leg. */
export function amountSql(currency: Currency): string {
  if (currency === "ARS") return `(${ARS_EXPR})`;
  if (currency === "USDT") {
    return `(CASE WHEN ${FIWIND_SQL} AND (${ARS_EXPR}) = 0 THEN ABS(CAST(IFNULL(t.amount_usd, '0') AS REAL)) ELSE 0 END)`;
  }
  return `(CASE WHEN NOT ${FIWIND_SQL} AND (${ARS_EXPR}) = 0 THEN ABS(CAST(IFNULL(t.amount_usd, '0') AS REAL)) ELSE 0 END)`;
}

export interface SqlQuery {
  sql: string;
  params: unknown[];
}

function counted(currency: Currency): { amount: string; hits: string } {
  const amount = amountSql(currency);
  return {
    amount,
    hits: `SUM(CASE WHEN ${amount} != 0 THEN 1 ELSE 0 END)`,
  };
}

/**
 * Inclusive window up to `today`. Day/month/year edges stay in; the day before
 * is out. Expenses only. Transferencias internas are not in the sum.
 */
export function spendingByCategoryQuery(input: {
  currency: Currency;
  today: string;
  window: SpendWindow;
  householdId: string;
  expenseSql: string;
  visibilitySql: string;
  visibilityBinds: unknown[];
}): SqlQuery {
  const { amount, hits } = counted(input.currency);
  const dates = dateWindowSql(input.today, input.window);
  return {
    sql: `
      SELECT COALESCE(c.name, 'Sin categoría') AS category,
             COALESCE(c.slug, '') AS slug,
             ${hits} AS count,
             ROUND(SUM(${amount}), 2) AS total
      FROM transactions t
      LEFT JOIN categories c ON c.id = t.category_id
      WHERE t.household_id = ?
        AND ${dates.sql}
        AND ${input.expenseSql}
        AND IFNULL(c.slug, '') != 'transferencia-interna'
        AND ${input.visibilitySql}
      GROUP BY c.id, category, slug
      HAVING ROUND(SUM(${amount}), 2) != 0
      ORDER BY total DESC, category ASC
    `,
    params: [input.householdId, ...dates.params, ...input.visibilityBinds],
  };
}

/** Same window as the pie. These rows are shown apart and are not in the expense total. */
export function internalAsideQuery(input: {
  currency: Currency;
  today: string;
  window: SpendWindow;
  householdId: string;
  visibilitySql: string;
  visibilityBinds: unknown[];
  internalIdsJson: string;
}): SqlQuery {
  const { amount, hits } = counted(input.currency);
  const dates = dateWindowSql(input.today, input.window);
  return {
    sql: `
      SELECT ${hits} AS count,
             ROUND(SUM(${amount}), 2) AS total
      FROM transactions t
      LEFT JOIN categories c ON c.id = t.category_id
      WHERE t.household_id = ?
        AND ${dates.sql}
        AND ${INTERNAL_ASIDE_SQL}
        AND ${input.visibilitySql}
    `,
    params: [
      input.householdId,
      ...dates.params,
      input.internalIdsJson,
      ...input.visibilityBinds,
    ],
  };
}

/** One month of ARS plus USD (wallet and bank), same split as the home total. */
export type MonthlySpendRow = {
  category: string;
  slug: string;
  month: string;
  count: number;
  ars: number;
  usd: number;
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Convert each month's USD at that month's `monthEndBuy` rate (oficial
 * compra), then add ARS. A missing rate leaves the USD leg unconverted,
 * same as the dashboard total.
 */
export function foldCombinedSpend(
  rows: Array<Pick<MonthlySpendRow, "category" | "slug" | "count" | "month" | "ars" | "usd">>,
  rateForMonth: (month: string) => number,
): { rows: { category: string; slug: string; count: number; total: number }[]; total: number } {
  const byCat = new Map<string, { category: string; slug: string; count: number; total: number }>();
  for (const row of rows) {
    const rate = rateForMonth(row.month);
    const converted = row.ars + (rate > 0 ? row.usd * rate : 0);
    const key = `${row.slug}\0${row.category}`;
    const cur = byCat.get(key) ?? {
      category: row.category,
      slug: row.slug,
      count: 0,
      total: 0,
    };
    cur.count += row.count;
    cur.total += converted;
    byCat.set(key, cur);
  }
  const folded = [...byCat.values()]
    .map((row) => ({ ...row, total: round2(row.total) }))
    .filter((row) => row.total !== 0)
    .sort((a, b) => b.total - a.total || a.category.localeCompare(b.category));
  let total = 0;
  for (const row of folded) total += row.total;
  return { rows: folded, total: round2(total) };
}

export function foldCombinedInternal(
  rows: Array<{ month: string; count: number; ars: number; usd: number }>,
  rateForMonth: (month: string) => number,
): { count: number; total: number } {
  let count = 0;
  let total = 0;
  for (const row of rows) {
    const rate = rateForMonth(row.month);
    count += row.count;
    total += row.ars + (rate > 0 ? row.usd * rate : 0);
  }
  return { count, total: round2(total) };
}

/**
 * Same window and filters as the single-currency pie, but one row per
 * category and month so each USD leg can use that month's rate.
 */
export function spendingByCategoryCombinedQuery(input: {
  today: string;
  window: SpendWindow;
  householdId: string;
  expenseSql: string;
  visibilitySql: string;
  visibilityBinds: unknown[];
}): SqlQuery {
  const ars = `(${ARS_EXPR})`;
  const usd = `(${USD_EXPR})`;
  const dates = dateWindowSql(input.today, input.window);
  return {
    sql: `
      SELECT COALESCE(c.name, 'Sin categoría') AS category,
             COALESCE(c.slug, '') AS slug,
             substr(t.date, 1, 7) AS month,
             SUM(CASE WHEN ${ars} != 0 OR ${usd} != 0 THEN 1 ELSE 0 END) AS count,
             ROUND(SUM(${ars}), 2) AS ars,
             ROUND(SUM(${usd}), 2) AS usd
      FROM transactions t
      LEFT JOIN categories c ON c.id = t.category_id
      WHERE t.household_id = ?
        AND ${dates.sql}
        AND ${input.expenseSql}
        AND IFNULL(c.slug, '') != 'transferencia-interna'
        AND ${input.visibilitySql}
      GROUP BY c.id, category, slug, month
      HAVING ROUND(SUM(${ars}), 2) != 0 OR ROUND(SUM(${usd}), 2) != 0
      ORDER BY month ASC, category ASC
    `,
    params: [input.householdId, ...dates.params, ...input.visibilityBinds],
  };
}

export function internalAsideCombinedQuery(input: {
  today: string;
  window: SpendWindow;
  householdId: string;
  visibilitySql: string;
  visibilityBinds: unknown[];
  internalIdsJson: string;
}): SqlQuery {
  const ars = `(${ARS_EXPR})`;
  const usd = `(${USD_EXPR})`;
  const dates = dateWindowSql(input.today, input.window);
  return {
    sql: `
      SELECT substr(t.date, 1, 7) AS month,
             SUM(CASE WHEN ${ars} != 0 OR ${usd} != 0 THEN 1 ELSE 0 END) AS count,
             ROUND(SUM(${ars}), 2) AS ars,
             ROUND(SUM(${usd}), 2) AS usd
      FROM transactions t
      LEFT JOIN categories c ON c.id = t.category_id
      WHERE t.household_id = ?
        AND ${dates.sql}
        AND ${INTERNAL_ASIDE_SQL}
        AND ${input.visibilitySql}
      GROUP BY month
    `,
    params: [
      input.householdId,
      ...dates.params,
      input.internalIdsJson,
      ...input.visibilityBinds,
    ],
  };
}

/**
 * Expense series. Not a cumulative line: each point is the spend of that bucket.
 * day: last 90 days. week: last 26 Monday-start weeks.
 * month: last 24 months. all: one point per month for the whole history.
 */
export function spendingSeriesQuery(input: {
  currency: Currency;
  today: string;
  granularity: Granularity;
  householdId: string;
  expenseSql: string;
  visibilitySql: string;
  visibilityBinds: unknown[];
}): SqlQuery {
  const { amount, hits } = counted(input.currency);
  const tail = `
        AND ${input.expenseSql}
        AND IFNULL(c.slug, '') != 'transferencia-interna'
        AND ${input.visibilitySql}
      GROUP BY bucket
      HAVING ROUND(SUM(${amount}), 2) != 0
      ORDER BY bucket ASC
  `;
  const from = `
      SELECT __BUCKET__ AS bucket,
             ${hits} AS count,
             ROUND(SUM(${amount}), 2) AS total
      FROM transactions t
      LEFT JOIN categories c ON c.id = t.category_id
      WHERE t.household_id = ?
  `;

  if (input.granularity === "day") {
    return {
      sql: from.replace("__BUCKET__", "t.date") + `
        AND t.date >= date(?, ?)
        AND t.date <= ?
      ` + tail,
      params: [
        input.householdId,
        input.today,
        `-${SPENDING_WINDOW_DAYS} days`,
        input.today,
        ...input.visibilityBinds,
      ],
    };
  }

  if (input.granularity === "week") {
    return {
      sql: from.replace("__BUCKET__", WEEK_BUCKET_SQL) + `
        AND t.date >= date(?, ?)
        AND t.date <= ?
      ` + tail,
      params: [
        input.householdId,
        input.today,
        `-${SERIES_WEEK_DAYS} days`,
        input.today,
        ...input.visibilityBinds,
      ],
    };
  }

  if (input.granularity === "month") {
    const monthBack = SERIES_MONTH_COUNT - 1;
    return {
      sql: from.replace("__BUCKET__", MONTH_BUCKET_SQL) + `
        AND t.date >= date(?, 'start of month', '-${monthBack} months')
        AND t.date <= ?
      ` + tail,
      params: [input.householdId, input.today, input.today, ...input.visibilityBinds],
    };
  }

  return {
    sql: from.replace("__BUCKET__", MONTH_BUCKET_SQL) + `
        AND t.date <= ?
      ` + tail,
    params: [input.householdId, input.today, ...input.visibilityBinds],
  };
}

/** Variable incomes only. Caller passes internal ids as a JSON array. Recurring rows are expanded outside SQL. */
export function variableIncomeByMonthSql(): string {
  return `
    SELECT substr(date, 1, 7) AS month,
           ROUND(SUM(CASE WHEN ABS(CAST(IFNULL(amount_ars, '0') AS REAL)) > 0 THEN CAST(amount_ars AS REAL) ELSE 0 END), 2) AS ars,
           ROUND(SUM(CASE WHEN ABS(CAST(IFNULL(amount_usd, '0') AS REAL)) > 0 THEN CAST(amount_usd AS REAL) ELSE 0 END), 2) AS usd,
           SUM(CASE WHEN ABS(CAST(IFNULL(amount_ars, '0') AS REAL)) > 0 THEN 1 ELSE 0 END) AS ars_count,
           SUM(CASE WHEN ABS(CAST(IFNULL(amount_usd, '0') AS REAL)) > 0 THEN 1 ELSE 0 END) AS usd_count
    FROM incomes
    WHERE user_id = ?
      AND household_id = ?
      AND IFNULL(kind, '') != 'recurring'
      AND id NOT IN (SELECT value FROM json_each(?))
    GROUP BY month
    ORDER BY month ASC
  `;
}
