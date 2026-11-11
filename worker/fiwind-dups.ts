/**
 * Fiwind numeric echoes: a digits-and-dots Fiwind row is the same movement as
 * a named twin, so the numeric id is dropped from gastos and Consumos.
 *
 * Pairing runs here, not in SQL. A correlated scan does not fit the Workers
 * free-plan CPU limit. Each request calls `loadFiwindEchoIds` once for the
 * requesting user. That is one D1 statement. It reads households of that
 * user through `household_members.user_id` and `tx_household_date_idx`
 * (`household_id`, `date`). Named rows are loaded only inside a same-household
 * ±2 day window or on the same day in another household of the same user,
 * and only when a signed amount is close enough to bother the matcher.
 * A loader error returns no ids, so every row still counts.
 *
 * `pairFiwindEchoes` is pure and 1:1. An eligible pair is a Fiwind numeric
 * row and a different row whose description is not numeric-only and is not
 * a transfer (TRANSFERENCIA / DEBIN). A named spend (letters left after
 * folding) may sit up to 2 calendar days away in the same household.
 * Anything else, including an empty merchant like "Pago a 0002", is
 * same-day only. Two households of this user always need the same calendar
 * day. A household absent from `userHouseholdIds` is ignored.
 *
 * The amount is the numeric row's own currency, signed, same direction, and
 * non-zero. Own currency is USD when |amount_usd| >= 0.005 and the ARS
 * counted amount is 0 the way `ARS_EXPR` is 0 when both sides are nonzero.
 * Otherwise it is ARS. Tolerance is strictly under 0.01 ARS or 0.005 USD.
 * 100 does not pair with -100.
 *
 * Eligible pairs are sorted by distance in days, then same-household before
 * cross-household, then numeric date, numeric id, named date, named id.
 * The first pair whose two rows are still free is taken. Each row is used
 * once. The named twin stays. Candidates are grouped by currency and a
 * rounded amount key so the work is O(n log n) over a few hundred rows.
 */

import { isAnonymousMerchant, isTransferLike } from "../src/lib/import/dedupe";

const ARS_TOLERANCE = 0.01;
const USD_TOLERANCE = 0.005;
const USD_CURRENCY_MIN = 0.005;

export type FiwindEchoRow = {
  id: string;
  householdId: string;
  date: string;
  bank?: string | null;
  description?: string | null;
  amountArs?: string | number | null;
  amountUsd?: string | number | null;
  /** Ignored. A payment or a credit is still a named twin. */
  isPayment?: number | boolean | null;
  /** Ignored. A payment or a credit is still a named twin. */
  isCredit?: number | boolean | null;
};

type Side = {
  id: string;
  householdId: string;
  date: string;
  day: number;
  ars: number;
  usd: number;
  namedSpend: boolean;
};

type Pair = {
  distance: number;
  cross: number;
  nDate: string;
  nId: string;
  mDate: string;
  mId: string;
};

type Currency = "ARS" | "USD";

/** Digits and dots only, matching `numericDescriptionSql` (trim, IFNULL → ''). */
export function isNumericDescription(description: string | null | undefined): boolean {
  const text = (description ?? "").trim().toUpperCase();
  if (!/^[0-9]/.test(text)) return false;
  return !/[^0-9.]/.test(text);
}

function parseAmount(value: string | number | null | undefined): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (value == null) return 0;
  const text = String(value).trim();
  if (!text) return 0;
  const amount = Number(text);
  return Number.isFinite(amount) ? amount : 0;
}

/**
 * Absolute ARS that `ARS_EXPR` would add. Both sides nonzero → 0.
 * A zero USD side leaves `abs(ars)`.
 */
function countedArsAbs(ars: number, usd: number): number {
  if (Math.abs(usd) > 0 && Math.abs(ars) > 0) return 0;
  return Math.abs(ars);
}

/** USD when the row's counted ARS is 0 and |USD| clears the USD floor. */
export function fiwindOwnCurrency(ars: number, usd: number): Currency {
  if (Math.abs(usd) >= USD_CURRENCY_MIN && countedArsAbs(ars, usd) === 0) return "USD";
  return "ARS";
}

/** Calendar day index for `YYYY-MM-DD`. Invalid dates return null. */
function dayIndex(iso: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const utc = Date.UTC(year, month - 1, day);
  const check = new Date(utc);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  return Math.floor(utc / 86_400_000);
}

function cmpText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function tolerance(currency: Currency): number {
  return currency === "ARS" ? ARS_TOLERANCE : USD_TOLERANCE;
}

/**
 * Strict `< tolerance` in micro-units so 0.01 and 0.005 do not pair when
 * binary floats land just under the cut.
 */
function withinTolerance(left: number, right: number, tol: number): boolean {
  const scale = 1_000_000;
  return Math.abs(Math.round(left * scale) - Math.round(right * scale)) < Math.round(tol * scale);
}

