/**
 * Cross-source duplicates: the same spend (same day + amount + merchant)
 * from a bank alert, a statement and Fiwind is shown once.
 *
 * Fiwind numeric echoes stay in `fiwind-dups.ts` (±2 days at home, same
 * day across households). This module only drops extra named copies, or a
 * same-day numeric Fiwind row when a named twin of the same amount exists
 * in any of the user's households.
 *
 * Pairing is 1:1 and pure. Rows are not deleted. A loader error returns
 * no ids, so every row still counts.
 */

import {
  compactMerchant,
  isNumericMerchant,
  merchantsMatch,
} from "../src/lib/import/dedupe";

const ARS_TOLERANCE = 0.01;
const USD_TOLERANCE = 0.005;
const USD_CURRENCY_MIN = 0.005;

export type LogicalDupRow = {
  id: string;
  householdId: string;
  date: string;
  bank?: string | null;
  source?: string | null;
  description?: string | null;
  amountArs?: string | number | null;
  amountUsd?: string | number | null;
  createdAt?: string | number | null;
};

type Side = {
  id: string;
  householdId: string;
  date: string;
  bank: string;
  source: string;
  description: string;
  numeric: boolean;
  merchant: string;
  ars: number;
  usd: number;
  createdAt: number;
};

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

function ownAmount(ars: number, usd: number): { currency: "ARS" | "USD"; amount: number } {
  if (Math.abs(usd) >= USD_CURRENCY_MIN && countedArsAbs(ars, usd) === 0) {
    return { currency: "USD", amount: usd };
  }
  return { currency: "ARS", amount: ars };
}

function withinTolerance(left: number, right: number, tol: number): boolean {
  const scale = 1_000_000;
  return Math.abs(Math.round(left * scale) - Math.round(right * scale)) < Math.round(tol * scale);
}

function keepScore(row: Side): number {
  let score = 0;
  if (!row.numeric) score += 100;
  const source = row.source.toLowerCase();
  const bank = row.bank.toLowerCase();
  if (source.startsWith("bbva") || bank === "bbva") score += 20;
  else if (bank === "fiwind" || source.includes("fiwind")) score += 8;
  else if (source === "manual" || source === "receipt") score += 4;
  else score += 10;
  score += Math.min(row.description.length, 40);
  return score;
}

function cmpText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function isTransferLike(description: string): boolean {
  const text = description.toUpperCase();
  return (
    text.includes("TRANSFERENCIA") ||
    text.includes("TRANSF ") ||
    text.includes("DEBIN") ||
    text.includes("TRANSFER ")
  );
}

function sameMovement(a: Side, b: Side): boolean {
  if (a.date !== b.date) return false;
  const left = ownAmount(a.ars, a.usd);
  const right = ownAmount(b.ars, b.usd);
  if (left.currency !== right.currency) return false;
  if (left.amount * right.amount <= 0) return false;
  const tol = left.currency === "ARS" ? ARS_TOLERANCE : USD_TOLERANCE;
  if (!withinTolerance(left.amount, right.amount, tol)) return false;
  if (a.numeric && !b.numeric) return !isTransferLike(b.description);
  if (b.numeric && !a.numeric) return !isTransferLike(a.description);
  if (a.numeric && b.numeric) return true;
  if (isTransferLike(a.description) || isTransferLike(b.description)) return false;
  return merchantsMatch(a.merchant, b.merchant);
}

/**
 * Ids to hide. `userHouseholdIds` is the requesting user's membership.
 * A Fiwind numeric row drops when a named twin of the same amount exists
 * that same day in any of those households. Named copies of the same shop
 * drop the weaker source (Fiwind / later copy). The keeper stays.
 */
