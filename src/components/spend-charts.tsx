"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { formatArs } from "@/lib/utils";
import { formatPeriodShort } from "@/lib/period-label";
import { colorForCategory, tint } from "@/lib/category-colors";

type TotalPoint = { period: string; amountArs: number };
type CatSeries = {
  slug: string;
  name: string;
  series: Array<{ period: string; amountArs: number }>;
  totalArs: number;
};

type Dims = { W: number; H: number; PAD: { top: number; right: number; bottom: number; left: number } };

function dimsFor(width: number): Dims {
  const W = Math.max(280, Math.round(width));
  const narrow = W < 520;
  return {
    W,
    H: narrow ? 240 : 260,
    PAD: { top: 20, right: narrow ? 22 : 24, bottom: 34, left: narrow ? 44 : 56 },
  };
}

/** Mide el ancho real del contenedor: el SVG se dibuja a 1:1 y el texto queda a tamaño legible (no escalado). */
function useChartDims() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth || 720);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, ...dimsFor(width) };
}

const AXIS_FONT = 11;

/** Chart ceiling: 10% above the tallest data point (not a large "nice" round). */
function chartMax(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 1;
  return v * 1.1;
}

function scaleX(i: number, n: number, width: number, PAD: Dims["PAD"]) {
  if (n <= 1) return PAD.left + width / 2;
  return PAD.left + (i / (n - 1)) * width;
}

function scaleY(v: number, max: number, height: number, PAD: Dims["PAD"]) {
  return PAD.top + height - (v / max) * height;
}

function linePath(
  points: Array<{ x: number; y: number }>,
): string {
  if (points.length === 0) return "";
  return points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(" ");
}

