"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowDownRight, ArrowUpRight, ChevronRight, Minus } from "lucide-react";
import { cn, formatArs, formatDateAr, formatPesos } from "@/lib/utils";
import {
  filterPatrimonioSeries,
  netWorthDeltas,
  sparklineNetWorths,
  usableFxRate,
  type PatrimonioPoint,
  type SeriesRange,
} from "@/lib/patrimonio";
import { SectionNav } from "@/components/section-nav";
import { Sparkline } from "@/components/sparkline";

type Current = Omit<PatrimonioPoint, "netWorthArs"> & {
  netWorthArs: number | null;
  cardStatus?: string;
  fxAvailable?: boolean;
};

type FlowPoint = {
  month: string;
  incomeArs: number;
  expenseArs: number;
  flowArs: number;
};

type Payload = {
  current: Current;
  series: PatrimonioPoint[];
  note: string;
  trustedMonths: string[];
  flujo?: FlowPoint[];
  derived?: boolean;
};

const RANGES: Array<{ id: SeriesRange; label: string }> = [
  { id: "6m", label: "6 meses" },
  { id: "1y", label: "1 año" },
  { id: "all", label: "Todo" },
];

function usePatrimonio() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/patrimonio", { credentials: "include" });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || "Error");
        if (!cancelled) setData(body);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Error de red");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { data, error };
}

/** Frase corta: sube, baja o igual, contra fin del mes pasado. */
function trendOf(data: Payload): {
  tone: "up" | "down" | "flat" | "none";
  text: string;
  delta: number | null;
} {
  const { vsPreviousMonth } = netWorthDeltas(
    data.current.date,
    data.current.netWorthArs,
    data.series,
  );
  if (!vsPreviousMonth) {
    return { tone: "none", text: "Todavía no hay un mes anterior para comparar.", delta: null };
  }
  const d = vsPreviousMonth.deltaArs;
  if (Math.abs(d) < 1) return { tone: "flat", text: "Igual que fin del mes pasado.", delta: d };
  return {
    tone: d > 0 ? "up" : "down",
    text: `${d > 0 ? "Subió" : "Bajó"} ${formatPesos(Math.abs(d))} desde el mes pasado.`,
    delta: d,
  };
}

function TrendLine({ tone, text }: { tone: "up" | "down" | "flat" | "none"; text: string }) {
  const Icon = tone === "up" ? ArrowUpRight : tone === "down" ? ArrowDownRight : Minus;
  return (
    <p
      className={cn(
        "mt-1 inline-flex items-center gap-1 text-[15px] font-medium",
        tone === "up" && "text-[var(--ok-text)]",
        tone === "down" && "text-[var(--err-text)]",
        (tone === "flat" || tone === "none") && "text-[var(--muted-fg)]",
      )}
    >
      {tone !== "none" && <Icon className="h-4 w-4 shrink-0" strokeWidth={2.2} aria-hidden />}
      {text}
    </p>
  );
}

function netText(current: Current): string {
  return current.netWorthArs == null ? "Sin cotización" : formatPesos(current.netWorthArs);
}

/** Tarjeta del Resumen: cuánto vale todo y para dónde va. */
export function PatrimonioGlance() {
  const { data, error } = usePatrimonio();

  const spark = data
    ? sparklineNetWorths(
        filterPatrimonioSeries(data.series, "6m", data.current.date),
        data.current.date,
        data.current.netWorthArs,
      )
    : [];

  if (error) {
    return <p className="text-sm text-[var(--err-text)]">{error}</p>;
  }
  if (!data) {
    return <div className="skeleton h-44 w-full !rounded-[1.5rem]" role="status" aria-label="Cargando patrimonio" />;
  }
  const trend = trendOf(data);

  return (
    <Link
      href="/patrimonio"
      className="group block rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--card-shadow)] transition active:scale-[0.99]"
      aria-label={`Tu patrimonio ${netText(data.current)}. ${trend.text}`}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="lc-eyebrow">Tu patrimonio</p>
        <ChevronRight className="h-5 w-5 text-[var(--border-strong)] transition group-hover:text-[var(--muted-fg)]" aria-hidden />
      </div>
      <p className="mt-1 text-[2rem] font-semibold leading-tight tabular-nums tracking-tight">
        {netText(data.current)}
      </p>
      <TrendLine tone={trend.tone} text={trend.text} />
      {spark.length >= 2 && (
        <div className="mt-3">
          <Sparkline values={spark} height={72} label="Cómo viene tu patrimonio en los últimos meses" />
        </div>
      )}
    </Link>
  );
}