export function pairLogicalDuplicates(
  rows: readonly LogicalDupRow[],
  userHouseholdIds: ReadonlySet<string>,
): Set<string> {
  const sides: Side[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.id || seen.has(row.id)) continue;
    if (!userHouseholdIds.has(row.householdId)) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) continue;
    seen.add(row.id);
    const description = row.description ?? "";
    const numeric = (row.bank ?? "") === "Fiwind" && isNumericMerchant(description);
    sides.push({
      id: row.id,
      householdId: row.householdId,
      date: row.date,
      bank: row.bank ?? "",
      source: row.source ?? "",
      description,
      numeric,
      merchant: numeric ? "" : compactMerchant(description),
      ars: parseAmount(row.amountArs),
      usd: parseAmount(row.amountUsd),
      createdAt: Number(row.createdAt) || 0,
    });
  }
  if (sides.length < 2) return new Set();

  sides.sort(
    (a, b) =>
      keepScore(b) - keepScore(a) ||
      a.createdAt - b.createdAt ||
      cmpText(a.id, b.id),
  );
  const keepers: Side[] = [];
  const drop = new Set<string>();
  for (const row of sides) {
    const twin = keepers.find((kept) => sameMovement(kept, row));
    if (twin) drop.add(row.id);
    else keepers.push(row);
  }
  return drop;
}

/**
 * Same-day amount collisions across the user's households.
 * One bound (`user_id`). Named rows and Fiwind numerics both come back.
 */
export const LOGICAL_DUP_CANDIDATE_SQL = `
WITH user_households AS (
  SELECT household_id FROM household_members WHERE user_id = ?
)
SELECT
  'hh' AS kind,
  uh.household_id AS id,
  uh.household_id AS household_id,
  NULL AS date,
  NULL AS bank,
  NULL AS source,
  NULL AS description_normalized,
  NULL AS amount_ars,
  NULL AS amount_usd,
  NULL AS created_at
FROM user_households uh
UNION ALL
SELECT
  'tx',
  t.id,
  t.household_id,
  t.date,
  t.bank,
  t.source,
  t.description_normalized,
  t.amount_ars,
  t.amount_usd,
  t.created_at
FROM user_households uh
INNER JOIN transactions t ON t.household_id = uh.household_id
WHERE t.is_payment = 0
  AND t.is_credit = 0
  AND EXISTS (
    SELECT 1
    FROM user_households uh2
    INNER JOIN transactions o ON o.household_id = uh2.household_id
    WHERE o.date = t.date
      AND o.id <> t.id
      AND o.is_payment = 0
      AND o.is_credit = 0
      AND (
        (
          CAST(IFNULL(t.amount_ars, '0') AS REAL) * CAST(IFNULL(o.amount_ars, '0') AS REAL) > 0
          AND abs(
            CAST(IFNULL(t.amount_ars, '0') AS REAL) - CAST(IFNULL(o.amount_ars, '0') AS REAL)
          ) < 0.01
        )
        OR (
          CAST(IFNULL(t.amount_usd, '0') AS REAL) * CAST(IFNULL(o.amount_usd, '0') AS REAL) > 0
          AND abs(
            CAST(IFNULL(t.amount_usd, '0') AS REAL) - CAST(IFNULL(o.amount_usd, '0') AS REAL)
          ) < 0.005
        )
      )
  )
`;

export type LogicalDupCandidateRow = {
  kind: string;
  id: string;
  household_id: string;
  date: string | null;
  bank: string | null;
  source: string | null;
  description_normalized: string | null;
  amount_ars: string | number | null;
  amount_usd: string | number | null;
  created_at: string | number | null;
};

export type LogicalDupDb = {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all<T = LogicalDupCandidateRow>(): Promise<{ results?: T[] }>;
    };
  };
};

export async function loadLogicalDupIds(db: LogicalDupDb, userId: string): Promise<string[]> {
  try {
    const res = await db.prepare(LOGICAL_DUP_CANDIDATE_SQL).bind(userId).all<LogicalDupCandidateRow>();
    const allowed = new Set<string>();
    const rows: LogicalDupRow[] = [];
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
        source: row.source,
        description: row.description_normalized,
        amountArs: row.amount_ars,
        amountUsd: row.amount_usd,
        createdAt: row.created_at,
      });
    }
    return [...pairLogicalDuplicates(rows, allowed)].sort();
  } catch (err) {
    const message = err instanceof Error ? err.message : "error";
    console.error("logical dup load failed", message.slice(0, 180));
    return [];
  }
}
