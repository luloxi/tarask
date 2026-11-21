"use client";

import { useState } from "react";
import { cn, formatArs, formatUsd, formatDateAr } from "@/lib/utils";
import { displayCategoryName } from "@/lib/category-label";
import { isReintegroHogarTipo } from "@/lib/reintegro-hogar";
import { isGastoCubiertoTipo } from "@/lib/gasto-cubierto";
import { isTransferenciaInternaTipo } from "@/lib/bbva/bank-entries";
import { BusinessSyncToggle, type SyncStatus } from "@/components/business-sync-toggle";

type CategoryOpt = { id: string; slug: string; name: string };

export type MesAMesTx = {
  id: string;
  date: string;
  descriptionNormalized: string;
  amountArs: number | null;
  amountUsd: number | null;
  isPayment?: boolean;
  /** Server flag: outbound-prefix payee OR bare payee. Missing on old responses. */
  reintegroHogar?: boolean;
  /** Server flag: outbound-prefix payee only. Missing on old responses. */
  reintegroPayee?: boolean;
  ownership: "personal" | "shared";
  category: CategoryOpt | null;
  isBusiness?: boolean;
  syncStatus?: SyncStatus | null;
  canEdit?: boolean;
};

type HouseholdOption = { id: string; name: string };

function parseAmount(raw: string, current: number | null, other: number | null): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") {
    if (other == null || !Number.isFinite(other) || Math.abs(other) === 0) return undefined;
    return null;
  }
  const n = Number(trimmed);
  if (Number.isNaN(n)) return undefined;
  return n;
}

/**
 * Expense row for Resumen: name always visible + currency impossible to confuse.
 * Assign mirrors Consumos Lista (Personal + per-hogar / Reintegro / Transferencia).
 * Tap opens inline edit for date, name, amounts; category and tipo stay one-tap.
 */
