"use client";

import { useEffect, useState } from "react";
import { useJsonResource } from "@/hooks/use-json-resource";
import type { Currency, Granularity } from "@/lib/stats/currency";
import { formatCurrencyAmount } from "@/lib/utils";
import { Surface } from "@/components/ui";
import {
  CURRENCY_OPTIONS,
  ChoiceRow,
  Legend,
  MoneyLineChart,
  PieChart,
  chartFill,
  formatBucket,
} from "@/components/money-charts";

type Ownership = "all" | "personal" | "shared";

type Spending = {
  currency: Currency;
  total: number;
  rows: { category: string; slug: string; count: number; total: number }[];
  internal: { count: number; total: number };
};

type Series = {
  currency: Currency;
  granularity: Granularity;
  rows: { bucket: string; count: number; total: number }[];
};

const GRANULARITY: Array<{ id: Granularity; label: string; note: string }> = [
  { id: "day", label: "Día", note: "Últimos 90 días, un punto por día con gasto." },
  { id: "week", label: "Semana", note: "Últimas 26 semanas. Cada semana empieza el lunes." },
  { id: "month", label: "Mes", note: "Últimos 24 meses." },
  {
    id: "all",
    label: "Todo",
    note: "Un punto por mes desde el primer gasto. No es un acumulado.",
  },
];

export function GastoInsights({ ownership }: { ownership: Ownership }) {
  const [currency, setCurrency] = useState<Currency>("ARS");
  const [granularity, setGranularity] = useState<Granularity>("month");
  const spend = useJsonResource<Spending>(
    `/api/spending-by-category?days=90&currency=${currency}&ownership=${ownership}`,
    [currency, ownership],
    { fallbackError: "No se pudo leer el gasto", staleWhileReload: true },
  );
  const series = useJsonResource<Series>(
    `/api/spending-series?granularity=${granularity}&currency=${currency}&ownership=${ownership}`,
    [currency, granularity, ownership],
    { fallbackError: "No se pudo leer la evolución", staleWhileReload: true },
  );
  const reloadSpend = spend.reload;
  const reloadSeries = series.reload;
  useEffect(() => {
    function onSwitch() {
      void reloadSpend();
      void reloadSeries();
    }
    window.addEventListener("lc:household-switched", onSwitch);
    return () => window.removeEventListener("lc:household-switched", onSwitch);
  }, [reloadSpend, reloadSeries]);

  const note = GRANULARITY.find((item) => item.id === granularity)?.note;

  return (
    <div className="space-y-4">
      <ChoiceRow label="Moneda" value={currency} options={CURRENCY_OPTIONS} onChange={setCurrency} />
      <Surface className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold tracking-tight">Últimos 90 días</h3>
          <p className="mt-1 text-xs text-[var(--muted-fg)]">
            Solo gastos, en {currency}. El día 90 entra y el 91 no. Las transferencias internas van aparte.
          </p>
        </div>
        {spend.error ? <p className="text-sm text-[var(--err-text)]">{spend.error}</p> : null}
        {spend.loading && !spend.data ? (
          <p className="text-sm text-[var(--muted-fg)]">Cargando…</p>
        ) : spend.data && spend.data.rows.some((row) => row.total > 0) ? (
          <>
            <p className="text-[1.35rem] font-semibold tabular-nums">
              {formatCurrencyAmount(spend.data.currency, spend.data.total)}
            </p>
            <div className="grid items-center gap-4 sm:grid-cols-[220px_1fr]">
              <PieChart slices={spend.data.rows.map((row) => ({ label: row.category, value: row.total }))} />
              <CategoryList rows={spend.data.rows} currency={spend.data.currency} />
            </div>
            <Legend items={spend.data.rows.filter((row) => row.total > 0).map((row) => ({ name: row.category }))} />
            {spend.data.internal.count > 0 ? (
              <p className="text-[13px] text-[var(--muted-fg)]">
                Transferencias internas: {formatCurrencyAmount(spend.data.currency, spend.data.internal.total)} (
                {spend.data.internal.count}). No entran en el total.
              </p>
            ) : null}
          </>
        ) : !spend.error ? (
          <InsightsEmpty
            title="Todavía no hay gastos en 90 días"
            description={`Cuando importes o cargues movimientos, acá se arma el recorte por categoría en ${currency}.`}
          />
        ) : null}
      </Surface>
      <Surface className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold tracking-tight">Evolución del gasto</h3>
          <p className="mt-1 text-xs text-[var(--muted-fg)]">{note}</p>
        </div>
        <ChoiceRow
          label="Granularidad"
          value={granularity}
          options={GRANULARITY.map((item) => ({ id: item.id, label: item.label }))}
          onChange={setGranularity}
        />
        {series.error ? <p className="text-sm text-[var(--err-text)]">{series.error}</p> : null}
        {series.loading && !series.data ? (
          <p className="text-sm text-[var(--muted-fg)]">Cargando…</p>
        ) : series.data && series.data.rows.length > 0 ? (
          <>
            <MoneyLineChart
              ariaLabel="Evolución del gasto"
              currency={series.data.currency}
              series={[
                {
                  name: series.data.currency,
                  points: series.data.rows.map((row) => ({ x: row.bucket, y: row.total })),
                },
              ]}
            />
            <SeriesTable rows={series.data.rows} currency={series.data.currency} granularity={series.data.granularity} />
          </>
        ) : !series.error ? (
          <InsightsEmpty
            title="Todavía no hay curva de gasto"
            description={`No hay movimientos en ${currency} para esta vista. Cambiá la moneda o la granularidad, o cargá un resumen.`}
          />
        ) : null}
      </Surface>
    </div>
  );
}

