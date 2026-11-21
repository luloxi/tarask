/** Label shown in Movimientos / Por mes. "Uncategorized" is always "Sin categoría". */
export function displayCategoryName(
  name?: string | null,
  slug?: string | null,
): string {
  const s = (slug ?? "").trim().toLowerCase();
  const n = (name ?? "").trim();
  if (!n || s === "uncategorized" || n.toLowerCase() === "uncategorized") {
    return "Sin categoría";
  }
  return n;
}

export function categorySlugOf(tx: {
  category?: { slug?: string | null } | null;
}): string {
  return tx.category?.slug || "uncategorized";
}
