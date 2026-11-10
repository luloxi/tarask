"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  ArrowDownRight,
  ChevronRight,
  Eye,
  EyeOff,
  LayoutGrid,
  Minus,
  X,
} from "lucide-react";
import { formatPesos, formatUsd, cn } from "@/lib/utils";
import { NinetyDaySpend } from "@/components/ninety-day-spend";
import { PatrimonioGlance } from "@/components/patrimonio-view";
import { formatPeriodTitle, isCurrentCalendarMonth } from "@/lib/period-label";
import { CategoryIcon } from "@/lib/category-icons";
import { colorForCategory, tint } from "@/lib/category-colors";
import { DEUDA_ENABLED } from "@/lib/features";
import {
  getHomeHiddenSnapshot,
  getHomeOrderSnapshot,
  getServerHomeHidden,
  getServerHomeOrder,
  getServerSkipped,
  getSkippedSnapshot,
  subscribeHomeLayout,
  writeHomeHidden,
  writeHomeOrder,
  type HomeSectionId,
} from "@/lib/home-layout";
import { homeNextAction } from "@/lib/nav";

type CategorySummary = {
  id: string;
  slug: string;
  name: string;
  total: number;
  pct: number;
};

type HouseholdService = {
  slug: string;
  name: string;
  paid: boolean;
};

type LiveRate = {
  id: string;
  label: string;
  value: number | null;
  buy?: number | null;
  sell?: number | null;
  spread?: number | null;
  hint?: string;
};

/** Tarjetas de "Más detalle". Las tres grandes de arriba no se mueven. */
const SECTION_LABELS: Record<HomeSectionId, string> = {
  gastos: "Neta del mes",
  categorias: "Dónde se fue la plata",
  ahorros: "Ahorros por moneda",
  hogar: "Hogar",
  deuda: "Deuda",
  cotizaciones: "Dólar",
};

function formatRate(n: number) {
  return new Intl.NumberFormat("es-AR", {
    maximumFractionDigits: 0,
  }).format(Math.round(n));
}

function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3);
}

function useCountUp(target: number, durationMs = 700) {
  const [value, setValue] = useState(target);
  const fromRef = useRef(target);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const from = fromRef.current;
    if (from === target) {
      setValue(target);
      return;
    }
    const start = performance.now();
    const delta = target - from;

    function tick(now: number) {
      const t = Math.min(1, (now - start) / durationMs);
      setValue(from + delta * easeOutCubic(t));
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = target;
        setValue(target);
      }
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [target, durationMs]);

  useEffect(() => {
    fromRef.current = value;
  }, [value]);

  return value;
}

const BURST_COLORS = [
  "#5a9a88",
  "#7eb8a8",
  "#c4a574",
  "#8a9bb5",
  "#a88bb0",
];

function SpendBurst({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <div
      className="pointer-events-none absolute inset-0 z-10 overflow-visible"
      aria-hidden
    >
      {Array.from({ length: 12 }).map((_, i) => {
        const angle = (i / 12) * Math.PI * 2 + (i % 3) * 0.15;
        const dist = 40 + (i % 4) * 14;
        const x = Math.cos(angle) * dist;
        const y = Math.sin(angle) * dist - 8;
        const size = 4 + (i % 3);
        const color = BURST_COLORS[i % BURST_COLORS.length]!;
        const delay = (i % 4) * 30;
        return (
          <span
            key={i}
            className="lc-burst-particle absolute left-1/2 top-1/2 rounded-full"
            style={{
              width: size,
              height: size,
              marginLeft: -size / 2,
              marginTop: -size / 2,
              background: color,
              ["--bx" as string]: `${x}px`,
              ["--by" as string]: `${y}px`,
              animationDelay: `${delay}ms`,
            }}
          />
        );
      })}
      <span className="lc-burst-ring absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2" />
      <span className="lc-burst-flash absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2" />
    </div>
  );
}


