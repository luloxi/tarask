/**
 * v2 charts on Tarask's data.
 * GET /api/spending-by-category
 * GET /api/spending-series
 * GET /api/income-by-month
 *
 * Totals are GROUP BY in D1. One currency per response.
 * Internal transfers are not income and are not in the expense total.
 */

import {
  expandRecurringDatesForPeriod,
  isIncomeFrequency,
} from "../src/lib/incomes";
import { isCurrency, isGranularity, type Currency, type Granularity } from "../src/lib/stats/currency";
import { isSpendPeriodId, windowForPeriod, type SpendPeriodId } from "../src/lib/spend-period";
import type { SessionUser } from "./auth";
import type { Env } from "./env";
import { activeHousehold, forceSharedOnly, type HouseholdRow } from "./household";
import { json, jsonPrivate, num, todayAr } from "./http";
import { annotateIncomeRows, type IncomeRow } from "./income";
import { loadFx, monthEndBuy } from "./fx";
import {
  SPENDING_WINDOW_DAYS,
  foldCombinedInternal,
  foldCombinedSpend,
  internalAsideCombinedQuery,
  internalAsideQuery,
  spendingByCategoryCombinedQuery,
  spendingByCategoryQuery,
  spendingSeriesQuery,
  variableIncomeByMonthSql,
  type SpendWindow,
} from "./insights-sql";
import { expenseSql } from "./sql";
import { loadExcludedMovementIds } from "./transfer-class";

type Ownership = "all" | "personal" | "shared";

export async function handleSpendingByCategory(
  req: Request,
  env: Env,
  user: SessionUser,
): Promise<Response> {
  if (req.method !== "GET") return json({ error: "Método no permitido" }, 405);
  const url = new URL(req.url);
  const combined = url.searchParams.get("currency") === "combined";
  const currency = combined ? "ARS" : currencyOf(url);
  if (!currency) return json({ error: "Moneda inválida" }, 400);
  const parsed = parseSpendWindowParam(url);
  if (!parsed) return json({ error: "Período inválido" }, 400);
  const scope = await scopeOf(req, env, user, url);
  if (scope instanceof Response) return scope;

  try {
    const movements = await loadExcludedMovementIds(env.DB, user.id, env.OWN_ACCOUNT_IDS);
    const expense = expenseSql(movements.excludedIds);
    if (combined) {
      return await respondCombined(env, scope, parsed, expense, movements.internalIds);
    }
    const categoryQuery = spendingByCategoryQuery({
      currency,
      today: scope.today,
      window: parsed.window,
      householdId: scope.household.id,
      expenseSql: expense,
      visibilitySql: scope.visibility.sql,
      visibilityBinds: scope.visibility.binds,
    });
    const aside = internalAsideQuery({
      currency,
      today: scope.today,
      window: parsed.window,
      householdId: scope.household.id,
      visibilitySql: scope.visibility.sql,
      visibilityBinds: scope.visibility.binds,
      internalIdsJson: JSON.stringify(movements.internalIds),
    });
    const [categories, internal] = await Promise.all([
      env.DB.prepare(categoryQuery.sql)
        .bind(...categoryQuery.params)
        .all<{ category: string; slug: string; count: number | null; total: number | null }>(),
      env.DB.prepare(aside.sql)
        .bind(...aside.params)
        .first<{ count: number | null; total: number | null }>(),
    ]);
    const rows = (categories.results ?? []).map((row) => ({
      category: String(row.category),
      slug: String(row.slug ?? ""),
      count: num(row.count),
      total: num(row.total),
    }));
    let total = 0;
    for (const row of rows) total += row.total;
    return jsonPrivate({
      currency,
      period: parsed.period,
      days: parsed.window.kind === "days" ? parsed.window.days : null,
      today: scope.today,
      total: round2(total),
      rows,
      internal: { count: num(internal?.count), total: round2(num(internal?.total)) },
    });
  } catch (err) {
    console.error("spending-by-category failed", err instanceof Error ? err.name : "error");
    return json({ error: "No se pudo leer el gasto" }, 500);
  }
}