export function MesAMesTxRow({
  t,
  categories,
  households,
  activeHouseholdId,
  savingId,
  onChangeCategory,
  onAssignChange,
  onToggleBusiness,
  onPatch,
}: {
  t: MesAMesTx;
  categories: CategoryOpt[];
  households: HouseholdOption[];
  activeHouseholdId: string | null;
  savingId: string | null;
  onChangeCategory: (txId: string, categoryId: string) => void;
  onAssignChange: (tx: MesAMesTx, value: string) => void;
  onToggleBusiness?: (tx: MesAMesTx) => void;
  onPatch?: (id: string, body: Record<string, unknown>) => void;
}) {
  const canEdit = t.canEdit !== false && Boolean(onPatch);
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(t.date);
  const [description, setDescription] = useState(t.descriptionNormalized);
  const [ars, setArs] = useState(t.amountArs == null ? "" : String(t.amountArs));
  const [usd, setUsd] = useState(t.amountUsd == null ? "" : String(t.amountUsd));

  const hasArs =
    t.amountArs != null &&
    Number.isFinite(t.amountArs) &&
    Math.abs(t.amountArs) > 0;
  const hasUsd =
    t.amountUsd != null &&
    Number.isFinite(t.amountUsd) &&
    Math.abs(t.amountUsd) > 0;

  const opts =
    households.length > 0
      ? households
      : activeHouseholdId
        ? [{ id: activeHouseholdId, name: "Hogar" }]
        : [];
  const assignValue = isReintegroHogarTipo(
    Boolean(t.isPayment),
    Boolean(t.reintegroHogar),
  )
    ? "reintegro"
    : isTransferenciaInternaTipo(Boolean(t.isPayment), t.category, t.descriptionNormalized)
      ? "internal"
      : isGastoCubiertoTipo(Boolean(t.isPayment), t.category)
        ? "cubierto"
        : t.ownership === "personal"
          ? "personal"
          : activeHouseholdId ?? "shared";

  function openEdit() {
    if (!canEdit) return;
    setDate(t.date);
    setDescription(t.descriptionNormalized);
    setArs(t.amountArs == null ? "" : String(t.amountArs));
    setUsd(t.amountUsd == null ? "" : String(t.amountUsd));
    setOpen((v) => !v);
  }

  function save() {
    if (!onPatch) return;
    const body: Record<string, unknown> = {};
    if (date && date !== t.date) body.date = date;
    const desc = description.trim();
    if (desc && desc !== t.descriptionNormalized) body.description = desc;
    const nextArs = parseAmount(ars, t.amountArs, t.amountUsd);
    const nextUsd = parseAmount(usd, t.amountUsd, t.amountArs);
    if (nextArs !== undefined && nextArs !== t.amountArs) body.amountArs = nextArs;
    if (nextUsd !== undefined && nextUsd !== t.amountUsd) body.amountUsd = nextUsd;
    if (Object.keys(body).length > 0) onPatch(t.id, body);
    setOpen(false);
  }

  return (
    <li className="rounded-xl border border-zinc-100/80 bg-white px-3 py-2.5 text-sm shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <button
        type="button"
        onClick={openEdit}
        aria-expanded={open}
        aria-label={`${t.descriptionNormalized}. ${open ? "Cerrar" : "Editar"}`}
        className={cn(
          "flex w-full items-start justify-between gap-3 text-left",
          canEdit && "cursor-pointer",
        )}
      >
        <div className="min-w-0 flex-1">
          <p className="text-xs tabular-nums text-zinc-500">
            {formatDateAr(t.date)}
          </p>
          <p className="mt-0.5 break-words font-medium leading-snug text-zinc-900 dark:text-zinc-50">
            {t.descriptionNormalized || "Sin descripción"}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {hasArs && (
            <span className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-100 px-2 py-1 dark:bg-zinc-800">
              <span className="text-[10px] font-bold uppercase tracking-wide text-zinc-500">
                Pesos
              </span>
              <span className="text-sm font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">
                {formatArs(Math.abs(t.amountArs!))}
              </span>
            </span>
          )}
          {hasUsd && (
            <span className="inline-flex items-center gap-1.5 rounded-lg bg-sky-100 px-2 py-1 dark:bg-sky-950">
              <span className="text-[10px] font-bold uppercase tracking-wide text-sky-700 dark:text-sky-300">
                Dólares
              </span>
              <span className="text-sm font-semibold tabular-nums text-sky-900 dark:text-sky-100">
                {formatUsd(Math.abs(t.amountUsd!))}
              </span>
            </span>
          )}
          {!hasArs && !hasUsd && (
            <span className="text-zinc-400">—</span>
          )}
        </div>
      </button>
      {open && canEdit && (
        <div className="mt-2 space-y-2 border-t border-[var(--border)] pt-2">
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-[var(--muted-fg)]">Fecha</span>
            <input
              type="date"
              value={date}
              disabled={savingId === t.id}
              onChange={(e) => setDate(e.target.value)}
              className="lc-input w-full !px-2 !py-1.5 text-xs"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-[var(--muted-fg)]">Nombre</span>
            <input
              type="text"
              value={description}
              maxLength={500}
              disabled={savingId === t.id}
              onChange={(e) => setDescription(e.target.value)}
              className="lc-input w-full !px-2 !py-1.5 text-xs"
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block min-w-0">
              <span className="mb-1 block text-[11px] font-medium text-[var(--muted-fg)]">Pesos</span>
              <input
                type="number"
                step="0.01"
                inputMode="decimal"
                value={ars}
                disabled={savingId === t.id}
                onChange={(e) => setArs(e.target.value)}
                className="lc-input w-full !px-2 !py-1.5 text-right text-xs tabular-nums"
                aria-label="Monto en pesos"
              />
            </label>
            <label className="block min-w-0">
              <span className="mb-1 block text-[11px] font-medium text-[var(--muted-fg)]">Dólares</span>
              <input
                type="number"
                step="0.01"
                inputMode="decimal"
                value={usd}
                disabled={savingId === t.id}
                onChange={(e) => setUsd(e.target.value)}
                className="lc-input w-full !px-2 !py-1.5 text-right text-xs tabular-nums"
                aria-label="Monto en dólares"
              />
            </label>
          </div>
          <button
            type="button"
            disabled={savingId === t.id}
            onClick={save}
            className="lc-btn lc-btn-primary w-full !min-h-10 text-sm"
          >
            Guardar
          </button>
        </div>
      )}
      <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
        <select
          value={t.category?.id ?? ""}
          disabled={savingId === t.id || t.canEdit === false}
          onChange={(e) => onChangeCategory(t.id, e.target.value)}
          onClick={(e) => e.stopPropagation()}
          className="lc-input w-full !px-2 !py-1.5 text-xs"
          aria-label="Categoría"
        >
          <option value="">Sin categoría</option>
          {categories.map((cat) => (
            <option key={cat.id} value={cat.id}>
              {displayCategoryName(cat.name, cat.slug)}
            </option>
          ))}
        </select>
        <select
          value={
            assignValue === "shared" && activeHouseholdId
              ? activeHouseholdId
              : assignValue
          }
          disabled={savingId === t.id || t.canEdit === false}
          onChange={(e) => onAssignChange(t, e.target.value)}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "lc-input w-full !px-2 !py-1.5 text-xs font-medium",
            assignValue === "reintegro"
              ? "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100"
              : assignValue === "cubierto"
                ? "border-emerald-300 bg-emerald-50 text-emerald-950 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-100"
                : t.ownership === "shared"
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
      </div>
      {onToggleBusiness ? (
        <div className="mt-2">
          <BusinessSyncToggle
            isBusiness={Boolean(t.isBusiness)}
            syncStatus={t.syncStatus ?? null}
            canMark={t.ownership === "personal" && !t.isPayment && t.canEdit !== false}
            disabled={savingId === t.id}
            onToggle={() => onToggleBusiness(t)}
          />
        </div>
      ) : null}
    </li>
  );
}
