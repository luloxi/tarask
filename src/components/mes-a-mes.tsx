"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  LineChart,
  LayoutList,
} from "lucide-react";
import { cn, formatArs, formatUsd, currentPeriodAr } from "@/lib/utils";
import { formatPeriodLabel } from "@/lib/period-label";
import { colorForCategory } from "@/lib/category-colors";
import { GastoInsights } from "@/components/gasto-insights";
import { CategoryLinesChart, TotalSpendChart } from "@/components/spend-charts";
import { MesAMesTxRow, type MesAMesTx } from "@/components/mes-a-mes-tx-row";
import {
  EmptyState,
  LoadingBlock,
  Surface,
  Toast,
} from "@/components/ui";
import {
  ApplyCriterionToast,
  type ApplyCriterionPrompt,
} from "@/components/apply-criterion-toast";
import {
  ReintegroHogarToast,
  type ReintegroHogarPrompt,
} from "@/components/reintegro-hogar-toast";
import {
  GastoCubiertoToast,
  type GastoCubiertoPrompt,
} from "@/components/gasto-cubierto-toast";
import {
  isConsumosHiddenPayment,
  isReintegroHogarTipo,
} from "@/lib/reintegro-hogar";
import { isGastoCubiertoTipo } from "@/lib/gasto-cubierto";
import { isTransferenciaInternaTipo } from "@/lib/bbva/bank-entries";
import { isAbortError } from "@/hooks/use-json-resource";
import { pickFilterPeriod } from "@/lib/list-page";

type CategoryOpt = { id: string; slug: string; name: string };

type UsdRate = {
  buy: number;
  asOf: string;
  source: string;
} | null;

type MonthCat = {
  slug: string;
  name: string;
  categoryId: string | null;
  amountArs: number;
  amountUsd: number;
  amountArsFromUsd?: number;
  amountArsCombined?: number;
  count: number;
  pct: number;
};

type CubiertoBlock = {
  amountArs: number;
  amountUsd: number;
  amountArsFromUsd?: number;
  amountArsCombined?: number;
  count: number;
};

type MonthBlock = {
  period: string;
  totalArs: number;
  totalUsd: number;
  totalArsFromUsd?: number;
  totalArsCombined?: number;
  totalCount: number;
  usdRate?: UsdRate;
  categories: MonthCat[];
  cubierto?: CubiertoBlock;
};

function monthTotalArs(m: MonthBlock): number {
  return m.totalArsCombined ?? m.totalArs + (m.totalArsFromUsd ?? 0);
}

function formatUsdRateLabel(rate: UsdRate | undefined): string | null {
  if (!rate || !(rate.buy > 0)) return null;
  const [y, mo, d] = rate.asOf.split("-");
  const dateLabel = d && mo && y ? `${d}/${mo}/${y}` : rate.asOf;
  return `TC compra ${dateLabel}: ${formatArs(rate.buy)} / USD`;
}

type ChartData = {
  periods: string[];
  totals: Array<{ period: string; amountArs: number; amountUsd?: number }>;
  byCategory: Array<{
    slug: string;
    name: string;
    series: Array<{ period: string; amountArs: number }>;
    totalArs: number;
  }>;
};

type Tx = MesAMesTx;

type OwnershipFilter = "all" | "personal" | "shared";
type HouseholdOption = { id: string; name: string };

function OwnershipChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex min-h-10 items-center rounded-full border px-3 text-xs font-medium transition",
        active
          ? "border-[var(--brand)]/40 bg-[var(--brand-soft)] text-[var(--brand-fg)]"
          : "border-[var(--border)] text-[var(--muted-fg)] hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)]",
      )}
    >
      {children}
    </button>
  );
}

