"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  formatArs,
  formatUsd,
  formatDateAr,
  currentPeriodAr,
  cn,
} from "@/lib/utils";
import { formatPeriodLabel, formatPeriodTitle, formatPeriodShort } from "@/lib/period-label";
import { HogarSkeleton, PageStack, SegmentedControl } from "@/components/ui";
import { SectionNav } from "@/components/section-nav";
import { HogarCharts } from "@/components/hogar-charts";
import { HouseholdSwitcher } from "@/components/household-switcher";
import { CreateHouseholdButton } from "@/components/create-household";
import { CategoryIcon } from "@/lib/category-icons";
import { colorForCategory, tint } from "@/lib/category-colors";
import {
  getServerSkipped,
  getSkippedSnapshot,
  subscribeHomeLayout,
  writeSkipped,
} from "@/lib/home-layout";
import { isAbortError } from "@/hooks/use-json-resource";
import {
  ArrowDownRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Home,
  LayoutList,
  LineChart,
  Link2,
  Minus,
  UserPlus,
  X,
} from "lucide-react";

type Member = {
  userId: string;
  name: string;
  paidArs: number;
  pct: number;
};

type Cat = {
  slug: string;
  name: string;
  total: number;
  count: number;
  pct: number;
};

type ReceiptItem = {
  id: string;
  name: string;
  quantity: number | null;
  unitPrice: number | null;
  lineTotal: number | null;
  productCategory: string | null;
};

type Expense = {
  id: string;
  date: string;
  description: string;
  amountArs: number | null;
  amountUsd: number | null;
  amountCombined: number;
  categorySlug: string;
  categoryName: string;
  paidByName: string;
  hasTicket: boolean;
  receiptItems: ReceiptItem[];
};

type ViewTab = "vista" | "charts";

/** Fixed household services shown as a permanent checklist in Hogar. */
const FIXED_SERVICES: Array<{ slug: string; name: string }> = [
  { slug: "alquiler", name: "Alquiler" },
  { slug: "luz", name: "Luz" },
  { slug: "agua", name: "Agua" },
  { slug: "gas", name: "Gas" },
  { slug: "internet", name: "Internet" },
];

function tabFromParam(raw: string | null): ViewTab {
  return raw === "charts" ? "charts" : "vista";
}

function firstName(name: string) {
  const n = name.trim();
  return n ? (n.split(/\s+/)[0] ?? n) : "Sin nombre";
}

function periodOfDate(date: string): string {
  return date.slice(0, 7);
}

