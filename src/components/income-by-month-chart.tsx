"use client";

import { useEffect, useState } from "react";
import { useJsonResource } from "@/hooks/use-json-resource";
import type { Currency } from "@/lib/stats/currency";
import { formatCurrencyAmount } from "@/lib/utils";
import { Surface } from "@/components/ui";
import {
  CURRENCY_OPTIONS,
  ChoiceRow,
  MoneyBarChart,
  formatMonth,
} from "@/components/money-charts";

type IncomeMonth = {
  currency: Currency;
  total: number;
  excludedCount: number;
  rows: { month: string; count: number; total: number }[];
};

export function IncomeByMonthChart({ refreshKey = 0 }: { refreshKey?: number }) {
  const [currency, setCurrency] = useState<Currency>("ARS");
  const resource = useJsonResource<IncomeMonth>(
    `/api/income-by-month?currency=${currency}`,
    [currency, refreshKey],
    { fallbackError: "No se pudieron leer los ingresos", staleWhileReload: true },
  );
  const { reload } = resource;
  useEffect(() => {
    function onSwitch() {
      void reload();
    }
    window.addEventListener("lc:household-switched", onSwitch);
    window.addEventListener("lc:expense-created", onSwitch);
    return () => {
      window.removeEventListener("lc:household-switched", onSwitch);
      window.removeEventListener("lc:expense-created", onSwitch);
    };
  }, [reload]);

  const data = resource.data;
  return (
    <Surface className="space-y-3 !p-4">
      <div>
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--muted-fg)]">
          Ingresos por mes
        </h2>
        <p className="mt-1 text-xs text-[var(--muted-fg)]">
          Solo ingresos, una moneda por vez. Las transferencias internas no entran. ARS, USDT y USD no se suman.
        </p>
      </div>
      <ChoiceRow label="Moneda de ingresos" value={currency} options={CURRENCY_OPTIONS} onChange={setCurrency} />
      {resource.error ? <p className="text-sm text-[var(--err-text)]">{resource.error}</p> : null}
      {data ? (
        <>
          <p className="lc-amount text-[1.35rem] font-semibold">
            {formatCurrencyAmount(data.currency, data.total)}
          </p>
          {data.excludedCount > 0 ? (
            <p className="text-[13px] text-[var(--muted-fg)]">
              {data.excludedCount === 1
                ? "1 transferencia interna quedó afuera."
                : `${data.excludedCount} transferencias internas quedaron afuera.`}
            </p>
          ) : null}
          <MoneyBarChart
            currency={data.currency}
            rows={data.rows.map((row) => ({ label: formatMonth(row.month), value: row.total }))}
          />
        </>
      ) : resource.loading ? (
        <div className="space-y-2" role="status" aria-live="polite" aria-label="Cargando ingresos">
          <div className="skeleton h-7 w-32" />
          <div className="skeleton h-40 w-full" />
        </div>
      ) : (
        <p className="rounded-2xl border border-dashed border-[var(--border)] px-3 py-4 text-[15px] text-[var(--muted-fg)]">
          Todavía no hay ingresos para graficar.
        </p>
      )}
    </Surface>
  );
}