function aggregateMonths(months: MonthBlock[]): MonthBlock {
  const bySlug = new Map<
    string,
    {
      slug: string;
      name: string;
      amountArs: number;
      amountUsd: number;
      amountArsFromUsd: number;
      amountArsCombined: number;
      count: number;
    }
  >();
  let totalArs = 0;
  let totalUsd = 0;
  let totalArsFromUsd = 0;
  let totalCount = 0;
  let cubiertoArs = 0;
  let cubiertoUsd = 0;
  let cubiertoArsFromUsd = 0;
  let cubiertoCount = 0;

  for (const m of months) {
    totalArs += m.totalArs;
    totalUsd += m.totalUsd;
    totalArsFromUsd += m.totalArsFromUsd ?? 0;
    totalCount += m.totalCount;
    if (m.cubierto) {
      cubiertoArs += m.cubierto.amountArs;
      cubiertoUsd += m.cubierto.amountUsd;
      cubiertoArsFromUsd += m.cubierto.amountArsFromUsd ?? 0;
      cubiertoCount += m.cubierto.count;
    }
    for (const c of m.categories) {
      const fromUsd = c.amountArsFromUsd ?? 0;
      const combined = c.amountArsCombined ?? c.amountArs + fromUsd;
      const cur = bySlug.get(c.slug) ?? {
        slug: c.slug,
        name: c.name,
        amountArs: 0,
        amountUsd: 0,
        amountArsFromUsd: 0,
        amountArsCombined: 0,
        count: 0,
      };
      cur.amountArs += c.amountArs;
      cur.amountUsd += c.amountUsd;
      cur.amountArsFromUsd += fromUsd;
      cur.amountArsCombined += combined;
      cur.count += c.count;
      if (c.name) cur.name = c.name;
      bySlug.set(c.slug, cur);
    }
  }

  const totalArsCombined = totalArs + totalArsFromUsd;
  const categories = [...bySlug.values()]
    .map((c) => ({
      ...c,
      categoryId: null as string | null,
      pct:
        totalArsCombined > 0
          ? (c.amountArsCombined / totalArsCombined) * 100
          : 0,
    }))
    .sort((a, b) => b.amountArsCombined - a.amountArsCombined);

  return {
    period: "total",
    totalArs,
    totalUsd,
    totalArsFromUsd,
    totalArsCombined,
    totalCount,
    categories,
    cubierto: {
      amountArs: cubiertoArs,
      amountUsd: cubiertoUsd,
      amountArsFromUsd: cubiertoArsFromUsd,
      amountArsCombined: cubiertoArs + cubiertoArsFromUsd,
      count: cubiertoCount,
    },
  };
}

