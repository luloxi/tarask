import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { getCategoryMap } from "@/lib/household";
import {
  countGastoCubiertoMatches,
  isHogarUtilityCategory,
  normalizeGastoCubiertoKey,
} from "@/lib/gasto-cubierto";

/** Count same-merchant utility bills in the household (for bulk toast). */
export async function countGastoCubiertoByMerchant(opts: {
  householdId: string;
  description: string;
  excludeTxId?: string;
  onlyUnset?: boolean;
}): Promise<number> {
  const key = normalizeGastoCubiertoKey(opts.description);
  if (!key) return 0;
  const db = (await getDb());
  const { byId } = await getCategoryMap();
  const all = await db
    .select({
      id: schema.transactions.id,
      descriptionNormalized: schema.transactions.descriptionNormalized,
      isPayment: schema.transactions.isPayment,
      categoryId: schema.transactions.categoryId,
    })
    .from(schema.transactions)
    .where(eq(schema.transactions.householdId, opts.householdId));

  return countGastoCubiertoMatches(
    all.map((tx) => {
      const cat = tx.categoryId ? byId.get(tx.categoryId) : null;
      return {
        id: tx.id,
        descriptionNormalized: tx.descriptionNormalized,
        isPayment: tx.isPayment,
        categorySlug: cat?.slug ?? null,
        categoryName: cat?.name ?? null,
      };
    }),
    opts.description,
    {
      excludeTxId: opts.excludeTxId,
      onlyUnset: opts.onlyUnset,
    },
  );
}

/**
 * Mark matching utility bills as isPayment (cubierto / out of neta).
 * Does not touch ownership, categories, or Deuda fields.
 */
export async function applyGastoCubiertoToSimilar(opts: {
  householdId: string;
  description: string;
  excludeTxId?: string;
}): Promise<number> {
  const key = normalizeGastoCubiertoKey(opts.description);
  if (!key) return 0;
  const db = (await getDb());
  const { byId } = await getCategoryMap();
  const all = await db
    .select({
      id: schema.transactions.id,
      descriptionNormalized: schema.transactions.descriptionNormalized,
      isPayment: schema.transactions.isPayment,
      categoryId: schema.transactions.categoryId,
    })
    .from(schema.transactions)
    .where(eq(schema.transactions.householdId, opts.householdId));

  let updated = 0;
  for (const tx of all) {
    if (opts.excludeTxId && tx.id === opts.excludeTxId) continue;
    if (normalizeGastoCubiertoKey(tx.descriptionNormalized) !== key) continue;
    if (tx.isPayment) continue;
    const cat = tx.categoryId ? byId.get(tx.categoryId) : null;
    if (
      !isHogarUtilityCategory({
        slug: cat?.slug ?? null,
        name: cat?.name ?? null,
      })
    ) {
      continue;
    }
    await db
      .update(schema.transactions)
      .set({ isPayment: true, updatedAt: new Date() })
      .where(eq(schema.transactions.id, tx.id));
    updated++;
  }
  return updated;
}
