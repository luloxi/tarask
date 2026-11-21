import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import {
  countHogarReintegroMatches,
  looksLikeHogarReintegroPayee,
  normalizeHogarReintegroKey,
} from "@/lib/reintegro-hogar";
import { reintegroPayeeGroups } from "@/lib/reintegro-hogar-server";

/** Count same-description outbound reimbursements in the household. */
export async function countHogarReintegroByMerchant(opts: {
  householdId: string;
  description: string;
  excludeTxId?: string;
  onlyUnset?: boolean;
}): Promise<number> {
  const groups = reintegroPayeeGroups();
  if (!looksLikeHogarReintegroPayee(opts.description, groups)) return 0;
  const db = (await getDb());
  const all = await db
    .select({
      id: schema.transactions.id,
      descriptionNormalized: schema.transactions.descriptionNormalized,
      isPayment: schema.transactions.isPayment,
    })
    .from(schema.transactions)
    .where(eq(schema.transactions.householdId, opts.householdId));
  return countHogarReintegroMatches(all, opts.description, groups, {
    excludeTxId: opts.excludeTxId,
    onlyUnset: opts.onlyUnset,
  });
}

/**
 * Mark matching txs as isPayment (reintegro / non-spend).
 * Does not touch ownership, categories, or Deuda fields.
 */
export async function applyHogarReintegroToSimilar(opts: {
  householdId: string;
  description: string;
  excludeTxId?: string;
}): Promise<number> {
  const groups = reintegroPayeeGroups();
  if (!looksLikeHogarReintegroPayee(opts.description, groups)) return 0;
  const db = (await getDb());
  const key = normalizeHogarReintegroKey(opts.description);
  if (!key) return 0;

  const all = await db
    .select({
      id: schema.transactions.id,
      descriptionNormalized: schema.transactions.descriptionNormalized,
      isPayment: schema.transactions.isPayment,
    })
    .from(schema.transactions)
    .where(eq(schema.transactions.householdId, opts.householdId));

  let updated = 0;
  for (const tx of all) {
    if (opts.excludeTxId && tx.id === opts.excludeTxId) continue;
    if (normalizeHogarReintegroKey(tx.descriptionNormalized) !== key) continue;
    if (tx.isPayment) continue;
    await db
      .update(schema.transactions)
      .set({ isPayment: true, updatedAt: new Date() })
      .where(eq(schema.transactions.id, tx.id));
    updated++;
  }
  return updated;
}