export async function handleSpendingSeries(
  req: Request,
  env: Env,
  user: SessionUser,
): Promise<Response> {
  if (req.method !== "GET") return json({ error: "Método no permitido" }, 405);
  const url = new URL(req.url);
  const currency = currencyOf(url);
  if (!currency) return json({ error: "Moneda inválida" }, 400);
  const raw = url.searchParams.get("granularity") ?? "day";
  if (!isGranularity(raw)) return json({ error: "Granularidad inválida" }, 400);
  const scope = await scopeOf(req, env, user, url);
  if (scope instanceof Response) return scope;

  try {
    const movements = await loadExcludedMovementIds(env.DB, user.id, env.OWN_ACCOUNT_IDS);
    const query = spendingSeriesQuery({
      currency,
      today: scope.today,
      granularity: raw,
      householdId: scope.household.id,
      expenseSql: expenseSql(movements.excludedIds),
      visibilitySql: scope.visibility.sql,
      visibilityBinds: scope.visibility.binds,
    });
    const res = await env.DB.prepare(query.sql)
      .bind(...query.params)
      .all<{ bucket: string; count: number | null; total: number | null }>();
    return jsonPrivate({
      currency,
      granularity: raw satisfies Granularity,
      today: scope.today,
      rows: (res.results ?? []).map((row) => ({
        bucket: String(row.bucket),
        count: num(row.count),
        total: num(row.total),
      })),
    });
  } catch (err) {
    console.error("spending-series failed", err instanceof Error ? err.name : "error");
    return json({ error: "No se pudo leer la evolución" }, 500);
  }
}

export async function handleIncomeByMonth(
  req: Request,
  env: Env,
  user: SessionUser,
): Promise<Response> {
  if (req.method !== "GET") return json({ error: "Método no permitido" }, 405);
  const url = new URL(req.url);
  const currency = currencyOf(url);
  if (!currency) return json({ error: "Moneda inválida" }, 400);
  const { active } = await activeHousehold(req, env, user.id);
  if (!active) return json({ error: "NO_HOUSEHOLD" }, 400);

  try {
    const today = todayAr();
    const [rows, movements] = await Promise.all([
      incomeRows(env, user.id, active.id),
      loadExcludedMovementIds(env.DB, user.id, env.OWN_ACCOUNT_IDS),
    ]);
    const annotated = annotateIncomeRows(rows, {
      ownIds: movements.ownIds,
      userHouseholdIds: movements.userHouseholdIds,
      outgoing: movements.incomeOutgoing,
    });
    const internalIds = annotated
      .filter((row) => row.internal && row.kind !== "recurring" && row.id)
      .map((row) => String(row.id));
    const grouped = await env.DB.prepare(variableIncomeByMonthSql())
      .bind(user.id, active.id, JSON.stringify(internalIds))
      .all<{
        month: string;
        ars: number | null;
        usd: number | null;
        ars_count: number | null;
        usd_count: number | null;
      }>();

    const cells = new Map<string, { total: number; count: number }>();
    const add = (month: string, code: "ARS" | "USD", amount: number, count: number) => {
      if (!month || !Number.isFinite(amount) || amount === 0 || count === 0) return;
      const key = `${month}|${code}`;
      const cell = cells.get(key) ?? { total: 0, count: 0 };
      cell.total += amount;
      cell.count += count;
      cells.set(key, cell);
    };
    for (const row of grouped.results ?? []) {
      add(String(row.month), "ARS", num(row.ars), num(row.ars_count));
      add(String(row.month), "USD", num(row.usd), num(row.usd_count));
    }
    for (const row of annotated) {
      if (row.kind !== "recurring" || !isIncomeFrequency(row.frequency)) continue;
      const anchor = row.date.slice(0, 7);
      const end = today.slice(0, 7);
      if (anchor > end) continue;
      for (const month of monthsBetween(anchor, end)) {
        const dates = expandRecurringDatesForPeriod(row.date, row.frequency, month);
        if (dates.length === 0) continue;
        const ars = num(row.amount_ars);
        const usd = num(row.amount_usd);
        if (ars !== 0) add(month, "ARS", Math.abs(ars) * dates.length, dates.length);
        if (usd !== 0) add(month, "USD", Math.abs(usd) * dates.length, dates.length);
      }
    }

    const rowsOut = [...cells.entries()]
      .filter(([key]) => key.endsWith(`|${currency}`))
      .map(([key, cell]) => ({
        month: key.slice(0, 7),
        count: cell.count,
        total: round2(cell.total),
      }))
      .sort((a, b) => a.month.localeCompare(b.month));
    let total = 0;
    for (const row of rowsOut) total += row.total;
    return jsonPrivate({
      currency,
      total: round2(total),
      excludedCount: internalIds.length,
      rows: rowsOut,
    });
  } catch (err) {
    console.error("income-by-month failed", err instanceof Error ? err.name : "error");
    return json({ error: "No se pudo leer los ingresos" }, 500);
  }
}

type SpendScope = {
  household: HouseholdRow;
  today: string;
  visibility: { sql: string; binds: unknown[] };
};