export function PatrimonioView() {
  const { data, error } = usePatrimonio();
  const [range, setRange] = useState<SeriesRange>("all");
  const [showParts, setShowParts] = useState(true);

  const shown = useMemo(
    () => (data ? filterPatrimonioSeries(data.series, range, data.current.date) : []),
    [data, range],
  );

  if (error) {
    return <p className="text-sm text-[var(--err-text)]">{error}</p>;
  }
  if (!data) {
    return (
      <div className="space-y-4">
        <SectionNav section="patrimonio" />
        <div className="skeleton h-72 w-full !rounded-[1.5rem]" role="status" aria-label="Cargando patrimonio" />
      </div>
    );
  }

  const current = data.current;
  const fxMissing = usableFxRate(current.fxRate) == null;
  const trend = trendOf(data);

  return (
    <div className="animate-fade-up space-y-4">
      <div>
        <h1 className="text-[1.6rem] font-semibold leading-tight tracking-tight">Patrimonio</h1>
        <p className="mt-1 text-[15px] text-[var(--muted-fg)]">Lo que tenés, menos lo que debés.</p>
      </div>
      <SectionNav section="patrimonio" />

      <section className="rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--card-shadow)]">
        <p className="lc-eyebrow">Hoy</p>
        <p className="mt-1 text-[2.25rem] font-semibold leading-tight tabular-nums tracking-tight">
          {netText(current)}
        </p>
        <TrendLine tone={trend.tone} text={trend.text} />

        <div className="mt-4 flex gap-2" role="group" aria-label="Período del gráfico">
          {RANGES.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setRange(item.id)}
              className="lc-chip"
              data-active={range === item.id}
              aria-pressed={range === item.id}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="mt-3">
          {shown.length >= 2 ? (
            <PatrimonioChart points={shown} showParts={showParts} />
          ) : (
            <p className="rounded-2xl border border-dashed border-[var(--border)] px-3 py-4 text-sm text-[var(--muted-fg)]">
              {data.note} Con un solo punto no hay línea todavía.
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={() => setShowParts((v) => !v)}
          aria-pressed={showParts}
          className="lc-btn lc-btn-secondary mt-3 !min-h-11 w-full"
        >
          {showParts ? "Solo patrimonio" : "Ver ahorros y deuda"}
        </button>
      </section>

      <section className="grid grid-cols-2 gap-3">
        <Metric label="Ahorros" value={assetsText(current)} href="/ahorros" />
        <Metric label="Deuda" value={debtText(current)} href="/deuda" />
      </section>

      <FlujoSection points={data.flujo ?? []} />

      <details className="rounded-[1.25rem] border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-sm text-[var(--muted-fg)] shadow-[var(--card-shadow)]">
        <summary className="flex min-h-10 cursor-pointer items-center font-semibold text-[var(--foreground)]">
          Cómo se calcula
        </summary>
        <div className="space-y-2 pb-1 pt-1">
          <p>Ahorros menos deuda, en pesos y dólares, al dólar blue.</p>
          {shown.length >= 2 && <p>{data.note}</p>}
          {fxMissing && <p>Sin cotización blue. No valuamos los dólares en 0.</p>}
          {current.cardStatus === "sin_tarjeta_activa" && <p>Sin tarjeta activa.</p>}
          {data.derived && (
            <p>
              La deuda histórica es el total de cada resumen Visa (cargos menos pagos de ese archivo). No hay saldo de cierre en D1. No inventamos números.
            </p>
          )}
          {!data.derived && data.trustedMonths.length === 0 && (
            <p>
              No hay meses anteriores confiables. El extracto de la tarjeta está incompleto, así que no estimamos deuda vieja.
            </p>
          )}
        </div>
      </details>
    </div>
  );
}

function assetsText(current: Current): string {
  if (current.assetsUsd > 0 && usableFxRate(current.fxRate) == null) return "Sin cotización";
  return formatPesos(current.assetsArs);
}

function debtText(current: Current): string {
  if (current.debtUsd > 0 && usableFxRate(current.fxRate) == null) return "Sin cotización";
  const rate = usableFxRate(current.fxRate) ?? 0;
  const total = current.debtArs + current.debtUsd * rate;
  if (total === 0 && current.debtUsd === 0) return "Sin deuda";
  return formatPesos(total);
}

function Metric({ label, value, href }: { label: string; value: string; href: string }) {
  return (
    <Link
      href={href}
      className="group block min-w-0 rounded-[1.25rem] border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--card-shadow)] transition active:scale-[0.99]"
    >
      <p className="lc-eyebrow flex items-center justify-between">
        {label}
        <ChevronRight className="h-4 w-4 text-[var(--border-strong)]" aria-hidden />
      </p>
      <p className="mt-1 truncate text-lg font-semibold tabular-nums">{value}</p>
    </Link>
  );
}

function PatrimonioChart({ points, showParts }: { points: PatrimonioPoint[]; showParts: boolean }) {
  const width = 360;
  const height = 190;
  const pad = { top: 12, right: 8, bottom: 24, left: 8 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const values = showParts
    ? points.flatMap((point) => [point.assetsArs, debtLine(point), point.netWorthArs])
    : points.map((point) => point.netWorthArs);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const span = max - min;
  min -= span * 0.08;
  max += span * 0.08;
  const x = (index: number) =>
    pad.left + (points.length === 1 ? innerW / 2 : (index / (points.length - 1)) * innerW);
  const y = (value: number) => pad.top + innerH - ((value - min) / (max - min)) * innerH;
  const d = (pick: (point: PatrimonioPoint) => number) =>
    points
      .map((point, index) => `${index === 0 ? "M" : "L"} ${x(index).toFixed(1)} ${y(pick(point)).toFixed(1)}`)
      .join(" ");
  const debtFromTotals = points.some((point) => point.debtKind === "statement_total");
  const netPath = d((point) => point.netWorthArs);
  const last = points.length - 1;

  return (
    <div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-auto w-full"
        role="img"
        aria-label="Evolución del patrimonio"
      >
        <defs>
          <linearGradient id="pat-area" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-1)" stopOpacity="0.25" />
            <stop offset="100%" stopColor="var(--chart-1)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {showParts && (
          <>
            <path
              d={d((point) => point.assetsArs)}
              fill="none"
              stroke="var(--chart-3)"
              strokeWidth="2"
              strokeLinecap="round"
            />
            <path
              d={d((point) => debtLine(point))}
              fill="none"
              stroke="var(--chart-err)"
              strokeWidth="2"
              strokeDasharray={debtFromTotals ? "4 3" : undefined}
              strokeLinecap="round"
            />
          </>
        )}
        {!showParts && (
          <path
            d={`${netPath} L ${x(last).toFixed(1)} ${height - pad.bottom} L ${x(0).toFixed(1)} ${height - pad.bottom} Z`}
            fill="url(#pat-area)"
          />
        )}
        <path
          d={netPath}
          fill="none"
          stroke="var(--chart-1)"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="lc-spark-line"
        />
        <circle cx={x(last)} cy={y(points[last]!.netWorthArs)} r="4.5" fill="var(--chart-1)" className="lc-spark-dot" />
        <text x={pad.left} y={height - 6} fill="var(--chart-axis)" fontSize={11}>
          {formatDateAr(points[0]!.date)}
        </text>
        <text x={width - pad.right} y={height - 6} textAnchor="end" fill="var(--chart-axis)" fontSize={11}>
          {formatDateAr(points[last]!.date)}
        </text>
      </svg>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-[var(--muted-fg)]">
        <Legend color="var(--chart-1)" label="Patrimonio" />
        {showParts && <Legend color="var(--chart-3)" label="Ahorros" />}
        {showParts && (
          <Legend
            color="var(--chart-err)"
            label={debtFromTotals ? "Deuda (total de cada resumen)" : "Deuda"}
          />
        )}
        {debtFromTotals && <span>Punteada: no es saldo de cierre</span>}
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} aria-hidden />
      {label}
    </span>
  );
}