function monthName(period: string): string {
  const [y, m] = period.split("-").map(Number);
  if (!y || !m) return period;
  return new Intl.DateTimeFormat("es-AR", { month: "long" }).format(new Date(y, m - 1, 1));
}

/** Una frase: más o menos que el mes anterior. Sin porcentajes ni barras. */
function VsPrevLine({
  total,
  prevTotal,
  prevPeriod,
  inProgressMonth,
}: {
  total: number;
  prevTotal: number;
  prevPeriod: string;
  inProgressMonth: boolean;
}) {
  if (prevTotal <= 0) return null;
  const diff = total - prevTotal;
  const flat = Math.abs(diff) < 1;
  const Icon = flat ? Minus : diff > 0 ? ArrowUpRight : ArrowDownRight;
  const prev = monthName(prevPeriod);
  const text = flat
    ? `Igual que en ${prev}`
    : inProgressMonth
      ? `En ${prev} gastaste ${formatPesos(prevTotal)}`
      : `${formatPesos(Math.abs(diff))} ${diff > 0 ? "más" : "menos"} que en ${prev}`;
  return (
    <p
      className={cn(
        "mt-1 inline-flex items-center gap-1 text-[15px] font-medium",
        flat || inProgressMonth
          ? "text-[var(--muted-fg)]"
          : diff > 0
            ? "text-[var(--warn-text)]"
            : "text-[var(--ok-text)]",
      )}
    >
      {!inProgressMonth && <Icon className="h-4 w-4 shrink-0" strokeWidth={2.2} aria-hidden />}
      {text}
    </p>
  );
}

function TapHint() {
  return (
    <ChevronRight
      className="h-5 w-5 shrink-0 text-[var(--border-strong)] transition group-hover:text-[var(--muted-fg)]"
      aria-hidden
    />
  );
}

/** Fila de "Más detalle": un título, un dato, un chevron. */
function DetailRow({
  href,
  label,
  value,
  note,
  tone,
  children,
}: {
  href: string;
  label: string;
  value?: string;
  note?: string;
  tone?: "ok" | "err";
  children?: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="group block rounded-[1.25rem] border border-[var(--border)] bg-[var(--surface)] px-4 py-3.5 shadow-[var(--card-shadow)] transition active:scale-[0.99]"
    >
      <div className="flex min-h-7 items-center justify-between gap-3">
        <p className="min-w-0 truncate text-[15px] font-semibold">{label}</p>
        <div className="flex min-w-0 max-w-[58%] items-center justify-end gap-1.5">
          {value && (
            <span
              className={cn(
                "lc-amount text-right text-[15px] font-semibold",
                tone === "ok" && "text-[var(--ok-text)]",
                tone === "err" && "text-[var(--err-text)]",
              )}
            >
              {value}
            </span>
          )}
          <TapHint />
        </div>
      </div>
      {note && <p className="mt-0.5 min-w-0 text-[13px] leading-snug text-[var(--muted-fg)]">{note}</p>}
      {children}
    </Link>
  );
}

function RatesRow({ rates }: { rates: LiveRate[] }) {
  const blue = rates.find((r) => r.id === "blue");
  const venta = blue?.sell ?? blue?.value ?? null;
  const compra = blue?.buy ?? null;
  const others = rates.filter((r) => r.id !== "blue" && r.value != null && r.value > 0);
  if (venta == null && compra == null && others.length === 0) return null;
  return (
    <div
      className="rounded-[1.25rem] border border-[var(--border)] bg-[var(--surface)] px-4 py-3.5 shadow-[var(--card-shadow)]"
      aria-label="Cotizaciones del dólar"
    >
      <p className="text-[15px] font-semibold">Dólar</p>
      <dl className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 text-[15px]">
        {venta != null && (
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-[var(--muted-fg)]">Blue</dt>
            <dd className="font-semibold tabular-nums">${formatRate(venta)}</dd>
          </div>
        )}
        {others.map((r) => (
          <div key={r.id} className="flex items-baseline justify-between gap-2">
            <dt className="truncate text-[var(--muted-fg)]">{r.label}</dt>
            <dd className="font-semibold tabular-nums">${formatRate(r.value!)}</dd>
          </div>
        ))}
      </dl>
      {compra != null && venta != null && (
        <p className="mt-1 text-[13px] text-[var(--muted-fg)]">
          Blue: compra ${formatRate(compra)} · venta ${formatRate(venta)}
        </p>
      )}
    </div>
  );
}