export function MesAMesView({
  mode = "resumen",
}: {
  mode?: "resumen" | "charts";
}) {
  const [filterPeriod, setFilterPeriod] = useState<string>(currentPeriodAr);
  const [periods, setPeriods] = useState<string[]>([]);
  const [months, setMonths] = useState<MonthBlock[]>([]);
  const [chart, setChart] = useState<ChartData | null>(null);
  const [categories, setCategories] = useState<CategoryOpt[]>([]);
  const [txs, setTxs] = useState<Tx[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [txsLoading, setTxsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [applyPrompt, setApplyPrompt] = useState<ApplyCriterionPrompt | null>(null);
  const [applyBusy, setApplyBusy] = useState(false);
  const [periodReady, setPeriodReady] = useState(false);
  const [ownershipF, setOwnershipF] = useState<OwnershipFilter>("all");
  const [households, setHouseholds] = useState<HouseholdOption[]>([]);
  const [activeHouseholdId, setActiveHouseholdId] = useState<string | null>(null);
  const [reintegroPrompt, setReintegroPrompt] = useState<ReintegroHogarPrompt | null>(null);
  const [reintegroBusy, setReintegroBusy] = useState(false);
  const [cubiertoPrompt, setCubiertoPrompt] = useState<GastoCubiertoPrompt | null>(null);
  const [cubiertoBusy, setCubiertoBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/household/active", { credentials: "include" });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as {
          households?: HouseholdOption[];
          activeHouseholdId?: string | null;
        };
        if (cancelled) return;
        setHouseholds(data.households ?? []);
        setActiveHouseholdId(data.activeHouseholdId ?? null);
      } catch {
        /* Tipo falls back to Personal/Hogar */
      }
    })();
    function onSwitch() {
      void (async () => {
        try {
          const res = await fetch("/api/household/active", { credentials: "include" });
          if (!res.ok) return;
          const data = (await res.json()) as {
            households?: HouseholdOption[];
            activeHouseholdId?: string | null;
          };
          setHouseholds(data.households ?? []);
          setActiveHouseholdId(data.activeHouseholdId ?? null);
        } catch { /* ignore */ }
      })();
    }
    window.addEventListener("lc:household-switched", onSwitch);
    window.addEventListener("lc:household-created", onSwitch);
    return () => {
      cancelled = true;
      window.removeEventListener("lc:household-switched", onSwitch);
      window.removeEventListener("lc:household-created", onSwitch);
    };
  }, []);

  const loadStats = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ period: "all" });
      if (ownershipF !== "all") params.set("ownership", ownershipF);
      const res = await fetch(`/api/stats/mes-a-mes?${params}`, {
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Error al cargar el análisis");
        return;
      }
      const loadedPeriods: string[] = data.periods ?? [];
      setPeriods(loadedPeriods);
      setMonths(data.months ?? []);
      setChart(data.chart ?? null);
      setCategories(data.categories ?? []);

      setFilterPeriod((prev) =>
        pickFilterPeriod(prev, loadedPeriods, currentPeriodAr()),
      );
      setPeriodReady(true);
    } catch {
      setError("Error de red");
    } finally {
      setLoading(false);
    }
  }, [ownershipF]);

  const statsKey = ownershipF;
  const [seenStatsKey, setSeenStatsKey] = useState(statsKey);
  if (statsKey !== seenStatsKey) {
    setSeenStatsKey(statsKey);
    setLoading(true);
    setError(null);
  }

  const txKey = `${mode}\0${periodReady ? filterPeriod : ""}`;
  const [seenTxKey, setSeenTxKey] = useState(txKey);
  if (txKey !== seenTxKey) {
    setSeenTxKey(txKey);
    if (mode !== "resumen") setTxs([]);
    if (mode === "resumen" && periodReady) {
      setTxsLoading(true);
      setExpanded(new Set());
    }
  }

  useEffect(() => {
    const ac = new AbortController();
    const params = new URLSearchParams({ period: "all" });
    if (ownershipF !== "all") params.set("ownership", ownershipF);
    fetch(`/api/stats/mes-a-mes?${params}`, {
      credentials: "include",
      signal: ac.signal,
    })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) {
          return {
            ok: false as const,
            message: (data.error || "Error al cargar el análisis") as string,
          };
        }
        return {
          ok: true as const,
          data: data as {
            periods?: string[];
            months?: MonthBlock[];
            chart?: ChartData | null;
            categories?: CategoryOpt[];
          },
        };
      })
      .then((result) => {
        if (ac.signal.aborted) return;
        if (!result.ok) {
          setError(result.message);
          setLoading(false);
          return;
        }
        const loadedPeriods = result.data.periods ?? [];
        setPeriods(loadedPeriods);
        setMonths(result.data.months ?? []);
        setChart(result.data.chart ?? null);
        setCategories(result.data.categories ?? []);
        setFilterPeriod((prev) =>
          pickFilterPeriod(prev, loadedPeriods, currentPeriodAr()),
        );
        setPeriodReady(true);
        setError(null);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted || isAbortError(e)) return;
        setError("Error de red");
        setLoading(false);
      });
    return () => ac.abort();
  }, [ownershipF]);

  useEffect(() => {
    if (!toast || applyPrompt || reintegroPrompt) return;
    const t = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(t);
  }, [toast, applyPrompt, reintegroPrompt]);

  useEffect(() => {
    if (mode !== "resumen" || !periodReady) return;
    const ac = new AbortController();
    const q =
      filterPeriod && filterPeriod !== "all"
        ? `?period=${encodeURIComponent(filterPeriod)}`
        : "";
    fetch(`/api/transactions${q}`, {
      credentials: "include",
      signal: ac.signal,
    })
      .then(async (res) => {
        const data = await res.json();
        return { ok: res.ok, data };
      })
      .then(({ ok, data }) => {
        if (ac.signal.aborted) return;
        if (ok) {
          setTxs(
            ((data.transactions ?? []) as Tx[])
              .filter(
                (t) =>
                  !isConsumosHiddenPayment(
                    Boolean(t.isPayment),
                    t.descriptionNormalized,
                    t.category?.slug,
                    Boolean(t.reintegroHogar),
                  ) &&
                  (t.amountArs != null || t.amountUsd != null),
              )
              .map((t) => ({
                ...t,
                ownership:
                  t.ownership === "shared" ? ("shared" as const) : ("personal" as const),
                reintegroHogar: Boolean(t.reintegroHogar),
                reintegroPayee: Boolean(t.reintegroPayee),
              })),
          );
          if (data.categories?.length) setCategories(data.categories);
        }
        setTxsLoading(false);
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted || isAbortError(e)) return;
        setTxsLoading(false);
      });
    return () => ac.abort();
  }, [mode, filterPeriod, periodReady]);

  const grand = useMemo(() => aggregateMonths(months), [months]);

  const selectedMonth = useMemo(() => {
    if (filterPeriod === "all") return null;
    return months.find((m) => m.period === filterPeriod) ?? null;
  }, [months, filterPeriod]);

  const filteredTxs = useMemo(() => {
    if (ownershipF === "all") return txs;
    return txs.filter((t) => t.ownership === ownershipF);
  }, [txs, ownershipF]);

  const txsByCat = useMemo(() => {
    const map = new Map<string, Tx[]>();
    for (const t of filteredTxs) {
      const slug = t.category?.slug ?? "uncategorized";
      if (!map.has(slug)) map.set(slug, []);
      map.get(slug)!.push(t);
    }
    for (const list of map.values()) {
      list.sort((a, b) => b.date.localeCompare(a.date));
    }
    return map;
  }, [filteredTxs]);

  const periodIndex = periods.indexOf(filterPeriod);
  const canPrev = periodIndex >= 0 && periodIndex < periods.length - 1;
  const canNext = periodIndex > 0;

  function goPrev() {
    if (!canPrev) return;
    setFilterPeriod(periods[periodIndex + 1]!);
  }
  function goNext() {
    if (!canNext) return;
    setFilterPeriod(periods[periodIndex - 1]!);
  }

  function toggleExpand(slug: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }

  async function reloadTxs() {
    const q =
      filterPeriod && filterPeriod !== "all"
        ? `?period=${encodeURIComponent(filterPeriod)}`
        : "";
    const res2 = await fetch(`/api/transactions${q}`, {
      credentials: "include",
    });
    if (res2.ok) {
      const d2 = await res2.json();
      setTxs(
        (d2.transactions as Tx[])
          .filter(
            (t) =>
              !isConsumosHiddenPayment(
                Boolean(t.isPayment),
                t.descriptionNormalized,
                t.category?.slug,
                Boolean(t.reintegroHogar),
              ) &&
              (t.amountArs != null || t.amountUsd != null),
          )
          .map((t) => ({
            ...t,
            reintegroHogar: Boolean(t.reintegroHogar),
            reintegroPayee: Boolean(t.reintegroPayee),
          })),
      );
    }
  }

  async function changeCategory(
    txId: string,
    categoryId: string,
    opts?: { applyToSimilar?: boolean },
  ) {
    setSavingId(txId);
    setToast(null);
    const prev = txs;
    const prevCatId = txs.find((t) => t.id === txId)?.category?.id ?? null;
    const categoryChanged = Boolean(categoryId) && categoryId !== prevCatId;
    const cat = categories.find((c) => c.id === categoryId) ?? null;
    if (!opts?.applyToSimilar) {
      setTxs((list) =>
        list.map((t) =>
          t.id === txId
            ? {
                ...t,
                category: cat
                  ? { id: cat.id, slug: cat.slug, name: cat.name }
                  : null,
              }
            : t,
        ),
      );
    }
    try {
      const res = await fetch("/api/transactions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          id: txId,
          categoryId: categoryId || null,
          ...(opts?.applyToSimilar ? { applyToSimilar: true } : {}),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setTxs(prev);
        setError(data?.error || "No se pudo guardar");
        return;
      }

      if (opts?.applyToSimilar) {
        setApplyPrompt(null);
        const n = typeof data?.similarUpdated === "number" ? data.similarUpdated : 0;
        setToast(
          n > 0
            ? `Criterio aplicado a ${n + 1} gasto${n + 1 === 1 ? "" : "s"}.`
            : "Criterio guardado.",
        );
        void loadStats();
        await reloadTxs();
        return;
      }

      const similarCount =
        typeof data?.similarCount === "number" ? data.similarCount : 0;
      if (categoryChanged && similarCount >= 2 && categoryId) {
        setApplyPrompt({ txId, categoryId, count: similarCount });
      } else if (categoryChanged) {
        setApplyPrompt(null);
        setToast("Guardado.");
      }

      void loadStats();
      await reloadTxs();
    } catch {
      setTxs(prev);
      setError("Error de red al guardar");
    } finally {
      setSavingId(null);
    }
  }

  async function applyCriterion() {
    if (!applyPrompt) return;
    setApplyBusy(true);
    try {
      await changeCategory(applyPrompt.txId, applyPrompt.categoryId, {
        applyToSimilar: true,
      });
    } finally {
      setApplyBusy(false);
    }
  }

  async function patchTx(id: string, body: Record<string, unknown>) {
    setError(null);
    setSavingId(id);
    const prev = txs;
    try {
      if (body.ownership === "personal" || body.ownership === "shared") {
        setTxs((list) =>
          list.map((t) =>
            t.id === id
              ? {
                  ...t,
                  ownership:
                    body.ownership === "shared"
                      ? ("shared" as const)
                      : ("personal" as const),
                }
              : t,
          ),
        );
      }
      const res = await fetch("/api/transactions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ id, ...body }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setTxs(prev);
        setError(data?.error || "No se pudo guardar");
        return data;
      }

      if (
        body.householdReimbursement ||
        body.householdBillCovered ||
        body.internalTransfer
      ) {
        if (body.internalTransfer) {
          setTxs((list) => list.filter((x) => x.id !== id));
        } else {
          // Reintegro / Cubierto stay visible (out of neta via isPayment).
          setTxs((list) =>
            list.map((x) => (x.id === id ? { ...x, isPayment: true } : x)),
          );
        }
        if (body.householdBillCovered) {
          setReintegroPrompt(null);
          const n =
            typeof data?.cubiertoCount === "number"
              ? data.cubiertoCount
              : typeof data?.similarCount === "number"
                ? data.similarCount
                : 1;
          if (n > 1 && !body.applyToSimilar) {
            setToast(null);
            setCubiertoPrompt({ txId: id, count: n, pending: false });
          } else if (body.applyToSimilar) {
            setCubiertoPrompt(null);
            const u =
              typeof data?.similarUpdated === "number" ? data.similarUpdated : 0;
            setToast(
              u > 0
                ? `Cubierto aplicado a ${u + 1} gasto${u + 1 === 1 ? "" : "s"} (no cuenta en la neta).`
                : "Marcado como cubierto (no cuenta en la neta).",
            );
            await reloadTxs();
          } else {
            setCubiertoPrompt(null);
            setToast("Marcado como cubierto (no cuenta en la neta).");
          }
          void loadStats();
          return data;
        }
        const n =
          typeof data?.reintegroCount === "number"
            ? data.reintegroCount
            : typeof data?.similarCount === "number"
              ? data.similarCount
              : 1;
        if (body.householdReimbursement && n > 1 && !body.applyToSimilar) {
          setToast(null);
          setCubiertoPrompt(null);
          setReintegroPrompt({ txId: id, count: n, pending: false });
        } else if (body.householdReimbursement) {
          setReintegroPrompt(null);
          setToast(
            "Marcado como reintegro de servicios (no cuenta en la neta).",
          );
        } else {
          setToast("Marcado como transferencia interna (no cuenta en la neta).");
        }
        void loadStats();
        return data;
      }

      if (body.applyToSimilar && body.householdReimbursement) {
        setReintegroPrompt(null);
      }

      const reintegroCount =
        typeof data?.reintegroCount === "number" ? data.reintegroCount : 0;
      const row =
        txs.find((r) => r.id === id) ?? prev.find((r) => r.id === id);
      if (
        !body.skipReintegroOffer &&
        reintegroCount >= 1 &&
        Boolean(row?.reintegroPayee) &&
        body.ownership === "shared"
      ) {
        setToast(null);
        setReintegroPrompt({
          txId: id,
          count: reintegroCount,
          pending: true,
        });
        return data;
      }

      if (body.ownership) setToast("Guardado.");
      void loadStats();
      await reloadTxs();
      return data;
    } catch {
      setTxs(prev);
      setError("Error de red al guardar");
      return null;
    } finally {
      setSavingId(null);
    }
  }

  async function onToggleBusiness(t: Tx) {
    const next = !t.isBusiness;
    setSavingId(t.id);
    setError(null);
    const prev = txs;
    setTxs((list) =>
      list.map((row) =>
        row.id === t.id ? { ...row, isBusiness: next, syncStatus: "pending" } : row,
      ),
    );
    try {
      const res = await fetch("/api/transactions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ id: t.id, isBusiness: next }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setTxs(prev);
        setError(data?.error || "No se pudo guardar");
        return;
      }
      setToast(
        next
          ? "Marcado como del negocio. Se envía a Serpix."
          : "Listo, ya no es del negocio.",
      );
    } catch {
      setTxs(prev);
      setError("Error de red al guardar");
    } finally {
      setSavingId(null);
    }
  }

  async function onAssignChange(r: Tx, value: string) {
    if (value === "personal") {
      const wasSpecial =
        isReintegroHogarTipo(Boolean(r.isPayment), Boolean(r.reintegroHogar)) ||
        isTransferenciaInternaTipo(Boolean(r.isPayment), r.category, r.descriptionNormalized) ||
        isGastoCubiertoTipo(Boolean(r.isPayment), r.category);
      if (r.ownership === "personal" && !wasSpecial) return;
      setError(null);
      setSavingId(r.id);
      const prev = txs;
      try {
        const res = await fetch("/api/transactions", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            id: r.id,
            ownership: "personal",
            ...(wasSpecial ? { isPayment: false } : {}),
          }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          setError(data?.error || "No se pudo asignar");
          return;
        }
        if (data?.moved) {
          setTxs((list) => list.filter((x) => x.id !== r.id));
          setToast("Movido a Personal.");
          void loadStats();
        } else {
          setTxs((list) =>
            list.map((x) =>
              x.id === r.id
                ? {
                    ...x,
                    ownership: "personal" as const,
                    ...(wasSpecial ? { isPayment: false } : {}),
                  }
                : x,
            ),
          );
          setToast("Guardado.");
          void loadStats();
        }
      } catch (e) {
        setTxs(prev);
        setError(e instanceof Error ? e.message : "Error de red");
      } finally {
        setSavingId(null);
      }
      return;
    }
    if (value === "cubierto") {
      setApplyPrompt(null);
      setReintegroPrompt(null);
      setToast(null);
      void patchTx(r.id, { householdBillCovered: true });
      return;
    }
    if (value === "reintegro") {
      setApplyPrompt(null);
      setCubiertoPrompt(null);
      setToast(null);
      void patchTx(r.id, { householdReimbursement: true });
      return;
    }
    if (value === "internal") {
      void patchTx(r.id, { internalTransfer: true });
      return;
    }
    if (value === "shared" || value === (activeHouseholdId ?? "")) {
      if (r.reintegroPayee && !r.isPayment) {
        const n = txs.filter(
          (x) =>
            !x.isPayment &&
            x.descriptionNormalized === r.descriptionNormalized,
        ).length;
        setApplyPrompt(null);
        setToast(null);
        setReintegroPrompt({
          txId: r.id,
          count: Math.max(1, n),
          pending: true,
          declineToShared: true,
        });
        return;
      }
      const wasSpecial =
        isReintegroHogarTipo(Boolean(r.isPayment), Boolean(r.reintegroHogar)) ||
        isTransferenciaInternaTipo(Boolean(r.isPayment), r.category, r.descriptionNormalized) ||
        isGastoCubiertoTipo(Boolean(r.isPayment), r.category);
      if (r.ownership !== "shared" || wasSpecial) {
        void patchTx(r.id, {
          ownership: "shared",
          ...(wasSpecial ? { isPayment: false } : {}),
          skipReintegroOffer: true,
        });
      }
      return;
    }
    // Move to another household
    setError(null);
    setSavingId(r.id);
    const prev = txs;
    setTxs((list) => list.filter((x) => x.id !== r.id));
    try {
      const res = await fetch("/api/transactions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ id: r.id, targetHouseholdId: value }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setTxs(prev);
        setError(data?.error || "No se pudo mover");
        return;
      }
      const dest = households.find((h) => h.id === value)?.name ?? "otro hogar";
      setToast(`Movido a ${dest}.`);
      void loadStats();
    } catch (e) {
      setTxs(prev);
      setError(e instanceof Error ? e.message : "Error de red");
    } finally {
      setSavingId(null);
    }
  }

  async function applyReintegro(all: boolean) {
    if (!reintegroPrompt) return;
    // Already marked via Tipo → "Reintegro hogar"; Solo este just closes.
    if (!reintegroPrompt.pending && !all) {
      setReintegroPrompt(null);
      setToast("Marcado como reintegro de servicios (no cuenta en la neta).");
      return;
    }
    setReintegroBusy(true);
    try {
      await patchTx(reintegroPrompt.txId, {
        householdReimbursement: true,
        applyToSimilar: all,
      });
    } finally {
      setReintegroBusy(false);
    }
  }

  async function applyCubierto(all: boolean) {
    if (!cubiertoPrompt) return;
    if (!cubiertoPrompt.pending && !all) {
      setCubiertoPrompt(null);
      setToast("Marcado como cubierto (no cuenta en la neta).");
      return;
    }
    setCubiertoBusy(true);
    try {
      await patchTx(cubiertoPrompt.txId, {
        householdBillCovered: true,
        applyToSimilar: all,
      });
    } finally {
      setCubiertoBusy(false);
    }
  }

  if (loading && months.length === 0 && !chart) {
    return <LoadingBlock label="Calculando análisis…" />;
  }

  if (error && months.length === 0) {
    return (
      <p className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
        {error}
      </p>
    );
  }

  const emptyHint = (
    <EmptyState
      icon={<LayoutList className="h-7 w-7" />}
      title="Todavía no hay nada para armar"
      description="Cargá un resumen y acá se ordena solo, mes a mes."
    />
  );

  if (mode === "charts") {
    return (
      <div className="space-y-4">
        <OwnershipFilterBar ownershipF={ownershipF} setOwnershipF={setOwnershipF} />
        <GastoInsights ownership={ownershipF} />
        {periods.length === 0 ? emptyHint : <ChartsPanel chart={chart} />}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {periods.length > 0 && (
          <div className="flex w-full items-center gap-2">
            <select
              value={filterPeriod}
              onChange={(e) => setFilterPeriod(e.target.value)}
              className="lc-input min-w-0 flex-1"
            >
              <option value="all">Todos los meses</option>
              {periods.map((p) => (
                <option key={p} value={p}>
                  {formatPeriodLabel(p)}
                </option>
              ))}
            </select>
            {filterPeriod !== "all" && (
              <div className="ml-auto flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={goPrev}
                  disabled={!canPrev}
                  aria-label="Mes anterior"
                  className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--surface)] text-[var(--foreground)] transition hover:bg-[var(--surface-muted)] disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={goNext}
                  disabled={!canNext}
                  aria-label="Mes siguiente"
                  className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--surface)] text-[var(--foreground)] transition hover:bg-[var(--surface-muted)] disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>
        )}
        <OwnershipFilterBar ownershipF={ownershipF} setOwnershipF={setOwnershipF} />
      </div>

      {reintegroPrompt ? (
        <ReintegroHogarToast
          prompt={reintegroPrompt}
          busy={reintegroBusy || savingId === reintegroPrompt.txId}
          onApply={() => void applyReintegro(true)}
          onSoloEste={() => void applyReintegro(false)}
          onDismiss={() => {
            const prompt = reintegroPrompt;
            setReintegroPrompt(null);
            setToast(null);
            if (prompt.declineToShared) {
              void patchTx(prompt.txId, {
                ownership: "shared",
                skipReintegroOffer: true,
              });
            }
          }}
        />
      ) : cubiertoPrompt ? (
        <GastoCubiertoToast
          prompt={cubiertoPrompt}
          busy={cubiertoBusy || savingId === cubiertoPrompt.txId}
          onApply={() => void applyCubierto(true)}
          onSoloEste={() => void applyCubierto(false)}
          onDismiss={() => {
            setCubiertoPrompt(null);
            setToast(null);
          }}
        />
      ) : applyPrompt ? (
        <ApplyCriterionToast
          prompt={applyPrompt}
          busy={applyBusy || savingId === applyPrompt.txId}
          onApply={() => void applyCriterion()}
          onSoloEste={() => {
            setApplyPrompt(null);
            setToast("Guardado.");
          }}
        />
      ) : (
        toast && <Toast>{toast}</Toast>
      )}
      {error && months.length > 0 && (
        <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40">
          {error}
        </p>
      )}

      {periods.length === 0 ? (
        emptyHint
      ) : filterPeriod === "all" ? (
        <MonthDetail
          month={grand}
          isGrand
          expanded={expanded}
          onToggle={toggleExpand}
          txsByCat={txsByCat}
          categories={categories}
          households={households}
          activeHouseholdId={activeHouseholdId}
          txsLoading={txsLoading}
          savingId={savingId}
          onChangeCategory={changeCategory}
          onAssignChange={onAssignChange}
          onToggleBusiness={onToggleBusiness}
        />
      ) : selectedMonth ? (
        <MonthDetail
          month={selectedMonth}
          expanded={expanded}
          onToggle={toggleExpand}
          txsByCat={txsByCat}
          categories={categories}
          households={households}
          activeHouseholdId={activeHouseholdId}
          txsLoading={txsLoading}
          savingId={savingId}
          onChangeCategory={changeCategory}
          onAssignChange={onAssignChange}
          onToggleBusiness={onToggleBusiness}
        />
      ) : (
        <p className="text-sm text-zinc-500">
          Sin movimientos en {formatPeriodLabel(filterPeriod)}. Elegí otro mes o
          &quot;Todos los meses&quot;.
        </p>
      )}
    </div>
  );
}

