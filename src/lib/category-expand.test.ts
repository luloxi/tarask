import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  categoryExpandMismatches,
  expenseAmountParts,
  groupTxsByCategorySlug,
} from "./category-expand";
import { displayCategoryName } from "./category-label";

describe("displayCategoryName", () => {
  it("muestra Sin categoría para Uncategorized, slug o nombre vacío", () => {
    assert.equal(displayCategoryName("Uncategorized", "uncategorized"), "Sin categoría");
    assert.equal(displayCategoryName("uncategorized", "kiosco"), "Sin categoría");
    assert.equal(displayCategoryName("Jardinería", "uncategorized"), "Sin categoría");
    assert.equal(displayCategoryName(null, null), "Sin categoría");
    assert.equal(displayCategoryName("", "comida"), "Sin categoría");
    assert.equal(displayCategoryName("Jardinería", "jardineria"), "Jardinería");
  });
});

describe("categoryExpandMismatches", () => {
  const jardineria = [
    { date: "2026-10-27", amountArs: 2500, amountUsd: null, category: { slug: "jardineria" } },
    { date: "2026-10-10", amountArs: 120000, amountUsd: null, category: { slug: "jardineria" } },
    { date: "2026-10-05", amountArs: 80000, amountUsd: null, category: { slug: "jardineria" } },
    { date: "2026-10-02", amountArs: 87300, amountUsd: null, category: { slug: "jardineria" } },
  ];
  const uncat = [
    { date: "2026-10-12", amountArs: 100, amountUsd: null, category: { slug: "uncategorized" } },
    { date: "2026-10-08", amountArs: 200, amountUsd: null, category: null },
    { date: "2026-10-01", amountArs: null, amountUsd: 10, category: { slug: "uncategorized" } },
  ];

  it("count y suma coinciden con el agregado cuando está la lista completa", () => {
    const groups = groupTxsByCategorySlug([...jardineria, ...uncat]);
    assert.equal(groups.get("jardineria")?.length, 4);
    assert.equal(groups.get("uncategorized")?.length, 3);
    const mismatches = categoryExpandMismatches(
      [
        { slug: "jardineria", count: 4, amountArs: 289800, amountUsd: 0 },
        { slug: "uncategorized", count: 3, amountArs: 300, amountUsd: 10 },
      ],
      groups,
    );
    assert.deepEqual(mismatches, []);
  });

  it("detecta el recorte de una página (solo los primeros movimientos)", () => {
    const page = [...jardineria, ...uncat]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 2);
    const groups = groupTxsByCategorySlug(page);
    const mismatches = categoryExpandMismatches(
      [
        { slug: "jardineria", count: 4, amountArs: 289800, amountUsd: 0 },
        { slug: "uncategorized", count: 3, amountArs: 300, amountUsd: 10 },
      ],
      groups,
    );
    assert.equal(mismatches.length >= 2, true);
    assert.equal(mismatches.some((m) => m.slug === "jardineria" && m.actualCount < 4), true);
    assert.equal(mismatches.some((m) => m.slug === "uncategorized"), true);
  });

  it("si un movimiento tiene pesos y dólares, los pesos no se suman (misma regla que el agregado)", () => {
    assert.deepEqual(expenseAmountParts({ amountArs: 100, amountUsd: 5 }), { ars: 0, usd: 5 });
    assert.deepEqual(expenseAmountParts({ amountArs: 100, amountUsd: null }), { ars: 100, usd: 0 });
  });
});
