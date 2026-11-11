"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown, ChevronLeft, ChevronRight, Download, FileSpreadsheet, FileText, Search, SlidersHorizontal, X, List,
} from "lucide-react";
import * as XLSX from "xlsx";
import { formatArs, formatPesos, formatUsd, cn, currentPeriodAr, periodFromDateString } from "@/lib/utils";
import { CategoryIcon } from "@/lib/category-icons";
import { colorForCategory, tint } from "@/lib/category-colors";
import { formatPeriodLabel, formatPeriodTitle } from "@/lib/period-label";
import { isAbortError } from "@/hooks/use-json-resource";
import { nextPage } from "@/lib/list-page";
import { EmptyState, ListSkeleton, Toast } from "@/components/ui";
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
import { isReintegroHogarTipo } from "@/lib/reintegro-hogar";
import { isGastoCubiertoTipo } from "@/lib/gasto-cubierto";
import { isTransferenciaInternaTipo } from "@/lib/bbva/bank-entries";
import { BusinessSyncToggle, type SyncStatus } from "@/components/business-sync-toggle";

type Category = { id: string; slug: string; name: string };
type Member = { userId: string; name: string };
type ReceiptItem = {
  id: string; name: string; quantity: number | null;
  unitPrice: number | null; lineTotal: number | null; productCategory: string | null;
};
type ReceiptInfo = {
  id: string; merchantName: string | null; receiptDate: string | null;
  totalArs: number | null; items: ReceiptItem[];
};
type Tx = {
  id: string; date: string; descriptionNormalized: string;
  amountArs: number | null; amountUsd: number | null; installment: string | null;
  isPayment: boolean; ownership: "personal" | "shared";
  /** Server flag: outbound-prefix payee OR bare payee. Missing on old responses. */
  reintegroHogar?: boolean;
  /** Server flag: outbound-prefix payee only. Missing on old responses. */
  reintegroPayee?: boolean;
  /** Generic transfer with no own account and no twin. Not stored. */
  revisar?: boolean;
  paidByUserId: string | null; source: string;
  linkedTransactionId?: string | null;
  linkedToInvoiceIog?: boolean;
  category: Category | null; hasTicket: boolean; receipt: ReceiptInfo | null;
  isBusiness?: boolean;
  syncStatus?: SyncStatus | null;
};

type HouseholdOption = { id: string; name: string };
type OwnershipFilter = "all" | "personal" | "shared";
type CategoryFilter = "all" | "uncategorized" | string;
type TicketFilter = "all" | "ticket" | "no-ticket";
type CurrencyFilter = "all" | "ars" | "usd";

const PRODUCT_SUBCATS = [
  "Lácteos","Panadería","Bebidas","Carnes","Verduras","Frutas",
  "Limpieza","Higiene","Snacks","Congelados","Almacén","Otros",
];
const PAGE_SIZES = [5, 10, 25, 50] as const;

const SHORT_MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/** "2026-11-04" → "4 nov". Sin año: el mes ya está arriba. */
function shortDate(date: string): string {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return date;
  return `${Number(m[3])} ${SHORT_MONTHS[Number(m[2]) - 1] ?? m[2]}`;
}

function memberLabel(m: Member) {
  const n = m.name.trim();
  return n ? (n.split(/\s+/)[0] ?? n) : "Sin nombre";
}
function categoryLabel(name?: string | null) {
  if (!name) return "—";
  return name.toLowerCase() === "uncategorized" ? "Sin categoría" : name;
}

/** Status only. Not a control: no click, no pointer, no tap target. */
function RevisarBadge({ size = "md" }: { size?: "sm" | "md" }) {
  return (
    <span
      className={
        size === "sm"
          ? "shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold text-amber-950 dark:bg-amber-900/50 dark:text-amber-100"
          : "shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-950 dark:bg-amber-900/50 dark:text-amber-100"
      }
    >
      Revisar
    </span>
  );
}

/** Amber IOG pill — keep shrink-0 so truncate never eats it. */
function IogBadge({ size = "md" }: { size?: "sm" | "md" }) {
  return (
    <span
      className={
        size === "sm"
          ? "shrink-0 rounded-full bg-[var(--warn)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[var(--on-accent)]"
          : "shrink-0 rounded-full bg-[var(--warn)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--on-accent)]"
      }
      title="Vinculado a Invoice IOG — no cuenta en la neta"
    >
      IOG
    </span>
  );
}

function hasAnyAmount(t: { amountArs: number | null; amountUsd: number | null }) {
  return (
    (t.amountArs != null && Number.isFinite(t.amountArs) && Math.abs(t.amountArs) > 0) ||
    (t.amountUsd != null && Number.isFinite(t.amountUsd) && Math.abs(t.amountUsd) > 0)
  );
}

/** Never wipe the last currency on blur of an empty field (imported rows). */
function nextAmountOnBlur(
  raw: string,
  current: number | null,
  other: number | null,
): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") {
    // Refuse to clear the only monto — keep current (incl. null → no patch).
    if (other == null || !Number.isFinite(other) || Math.abs(other) === 0) {
      return undefined; // skip patch
    }
    return null;
  }
  const n = Number(trimmed);
  if (Number.isNaN(n)) return undefined;
  return n;
}
type TxPayload = {
  error?: string;
  transactions?: Tx[];
  categories?: Category[];
  members?: Member[];
  total?: number;
  periods?: string[];
  iogCount?: number;
};

function normalizeTxPayload(data: TxPayload) {
  const list = (data.transactions ?? []).map((t) => ({
    ...t,
    ownership: t.ownership === "shared" ? ("shared" as const) : ("personal" as const),
    reintegroHogar: Boolean(t.reintegroHogar),
    reintegroPayee: Boolean(t.reintegroPayee),
    revisar: Boolean(t.revisar),
  }));
  return {
    list,
    total: data.total ?? list.length,
    iog: data.iogCount ?? 0,
    categories: data.categories ?? [],
    members: data.members ?? [],
    periods: data.periods ?? [],
  };
}

async function parseJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!text) throw new Error(res.ok ? "Respuesta vacía" : `Error ${res.status}`);
  try { return JSON.parse(text) as T; }
  catch {
    throw new Error(`Respuesta inválida (${res.status})`);
  }
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-1 text-xs font-medium transition",
        active
          ? "border-[var(--brand)]/40 bg-[var(--brand-soft)] text-[var(--brand-fg)]"
          : "border-[var(--border)] text-[var(--muted-fg)] hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)]",
      )}
    >
      {children}
    </button>
  );
}