export function CompartidoView() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const urlTab = tabFromParam(searchParams.get("tab"));
  const [viewTab, setViewTab] = useState<ViewTab>(urlTab);
  const [seenTab, setSeenTab] = useState(urlTab);
  if (urlTab !== seenTab) {
    setSeenTab(urlTab);
    setViewTab(urlTab);
  }
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [categories, setCategories] = useState<Cat[]>([]);
  const [periods, setPeriods] = useState<string[]>([]);
  const [period, setPeriod] = useState(currentPeriodAr);
  const [prevPeriod, setPrevPeriod] = useState<string | null>(null);
  const [prevTotalArs, setPrevTotalArs] = useState(0);
  const [members, setMembers] = useState<Member[]>([]);
  const [householdName, setHouseholdName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [total, setTotal] = useState(0);
  const [expenseCount, setExpenseCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [copied, setCopied] = useState<"code" | "link" | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [ticketOpen, setTicketOpen] = useState<Set<string>>(new Set());
  const [reloadKey, setReloadKey] = useState(0);
  const [servicesOpen, setServicesOpen] = useState(false);
  const skipped = useSyncExternalStore(
    subscribeHomeLayout,
    getSkippedSnapshot,
    getServerSkipped,
  );
  const requestKey = `${period}\0${reloadKey}`;
  const [seenRequest, setSeenRequest] = useState(requestKey);
  if (requestKey !== seenRequest) {
    setSeenRequest(requestKey);
    setLoading(true);
    setError(null);
  }

  const onViewTab = useCallback(
    (v: ViewTab) => {
      setViewTab(v);
      router.replace(`/compartido?tab=${v}`, { scroll: false });
    },
    [router],
  );

  useEffect(() => {
    const ac = new AbortController();
    const q =
      period === "all"
        ? "?period=all"
        : `?period=${encodeURIComponent(period)}`;
    fetch(`/api/stats/compartido${q}`, {
      credentials: "include",
      signal: ac.signal,
    })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Error");
        return data;
      })
      .then((data) => {
        if (ac.signal.aborted) return;
        setExpenses(data.expenses ?? []);
        setCategories(data.categories ?? []);
        setPeriods(data.periods ?? []);
        setMembers(data.members ?? []);
        setInviteCode(data.inviteCode ?? "");
        setHouseholdName(data.householdName ?? "");
        setPrevPeriod(data.prevPeriod ?? null);
        setPrevTotalArs(data.prevTotalArs ?? 0);
        setTotal(data.summary?.totalArsCombined ?? 0);
        setExpenseCount(data.summary?.expenseCount ?? 0);
        setError(null);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted || isAbortError(e)) return;
        setError(e instanceof Error ? e.message : "Error de red");
        setLoading(false);
      });
    return () => ac.abort();
  }, [period, reloadKey]);

  useEffect(() => {
    function onCreated() {
      setReloadKey((k) => k + 1);
    }
    window.addEventListener("lc:expense-created", onCreated);
    window.addEventListener("lc:card-imported", onCreated);
    window.addEventListener("lc:household-switched", onCreated);
    return () => {
      window.removeEventListener("lc:expense-created", onCreated);
      window.removeEventListener("lc:card-imported", onCreated);
      window.removeEventListener("lc:household-switched", onCreated);
    };
  }, []);

  const inviteLink =
    typeof window !== "undefined" && inviteCode
      ? `${window.location.origin}/onboarding?invite=${encodeURIComponent(inviteCode)}`
      : inviteCode
        ? `/onboarding?invite=${encodeURIComponent(inviteCode)}`
        : "";

  async function copyText(text: string, kind: "code" | "link") {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 1600);
    } catch {
      /* ignore */
    }
  }

  function toggleCat(slug: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }

  function toggleTicket(id: string) {
    setTicketOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSkipped(slug: string) {
    const next = new Set(skipped);
    if (next.has(slug)) next.delete(slug);
    else next.add(slug);
    writeSkipped(next);
  }

  /** Checklist period: selected month, or current month when viewing "all". */
  const checklistPeriod = period === "all" ? currentPeriodAr() : period;

  const fixedServiceStatus = useMemo(() => {
    return FIXED_SERVICES.map((svc) => {
      const list = expenses.filter((e) => {
        if (e.categorySlug !== svc.slug) return false;
        if (period === "all") return periodOfDate(e.date) === checklistPeriod;
        return true;
      });
      const totalArs = list.reduce((s, e) => s + e.amountCombined, 0);
      const payers = [
        ...new Set(list.map((e) => firstName(e.paidByName)).filter(Boolean)),
      ];
      const na = skipped.has(svc.slug);
      return {
        ...svc,
        paid: list.length > 0,
        na,
        totalArs,
        count: list.length,
        payers,
        expenses: list,
      };
    });
  }, [expenses, period, checklistPeriod, skipped]);

  const applicable = fixedServiceStatus.filter((s) => !s.na);
  const paidCount = applicable.filter((s) => s.paid).length;
  const applicableCount = applicable.length;
  const allFixedPaid =
    applicableCount > 0 && paidCount === applicableCount;

  if (loading && expenses.length === 0 && total === 0 && viewTab === "vista") {
    return <HogarSkeleton />;
  }
  if (error) {
    return (
      <p className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40">
        {error}
      </p>
    );
  }

  const delta =
    prevTotalArs > 0 ? ((total - prevTotalArs) / prevTotalArs) * 100 : null;
  const DeltaIcon =
    delta == null || Math.abs(delta) < 0.5
      ? Minus
      : delta > 0
        ? ArrowUpRight
        : ArrowDownRight;
  const deltaColor =
    delta == null || Math.abs(delta) < 0.5
      ? "text-[var(--muted-fg)]"
      : delta > 0
        ? "text-amber-700 dark:text-amber-400"
        : "text-[var(--brand-fg)]";
  const barPct =
    prevTotalArs > 0
      ? Math.min(120, (total / prevTotalArs) * 100)
      : total > 0
        ? 100
        : 0;

  return (
    <PageStack className="!space-y-4">
      <SectionNav section="hogar" />
      <SegmentedControl
        value={viewTab}
        onChange={onViewTab}
        className="w-full"
        options={[
          {
            id: "vista",
            label: "Vista",
            icon: <LayoutList className="h-3.5 w-3.5" />,
          },
          {
            id: "charts",
            label: "Gráficos",
            icon: <LineChart className="h-3.5 w-3.5" />,
          },
        ]}
      />

      <div className="min-h-[40vh] space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="min-w-0 truncate text-[1.65rem] font-semibold tracking-tight">
            {householdName || "Hogar"}
          </h1>
          <HouseholdSwitcher />
          <CreateHouseholdButton />
          {inviteCode && (
            <button
              type="button"
              onClick={() => setInviteOpen(true)}
              className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3.5 py-1 text-[13px] font-semibold text-[var(--text)] transition hover:bg-[var(--brand-soft)]"
            >
              <UserPlus className="h-3.5 w-3.5" />
              Invitar
            </button>
          )}
        </div>

        {viewTab === "charts" ? (
          <HogarCharts />
        ) : (
          <>
            <div className="flex w-full items-center gap-2">
              <select
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
                className="lc-input min-w-0 flex-1"
              >
                <option value="all">Todos los meses</option>
                {periods.map((p) => (
                  <option key={p} value={p}>
                    {formatPeriodTitle(p)}
                  </option>
                ))}
                {period !== "all" && !periods.includes(period) && (
                  <option value={period}>{formatPeriodTitle(period)}</option>
                )}
              </select>
            </div>

            <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 text-center">
              <p className="text-4xl font-semibold tabular-nums tracking-tight text-[var(--foreground)]">
                {formatArs(total)}
              </p>
              {period !== "all" && (
                <div className="relative mx-auto mt-3 max-w-[240px]">
                  <div className="h-1 overflow-hidden rounded-full bg-[var(--surface-muted)]">
                    <div
                      className={cn(
                        "h-full rounded-full transition-all duration-700",
                        barPct >= 100 ? "bg-amber-500/90" : "bg-[var(--brand)]",
                      )}
                      style={{ width: `${Math.min(100, barPct)}%` }}
                    />
                  </div>
                  <div className="mt-1.5 flex items-center justify-center gap-2 text-[11px] text-[var(--muted-fg)]">
                    {prevPeriod && (
                      <span className="tabular-nums">
                        vs {formatPeriodShort(prevPeriod)} ·{" "}
                        {formatArs(prevTotalArs)}
                      </span>
                    )}
                    {delta != null && (
                      <span
                        className={cn(
                          "inline-flex items-center gap-0.5 font-medium",
                          deltaColor,
                        )}
                      >
                        <DeltaIcon className="h-3.5 w-3.5" />
                        {Math.abs(delta).toFixed(0)}%
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
              <button
                type="button"
                onClick={() => setServicesOpen((v) => !v)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-[var(--surface-muted)]"
              >
                <ChevronDown
                  className={cn(
                    "h-4 w-4 shrink-0 text-[var(--muted-fg)] transition",
                    servicesOpen && "rotate-180",
                  )}
                />
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-muted)] text-[var(--muted-fg)]">
                  <Home className="h-4 w-4" strokeWidth={1.75} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">Servicios de la casa</p>
                  <p className="text-xs text-[var(--muted-fg)]">
                    {formatPeriodLabel(checklistPeriod)}
                    {period === "all" ? " · mes actual" : ""}
                    {applicableCount > 0 && (
                      <>
                        {" · "}
                        <span
                          className={
                            allFixedPaid
                              ? "font-medium text-[var(--brand-fg)]"
                              : "font-medium text-amber-700 dark:text-amber-400"
                          }
                        >
                          {paidCount}/{applicableCount} pagos
                        </span>
                      </>
                    )}
                  </p>
                </div>
              </button>

              {servicesOpen && (
                <>
                  <ul className="divide-y divide-[var(--border)] border-t border-[var(--border)]">
                    {fixedServiceStatus.map((svc) => {
                      const color = colorForCategory(svc.slug);
                      return (
                        <li
                          key={svc.slug}
                          className={cn(
                            "flex items-center gap-3 px-4 py-3",
                            svc.na && "opacity-60",
                          )}
                        >
                          <span
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                            style={{ backgroundColor: tint(color, 14), color }}
                          >
                            <CategoryIcon slug={svc.slug} size={16} />
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium">{svc.name}</p>
                            {svc.na ? (
                              <p className="text-xs text-[var(--muted-fg)]">
                                No aplica en este hogar
                              </p>
                            ) : svc.paid ? (
                              <p className="text-xs text-[var(--muted-fg)]">
                                {svc.payers.length > 0
                                  ? `Pagó ${svc.payers.join(", ")}`
                                  : "Registrado"}
                                {svc.count > 1
                                  ? ` · ${svc.count} cargos`
                                  : ""}
                              </p>
                            ) : (
                              <p className="text-xs text-amber-700 dark:text-amber-400">
                                Sin cargar este mes
                              </p>
                            )}
                          </div>
                          <div className="flex shrink-0 flex-col items-end gap-1.5">
                            {svc.na ? (
                              <button
                                type="button"
                                onClick={() => toggleSkipped(svc.slug)}
                                className="inline-flex min-h-10 min-w-10 cursor-pointer items-center justify-center rounded-full border border-[var(--border)] px-3 text-[11px] font-semibold text-[var(--muted-fg)] transition hover:bg-[var(--surface-muted)]"
                              >
                                Reactivar
                              </button>
                            ) : svc.paid ? (
                              <>
                                <p className="text-sm font-semibold tabular-nums">
                                  {formatArs(svc.totalArs)}
                                </p>
                                <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--brand-fg)]">
                                  <Check className="h-3 w-3" />
                                  Pagado
                                </span>
                              </>
                            ) : (
                              <button
                                type="button"
                                onClick={() => toggleSkipped(svc.slug)}
                                className="inline-flex min-h-10 min-w-10 cursor-pointer items-center justify-center rounded-full border border-[var(--border)] px-3 text-[11px] font-semibold text-[var(--muted-fg)] transition hover:bg-[var(--surface-muted)]"
                              >
                                No aplica
                              </button>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  <p className="border-t border-[var(--border)] px-4 py-2.5 text-[11px] leading-relaxed text-[var(--muted-fg)]">
                    Si no usan gas u otro servicio, tocá <strong>No aplica</strong>.
                  </p>
                </>
              )}
            </div>

            <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
              <div className="border-b border-[var(--border)] px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--muted-fg)]">
                  Por categoría
                </p>
              </div>
              {categories.length === 0 ? (
                <p className="p-6 text-center text-[15px] leading-relaxed text-[var(--muted-fg)]">
                  Todavía no hay gastos de hogar este período. En Consumos,
                  marcá el tipo como <strong>Hogar</strong>.
                </p>
              ) : (
                <ul className="divide-y divide-[var(--border)]">
                  {categories.map((c) => {
                    const open = expanded.has(c.slug);
                    const list = expenses.filter(
                      (e) => e.categorySlug === c.slug,
                    );
                    const color = colorForCategory(c.slug);
                    return (
                      <li key={c.slug}>
                        <button
                          type="button"
                          onClick={() => toggleCat(c.slug)}
                          className="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left transition hover:bg-[var(--surface-muted)]"
                        >
                          <ChevronDown
                            className={cn(
                              "h-4 w-4 shrink-0 text-[var(--muted-fg)] transition",
                              open && "rotate-180",
                            )}
                          />
                          <span
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                            style={{ backgroundColor: tint(color, 14), color }}
                          >
                            <CategoryIcon slug={c.slug} size={16} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">
                              {c.name}
                            </span>
                            <span className="text-xs text-[var(--muted-fg)]">
                              {c.count}× · {c.pct.toFixed(0)}%
                            </span>
                          </span>
                          <span className="shrink-0 text-sm font-semibold tabular-nums">
                            {formatArs(c.total)}
                          </span>
                        </button>
                        {open && (
                          <ul className="space-y-1.5 bg-[var(--surface-muted)]/50 px-3 py-2">
                            {list.map((e) => {
                              const ticketShown = ticketOpen.has(e.id);
                              const hasItems = e.receiptItems?.length > 0;
                              return (
                                <li
                                  key={e.id}
                                  className="rounded-xl border border-[var(--border)] bg-[var(--surface)]"
                                >
                                  <div className="flex items-start justify-between gap-2 px-3 py-2">
                                    <div className="min-w-0">
                                      <p className="text-sm font-medium leading-snug">
                                        {e.description}
                                        {e.hasTicket && (
                                          <span className="ml-1.5 rounded-full bg-[var(--a2)] px-2 py-0.5 text-[10px] font-semibold uppercase text-[var(--on-accent)]">
                                            Ticket
                                          </span>
                                        )}
                                      </p>
                                      <p className="mt-0.5 text-xs text-[var(--muted-fg)]">
                                        {formatDateAr(e.date)} ·{" "}
                                        {firstName(e.paidByName)}
                                      </p>
                                    </div>
                                    <div className="shrink-0 text-right">
                                      {e.amountArs != null && e.amountArs > 0 && (
                                        <p className="text-sm font-semibold tabular-nums">
                                          {formatArs(e.amountArs)}
                                        </p>
                                      )}
                                      {e.amountUsd != null && e.amountUsd > 0 && (
                                        <p className="text-xs tabular-nums text-emerald-700 dark:text-emerald-300">
                                          {formatUsd(e.amountUsd)}
                                        </p>
                                      )}
                                      {e.amountArs == null &&
                                        e.amountUsd == null && (
                                          <p className="text-sm tabular-nums">
                                            {formatArs(e.amountCombined)}
                                          </p>
                                        )}
                                    </div>
                                  </div>
                                  {hasItems && (
                                    <>
                                      <button
                                        type="button"
                                        onClick={() => toggleTicket(e.id)}
                                        className="flex w-full cursor-pointer items-center justify-center gap-1 border-t border-[var(--border)] py-1.5 text-xs font-medium text-[var(--brand-fg)]"
                                      >
                                        {ticketShown ? (
                                          <ChevronDown className="h-3.5 w-3.5" />
                                        ) : (
                                          <ChevronRight className="h-3.5 w-3.5" />
                                        )}
                                        {ticketShown
                                          ? "Ocultar ítems"
                                          : `Ver ${e.receiptItems.length} ítems`}
                                      </button>
                                      {ticketShown && (
                                        <ul className="space-y-1.5 border-t border-[var(--border)] bg-[var(--surface-muted)]/50 px-3 py-2">
                                          {e.receiptItems.map((it) => (
                                            <li
                                              key={it.id}
                                              className="flex items-start justify-between gap-2 text-sm"
                                            >
                                              <div className="min-w-0">
                                                <p className="leading-snug">
                                                  {it.name}
                                                </p>
                                                {it.productCategory && (
                                                  <p className="text-[11px] text-[var(--muted-fg)]">
                                                    {it.productCategory}
                                                  </p>
                                                )}
                                              </div>
                                              <span className="shrink-0 tabular-nums text-[var(--muted-fg)]">
                                                {it.quantity &&
                                                it.quantity !== 1
                                                  ? `${it.quantity}× `
                                                  : ""}
                                                {formatArs(it.lineTotal)}
                                              </span>
                                            </li>
                                          ))}
                                        </ul>
                                      )}
                                    </>
                                  )}
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {expenseCount > 0 && (
                <p className="border-t border-[var(--border)] px-4 py-3 text-center text-xs text-[var(--muted-fg)]">
                  {expenseCount} gasto{expenseCount === 1 ? "" : "s"} compartido
                  {expenseCount === 1 ? "" : "s"}
                </p>
              )}
            </div>

            {members.some((m) => m.paidArs > 0) && (
              <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
                <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--muted-fg)]">
                  Quién pagó
                </p>
                <ul className="space-y-3">
                  {members
                    .filter((m) => m.paidArs > 0)
                    .sort((a, b) => b.paidArs - a.paidArs)
                    .map((m) => (
                      <li key={m.userId} className="text-sm">
                        <div className="mb-1.5 flex items-baseline justify-between gap-2">
                          <span className="font-medium">
                            {firstName(m.name)}
                          </span>
                          <span className="tabular-nums">
                            <span className="font-semibold">
                              {formatArs(m.paidArs)}
                            </span>
                            <span className="ml-1.5 text-xs text-[var(--muted-fg)]">
                              {m.pct.toFixed(0)}% del total
                            </span>
                          </span>
                        </div>
                        <div className="h-1 overflow-hidden rounded-full bg-[var(--surface-muted)]">
                          <div
                            className="h-full rounded-full bg-[var(--brand)]"
                            style={{
                              width: `${Math.min(Math.max(m.pct, 0), 100)}%`,
                            }}
                          />
                        </div>
                      </li>
                    ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>

      {inviteOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
        >
          <button
            type="button"
            className="absolute inset-0 bg-[#121110]/55 backdrop-blur-[2px]"
            aria-label="Cerrar"
            onClick={() => setInviteOpen(false)}
          />
          <div className="relative z-10 w-full max-w-sm overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-[var(--muted-fg)]">
                  Hogar
                </p>
                <h2 className="mt-0.5 text-lg font-semibold tracking-tight">
                  Invitar al hogar
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setInviteOpen(false)}
                className="rounded-full p-1.5 text-[var(--muted-fg)] hover:bg-[var(--surface-muted)]"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="mt-4 space-y-3">
              <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/50 p-3">
                <p className="text-xs font-medium text-[var(--muted-fg)]">Código</p>
                <p className="mt-1 font-mono text-xl font-bold tracking-widest">
                  {inviteCode}
                </p>
                <button
                  type="button"
                  onClick={() => void copyText(inviteCode, "code")}
                  className="mt-2 inline-flex items-center gap-1.5 text-sm font-semibold text-[var(--brand-fg)]"
                >
                  <Copy className="h-3.5 w-3.5" />
                  {copied === "code" ? "¡Copiado!" : "Copiar código"}
                </button>
              </div>

              {inviteLink && (
                <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/50 p-3">
                  <p className="text-xs font-medium text-[var(--muted-fg)]">Link</p>
                  <p className="mt-1 break-all text-xs text-[var(--muted-fg)]">
                    {inviteLink}
                  </p>
                  <button
                    type="button"
                    onClick={() => void copyText(inviteLink, "link")}
                    className="mt-2 inline-flex items-center gap-1.5 text-sm font-semibold text-[var(--brand-fg)]"
                  >
                    <Link2 className="h-3.5 w-3.5" />
                    {copied === "link" ? "¡Copiado!" : "Copiar link"}
                  </button>
                </div>
              )}

              <p className="text-xs leading-relaxed text-[var(--muted-fg)]">
                Mandale el código o el link. Entra con Google y queda en este
                hogar, viendo lo compartido.
              </p>
            </div>
          </div>
        </div>
      )}
    </PageStack>
  );
}