function amountOf(row: Side, currency: Currency): number {
  return currency === "ARS" ? row.ars : row.usd;
}

function bucketOf(amount: number, currency: Currency): number {
  return Math.round(amount / tolerance(currency));
}

/**
 * Numeric ids to drop. `userHouseholdIds` is the requesting user's
 * membership. Rows outside that set are not candidates.
 */
export function pairFiwindEchoes(
  rows: readonly FiwindEchoRow[],
  userHouseholdIds: ReadonlySet<string>,
): Set<string> {
  const numerics: Side[] = [];
  const named: Side[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.id || seen.has(row.id)) continue;
    if (!userHouseholdIds.has(row.householdId)) continue;
    const day = dayIndex(row.date);
    if (day == null) continue;
    seen.add(row.id);
    const description = row.description ?? "";
    if (isTransferLike(description)) continue;
    const side: Side = {
      id: row.id,
      householdId: row.householdId,
      date: row.date,
      day,
      ars: parseAmount(row.amountArs),
      usd: parseAmount(row.amountUsd),
      namedSpend: !isAnonymousMerchant(description),
    };
    const numeric = (row.bank ?? "") === "Fiwind" && isNumericDescription(description);
    if (numeric) numerics.push(side);
    else if (!isNumericDescription(description)) named.push(side);
  }
  if (numerics.length === 0 || named.length === 0) return new Set();

  const buckets = new Map<string, Side[]>();
  const pushBucket = (currency: Currency, amount: number, row: Side) => {
    if (amount === 0) return;
    const key = `${currency}:${bucketOf(amount, currency)}`;
    const list = buckets.get(key);
    if (list) list.push(row);
    else buckets.set(key, [row]);
  };
  for (const row of named) {
    pushBucket("ARS", row.ars, row);
    pushBucket("USD", row.usd, row);
  }

  const pairs: Pair[] = [];
  for (const numeric of numerics) {
    const currency = fiwindOwnCurrency(numeric.ars, numeric.usd);
    const amount = amountOf(numeric, currency);
    if (amount === 0) continue;
    const tol = tolerance(currency);
    const key = bucketOf(amount, currency);
    for (let delta = -1; delta <= 1; delta += 1) {
      const list = buckets.get(`${currency}:${key + delta}`);
      if (!list) continue;
      for (const twin of list) {
        if (twin.id === numeric.id) continue;
        const twinAmount = amountOf(twin, currency);
        // Same sign and both non-zero. 100 does not match -100.
        if (amount * twinAmount <= 0) continue;
        if (!withinTolerance(amount, twinAmount, tol)) continue;
        const distance = Math.abs(numeric.day - twin.day);
        const sameHousehold = numeric.householdId === twin.householdId;
        if (sameHousehold) {
          const maxDistance = twin.namedSpend ? 2 : 0;
          if (distance > maxDistance) continue;
        } else if (distance !== 0) {
          continue;
        }
        pairs.push({
          distance,
          cross: sameHousehold ? 0 : 1,
          nDate: numeric.date,
          nId: numeric.id,
          mDate: twin.date,
          mId: twin.id,
        });
      }
    }
  }

  pairs.sort(
    (a, b) =>
      a.distance - b.distance ||
      a.cross - b.cross ||
      cmpText(a.nDate, b.nDate) ||
      cmpText(a.nId, b.nId) ||
      cmpText(a.mDate, b.mDate) ||
      cmpText(a.mId, b.mId),
  );

  const usedNumeric = new Set<string>();
  const usedNamed = new Set<string>();
  const drop = new Set<string>();
  for (const pair of pairs) {
    if (usedNumeric.has(pair.nId) || usedNamed.has(pair.mId)) continue;
    usedNumeric.add(pair.nId);
    usedNamed.add(pair.mId);
    drop.add(pair.nId);
  }
  return drop;
}

/** Same predicate as `isNumericDescription`, for the candidate statement. */
function numericDescriptionSql(alias: string): string {
  return `(
    upper(trim(IFNULL(${alias}.description_normalized, ''))) GLOB '[0-9]*'
    AND upper(trim(IFNULL(${alias}.description_normalized, ''))) NOT GLOB '*[^0-9.]*'
  )`;
}

/**
 * Coarse signed filter so the loader can skip unrelated named rows.
 * Own-currency matching stays in `pairFiwindEchoes`. An ARS hit or a USD
 * hit is enough to load the row; the pure function then keeps only the
 * numeric row's currency.
 */