function InsightsEmpty({ title, description }: { title: string; description: string }) {
  return (
    <p className="rounded-2xl border border-dashed border-[var(--border)] px-3 py-4 text-[15px] leading-snug text-[var(--muted-fg)]">
      <span className="block font-semibold text-[var(--foreground)]">{title}</span>
      <span className="mt-1 block">{description}</span>
    </p>
  );
}

function CategoryList({
  rows,
  currency,
}: {
  rows: Spending["rows"];
  currency: Currency;
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-[var(--muted-fg)]">No hay gastos en {currency} en esta ventana.</p>;
  }
  return (
    <ul className="divide-y divide-[var(--border)]">
      {rows.map((row, index) => (
        <li key={`${row.slug}-${row.category}`} className="flex items-center gap-2 py-2 text-[15px]">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: chartFill(index) }} />
          <span className="min-w-0 flex-1 truncate">{row.category}</span>
          <span className="shrink-0 tabular-nums text-[var(--muted-fg)]">{row.count}</span>
          <span className="shrink-0 font-medium tabular-nums">{formatCurrencyAmount(currency, row.total)}</span>
        </li>
      ))}
    </ul>
  );
}

function SeriesTable({
  rows,
  currency,
  granularity,
}: {
  rows: Series["rows"];
  currency: Currency;
  granularity: Granularity;
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-[var(--muted-fg)]">No hay gastos en {currency} para esta vista.</p>;
  }
  const shown = [...rows].reverse();
  return (
    <div className="max-h-64 overflow-y-auto">
      <table className="w-full text-left text-[14px]">
        <caption className="sr-only">Serie de gasto</caption>
        <thead className="text-[12px] uppercase tracking-wide text-[var(--muted-fg)]">
          <tr>
            <th className="py-1 font-medium">Período</th>
            <th className="py-1 text-right font-medium">Cantidad</th>
            <th className="py-1 text-right font-medium">Total</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((row) => (
            <tr key={row.bucket} className="border-t border-[var(--border)]">
              <td className="py-1.5">{formatBucket(row.bucket, granularity)}</td>
              <td className="py-1.5 text-right tabular-nums">{row.count}</td>
              <td className="py-1.5 text-right font-medium tabular-nums">
                {formatCurrencyAmount(currency, row.total)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
