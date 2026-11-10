"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useJsonResource } from "@/hooks/use-json-resource";
import type { Currency } from "@/lib/stats/currency";
import { formatCurrencyAmount } from "@/lib/utils";
import { CURRENCY_OPTIONS, ChoiceRow, Legend, PieChart } from "@/components/money-charts";

type Spending = {
  currency: Currency;
  total: number;
  rows: { category: string; slug: string; count: number; total: number }[];
  internal: { count: number; total: number };
};

export function NinetyDaySpend() {
  const [currency, setCurrency] = useState<Currency>("ARS");
  const resource = useJsonResource<Spending>(
    `/api/spending-by-category?days=90&currency=${currency}`,
    [currency],
    { fallbackError: "No se pudo leer el gasto", staleWhileReload: true },
  );
  const { reload } = resource;
  useEffect(() => {
    function onSwitch() {
      void reload();
    }
    window.addEventListener("lc:household-switched", onSwitch);
    return () => window.removeEventListener("lc:household-switched", onSwitch);
  }, [reload]);

  const data = resource.data;
  return (
    <section className="rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--card-shadow)]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold">Últimos 90 días</h2>
          <p className="mt-0.5 text-[13px] leading-snug text-[var(--muted-fg)]">
            Gastos por categoría. Una moneda por vez. Las transferencias internas no entran.
          </p>
        </div>
        <Link
          href="/consumos?tab=charts"
          className="shrink-0 whitespace-nowrap pt-0.5 text-[13px] font-medium text-[var(--brand-fg)]"
        >
          Ver evolución
        </Link>
      </div>
      <div className="mt-3">
        <ChoiceRow label="Moneda" value={currency} options={CURRENCY_OPTIONS} onChange={setCurrency} />
      </div>
      {resource.loading && !data ? (
        <div className="mt-4 space-y-3" role="status" aria-live="polite" aria-label="Cargando gastos">
          <div className="skeleton h-7 w-36" />
          <div className="skeleton mx-auto h-40 w-40 !rounded-full" />
          <div className="skeleton h-4 w-3/4" />
        </div>
      ) : null}
      {resource.error ? (
        <p className="mt-4 text-[15px] text-[var(--err-text)]">{resource.error}</p>
      ) : null}
      {data ? (
        data.rows.some((row) => row.total > 0) ? (
          <div className="mt-4 space-y-3">
            <p className="lc-amount text-[1.4rem] font-semibold tracking-tight">
              {formatCurrencyAmount(data.currency, data.total)}
            </p>
            <PieChart slices={data.rows.map((row) => ({ label: row.category, value: row.total }))} />
            <Legend items={data.rows.filter((row) => row.total > 0).map((row) => ({ name: row.category }))} />
            {data.internal.count > 0 ? (
              <p className="text-[13px] text-[var(--muted-fg)]">
                Transferencias internas: {formatCurrencyAmount(data.currency, data.internal.total)}. No entran en el total.
              </p>
            ) : null}
          </div>
        ) : (
          <p className="mt-4 rounded-2xl border border-dashed border-[var(--border)] px-3 py-4 text-[15px] leading-snug text-[var(--muted-fg)]">
            Todavía no hay gastos en 90 días. Cuando importes o cargues movimientos, acá se arma el recorte por categoría.
          </p>
        )
      ) : null}
    </section>
  );
}