function OwnershipFilterBar({
  ownershipF,
  setOwnershipF,
}: {
  ownershipF: OwnershipFilter;
  setOwnershipF: (v: OwnershipFilter) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filtrar por tipo">
      <span className="mr-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-fg)]">
        Tipo
      </span>
      <OwnershipChip active={ownershipF === "all"} onClick={() => setOwnershipF("all")}>
        Todos
      </OwnershipChip>
      <OwnershipChip
        active={ownershipF === "personal"}
        onClick={() => setOwnershipF("personal")}
      >
        Personal
      </OwnershipChip>
      <OwnershipChip
        active={ownershipF === "shared"}
        onClick={() => setOwnershipF("shared")}
      >
        Hogar
      </OwnershipChip>
    </div>
  );
}

function ChartsPanel({ chart }: { chart: ChartData | null }) {
  if (!chart || chart.periods.length === 0) {
    return (
      <EmptyState
        icon={<LineChart className="h-7 w-7" />}
        title="Todavía no hay curva"
        description="Cuando haya movimientos, acá se ve cómo viene el mes."
      />
    );
  }
  return (
    <div className="space-y-4">
      <Surface>
        <h3 className="mb-1 text-sm font-semibold tracking-tight">
          Gasto total por mes
        </h3>
        <p className="mb-3 text-xs text-zinc-500">
          En pesos (los dólares se convierten al tipo de cambio de fin de mes).
        </p>
        <TotalSpendChart totals={chart.totals} />
      </Surface>
      <Surface>
        <h3 className="mb-1 text-sm font-semibold tracking-tight">
          Por categoría
        </h3>
        <p className="mb-3 text-xs text-zinc-500">
          Tocá una categoría para mostrarla u ocultarla.
        </p>
        <CategoryLinesChart
          periods={chart.periods}
          byCategory={chart.byCategory}
        />
      </Surface>
    </div>
  );
}