function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function toSheet(rows: Tx[], members: Member[]) {
  return rows.map((r) => ({
    Fecha: r.date,
    Comercio: r.descriptionNormalized,
    "Monto $": r.amountArs ?? "",
    USD: r.amountUsd ?? "",
    Categoría: categoryLabel(r.category?.name),
    Tipo: isReintegroHogarTipo(r.isPayment, Boolean(r.reintegroHogar))
      ? "Reintegro hogar"
      : isTransferenciaInternaTipo(r.isPayment, r.category, r.descriptionNormalized)
        ? "Transferencia interna"
        : isGastoCubiertoTipo(r.isPayment, r.category)
          ? "Cubierto"
          : r.ownership === "shared"
            ? "Hogar"
            : "Personal",
    Pagó: (() => {
      const m = members.find((x) => x.userId === r.paidByUserId);
      return m ? memberLabel(m) : "";
    })(),
    Cuota: r.installment ?? "",
    Ticket: r.hasTicket ? "Sí" : "No",
  }));
}

export function TransactionsTable() {
  const [rows, setRows] = useState<Tx[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [period, setPeriod] = useState(currentPeriodAr);
  const [allPeriods, setAllPeriods] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [ownershipF, setOwnershipF] = useState<OwnershipFilter>("all");
  const [categoryF, setCategoryF] = useState<CategoryFilter>("all");
  const [ticketF, setTicketF] = useState<TicketFilter>("all");
  const [currencyF, setCurrencyF] = useState<CurrencyFilter>("all");
  const [iogOnly, setIogOnly] = useState(false);
  const [households, setHouseholds] = useState<HouseholdOption[]>([]);
  const [activeHouseholdId, setActiveHouseholdId] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [applyPrompt, setApplyPrompt] = useState<ApplyCriterionPrompt | null>(null);
  const [applyBusy, setApplyBusy] = useState(false);
  const [reintegroPrompt, setReintegroPrompt] = useState<ReintegroHogarPrompt | null>(null);
  const [reintegroBusy, setReintegroBusy] = useState(false);
  const [cubiertoPrompt, setCubiertoPrompt] = useState<GastoCubiertoPrompt | null>(null);
  const [cubiertoBusy, setCubiertoBusy] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [totalCount, setTotalCount] = useState(0);
  const [iogTotal, setIogTotal] = useState(0);
  const [exportOpen, setExportOpen] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLDivElement>(null);

  const activeFilterCount = [
    ownershipF !== "all",
    categoryF !== "all",
    ticketF !== "all",
    currencyF !== "all",
    iogOnly,
  ].filter(Boolean).length;

  useEffect(() => {
    if (!toast || applyPrompt || reintegroPrompt || cubiertoPrompt) return;
    const t = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(t);
  }, [toast, applyPrompt, reintegroPrompt, cubiertoPrompt]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/household/active", { credentials: "include" });
        if (!res.ok || cancelled) return;
        const data = await parseJson<{
          households?: HouseholdOption[];
          activeHouseholdId?: string | null;
        }>(res);
        if (cancelled) return;
        setHouseholds(data.households ?? []);
        setActiveHouseholdId(data.activeHouseholdId ?? null);
      } catch {
        /* ignore — Tipo falls back to Personal/Hogar */
      }
    })();
    function onSwitch() {
      void (async () => {
        try {
          const res = await fetch("/api/household/active", { credentials: "include" });
          if (!res.ok) return;
          const data = await parseJson<{
            households?: HouseholdOption[];
            activeHouseholdId?: string | null;
          }>(res);
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


  useEffect(() => {
    if (!exportOpen && !filterOpen) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (exportOpen && exportRef.current && !exportRef.current.contains(t)) setExportOpen(false);
      if (filterOpen && filterRef.current && !filterRef.current.contains(t)) setFilterOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [exportOpen, filterOpen]);

  const queryFor = useCallback((limit: number, offset: number) => {
    const params = new URLSearchParams();
    const qTrim = q.trim();
    if (period && !qTrim) params.set("period", period);
    if (qTrim) params.set("q", qTrim);
    if (ownershipF !== "all") params.set("ownership", ownershipF);
    if (categoryF === "uncategorized") params.set("uncategorized", "1");
    else if (categoryF !== "all") params.set("categoryId", categoryF);
    if (ticketF !== "all") params.set("ticket", ticketF);
    if (currencyF !== "all") params.set("currency", currencyF);
    if (iogOnly) params.set("iog", "1");
    params.set("limit", String(limit));
    params.set("offset", String(offset));
    return params;
  }, [period, q, ownershipF, categoryF, ticketF, currencyF, iogOnly]);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    const params = queryFor(pageSize, (page - 1) * pageSize);
    try {
      const res = await fetch(`/api/transactions?${params}`, { credentials: "include" });
      const data = await parseJson<TxPayload>(res);
      if (!res.ok) { setError(data.error || `Error ${res.status}`); return; }
      const next = normalizeTxPayload(data);
      setRows(next.list);
      setTotalCount(next.total);
      setIogTotal(next.iog);
      setCategories(next.categories);
      setMembers(next.members);
      if (next.periods.length) setAllPeriods(next.periods);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error de red");
    } finally {
      setLoading(false);
    }
  }, [queryFor, page, pageSize]);

  useEffect(() => {
    const ac = new AbortController();
    const params = queryFor(pageSize, (page - 1) * pageSize);
    fetch(`/api/transactions?${params}`, {
      credentials: "include",
      signal: ac.signal,
    })
      .then(async (res) => {
        const data = await parseJson<TxPayload>(res);
        return { ok: res.ok, status: res.status, data };
      })
      .then((result) => {
        if (ac.signal.aborted) return;
        if (!result.ok) {
          setError(result.data.error || `Error ${result.status}`);
          setLoading(false);
          return;
        }
        const next = normalizeTxPayload(result.data);
        setRows(next.list);
        setTotalCount(next.total);
        setIogTotal(next.iog);
        setCategories(next.categories);
        setMembers(next.members);
        if (next.periods.length) setAllPeriods(next.periods);
        setError(null);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted || isAbortError(e)) return;
        setError(e instanceof Error ? e.message : "Error de red");
        setLoading(false);
      });
    return () => ac.abort();
  }, [queryFor, page, pageSize]);

  useEffect(() => {
    function onCreated() {
      void load();
    }
    window.addEventListener("lc:expense-created", onCreated);
    return () => window.removeEventListener("lc:expense-created", onCreated);
  }, [load]);

  const linkedIogCount = iogTotal;
  const sorted = rows;
  const pageRows = rows;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const filterKey = `${period}\0${q}\0${ownershipF}\0${categoryF}\0${ticketF}\0${currencyF}\0${iogOnly}`;
  const [seenFilter, setSeenFilter] = useState(filterKey);
  const [seenTxQuery, setSeenTxQuery] = useState<string | null>(null);
  const pageNow = nextPage({
    filterChanged: filterKey !== seenFilter,
    page,
    totalPages,
  });
  if (filterKey !== seenFilter) setSeenFilter(filterKey);
  if (pageNow !== page) setPage(pageNow);
  const txQueryKey = `${filterKey}\0${pageNow}\0${pageSize}`;
  if (txQueryKey !== seenTxQuery) {
    setSeenTxQuery(txQueryKey);
    if (seenTxQuery !== null) {
      setLoading(true);
      setError(null);
    }
  }
  const safePage = Math.min(pageNow, totalPages);

  async function patch(id: string, body: Record<string, unknown>) {
    setError(null); setSavingId(id);
    const prev = rows;
    const catId = "categoryId" in body ? (body.categoryId as string | null) : undefined;
    const nextCat =
      catId === undefined ? undefined
        : !catId ? null
        : (categories.find((c) => c.id === catId) ?? null);
    const prevCatId = rows.find((r) => r.id === id)?.category?.id ?? null;
    const categoryChanged =
      catId !== undefined && catId !== null && catId !== prevCatId;

    setRows((list) => list.map((r) => {
      if (r.id !== id) return r;
      const next = { ...r };
      if (nextCat !== undefined) next.category = nextCat;
      if ("paidByUserId" in body) next.paidByUserId = (body.paidByUserId as string | null) ?? null;
      if ("ownership" in body) {
        next.ownership = body.ownership === "shared" ? "shared" : "personal";
      }
      if ("date" in body && typeof body.date === "string") next.date = body.date;
      if ("amountArs" in body) next.amountArs = body.amountArs as number | null;
      if ("amountUsd" in body) next.amountUsd = body.amountUsd as number | null;
      if ("isBusiness" in body) {
        next.isBusiness = body.isBusiness === true;
        next.syncStatus = "pending";
      }
      const leavesBusiness =
        body.isPayment === true ||
        body.householdReimbursement ||
        body.householdBillCovered ||
        body.internalTransfer ||
        body.ownership === "shared";
      if (leavesBusiness && next.isBusiness) {
        next.isBusiness = false;
        next.syncStatus = "pending";
      }
      return next;
    }));

    try {
      const res = await fetch("/api/transactions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ id, ...body }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) { setRows(prev); setError(data?.error || "No se pudo guardar"); return; }

      if ("isBusiness" in body && Object.keys(body).length === 1) {
        setToast(
          body.isBusiness
            ? "Marcado como del negocio. Se envía a Serpix."
            : "Listo, ya no es del negocio.",
        );
        return;
      }

      if (body.householdReimbursement) {
        setApplyPrompt(null);
        setCubiertoPrompt(null);
        if (body.applyToSimilar) {
          setReintegroPrompt(null);
          const n = typeof data?.similarUpdated === "number" ? data.similarUpdated : 0;
          setToast(
            n > 0
              ? `Reintegro aplicado a ${n + 1} pago${n + 1 === 1 ? "" : "s"} (no duplica Hogar).`
              : "Marcado como reintegro de servicios (no cuenta en la neta).",
          );
          void load();
          return;
        }
        const n =
          typeof data?.reintegroCount === "number"
            ? data.reintegroCount
            : typeof data?.similarCount === "number"
              ? data.similarCount
              : 1;
        // Keep visible in Consumos as Tipo Reintegro hogar (still out of neta).
        setRows((list) =>
          list.map((x) => (x.id === id ? { ...x, isPayment: true } : x)),
        );
        if (n > 1 && !body.applyToSimilar) {
          setToast(null);
          setReintegroPrompt({
            txId: id,
            count: n,
            pending: false,
          });
        } else {
          setReintegroPrompt(null);
          setToast(
            "Marcado como reintegro de servicios (no cuenta en la neta).",
          );
        }
        return;
      }

      if (body.householdBillCovered) {
        setApplyPrompt(null);
        setReintegroPrompt(null);
        if (body.applyToSimilar) {
          setCubiertoPrompt(null);
          const n = typeof data?.similarUpdated === "number" ? data.similarUpdated : 0;
          setToast(
            n > 0
              ? `Cubierto aplicado a ${n + 1} gasto${n + 1 === 1 ? "" : "s"} (no cuenta en la neta).`
              : "Marcado como cubierto (no cuenta en la neta).",
          );
          void load();
          return;
        }
        const n =
          typeof data?.cubiertoCount === "number"
            ? data.cubiertoCount
            : typeof data?.similarCount === "number"
              ? data.similarCount
              : 1;
        setRows((list) =>
          list.map((x) => (x.id === id ? { ...x, isPayment: true } : x)),
        );
        if (n > 1 && !body.applyToSimilar) {
          setToast(null);
          setCubiertoPrompt({ txId: id, count: n, pending: false });
        } else {
          setCubiertoPrompt(null);
          setToast("Marcado como cubierto (no cuenta en la neta).");
        }
        return;
      }

      if (body.applyToSimilar) {
        setApplyPrompt(null);
        setReintegroPrompt(null);
        const n = typeof data?.similarUpdated === "number" ? data.similarUpdated : 0;
        setToast(
          n > 0
            ? `Criterio aplicado a ${n + 1} gasto${n + 1 === 1 ? "" : "s"}.`
            : "Criterio guardado.",
        );
        void load();
        return;
      }

      const similarCount =
        typeof data?.similarCount === "number" ? data.similarCount : 0;
      const reintegroCount =
        typeof data?.reintegroCount === "number" ? data.reintegroCount : 0;
      const row =
        rows.find((r) => r.id === id) ?? prev.find((r) => r.id === id);

      // Option C: editing a roommate service reimbursement → ask before double-loading.
      if (
        !body.skipReintegroOffer &&
        reintegroCount >= 1 &&
        Boolean(row?.reintegroPayee) &&
        (categoryChanged || body.ownership === "shared")
      ) {
        setApplyPrompt(null);
        setToast(null);
        setReintegroPrompt({
          txId: id,
          count: reintegroCount,
          pending: true,
        });
        return;
      }

      if (categoryChanged && similarCount >= 2 && catId) {
        setToast(null);
        setReintegroPrompt(null);
        setApplyPrompt({ txId: id, categoryId: catId, count: similarCount });
      } else if (body.ownership || categoryChanged) {
        setApplyPrompt(null);
        setReintegroPrompt(null);
        setToast("Guardado.");
      }
      if (data?.possibleDuplicate) {
        setToast("Posible duplicado: ya hay un gasto igual ese día. Se guardó igual.");
      }
    } catch {
      setRows(prev); setError("Error de red al guardar");
    } finally {
      setSavingId(null);
    }
  }

  async function applyCriterion() {
    if (!applyPrompt) return;
    setApplyBusy(true);
    try {
      await patch(applyPrompt.txId, {
        categoryId: applyPrompt.categoryId,
        applyToSimilar: true,
      });
    } finally {
      setApplyBusy(false);
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
      await patch(reintegroPrompt.txId, {
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
      await patch(cubiertoPrompt.txId, {
        householdBillCovered: true,
        applyToSimilar: all,
      });
    } finally {
      setCubiertoBusy(false);
    }
  }

  async function patchItem(txId: string, itemId: string, body: { name?: string; productCategory?: string | null }) {
    const prev = rows;
    setRows((list) => list.map((r) => {
      if (r.id !== txId || !r.receipt) return r;
      return {
        ...r,
        receipt: {
          ...r.receipt,
          items: r.receipt.items.map((it) =>
            it.id === itemId
              ? { ...it, name: body.name ?? it.name, productCategory: "productCategory" in body ? (body.productCategory ?? null) : it.productCategory }
              : it,
          ),
        },
      };
    }));
    try {
      const res = await fetch("/api/receipts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ itemId, ...body }),
      });
      if (!res.ok) setRows(prev);
    } catch { setRows(prev); }
  }

  function toggleExpand(id: string) {
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  function clearFilters() {
    setOwnershipF("all");
    setCategoryF("all");
    setTicketF("all");
    setCurrencyF("all");
    setIogOnly(false);
  }

  function assignValueFor(r: Tx): string {
    if (isReintegroHogarTipo(r.isPayment, Boolean(r.reintegroHogar))) return "reintegro";
    if (isTransferenciaInternaTipo(r.isPayment, r.category, r.descriptionNormalized)) return "internal";
    if (isGastoCubiertoTipo(r.isPayment, r.category)) return "cubierto";
    if (r.ownership === "personal") return "personal";
    return activeHouseholdId ?? "shared";
  }

  async function onAssignChange(r: Tx, value: string) {
    if (value === "personal") {
      const wasSpecial =
        isReintegroHogarTipo(r.isPayment, Boolean(r.reintegroHogar)) ||
        isTransferenciaInternaTipo(r.isPayment, r.category, r.descriptionNormalized) ||
        isGastoCubiertoTipo(r.isPayment, r.category);
      if (r.ownership === "personal" && !wasSpecial) return;
      setError(null);
      setSavingId(r.id);
      const prev = rows;
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
          setRows((list) => list.filter((x) => x.id !== r.id));
          setToast("Movido a Personal.");
        } else {
          setRows((list) =>
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
        }
      } catch (e) {
        setRows(prev);
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
      void patch(r.id, { householdBillCovered: true });
      return;
    }
    if (value === "reintegro") {
      setApplyPrompt(null);
      setCubiertoPrompt(null);
      setToast(null);
      void patch(r.id, { householdReimbursement: true });
      return;
    }
    if (value === "internal") {
      // Hide from Consumos + neta (isPayment); keep history in statements.
      setError(null);
      setSavingId(r.id);
      const prev = rows;
      setRows((list) => list.filter((x) => x.id !== r.id));
      try {
        const res = await fetch("/api/transactions", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ id: r.id, internalTransfer: true }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          setRows(prev);
          setError(data?.error || "No se pudo marcar");
          return;
        }
        setToast("Marcado como transferencia interna (no cuenta en la neta).");
      } catch (e) {
        setRows(prev);
        setError(e instanceof Error ? e.message : "Error de red");
      } finally {
        setSavingId(null);
      }
      return;
    }
    // value is a household id (or legacy "shared")
    if (value === "shared" || value === (activeHouseholdId ?? "")) {
      // Roommate service reimbursements must not become a second Hogar bill.
      if (r.reintegroPayee && !r.isPayment) {
        const n = rows.filter(
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
        isReintegroHogarTipo(r.isPayment, Boolean(r.reintegroHogar)) ||
        isTransferenciaInternaTipo(r.isPayment, r.category, r.descriptionNormalized) ||
        isGastoCubiertoTipo(r.isPayment, r.category);
      if (r.ownership !== "shared" || wasSpecial) {
        void patch(r.id, {
          ownership: "shared",
          ...(wasSpecial ? { isPayment: false } : {}),
          skipReintegroOffer: true,
        });
        if (wasSpecial) {
          setRows((list) =>
            list.map((x) =>
              x.id === r.id
                ? { ...x, isPayment: false, ownership: "shared" as const }
                : x,
            ),
          );
        }
      }
      return;
    }
    // Move to another household — drop from this list on success
    setError(null);
    setSavingId(r.id);
    const prev = rows;
    setRows((list) => list.filter((x) => x.id !== r.id));
    try {
      const res = await fetch("/api/transactions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ id: r.id, targetHouseholdId: value }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setRows(prev);
        setError(data?.error || "No se pudo mover");
        return;
      }
      const dest = households.find((h) => h.id === value)?.name ?? "otro hogar";
      setToast(`Movido a ${dest}.`);
    } catch (e) {
      setRows(prev);
      setError(e instanceof Error ? e.message : "Error de red");
    } finally {
      setSavingId(null);
    }
  }

  function AssignSelect({ r, full = false }: { r: Tx; full?: boolean }) {
    const value = assignValueFor(r);
    const opts =
      households.length > 0
        ? households
        : activeHouseholdId
          ? [{ id: activeHouseholdId, name: "Hogar" }]
          : [];
    return (
      <select
        value={value === "shared" && activeHouseholdId ? activeHouseholdId : value}
        disabled={savingId === r.id}
        onChange={(e) => void onAssignChange(r, e.target.value)}
        className={cn(
          full ? "lc-input w-full font-medium" : "lc-input !px-2 !py-1.5 text-xs font-medium",
          value === "reintegro"
            ? "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100"
            : value === "cubierto"
              ? "border-emerald-300 bg-emerald-50 text-emerald-950 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-100"
              : r.ownership === "shared"
                ? "border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-100"
                : "",
        )}
        aria-label="Asignar a"
      >
        <option value="personal">Personal</option>
        {opts.map((h) => (
          <option key={h.id} value={h.id}>
            {h.name}
          </option>
        ))}
        {opts.length === 0 && <option value="shared">Hogar</option>}
        <option value="cubierto">Cubierto</option>
        <option value="reintegro">Reintegro hogar</option>
        <option value="internal">Transferencia interna</option>
      </select>
    );
  }


  const periods = allPeriods.length
    ? allPeriods
    : [...new Set(rows.map((r) => periodFromDateString(r.date)))].sort().reverse();

  const catOptions = useMemo(() => {
    return categories
      .filter((c) => c.slug !== "uncategorized")
      .sort((a, b) => a.name.localeCompare(b.name, "es"));
  }, [categories]);

  async function rowsForExport(): Promise<Tx[]> {
    const all: Tx[] = [];
    let offset = 0;
    let total = Number.POSITIVE_INFINITY;
    while (offset < total && all.length < 1000) {
      const params = queryFor(100, offset);
      const res = await fetch(`/api/transactions?${params}`, { credentials: "include" });
      const data = await parseJson<{ error?: string; transactions?: Tx[]; total?: number }>(res);
      if (!res.ok) throw new Error(data.error || "No se pudo exportar");
      const chunk = data.transactions ?? [];
      total = data.total ?? chunk.length;
      all.push(...chunk);
      if (chunk.length === 0) break;
      offset += chunk.length;
    }
    return all;
  }
  async function exportCsv() {
    try {
      const list = await rowsForExport();
      const ws = XLSX.utils.json_to_sheet(toSheet(list, members));
      downloadBlob(`gastos-${period || "todos"}.csv`, new Blob([XLSX.utils.sheet_to_csv(ws)], { type: "text/csv;charset=utf-8" }));
      setExportOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo exportar");
    }
  }
  async function exportXls() {
    try {
      const list = await rowsForExport();
      const ws = XLSX.utils.json_to_sheet(toSheet(list, members));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Gastos");
      const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" });
      downloadBlob(`gastos-${period || "todos"}.xlsx`, new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
      setExportOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo exportar");
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex w-full items-center gap-2">
        <select
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          className="lc-input min-w-0 flex-1"
        >
          <option value="">Todos los meses</option>
          {periods.map((p) => (
            <option key={p} value={p}>{formatPeriodTitle(p)}</option>
          ))}
        </select>

        <div className="relative shrink-0" ref={exportRef}>
          <button
            type="button"
            onClick={() => { setExportOpen((o) => !o); setFilterOpen(false); }}
            disabled={!sorted.length}
            className="lc-btn lc-btn-secondary !min-h-11 !w-11 !rounded-full !px-0 disabled:opacity-40"
            aria-label="Descargar"
            aria-expanded={exportOpen}
          >
            <Download className="h-[18px] w-[18px]" />
          </button>
          {exportOpen && (
            <div className="absolute right-0 z-30 mt-1.5 w-[min(16rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--card-shadow-lg)]">
              <p className="border-b border-zinc-100 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400 dark:border-zinc-800">
                Exportar listado filtrado
              </p>
              <button type="button" onClick={exportCsv} className="flex w-full items-start gap-3 px-3 py-2.5 text-left transition hover:bg-zinc-50 dark:hover:bg-zinc-900">
                <FileText className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
                <span>
                  <span className="block text-sm font-semibold">CSV</span>
                  <span className="block text-xs text-zinc-500">Texto separado por comas. Ideal para Sheets.</span>
                </span>
              </button>
              <button type="button" onClick={exportXls} className="flex w-full items-start gap-3 border-t border-zinc-100 px-3 py-2.5 text-left transition hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900">
                <FileSpreadsheet className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                <span>
                  <span className="block text-sm font-semibold">Excel (.xlsx)</span>
                  <span className="block text-xs text-zinc-500">Planilla lista para Office o LibreOffice.</span>
                </span>
              </button>
            </div>
          )}
        </div>

        <div className="relative ml-auto shrink-0" ref={filterRef}>
          <button
            type="button"
            onClick={() => { setFilterOpen((o) => !o); setExportOpen(false); }}
            className={cn(
              "relative inline-flex min-h-11 w-11 items-center justify-center rounded-full border transition",
              activeFilterCount > 0 || filterOpen
                ? "border-[var(--brand)]/50 bg-[var(--brand-soft)] text-[var(--foreground)]"
                : "border-[var(--border)] bg-[var(--surface)] text-[var(--foreground)] hover:bg-[var(--surface-muted)]",
            )}
            aria-expanded={filterOpen}
            aria-label={activeFilterCount > 0 ? `Filtros (${activeFilterCount})` : "Filtros"}
          >
            <SlidersHorizontal className="h-[18px] w-[18px]" />
            {activeFilterCount > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--brand)] px-1 text-[11px] font-bold text-[var(--on-accent)]">
                {activeFilterCount}
              </span>
            )}
          </button>

          {filterOpen && (
            <div className="absolute right-0 z-30 mt-1.5 max-h-[70dvh] w-[min(20rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--card-shadow-lg)]">
              <div className="flex items-center justify-between border-b border-zinc-100 px-3 py-2 dark:border-zinc-800">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Filtros</p>
                {activeFilterCount > 0 && (
                  <button type="button" onClick={clearFilters} className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
                    Limpiar
                  </button>
                )}
              </div>

              <div className="space-y-3 p-3">
                <div>
                  <p className="mb-1.5 text-[11px] font-semibold text-zinc-500">Tipo</p>
                  <div className="flex flex-wrap gap-1.5">
                    <FilterChip active={ownershipF === "all"} onClick={() => setOwnershipF("all")}>Todos</FilterChip>
                    <FilterChip active={ownershipF === "personal"} onClick={() => setOwnershipF("personal")}>Personal</FilterChip>
                    <FilterChip active={ownershipF === "shared"} onClick={() => setOwnershipF("shared")}>Hogar</FilterChip>
                  </div>
                </div>

                <div>
                  <p className="mb-1.5 text-[11px] font-semibold text-zinc-500">Categoría</p>
                  <div className="flex flex-wrap gap-1.5">
                    <FilterChip active={categoryF === "all"} onClick={() => setCategoryF("all")}>Todas</FilterChip>
                    <FilterChip active={categoryF === "uncategorized"} onClick={() => setCategoryF("uncategorized")}>Sin categoría</FilterChip>
                    {catOptions.map((c) => (
                      <FilterChip key={c.id} active={categoryF === c.id} onClick={() => setCategoryF(c.id)}>
                        {categoryLabel(c.name)}
                      </FilterChip>
                    ))}
                  </div>
                </div>

                <div>
                  <p className="mb-1.5 text-[11px] font-semibold text-zinc-500">Origen</p>
                  <div className="flex flex-wrap gap-1.5">
                    <FilterChip active={ticketF === "all"} onClick={() => setTicketF("all")}>Todos</FilterChip>
                    <FilterChip active={ticketF === "ticket"} onClick={() => setTicketF("ticket")}>Con ticket</FilterChip>
                    <FilterChip active={ticketF === "no-ticket"} onClick={() => setTicketF("no-ticket")}>Sin ticket</FilterChip>
                  </div>
                </div>

                <div>
                  <p className="mb-1.5 text-[11px] font-semibold text-zinc-500">Moneda</p>
                  <div className="flex flex-wrap gap-1.5">
                    <FilterChip active={currencyF === "all"} onClick={() => setCurrencyF("all")}>Todas</FilterChip>
                    <FilterChip active={currencyF === "ars"} onClick={() => setCurrencyF("ars")}>Pesos</FilterChip>
                    <FilterChip active={currencyF === "usd"} onClick={() => setCurrencyF("usd")}>Dólares</FilterChip>
                  </div>
                </div>

                {linkedIogCount > 0 && (
                  <div>
                    <p className="mb-1.5 text-[11px] font-semibold text-zinc-500">Invoice IOG</p>
                    <div className="flex flex-wrap gap-1.5">
                      <FilterChip active={!iogOnly} onClick={() => setIogOnly(false)}>Todos</FilterChip>
                      <FilterChip active={iogOnly} onClick={() => setIogOnly(true)}>Solo IOG</FilterChip>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {activeFilterCount > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {ownershipF !== "all" && (
            <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium dark:bg-zinc-800">
              {ownershipF === "personal" ? "Personal" : "Hogar"}
              <button type="button" onClick={() => setOwnershipF("all")} aria-label="Quitar"><X className="h-3 w-3" /></button>
            </span>
          )}
          {categoryF !== "all" && (
            <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium dark:bg-zinc-800">
              {categoryF === "uncategorized"
                ? "Sin categoría"
                : categoryLabel(categories.find((c) => c.id === categoryF)?.name)}
              <button type="button" onClick={() => setCategoryF("all")} aria-label="Quitar"><X className="h-3 w-3" /></button>
            </span>
          )}
          {ticketF !== "all" && (
            <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium dark:bg-zinc-800">
              {ticketF === "ticket" ? "Con ticket" : "Sin ticket"}
              <button type="button" onClick={() => setTicketF("all")} aria-label="Quitar"><X className="h-3 w-3" /></button>
            </span>
          )}
          {currencyF !== "all" && (
            <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium dark:bg-zinc-800">
              {currencyF === "ars" ? "Pesos" : "Dólares"}
              <button type="button" onClick={() => setCurrencyF("all")} aria-label="Quitar"><X className="h-3 w-3" /></button>
            </span>
          )}
          {iogOnly && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-900 dark:bg-amber-950/60 dark:text-amber-100">
              Solo IOG
              <button type="button" onClick={() => setIogOnly(false)} aria-label="Quitar"><X className="h-3 w-3" /></button>
            </span>
          )}
        </div>
      )}

      <div className="relative w-full">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Buscar comercio…"
          className="lc-input w-full !pl-9"
        />
      </div>

      {error && <p className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">{error}</p>}
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
            if (prompt?.declineToShared) {
              void patch(prompt.txId, {
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
        toast && (
          <Toast tone={toast.startsWith("Posible duplicado") ? "warn" : "ok"}>
            {toast}
          </Toast>
        )
      )}

      {loading && !rows.length ? (
        <ListSkeleton label="Cargando consumos…" />
      ) : !sorted.length ? (
        <EmptyState
          icon={<List className="h-7 w-7" />}
          title={
            activeFilterCount > 0
              ? "Nada con esos filtros"
              : period
                ? `Nada en ${formatPeriodLabel(period)}`
                : "Todavía no hay consumos"
          }
          description={
            activeFilterCount > 0
              ? "Sacá un filtro o limpiá todo. Seguro está, escondido."
              : "Probá otro mes. Los movimientos de este hogar aparecen acá."
          }
          action={
            activeFilterCount > 0 ? (
              <button type="button" onClick={clearFilters} className="lc-btn lc-btn-secondary min-h-10 cursor-pointer">
                Limpiar filtros
              </button>
            ) : undefined
          }
        />
      ) : (
        <>
          <ul className="space-y-2.5 md:hidden">
            {pageRows.map((r) => {
              const isTicket = r.hasTicket;
              const isOpen = expanded.has(r.id);
              const isEditing = editingId === r.id;
              const slug = r.category?.slug ?? "uncategorized";
              const color = colorForCategory(slug);
              const amountMain =
                r.amountArs != null
                  ? formatPesos(r.amountArs)
                  : r.amountUsd != null
                    ? formatUsd(r.amountUsd)
                    : "Sin monto";
              const amountSub = r.amountArs != null && r.amountUsd != null ? formatUsd(r.amountUsd) : null;
              return (
                <li
                  key={r.id}
                  className={cn(
                    "overflow-hidden rounded-[1.25rem] border shadow-[var(--card-shadow)]",
                    isTicket ? "lc-ticket" : "border-[var(--border)] bg-[var(--surface)]",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => setEditingId(isEditing ? null : r.id)}
                    aria-expanded={isEditing}
                    aria-label={`${r.descriptionNormalized}, ${amountMain}. ${isEditing ? "Cerrar" : "Editar"}`}
                    className="flex min-h-[3.75rem] w-full cursor-pointer items-center gap-3 px-4 py-3 text-left"
                  >
                    <span
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl"
                      style={{ backgroundColor: tint(color, 15), color }}
                    >
                      <CategoryIcon slug={slug} size={18} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate text-[15px] font-semibold">{r.descriptionNormalized}</span>
                        {r.revisar ? <RevisarBadge size="sm" /> : null}
                        {r.linkedToInvoiceIog && <IogBadge size="sm" />}
                      </span>
                      <span className="block truncate text-[13px] text-[var(--muted-fg)]">
                        {shortDate(r.date)} · {categoryLabel(r.category?.name) || "Sin categoría"}
                        {r.ownership === "shared" ? " · Hogar" : ""}
                        {r.installment ? ` · cuota ${r.installment}` : ""}
                      </span>
                    </span>
                    <span className="lc-amount max-w-[42%] shrink-0 text-right">
                      <span className="block text-[15px] font-semibold">{amountMain}</span>
                      {amountSub && (
                        <span className="block text-[12px] text-[var(--muted-fg)]">{amountSub}</span>
                      )}
                    </span>
                  </button>

                  {isEditing && (
                    <div className="space-y-3 border-t border-[var(--border)] px-4 pb-4 pt-3">
                      <label className="block">
                        <span className="mb-1 block text-[13px] font-medium text-[var(--muted-fg)]">Fecha</span>
                        <input
                          type="date"
                          defaultValue={r.date}
                          disabled={savingId === r.id}
                          onBlur={(e) => {
                            const v = e.target.value;
                            if (v && v !== r.date) void patch(r.id, { date: v });
                          }}
                          className="lc-input w-full"
                        />
                      </label>
                      <div className="grid grid-cols-2 gap-2">
                        <label className="block min-w-0">
                          <span className="mb-1 block text-[13px] font-medium text-[var(--muted-fg)]">Monto en pesos</span>
                          <input
                            key={`${r.id}-ars-${r.amountArs ?? "∅"}`}
                            type="number"
                            step="0.01"
                            inputMode="decimal"
                            defaultValue={r.amountArs ?? ""}
                            placeholder={hasAnyAmount(r) ? undefined : "sin monto"}
                            disabled={savingId === r.id}
                            onBlur={(e) => {
                              const next = nextAmountOnBlur(e.target.value, r.amountArs, r.amountUsd);
                              if (next === undefined) return;
                              if (next !== r.amountArs) void patch(r.id, { amountArs: next });
                            }}
                            className="lc-input w-full text-right tabular-nums"
                            aria-label="Monto en pesos"
                          />
                        </label>
                        <label className="block min-w-0">
                          <span className="mb-1 block text-[13px] font-medium text-[var(--muted-fg)]">Monto en dólares</span>
                          <input
                            key={`${r.id}-usd-${r.amountUsd ?? "∅"}`}
                            type="number"
                            step="0.01"
                            inputMode="decimal"
                            defaultValue={r.amountUsd ?? ""}
                            placeholder={hasAnyAmount(r) ? undefined : "sin monto"}
                            disabled={savingId === r.id}
                            onBlur={(e) => {
                              const next = nextAmountOnBlur(e.target.value, r.amountUsd, r.amountArs);
                              if (next === undefined) return;
                              if (next !== r.amountUsd) void patch(r.id, { amountUsd: next });
                            }}
                            className="lc-input w-full text-right tabular-nums"
                            aria-label="Monto en dólares"
                          />
                        </label>
                      </div>
                      <div>
                        <span className="mb-1 block text-[13px] font-medium text-[var(--muted-fg)]">Categoría</span>
                        {isTicket ? (
                          <span className="inline-flex min-h-11 items-center rounded-2xl bg-[color-mix(in_srgb,var(--a2)_22%,var(--surface))] px-3 text-sm font-medium">
                            {categoryLabel(r.category?.name) || "Supermercado"}
                          </span>
                        ) : (
                          <select
                            value={r.category?.id ?? ""}
                            disabled={savingId === r.id}
                            onChange={(e) => void patch(r.id, { categoryId: e.target.value || null })}
                            className="lc-input w-full"
                            aria-label="Categoría"
                          >
                            {categories.map((c) => (
                              <option key={c.id} value={c.id}>{categoryLabel(c.name)}</option>
                            ))}
                          </select>
                        )}
                      </div>
                      <div>
                        <span className="mb-1 block text-[13px] font-medium text-[var(--muted-fg)]">De quién es</span>
                        <AssignSelect r={r} full />
                      </div>
                      <div>
                        <span className="mb-1 block text-[13px] font-medium text-[var(--muted-fg)]">Quién pagó</span>
                        <select
                          value={r.paidByUserId ?? members[0]?.userId ?? ""}
                          disabled={savingId === r.id || !members.length}
                          onChange={(e) => void patch(r.id, { paidByUserId: e.target.value || null })}
                          className="lc-input w-full"
                          aria-label="Quién pagó"
                        >
                          {members.map((m) => (
                            <option key={m.userId} value={m.userId}>{memberLabel(m)}</option>
                          ))}
                        </select>
                      </div>
                      <BusinessSyncToggle
                        isBusiness={Boolean(r.isBusiness)}
                        syncStatus={r.syncStatus ?? null}
                        canMark={r.ownership === "personal" && !r.isPayment}
                        disabled={savingId === r.id}
                        onToggle={() => void patch(r.id, { isBusiness: !r.isBusiness })}
                      />
                      {isTicket && (
                        <button
                          type="button"
                          onClick={() => toggleExpand(r.id)}
                          className="lc-btn lc-btn-secondary w-full"
                        >
                          {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                          {isOpen ? "Ocultar ítems del ticket" : "Ver ítems del ticket"}
                        </button>
                      )}
                      {isTicket && isOpen && r.receipt && (
                        <div className="space-y-2 border-t border-[var(--border)] pt-3">
                          {r.receipt.items.length === 0 ? (
                            <p className="text-sm text-[var(--muted-fg)]">Sin ítems leídos.</p>
                          ) : r.receipt.items.map((item) => (
                            <div key={item.id} className="space-y-2 rounded-2xl bg-[var(--surface-muted)] p-2.5">
                              <input defaultValue={item.name} onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== item.name) void patchItem(r.id, item.id, { name: v }); }} className="lc-input w-full" aria-label="Nombre del ítem" />
                              <div className="flex items-center gap-2">
                                <select value={item.productCategory ?? ""} onChange={(e) => void patchItem(r.id, item.id, { productCategory: e.target.value || null })} className="lc-input min-w-0 flex-1" aria-label="Subcategoría">
                                  <option value="">Subcategoría…</option>
                                  {PRODUCT_SUBCATS.map((sub) => <option key={sub} value={sub}>{sub}</option>)}
                                </select>
                                <span className="shrink-0 text-sm tabular-nums text-[var(--muted-fg)]">{item.quantity && item.quantity !== 1 ? `${item.quantity}× ` : ""}{formatArs(item.lineTotal)}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          <div className="lc-table-wrap hidden md:block">
            <table>
              <thead>
                <tr>
                  <th className="w-8 px-2 py-2.5" />
                  <th className="px-3 py-2.5">Fecha</th>
                  <th className="px-3 py-2.5">Descripción</th>
                  <th className="px-3 py-2.5">Monto $</th>
                  <th className="px-3 py-2.5">USD</th>
                  <th className="px-3 py-2.5">Categoría</th>
                  <th className="px-3 py-2.5">Tipo</th>
                  <th className="px-3 py-2.5">Pagó</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/80">
                {pageRows.map((r) => {
                  const isTicket = r.hasTicket;
                  const isOpen = expanded.has(r.id);
                  return (
                    <Fragment key={r.id}>
                      <tr className={isTicket ? "bg-violet-50/80 dark:bg-violet-950/30" : undefined}>
                        <td className="px-2 py-2">
                          {isTicket && (
                            <button type="button" onClick={() => toggleExpand(r.id)} className="rounded p-1 text-violet-700 dark:text-violet-300">
                              {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                            </button>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-zinc-600">
                          <input
                            type="date"
                            defaultValue={r.date}
                            disabled={savingId === r.id}
                            onBlur={(e) => {
                              const v = e.target.value;
                              if (v && v !== r.date) void patch(r.id, { date: v });
                            }}
                            className="lc-input !w-auto !px-1.5 !py-1 text-xs"
                            aria-label="Fecha"
                          />
                        </td>
                        <td className="max-w-xs px-3 py-2">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate font-medium">{r.descriptionNormalized}</span>
                            {r.revisar ? <RevisarBadge /> : null}
                            {isTicket && <span className="shrink-0 rounded-full bg-[var(--a2)] px-2 py-0.5 text-[10px] font-semibold uppercase text-[var(--on-accent)]">Ticket</span>}
                            {r.linkedToInvoiceIog && <IogBadge />}
                          </div>
                          {r.installment && <div className="text-xs text-zinc-500">cuota {r.installment}</div>}
                          <div className="mt-1">
                            <BusinessSyncToggle
                              isBusiness={Boolean(r.isBusiness)}
                              syncStatus={r.syncStatus ?? null}
                              canMark={r.ownership === "personal" && !r.isPayment}
                              disabled={savingId === r.id}
                              onToggle={() => void patch(r.id, { isBusiness: !r.isBusiness })}
                            />
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                          <div className="inline-flex items-center gap-1.5">
                            {r.linkedToInvoiceIog && <IogBadge />}
                            <input
                              key={`${r.id}-desk-ars-${r.amountArs ?? "∅"}`}
                              type="number"
                              step="0.01"
                              inputMode="decimal"
                              defaultValue={r.amountArs ?? ""}
                              placeholder={hasAnyAmount(r) ? undefined : "sin monto"}
                              disabled={savingId === r.id}
                              onBlur={(e) => {
                                const next = nextAmountOnBlur(e.target.value, r.amountArs, r.amountUsd);
                                if (next === undefined) return;
                                if (next !== r.amountArs) void patch(r.id, { amountArs: next });
                              }}
                              className="lc-input w-[7.5rem] !px-1.5 !py-1 text-right text-sm tabular-nums placeholder:text-[10px] placeholder:font-normal placeholder:text-zinc-400"
                              aria-label="Monto en pesos"
                            />
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                          <input
                            key={`${r.id}-desk-usd-${r.amountUsd ?? "∅"}`}
                            type="number"
                            step="0.01"
                            inputMode="decimal"
                            defaultValue={r.amountUsd ?? ""}
                            placeholder={hasAnyAmount(r) ? undefined : "sin monto"}
                            disabled={savingId === r.id}
                            onBlur={(e) => {
                              const next = nextAmountOnBlur(e.target.value, r.amountUsd, r.amountArs);
                              if (next === undefined) return;
                              if (next !== r.amountUsd) void patch(r.id, { amountUsd: next });
                            }}
                            className="lc-input w-[7rem] !px-1.5 !py-1 text-right text-sm tabular-nums placeholder:text-[10px] placeholder:font-normal placeholder:text-zinc-400"
                            aria-label="Monto en dólares"
                          />
                        </td>
                        <td className="px-3 py-2">
                          {isTicket ? (
                            <span className="rounded-md bg-violet-100 px-2 py-1 text-xs font-medium text-violet-900 dark:bg-violet-900/50 dark:text-violet-100">{categoryLabel(r.category?.name) || "Supermercado"}</span>
                          ) : (
                            <select value={r.category?.id ?? ""} disabled={savingId === r.id} onChange={(e) => void patch(r.id, { categoryId: e.target.value || null })} className="lc-input max-w-[160px] !px-1.5 !py-1 text-xs">
                              {categories.map((c) => <option key={c.id} value={c.id}>{categoryLabel(c.name)}</option>)}
                            </select>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <div className="max-w-[140px]">
                            <AssignSelect r={r} />
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <select value={r.paidByUserId ?? members[0]?.userId ?? ""} disabled={savingId === r.id || !members.length} onChange={(e) => void patch(r.id, { paidByUserId: e.target.value || null })} className="lc-input max-w-[120px] !px-1.5 !py-1 text-xs">
                            {members.map((m) => <option key={m.userId} value={m.userId}>{memberLabel(m)}</option>)}
                          </select>
                        </td>
                      </tr>
                      {isTicket && isOpen && r.receipt && (
                        <tr className="bg-violet-50/50 dark:bg-violet-950/20">
                          <td colSpan={8} className="px-4 py-3">
                            <div className="rounded-xl border border-violet-200 bg-white p-3 dark:border-violet-900 dark:bg-zinc-950">
                              <p className="mb-2 text-xs font-semibold uppercase text-violet-700 dark:text-violet-300">
                                Detalle del ticket{r.receipt.items.length ? ` · ${r.receipt.items.length} ítems` : ""}
                              </p>
                              {r.receipt.items.length === 0 ? (
                                <p className="text-sm text-zinc-500">Sin ítems leídos.</p>
                              ) : (
                                <ul className="space-y-2">
                                  {r.receipt.items.map((item) => (
                                    <li key={item.id} className="grid gap-2 sm:grid-cols-[1fr_140px_auto] sm:items-center">
                                      <input defaultValue={item.name} onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== item.name) void patchItem(r.id, item.id, { name: v }); }} className="rounded-lg border border-zinc-200 px-2 py-1.5 text-sm dark:border-zinc-600 dark:bg-zinc-900" />
                                      <select value={item.productCategory ?? ""} onChange={(e) => void patchItem(r.id, item.id, { productCategory: e.target.value || null })} className="rounded-lg border border-zinc-200 px-2 py-1.5 text-xs dark:border-zinc-600 dark:bg-zinc-900">
                                        <option value="">Subcategoría…</option>
                                        {PRODUCT_SUBCATS.map((s) => <option key={s} value={s}>{s}</option>)}
                                      </select>
                                      <span className="text-right text-sm tabular-nums text-zinc-600">{item.quantity && item.quantity !== 1 ? `${item.quantity}× ` : ""}{formatArs(item.lineTotal)}</span>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <div className="flex items-center gap-2 text-zinc-500">
              <span>
                {totalCount === 0 ? "0" : `${(safePage - 1) * pageSize + 1}–${Math.min(safePage * pageSize, totalCount)}`} de {totalCount}
              </span>
              <label className="inline-flex items-center gap-1.5">
                <span className="text-xs">por pág.</span>
                <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }} className="lc-input !px-2 !py-1 text-xs">
                  {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
            </div>
            <div className="flex items-center gap-1">
              <button type="button" disabled={safePage <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} className="lc-btn lc-btn-secondary !min-w-11 !px-2.5 disabled:opacity-40" aria-label="Anterior">
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="min-w-[4.5rem] text-center tabular-nums text-zinc-600 dark:text-zinc-400">{safePage} / {totalPages}</span>
              <button type="button" disabled={safePage >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))} className="lc-btn lc-btn-secondary !min-w-11 !px-2.5 disabled:opacity-40" aria-label="Siguiente">
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