function debtLine(point: PatrimonioPoint): number {
  const rate = usableFxRate(point.fxRate) ?? 0;
  return point.debtArs + point.debtUsd * rate;
}

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

function monthLabel(period: string): string {
  const [year, month] = period.split("-");
  const name = MONTHS[Number(month) - 1] ?? month;
  return `${name} ${year?.slice(2) ?? ""}`;
}

function FlujoSection({ points }: { points: FlowPoint[] }) {
  return (
    <section className="space-y-2 rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--card-shadow)]">
      <div>
        <h2 className="text-base font-semibold tracking-tight">Lo que te queda cada mes</h2>
        <p className="text-[13px] text-[var(--muted-fg)]">
          Ingresos menos gastos. Es plata que entra y sale, no es patrimonio.
        </p>
      </div>
      {points.length === 0 ? (
        <p className="text-sm text-[var(--muted-fg)]">Todavía no hay un espacio activo para el flujo.</p>
      ) : (
        <FlowChart points={points} />
      )}
    </section>
  );
}

function FlowChart({ points }: { points: FlowPoint[] }) {
  const width = 360;
  const height = 140;
  const pad = { top: 8, right: 4, bottom: 22, left: 4 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  let min = Math.min(0, ...points.map((point) => point.flowArs));
  let max = Math.max(0, ...points.map((point) => point.flowArs));
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const span = max - min;
  const y = (value: number) => pad.top + innerH - ((value - min) / span) * innerH;
  const zero = y(0);
  const slot = innerW / points.length;
  const barW = Math.max(2, slot * 0.62);

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" role="img" aria-label="Ingresos menos gastos, mes a mes">
        <line x1={pad.left} x2={width - pad.right} y1={zero} y2={zero} stroke="var(--border-strong)" strokeWidth="1" />
        {points.map((point, index) => {
          const x = pad.left + index * slot + (slot - barW) / 2;
          const top = y(Math.max(point.flowArs, 0));
          const bottom = y(Math.min(point.flowArs, 0));
          return (
            <rect
              key={point.month}
              x={x}
              y={top}
              width={barW}
              height={Math.max(1, bottom - top)}
              rx={Math.min(3, barW / 2)}
              fill={point.flowArs >= 0 ? "var(--chart-3)" : "var(--chart-err)"}
            >
              <title>{`${monthLabel(point.month)}: ${formatArs(point.flowArs)}`}</title>
            </rect>
          );
        })}
        <text x={pad.left} y={height - 6} fill="var(--chart-axis)" fontSize={11}>
          {monthLabel(points[0]!.month)}
        </text>
        <text x={width - pad.right} y={height - 6} textAnchor="end" fill="var(--chart-axis)" fontSize={11}>
          {monthLabel(points[points.length - 1]!.month)}
        </text>
      </svg>
    </div>
  );
}