function HomeLayoutEditor({
  open,
  onClose,
  order,
  hidden,
  onChange,
}: {
  open: boolean;
  onClose: () => void;
  order: HomeSectionId[];
  hidden: Set<HomeSectionId>;
  onChange: (order: HomeSectionId[], hidden: Set<HomeSectionId>) => void;
}) {
  if (!open) return null;

  function move(id: HomeSectionId, dir: -1 | 1) {
    const i = order.indexOf(id);
    if (i < 0) return;
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    const tmp = next[i]!;
    next[i] = next[j]!;
    next[j] = tmp;
    onChange(next, hidden);
  }

  function toggle(id: HomeSectionId) {
    const next = new Set(hidden);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(order, next);
  }

  return (
    <div className="rounded-[1.25rem] border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--card-shadow)]">
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="text-[15px] font-semibold">Ordená tu resumen</p>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-11 w-11 cursor-pointer items-center justify-center rounded-full text-[var(--muted-fg)] hover:bg-[var(--surface-muted)]"
          aria-label="Cerrar"
        >
          <X className="h-5 w-5" />
        </button>
      </div>
      <p className="mb-3 text-[13px] text-[var(--muted-fg)]">
        Subí, bajá o escondé las tarjetas de más detalle. Lo demás está en la barra de abajo.
      </p>
      <ul className="space-y-2">
        {order.map((id, i) => {
          const isHidden = hidden.has(id);
          return (
            <li
              key={id}
              className={cn(
                "flex items-center gap-1 rounded-2xl border px-3 py-1",
                isHidden
                  ? "border-dashed border-[var(--border)] opacity-60"
                  : "border-[var(--border)] bg-[var(--surface-muted)]",
              )}
            >
              <span className="min-w-0 flex-1 truncate text-[15px] font-medium">
                {SECTION_LABELS[id]}
              </span>
              <button
                type="button"
                disabled={i === 0}
                onClick={() => move(id, -1)}
                className="inline-flex h-11 w-11 cursor-pointer items-center justify-center rounded-full text-[var(--muted-fg)] hover:bg-[var(--surface)] disabled:cursor-not-allowed disabled:opacity-30"
                aria-label={`Subir ${SECTION_LABELS[id]}`}
              >
                <ArrowUp className="h-4 w-4" />
              </button>
              <button
                type="button"
                disabled={i === order.length - 1}
                onClick={() => move(id, 1)}
                className="inline-flex h-11 w-11 cursor-pointer items-center justify-center rounded-full text-[var(--muted-fg)] hover:bg-[var(--surface)] disabled:cursor-not-allowed disabled:opacity-30"
                aria-label={`Bajar ${SECTION_LABELS[id]}`}
              >
                <ArrowDown className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => toggle(id)}
                className="inline-flex h-11 w-11 cursor-pointer items-center justify-center rounded-full text-[var(--muted-fg)] hover:bg-[var(--surface)]"
                aria-label={isHidden ? `Mostrar ${SECTION_LABELS[id]}` : `Ocultar ${SECTION_LABELS[id]}`}
                title={isHidden ? "Mostrar" : "Ocultar"}
              >
                {isHidden ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function DashboardHome({
  firstName,
  period,
  periods,
  onPeriodChange,
  prevPeriod,
  totalArs,
  prevTotalArs,
  sharedTotalArs,
  debtBalanceArs,
  debtSettled,
  debtActiveCard = false,
  monthTxCount,
  categorySummary,
  householdServices = [],
  liveRates = [],
  savingsArs = 0,
  savingsUsd = 0,
  savingsUsdc = 0,
  savingsNetArs = 0,
  incomeArs = 0,
  householdName,
}: {
  firstName: string;
  period: string;
  periods?: string[];
  onPeriodChange?: (period: string) => void;
  prevPeriod: string;
  totalArs: number;
  prevTotalArs: number;
  sharedTotalArs: number;
  sharedPrevTotalArs: number;
  debtBalanceArs: number;
  debtSettled: boolean;
  debtActiveCard?: boolean;
  monthTxCount: number;
  categorySummary: CategorySummary[];
  householdServices?: HouseholdService[];
  liveRates?: LiveRate[];
  savingsArs?: number;
  savingsUsd?: number;
  savingsUsdc?: number;
  savingsNetArs?: number;
  /** Ingresos del mes en ARS (USD ya convertidos). 0 = sin ingresos cargados. */
  incomeArs?: number;
  householdName?: string;
  initialCategories?: unknown;
  initialMembers?: unknown;
}) {
  const router = useRouter();
  const liveTotal = totalArs;
  const liveCats = categorySummary;
  const [burst, setBurst] = useState(false);
  const [pop, setPop] = useState(false);
  const skipped = useSyncExternalStore(
    subscribeHomeLayout,
    getSkippedSnapshot,
    getServerSkipped,
  );
  const order = useSyncExternalStore(
    subscribeHomeLayout,
    getHomeOrderSnapshot,
    getServerHomeOrder,
  );
  const hidden = useSyncExternalStore(
    subscribeHomeLayout,
    getHomeHiddenSnapshot,
    getServerHomeHidden,
  );
  const [editing, setEditing] = useState(false);

  const hasIncomes = incomeArs > 0;
  const hasSavings =
    savingsArs > 0 || savingsUsd > 0 || savingsUsdc > 0 || savingsNetArs > 0;
  const haveAmount = useCountUp(hasSavings ? savingsNetArs : 0, 750);
  const spentAmount = useCountUp(liveTotal, 750);

  const triggerCelebrate = useCallback(() => {
    setBurst(true);
    setPop(true);
    window.setTimeout(() => setBurst(false), 900);
    window.setTimeout(() => setPop(false), 500);
  }, []);

  useEffect(() => {
    function onCreated() {
      triggerCelebrate();
      router.refresh();
    }
    window.addEventListener("lc:expense-created", onCreated);
    return () => window.removeEventListener("lc:expense-created", onCreated);
  }, [router, triggerCelebrate]);

  const visibleServices = householdServices.filter((s) => !skipped.has(s.slug));
  const inProgress = isCurrentCalendarMonth(period);
  const emptyMonth = monthTxCount <= 0 && !hasIncomes;
  const next = homeNextAction(monthTxCount);
  const netaMes = incomeArs - liveTotal;

  function onLayoutChange(
    nextOrder: HomeSectionId[],
    nextHidden: Set<HomeSectionId>,
  ) {
    writeHomeOrder(nextOrder);
    writeHomeHidden(nextHidden);
  }

  const details = useMemo(() => {
    const map: Record<HomeSectionId, React.ReactNode> = {
      gastos: hasIncomes ? (
        <DetailRow
          href="/ingresos"
          label="Te quedó este mes"
          value={formatPesos(netaMes)}
          tone={netaMes < 0 ? "err" : "ok"}
          note={`Ingresaron ${formatPesos(incomeArs)} y salieron ${formatPesos(liveTotal)}.`}
        />
      ) : (
        <DetailRow
          href="/ingresos"
          label="Ingresos del mes"
          note="Todavía no cargaste ingresos. Con ellos vemos cuánto te queda."
        />
      ),
      categorias:
        liveCats.length > 0 ? (
          <Link
            href="/consumos?tab=resumen"
            className="group block rounded-[1.25rem] border border-[var(--border)] bg-[var(--surface)] px-4 py-3.5 shadow-[var(--card-shadow)] transition active:scale-[0.99]"
            aria-label="Gastos por categoría"
          >
            <div className="mb-2.5 flex items-center justify-between gap-2">
              <p className="text-[15px] font-semibold">Dónde se fue la plata</p>
              <TapHint />
            </div>
            <ul className="space-y-3">
              {liveCats.slice(0, 3).map((c) => {
                const color = colorForCategory(c.slug);
                return (
                  <li key={c.id}>
                    <div className="flex items-center gap-2.5">
                      <span
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl"
                        style={{ backgroundColor: tint(color, 15), color }}
                      >
                        <CategoryIcon slug={c.slug} size={15} />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[15px]">{c.name}</span>
                      <span className="shrink-0 text-[15px] font-semibold tabular-nums">
                        {formatPesos(c.total)}
                      </span>
                    </div>
                    <div className="ml-[2.625rem] mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--surface-muted)]">
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${Math.min(100, c.pct)}%`, backgroundColor: color }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          </Link>
        ) : null,
      ahorros: hasSavings ? (
        <DetailRow
          href="/ahorros"
          label="Ahorros por moneda"
          note={`Pesos ${formatPesos(savingsArs)} · ${formatUsd(savingsUsd)} · USDC ${formatUsd(savingsUsdc)}`}
        />
      ) : null,
      hogar:
        sharedTotalArs > 0 || visibleServices.some((s) => s.paid) ? (
          <DetailRow
            href="/compartido"
            label="Hogar"
            value={formatPesos(sharedTotalArs)}
            note="Gastos compartidos del mes"
          >
            {visibleServices.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {visibleServices.map((svc) => (
                  <span
                    key={svc.slug}
                    title={`${svc.name}: ${svc.paid ? "Pagado" : "Pendiente"}`}
                    className={cn(
                      "flex h-8 w-8 items-center justify-center rounded-xl",
                      svc.paid
                        ? "bg-[color-mix(in_srgb,var(--ok)_30%,var(--surface))] text-[var(--ok-text)]"
                        : "bg-[var(--surface-muted)] text-[var(--muted-fg)]",
                    )}
                  >
                    <CategoryIcon slug={svc.slug} size={15} />
                    <span className="sr-only">{`${svc.name}: ${svc.paid ? "pagado" : "pendiente"}`}</span>
                  </span>
                ))}
              </div>
            )}
          </DetailRow>
        ) : null,
      deuda: DEUDA_ENABLED ? (
        <DetailRow
          href="/deuda"
          label="Deuda de la tarjeta"
          value={debtSettled ? "Sin deuda" : formatPesos(debtBalanceArs)}
          tone={debtSettled ? "ok" : "err"}
          note={debtSettled && !debtActiveCard ? "Sin tarjeta activa" : undefined}
        />
      ) : null,
      cotizaciones: <RatesRow rates={liveRates} />,
    };
    return order
      .filter((id) => !hidden.has(id))
      .map((id) => {
        const node = map[id];
        if (!node) return null;
        return <div key={id}>{node}</div>;
      })
      .filter(Boolean);
  }, [
    order,
    hidden,
    hasIncomes,
    incomeArs,
    netaMes,
    liveTotal,
    liveCats,
    hasSavings,
    savingsArs,
    savingsUsd,
    savingsUsdc,
    sharedTotalArs,
    visibleServices,
    debtSettled,
    debtActiveCard,
    debtBalanceArs,
    liveRates,
  ]);

  return (
    <div className="animate-fade-up mx-auto flex w-full max-w-xl flex-col gap-4">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-[1.6rem] font-semibold leading-tight tracking-tight break-words">
            Hola, {firstName}
          </h1>
          {householdName ? (
            <p className="text-[15px] leading-snug text-[var(--muted-fg)] break-words">{householdName}</p>
          ) : null}
        </div>
        {onPeriodChange ? (
          <select
            value={period}
            onChange={(e) => onPeriodChange(e.target.value)}
            className="lc-input w-fit max-w-full rounded-full !px-3 !py-0 text-[15px] font-medium"
            aria-label="Mes"
          >
            {(periods && periods.length > 0 ? periods : [period]).map((p) => (
              <option key={p} value={p}>
                {formatPeriodTitle(p)}
              </option>
            ))}
          </select>
        ) : (
          <span className="shrink-0 text-[15px] font-medium">{formatPeriodTitle(period)}</span>
        )}
      </header>

      {/* 1. Cuánta plata tenés */}
      <Link
        href="/ahorros"
        className="group relative block overflow-hidden rounded-[1.5rem] border border-[color-mix(in_srgb,var(--accent)_45%,var(--border))] bg-[color-mix(in_srgb,var(--accent)_16%,var(--surface))] p-5 shadow-[var(--card-shadow-lg)] transition active:scale-[0.99]"
        aria-label={hasSavings ? `Tenés ${formatPesos(savingsNetArs)}` : "Todavía no cargaste ahorros"}
      >
        <div className="flex items-center justify-between gap-2">
          <p className="text-[15px] font-semibold">Tenés</p>
          <TapHint />
        </div>
        {hasSavings ? (
          <>
            <p className="lc-amount lc-glow mt-1 text-[clamp(1.7rem,8.5vw,2.6rem)] font-semibold leading-none tracking-[-0.03em]">
              {formatPesos(haveAmount)}
            </p>
            <p className="mt-2 text-[15px] text-[var(--muted-fg)]">
              En pesos y dólares, al blue.
            </p>
          </>
        ) : (
          <p className="mt-2 text-[17px] leading-snug text-[var(--muted-fg)]">
            Todavía no cargaste ahorros. Sumá tus cuentas para ver cuánto tenés.
          </p>
        )}
      </Link>

      {/* 2. Cuánto gastaste este mes */}
      <Link
        href={next.href}
        className="group relative block overflow-hidden rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--card-shadow)] transition active:scale-[0.99]"
        aria-label={`Gastaste ${formatPesos(liveTotal)} en ${monthName(period)}`}
      >
        <SpendBurst active={burst} />
        <div className="flex items-center justify-between gap-2">
          <p className="text-[15px] font-semibold">
            {inProgress ? "Gastaste este mes" : `Gastaste en ${monthName(period)}`}
          </p>
          <TapHint />
        </div>
        {emptyMonth ? (
          <p className="mt-2 text-[17px] text-[var(--muted-fg)]">Este mes todavía está en blanco.</p>
        ) : (
          <>
            <p
              className={cn(
                "lc-amount mt-1 text-[clamp(1.5rem,7.5vw,2.1rem)] font-semibold leading-tight tracking-[-0.03em]",
                pop && "lc-amount-pop",
              )}
            >
              {formatPesos(spentAmount)}
            </p>
            <VsPrevLine
              total={liveTotal}
              prevTotal={prevTotalArs}
              prevPeriod={prevPeriod}
              inProgressMonth={inProgress}
            />
          </>
        )}
      </Link>

      <NinetyDaySpend />

      {/* 3. Cómo viene tu patrimonio */}
      <PatrimonioGlance />

      {/* Un nivel más adentro */}
      <section className="mt-2 flex flex-col gap-3" aria-label="Más detalle">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-[15px] font-semibold text-[var(--muted-fg)]">Más detalle</h2>
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            aria-pressed={editing}
            className={cn(
              "inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-full px-3 text-[14px] font-medium transition",
              editing
                ? "bg-[var(--brand-soft)] text-[var(--text)]"
                : "text-[var(--muted-fg)] hover:bg-[var(--surface-muted)] hover:text-[var(--text)]",
            )}
          >
            <LayoutGrid className="h-4 w-4" strokeWidth={1.8} />
            Ordenar
          </button>
        </div>

        <HomeLayoutEditor
          open={editing}
          onClose={() => setEditing(false)}
          order={order}
          hidden={hidden}
          onChange={onLayoutChange}
        />

        {details}
      </section>
    </div>
  );
}