export function TotalSpendChart({
  totals,
  ariaLabel = "Evolución del gasto total por mes",
  gradientPrefix = "total",
}: {
  totals: TotalPoint[];
  ariaLabel?: string;
  /** Unique SVG gradient id prefix when multiple charts share a page. */
  gradientPrefix?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const { ref, W, H, PAD } = useChartDims();
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;
  const fillId = `${gradientPrefix}Fill`;
  const strokeId = `${gradientPrefix}Stroke`;

  const max = useMemo(
    () => chartMax(Math.max(...totals.map((t) => t.amountArs), 0)),
    [totals],
  );

  if (totals.length === 0) {
    return (
      <div ref={ref}>
        <p className="text-sm text-[var(--muted)]">Sin datos para graficar.</p>
      </div>
    );
  }

  const points = totals.map((t, i) => ({
    ...t,
    x: scaleX(i, totals.length, chartW, PAD),
    y: scaleY(t.amountArs, max, chartH, PAD),
  }));
  const labelStep = Math.max(1, Math.ceil(totals.length / (W < 520 ? 5 : 8)));

  const gridYs = [0, 0.25, 0.5, 0.75, 1].map((f) => ({
    y: PAD.top + chartH * (1 - f),
    label: max * f,
  }));

  return (
    <div className="relative" ref={ref}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block h-auto w-full" width={W} height={H}
        role="img"
        aria-label={ariaLabel}
      >
        {gridYs.map((g) => (
          <g key={g.y}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={g.y}
              y2={g.y}
              stroke="var(--chart-grid)"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 8}
              y={g.y + 4}
              textAnchor="end"
              fill="var(--chart-axis)"
              fontSize={AXIS_FONT}
            >
              {g.label >= 1_000_000
                ? `${(g.label / 1_000_000).toFixed(1)}M`
                : g.label >= 1000
                  ? `${Math.round(g.label / 1000)}k`
                  : Math.round(g.label)}
            </text>
          </g>
        ))}

        <defs>
          <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-1)" stopOpacity="0.4" />
            <stop offset="100%" stopColor="var(--chart-1)" stopOpacity="0" />
          </linearGradient>
          <linearGradient id={strokeId} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--chart-1)" />
            <stop offset="100%" stopColor="var(--chart-1)" />
          </linearGradient>
        </defs>
        <path
          d={`${linePath(points)} L ${points[points.length - 1]!.x} ${PAD.top + chartH} L ${points[0]!.x} ${PAD.top + chartH} Z`}
          fill={`url(#${fillId})`}
        />
        <path
          d={linePath(points)}
          fill="none"
          stroke={`url(#${strokeId})`}
          strokeWidth={2.75}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {points.map((p, i) => (
          <g key={p.period}>
            <circle
              cx={p.x}
              cy={p.y}
              r={hover === i ? 5.5 : 3.5}
              fill="var(--chart-1)"
              stroke="var(--surface)"
              strokeWidth={2}
              className="cursor-pointer"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            />
            {/* wider hit area */}
            <circle
              cx={p.x}
              cy={p.y}
              r={14}
              fill="transparent"
              className="cursor-pointer"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            />
            {i % labelStep === 0 ? (
              <text
                x={p.x}
                y={H - 10}
                textAnchor="middle"
                fill="var(--chart-axis)"
                fontSize={AXIS_FONT}
              >
                {formatPeriodShort(p.period)}
              </text>
            ) : null}
          </g>
        ))}

        {hover != null && points[hover] && (
          <g>
            <line
              x1={points[hover].x}
              x2={points[hover].x}
              y1={PAD.top}
              y2={PAD.top + chartH}
              stroke="var(--chart-1)"
              strokeDasharray="4 3"
              opacity={0.6}
            />
            <rect
              x={Math.min(points[hover].x + 8, W - 158)}
              y={Math.max(points[hover].y - 36, 4)}
              width={150}
              height={32}
              rx={6}
              fill="var(--chart-tip-bg)"
              stroke="var(--chart-tip-border)"
              strokeWidth={1}
            />
            <text
              x={Math.min(points[hover].x + 16, W - 150)}
              y={Math.max(points[hover].y - 16, 24)}
              fill="var(--chart-tip-fg)"
              fontSize={12}
              fontWeight={600}
            >
              {formatPeriodShort(points[hover].period)} ·{" "}
              {formatArs(points[hover].amountArs)}
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}

export function CategoryLinesChart({
  periods,
  byCategory,
}: {
  periods: string[];
  byCategory: CatSeries[];
}) {
  // Show top categories by default; rest off until toggled
  const topSlugs = useMemo(
    () => byCategory.slice(0, 6).map((c) => c.slug),
    [byCategory],
  );
  const [enabled, setEnabled] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const c of byCategory) {
      init[c.slug] = topSlugs.includes(c.slug);
    }
    return init;
  });
  const [hover, setHover] = useState<{
    i: number;
    items: Array<{ slug: string; name: string; amount: number; color: string }>;
  } | null>(null);

  const { ref, W, H, PAD } = useChartDims();
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  const active = byCategory.filter((c) => enabled[c.slug]);
  const max = useMemo(() => {
    let m = 0;
    for (const c of active) {
      for (const p of c.series) m = Math.max(m, p.amountArs);
    }
    return chartMax(m);
  }, [active]);

  if (periods.length === 0 || byCategory.length === 0) {
    return (
      <div ref={ref}>
        <p className="text-sm text-[var(--muted)]">Sin categorías para graficar.</p>
      </div>
    );
  }

  const gridYs = [0, 0.25, 0.5, 0.75, 1].map((f) => ({
    y: PAD.top + chartH * (1 - f),
    label: max * f,
  }));

  function toggle(slug: string) {
    setEnabled((prev) => ({ ...prev, [slug]: !prev[slug] }));
  }

  function onHoverIndex(i: number | null) {
    if (i == null) {
      setHover(null);
      return;
    }
    const items = active
      .map((c) => {
        const amount = c.series[i]?.amountArs ?? 0;
        return {
          slug: c.slug,
          name: c.name,
          amount,
          color: colorForCategory(c.slug),
        };
      })
      .filter((x) => x.amount > 0)
      .sort((a, b) => b.amount - a.amount);
    setHover({ i, items });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {byCategory.map((c) => {
          const on = enabled[c.slug];
          const color = colorForCategory(c.slug);
          return (
            <button
              key={c.slug}
              type="button"
              onClick={() => toggle(c.slug)}
              className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-[13px] transition md:min-h-9"
              style={{
                borderColor: on ? color : undefined,
                backgroundColor: on ? tint(color, 14) : undefined,
                opacity: on ? 1 : 0.45,
              }}
            >
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: color }}
              />
              {c.name}
            </button>
          );
        })}
      </div>

      <div className="relative" ref={ref}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="block h-auto w-full" width={W} height={H}
          role="img"
          aria-label="Gasto por categoría a lo largo de los meses"
          onMouseLeave={() => onHoverIndex(null)}
        >
          {gridYs.map((g) => (
            <g key={g.y}>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={g.y}
                y2={g.y}
                stroke="var(--chart-grid)"
                strokeWidth={1}
              />
              <text
                x={PAD.left - 8}
                y={g.y + 4}
                textAnchor="end"
                fill="var(--chart-axis)"
              fontSize={AXIS_FONT}
              >
                {g.label >= 1_000_000
                  ? `${(g.label / 1_000_000).toFixed(1)}M`
                  : g.label >= 1000
                    ? `${Math.round(g.label / 1000)}k`
                    : Math.round(g.label)}
              </text>
            </g>
          ))}

          {active.map((c) => {
            const color = colorForCategory(c.slug);
            const pts = c.series.map((s, i) => ({
              x: scaleX(i, periods.length, chartW, PAD),
              y: scaleY(s.amountArs, max, chartH, PAD),
            }));
            return (
              <path
                key={c.slug}
                d={linePath(pts)}
                fill="none"
                stroke={color}
                strokeWidth={2.5}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            );
          })}

          {/* vertical hover strips */}
          {periods.map((p, i) => {
            const x = scaleX(i, periods.length, chartW, PAD);
            const half =
              periods.length <= 1
                ? chartW / 2
                : chartW / (periods.length - 1) / 2;
            const catLabelStep = Math.max(1, Math.ceil(periods.length / (W < 520 ? 5 : 8)));
            return (
              <g key={p}>
                <rect
                  x={x - half}
                  y={PAD.top}
                  width={half * 2}
                  height={chartH}
                  fill="transparent"
                  onMouseEnter={() => onHoverIndex(i)}
                />
                {i % catLabelStep === 0 ? (
                  <text
                    x={x}
                    y={H - 10}
                    textAnchor="middle"
                    fill="var(--chart-axis)"
                    fontSize={AXIS_FONT}
                  >
                    {formatPeriodShort(p)}
                  </text>
                ) : null}
              </g>
            );
          })}

          {hover && periods[hover.i] && (
            <g>
              <line
                x1={scaleX(hover.i, periods.length, chartW, PAD)}
                x2={scaleX(hover.i, periods.length, chartW, PAD)}
                y1={PAD.top}
                y2={PAD.top + chartH}
                stroke="var(--chart-axis)"
                strokeDasharray="4 3"
                opacity={0.7}
              />
            </g>
          )}
        </svg>

        {hover && periods[hover.i] && (
          <div
            className="pointer-events-none absolute z-10 w-[min(16rem,calc(100%-0.5rem))] max-w-full rounded-xl border border-[var(--chart-tip-border)] bg-[var(--chart-tip-bg)] p-2.5 text-[13px] text-[var(--chart-tip-fg)] shadow-lg"
            style={{
              left: `min(${(scaleX(hover.i, periods.length, chartW, PAD) / W) * 100}%, calc(100% - 215px))`,
              top: 8,
            }}
          >
            <p className="mb-1 font-semibold capitalize">
              {formatPeriodShort(periods[hover.i]!)}
            </p>
            {hover.items.length === 0 ? (
              <p className="text-[var(--chart-axis)]">Sin gasto</p>
            ) : (
              <ul className="space-y-0.5">
                {hover.items.slice(0, 8).map((it) => (
                  <li
                    key={it.slug}
                    className="flex items-center justify-between gap-3"
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: it.color }}
                      />
                      <span className="truncate">{it.name}</span>
                    </span>
                    <span className="lc-amount shrink-0 font-medium">
                      {formatArs(it.amount)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