function TotalRow({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone: "pesos" | "dolares" | "neto" | "cubierto";
  hint?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-xl px-3 py-2.5",
        tone === "pesos" && "bg-[var(--sky)] text-[var(--on-accent)]",
        tone === "dolares" &&
          "bg-[var(--ok)] text-[var(--on-accent)]",
        tone === "neto" &&
          "bg-[var(--warn)] text-[var(--on-accent)]",
        tone === "cubierto" &&
          "bg-[var(--a2)] text-[var(--on-accent)]",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-semibold uppercase tracking-wide opacity-90">
          {label}
        </span>
        {hint ? (
          <span className="mt-0.5 block text-[10px] font-medium leading-snug opacity-80">
            {hint}
          </span>
        ) : null}
      </span>
      <span className="lc-amount max-w-[58%] text-right text-sm font-bold tracking-tight">
        {value}
      </span>
    </div>
  );
}

function formatCubiertoValue(c: CubiertoBlock): string {
  const parts: string[] = [];
  if (c.amountArs > 0) parts.push(formatArs(c.amountArs));
  if (c.amountUsd > 0) parts.push(formatUsd(c.amountUsd));
  if (parts.length === 0) {
    const combined =
      c.amountArsCombined ?? c.amountArs + (c.amountArsFromUsd ?? 0);
    return combined > 0 ? formatArs(combined) : formatArs(0);
  }
  return parts.join(" · ");
}

