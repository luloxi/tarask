import { categorySlugOf } from "./category-label";

/** Same rule as ARS_EXPR / USD_EXPR in worker/sql.ts */
export function expenseAmountParts(t: {
  amountArs: number | null;
  amountUsd: number | null;
}): { ars: number; usd: number } {
  const ars =
    t.amountArs != null && Number.isFinite(t.amountArs) ? Math.abs(t.amountArs) : 0;
  const usd =
    t.amountUsd != null && Number.isFinite(t.amountUsd) ? Math.abs(t.amountUsd) : 0;
  return { ars: ars > 0 && usd > 0 ? 0 : ars, usd };
}

export function groupTxsByCategorySlug<
  T extends {
    category?: { slug?: string | null } | null;
    date?: string;
  },
>(txs: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const t of txs) {
    const slug = categorySlugOf(t);
    const list = map.get(slug) ?? [];
    list.push(t);
    map.set(slug, list);
  }
  for (const list of map.values()) {
    list.sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")));
  }
  return map;
}

export type CategoryTotal = {
  slug: string;
  count: number;
  amountArs: number;
  amountUsd: number;
};

export type CategoryExpandMismatch = {
  slug: string;
  expectedCount: number;
  actualCount: number;
  expectedArs: number;
  actualArs: number;
  expectedUsd: number;
  actualUsd: number;
};

function sumsOf(
  list: Array<{ amountArs: number | null; amountUsd: number | null }>,
): { ars: number; usd: number } {
  return list.reduce(
    (acc, t) => {
      const p = expenseAmountParts(t);
      acc.ars += p.ars;
      acc.usd += p.usd;
      return acc;
    },
    { ars: 0, usd: 0 },
  );
}

/** True when every category total matches the expanded list (count and sums). */
export function categoryExpandMismatches(
  categories: CategoryTotal[],
  groups: Map<string, Array<{ amountArs: number | null; amountUsd: number | null }>>,
): CategoryExpandMismatch[] {
  const mismatches: CategoryExpandMismatch[] = [];
  const seen = new Set<string>();
  for (const c of categories) {
    seen.add(c.slug);
    const list = groups.get(c.slug) ?? [];
    const sums = sumsOf(list);
    if (
      list.length !== c.count ||
      Math.abs(sums.ars - c.amountArs) > 0.009 ||
      Math.abs(sums.usd - c.amountUsd) > 0.009
    ) {
      mismatches.push({
        slug: c.slug,
        expectedCount: c.count,
        actualCount: list.length,
        expectedArs: c.amountArs,
        actualArs: sums.ars,
        expectedUsd: c.amountUsd,
        actualUsd: sums.usd,
      });
    }
  }
  for (const [slug, list] of groups) {
    if (seen.has(slug) || list.length === 0) continue;
    const sums = sumsOf(list);
    mismatches.push({
      slug,
      expectedCount: 0,
      actualCount: list.length,
      expectedArs: 0,
      actualArs: sums.ars,
      expectedUsd: 0,
      actualUsd: sums.usd,
    });
  }
  return mismatches;
}