async function respondCombined(
  env: Env,
  scope: SpendScope,
  parsed: ParsedSpendWindow,
  expense: string,
  internalIds: readonly string[],
): Promise<Response> {
  const categoryQuery = spendingByCategoryCombinedQuery({
    today: scope.today,
    window: parsed.window,
    householdId: scope.household.id,
    expenseSql: expense,
    visibilitySql: scope.visibility.sql,
    visibilityBinds: scope.visibility.binds,
  });
  const aside = internalAsideCombinedQuery({
    today: scope.today,
    window: parsed.window,
    householdId: scope.household.id,
    visibilitySql: scope.visibility.sql,
    visibilityBinds: scope.visibility.binds,
    internalIdsJson: JSON.stringify(internalIds),
  });
  const [categories, internal, fx] = await Promise.all([
    env.DB.prepare(categoryQuery.sql)
      .bind(...categoryQuery.params)
      .all<{ category: string; slug: string; month: string; count: number | null; ars: number | null; usd: number | null }>(),
    env.DB.prepare(aside.sql)
      .bind(...aside.params)
      .all<{ month: string; count: number | null; ars: number | null; usd: number | null }>(),
    loadFx(),
  ]);
  const rateForMonth = (month: string) => monthEndBuy(fx, month);
  const folded = foldCombinedSpend(
    (categories.results ?? []).map((row) => ({
      category: String(row.category),
      slug: String(row.slug ?? ""),
      month: String(row.month),
      count: num(row.count),
      ars: num(row.ars),
      usd: num(row.usd),
    })),
    rateForMonth,
  );
  const asideFold = foldCombinedInternal(
    (internal.results ?? []).map((row) => ({
      month: String(row.month),
      count: num(row.count),
      ars: num(row.ars),
      usd: num(row.usd),
    })),
    rateForMonth,
  );
  return jsonPrivate({
    currency: "ARS",
    combined: true,
    period: parsed.period,
    days: parsed.window.kind === "days" ? parsed.window.days : null,
    today: scope.today,
    total: folded.total,
    rows: folded.rows,
    internal: asideFold,
  });
}

function currencyOf(url: URL): Currency | null {

  const raw = url.searchParams.get("currency") ?? "ARS";
  return isCurrency(raw) ? raw : null;
}

export type ParsedSpendWindow = {
  period: SpendPeriodId | null;
  window: SpendWindow;
};

/**
 * `period` (30d / 90d / 6m / 1y / all) wins when present.
 * Otherwise `days` (1–3660, or `all`). Missing both keeps the historical
 * 90-day default so older callers of this endpoint stay unchanged.
 */
export function parseSpendWindowParam(url: URL): ParsedSpendWindow | null {
  const period = url.searchParams.get("period");
  if (period != null && period !== "") {
    if (!isSpendPeriodId(period)) return null;
    return { period, window: windowForPeriod(period) };
  }
  const raw = url.searchParams.get("days");
  if (raw == null || raw === "") {
    return { period: "90d", window: { kind: "days", days: SPENDING_WINDOW_DAYS } };
  }
  if (raw === "all") return { period: "all", window: { kind: "all" } };
  if (!/^\d+$/.test(raw)) return null;
  const days = Number(raw);
  if (days < 1 || days > 3660) return null;
  return { period: null, window: { kind: "days", days } };
}

async function scopeOf(req: Request, env: Env, user: SessionUser, url: URL) {
  const { active } = await activeHousehold(req, env, user.id);
  if (!active) return json({ error: "NO_HOUSEHOLD" }, 400);
  const ownershipRaw = url.searchParams.get("ownership");
  const ownership: Ownership =
    ownershipRaw === "personal" || ownershipRaw === "shared" ? ownershipRaw : "all";
  return {
    household: active,
    today: todayAr(),
    visibility: visibility(active, user.id, ownership),
  };
}

function visibility(household: HouseholdRow, userId: string, ownership: Ownership) {
  if (ownership === "personal") {
    return { sql: "t.ownership = 'personal' AND t.paid_by_user_id = ?", binds: [userId] };
  }
  if (ownership === "shared" || forceSharedOnly(household.name)) {
    return { sql: "t.ownership = 'shared'", binds: [] as unknown[] };
  }
  return { sql: "(t.ownership = 'shared' OR t.paid_by_user_id = ?)", binds: [userId] };
}

async function incomeRows(env: Env, userId: string, householdId: string): Promise<IncomeRow[]> {
  const res = await env.DB.prepare(
    `SELECT id, household_id, date, label, kind, frequency, amount_ars, amount_usd
     FROM incomes WHERE user_id = ? AND household_id = ?`,
  )
    .bind(userId, householdId)
    .all<IncomeRow>();
  return res.results ?? [];
}

function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let year = Number(from.slice(0, 4));
  let month = Number(from.slice(5, 7));
  const endYear = Number(to.slice(0, 4));
  const endMonth = Number(to.slice(5, 7));
  let guard = 0;
  while ((year < endYear || (year === endYear && month <= endMonth)) && guard < 240) {
    out.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
    guard += 1;
  }
  return out;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