function MonthDetail({
  month,
  isGrand = false,
  expanded,
  onToggle,
  txsByCat,
  categories,
  households,
  activeHouseholdId,
  txsLoading,
  savingId,
  onChangeCategory,
  onAssignChange,
  onToggleBusiness,
}: {
  month: MonthBlock;
  isGrand?: boolean;
  expanded: Set<string>;
  onToggle: (slug: string) => void;
  txsByCat: Map<string, Tx[]>;
  categories: CategoryOpt[];
  households: HouseholdOption[];
  activeHouseholdId: string | null;
  txsLoading: boolean;
  savingId: string | null;
  onChangeCategory: (txId: string, categoryId: string) => void;
  onAssignChange: (tx: Tx, value: string) => void;
  onToggleBusiness: (tx: Tx) => void;
}) {
  const combined = monthTotalArs(month);
  const rateLabel = formatUsdRateLabel(month.usdRate);

  return (
    <section className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-sm">
      <div className="space-y-1.5 border-b border-[var(--border)] px-3 py-3 sm:px-4">
        <TotalRow label="Pesos" value={formatArs(month.totalArs)} tone="pesos" />
        <TotalRow label="Dólares" value={formatUsd(month.totalUsd)} tone="dolares" />
        <TotalRow label="Neto" value={formatArs(combined)} tone="neto" />
        {month.cubierto && month.cubierto.count > 0 ? (
          <TotalRow
            label="Cubiertos"
            value={formatCubiertoValue(month.cubierto)}
            tone="cubierto"
            hint={`${month.cubierto.count} fuera de neta · no inflan el gasto`}
          />
        ) : null}
        <p className="px-1 text-[10px] leading-snug text-[var(--muted-fg)]">
          Neto = pesos + dólares convertidos al TC del mes
          {month.cubierto && month.cubierto.count > 0
            ? " · Cubiertos = servicios hogar ya liquidados (Tipo Cubierto)"
            : ""}
        </p>
      </div>

      <div className="divide-y divide-[var(--border)]">
        {month.categories.map((c) => {
          const open = expanded.has(c.slug);
          const list = txsByCat.get(c.slug) ?? [];
          const catCombined =
            c.amountArsCombined ?? c.amountArs + (c.amountArsFromUsd ?? 0);
          return (
            <div key={c.slug + c.name}>
              <button
                type="button"
                onClick={() => onToggle(c.slug)}
                className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left transition hover:bg-[var(--surface-muted)]"
              >
                <span className="flex min-w-0 flex-1 items-center gap-3">
                  <ChevronDown
                    className={cn(
                      "h-4 w-4 shrink-0 text-[var(--muted-fg)] transition",
                      open && "rotate-180",
                    )}
                  />
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: colorForCategory(c.slug) }}
                  />
                  <span className="min-w-0 truncate font-medium">{c.name}</span>
                  <span className="shrink-0 text-xs text-[var(--muted-fg)]">{c.count}×</span>
                </span>
                <span className="ml-auto text-right">
                  <span className="block text-sm font-semibold tabular-nums">
                    {catCombined > 0 ? formatArs(catCombined) : "—"}
                  </span>
                </span>
                <span className="w-full space-y-0.5 pl-9 text-xs">
                  {c.amountArs > 0 && (
                    <span className="mr-3 inline-flex items-center gap-1 rounded-md bg-sky-500/15 px-1.5 py-0.5 text-sky-800 dark:text-sky-200">
                      <span className="font-semibold">Pesos</span>
                      {formatArs(c.amountArs)}
                    </span>
                  )}
                  {c.amountUsd > 0 && (
                    <span className="mr-3 inline-flex items-center gap-1 rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-emerald-800 dark:text-emerald-200">
                      <span className="font-semibold">Dólares</span>
                      {formatUsd(c.amountUsd)}
                    </span>
                  )}
                  <span className="text-[var(--muted-fg)]">{c.pct.toFixed(1)}% del mes</span>
                </span>
              </button>

              {open && (
                <div className="border-t border-[var(--border)] bg-[var(--surface-muted)]/60 px-2 py-2 sm:px-4">
                  {txsLoading && list.length === 0 ? (
                    <p className="px-2 py-2 text-xs text-[var(--muted-fg)]">Cargando gastos…</p>
                  ) : list.length === 0 ? (
                    <p className="px-2 py-2 text-xs text-[var(--muted-fg)]">
                      No hay gastos listados en esta categoría.
                    </p>
                  ) : (
                    <ul className="space-y-1.5">
                      {list.map((t) => (
                        <MesAMesTxRow
                          key={t.id}
                          t={t}
                          categories={categories}
                          households={households}
                          activeHouseholdId={activeHouseholdId}
                          savingId={savingId}
                          onChangeCategory={onChangeCategory}
                          onAssignChange={onAssignChange}
                          onToggleBusiness={onToggleBusiness}
                        />
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="border-t border-[var(--border)] px-4 py-3 text-center">
        <p className="text-xs text-[var(--muted-fg)]">
          {month.totalCount} movimiento{month.totalCount === 1 ? "" : "s"}
          {isGrand ? " en total" : ""}
        </p>
        {rateLabel && (
          <p className="mt-1 text-[11px] text-[var(--muted-fg)]">{rateLabel}</p>
        )}
      </div>
    </section>
  );
}