function amountCouldMatchSql(numeric: string, named: string): string {
  return `(
    (
      CAST(IFNULL(${numeric}.amount_ars, '0') AS REAL) * CAST(IFNULL(${named}.amount_ars, '0') AS REAL) > 0
      AND abs(
        CAST(IFNULL(${named}.amount_ars, '0') AS REAL) - CAST(IFNULL(${numeric}.amount_ars, '0') AS REAL)
      ) < 0.01
    )
    OR (
      CAST(IFNULL(${numeric}.amount_usd, '0') AS REAL) * CAST(IFNULL(${named}.amount_usd, '0') AS REAL) > 0
      AND abs(
        CAST(IFNULL(${named}.amount_usd, '0') AS REAL) - CAST(IFNULL(${numeric}.amount_usd, '0') AS REAL)
      ) < 0.005
    )
  )`;
}

/**
 * One statement, one bound (`user_id`). Membership comes from
 * `household_members`. Fiwind numerics use `bank = 'Fiwind'` on
 * `tx_household_bank_idx (household_id, bank)`. `IFNULL(bank, '')` matches
 * the same rows (NULL is never `'Fiwind'`) but cannot use that index.
 * Named rows use a ±2 day range or an equality on
 * `tx_household_date_idx (household_id, date)`. There is no date-only
 * index, so the statement never filters transactions by date alone.
 *
 * `kind = 'hh'` is one row per household of the user. `kind = 'tx'` is a
 * Fiwind numeric candidate or a named row that could match one.
 */
export const FIWIND_ECHO_CANDIDATE_SQL = `
WITH user_households AS (
  SELECT household_id FROM household_members WHERE user_id = ?
),
numerics AS (
  SELECT
    t.id,
    t.household_id,
    t.date,
    t.bank,
    t.description_normalized,
    t.amount_ars,
    t.amount_usd
  FROM user_households uh
  INNER JOIN transactions t ON t.household_id = uh.household_id
  WHERE t.bank = 'Fiwind'
    AND ${numericDescriptionSql("t")}
)
SELECT
  'hh' AS kind,
  uh.household_id AS id,
  uh.household_id AS household_id,
  NULL AS date,
  NULL AS bank,
  NULL AS description_normalized,
  NULL AS amount_ars,
  NULL AS amount_usd
FROM user_households uh
UNION ALL
SELECT
  'tx',
  n.id,
  n.household_id,
  n.date,
  n.bank,
  n.description_normalized,
  n.amount_ars,
  n.amount_usd
FROM numerics n
UNION ALL
SELECT
  'tx',
  m.id,
  m.household_id,
  m.date,
  m.bank,
  m.description_normalized,
  m.amount_ars,
  m.amount_usd
FROM numerics n
INNER JOIN transactions m
  ON m.household_id = n.household_id
 AND m.date >= date(n.date, '-2 days')
 AND m.date <= date(n.date, '+2 days')
 AND m.id <> n.id
WHERE NOT ${numericDescriptionSql("m")}
  AND ${amountCouldMatchSql("n", "m")}
UNION ALL
SELECT
  'tx',
  m.id,
  m.household_id,
  m.date,
  m.bank,
  m.description_normalized,
  m.amount_ars,
  m.amount_usd
FROM numerics n
INNER JOIN user_households uh ON uh.household_id <> n.household_id
INNER JOIN transactions m
  ON m.household_id = uh.household_id
 AND m.date = n.date
 AND m.id <> n.id
WHERE NOT ${numericDescriptionSql("m")}
  AND ${amountCouldMatchSql("n", "m")}
`;

export type FiwindEchoCandidateRow = {
  kind: string;
  id: string;
  household_id: string;
  date: string | null;
  bank: string | null;
  description_normalized: string | null;
  amount_ars: string | number | null;
  amount_usd: string | number | null;
};

export type FiwindEchoDb = {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all<T = FiwindEchoCandidateRow>(): Promise<{ results?: T[] }>;
    };
  };
};

/**
 * Numeric ids to drop for `userId`. Safe on failure: logs a short message
 * with no row amounts and returns []. Callers then count every row.
 */
export async function loadFiwindEchoIds(db: FiwindEchoDb, userId: string): Promise<string[]> {
  try {
    const res = await db.prepare(FIWIND_ECHO_CANDIDATE_SQL).bind(userId).all<FiwindEchoCandidateRow>();
    const allowed = new Set<string>();
    const rows: FiwindEchoRow[] = [];
    for (const row of res.results ?? []) {
      if (row.kind === "hh") {
        if (row.household_id) allowed.add(String(row.household_id));
        continue;
      }
      if (!row.id || !row.household_id || !row.date) continue;
      rows.push({
        id: String(row.id),
        householdId: String(row.household_id),
        date: String(row.date),
        bank: row.bank,
        description: row.description_normalized,
        amountArs: row.amount_ars,
        amountUsd: row.amount_usd,
      });
    }
    return [...pairFiwindEchoes(rows, allowed)].sort();
  } catch (err) {
    const message = err instanceof Error ? err.message : "error";
    console.error("fiwind echo load failed", message.slice(0, 180));
    return [];
  }
}
