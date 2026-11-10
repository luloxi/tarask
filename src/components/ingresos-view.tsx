"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useJsonResource } from "@/hooks/use-json-resource";
import { readScoped, scoped, type Scoped } from "@/lib/scoped-state";
import { Trash2 } from "lucide-react";
import { IncomeByMonthChart } from "@/components/income-by-month-chart";
import { SectionNav } from "@/components/section-nav";
import {
  EmptyState,
  FieldLabel,
  ListSkeleton,
  PageHeader,
  PageStack,
  SegmentedControl,
  Surface,
  Toast,
} from "@/components/ui";
import {
  formatArs,
  formatUsd,
  formatDateAr,
  todayDateAr,
  cn,
  currentPeriodAr,
} from "@/lib/utils";
import {
  formatPeriodLabel,
  formatPeriodTitle,
  periodSelectOptions,
  selectedPeriod,
} from "@/lib/period-label";
import {
  INCOME_FREQUENCIES,
  frequencyLabel,
  periodIncomeEntries,
  type IncomeFrequency,
  type IncomeKind,
  type PeriodIncomeEntry,
} from "@/lib/incomes";

type IncomeRow = {
  id: string;
  kind: IncomeKind;
  frequency: IncomeFrequency | null;
  date: string;
  label: string;
  amountArs: number | null;
  amountUsd: number | null;
};

type FormMode = "recurring" | "variable";

export function IngresosView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const fallback = currentPeriodAr();
  const period = selectedPeriod(searchParams.get("period"), fallback);
  const periods = useMemo(
    () => periodSelectOptions(period, fallback, 18),
    [period, fallback],
  );

  const resource = useJsonResource<{
    incomes?: IncomeRow[];
    periodEntries?: PeriodIncomeEntry[];
  }>(`/api/incomes?period=${encodeURIComponent(period)}`, [period], {
    fallbackError: "Error",
    networkError: "Error de red",
  });
  const rows = useMemo(() => resource.data?.incomes ?? [], [resource.data?.incomes]);
  const periodEntries = useMemo(
    () => resource.data?.periodEntries ?? [],
    [resource.data?.periodEntries],
  );
  const loading = resource.loading;
  const [saving, setSaving] = useState(false);
  const [actionErrorState, setActionErrorState] = useState<Scoped<string> | null>(null);
  const [okState, setOkState] = useState<Scoped<string> | null>(null);
  const actionError = readScoped(actionErrorState, period);
  const ok = readScoped(okState, period);
  const error = actionError ?? resource.error;
  const setActionError = (message: string | null) =>
    setActionErrorState(message == null ? null : scoped(period, message));
  const setOk = (message: string | null) =>
    setOkState(message == null ? null : scoped(period, message));
  const [mode, setMode] = useState<FormMode>("recurring");
  const [incomeTick, setIncomeTick] = useState(0);

  const [date, setDate] = useState(todayDateAr);
  const [label, setLabel] = useState("");
  const [amountArs, setAmountArs] = useState("");
  const [amountUsd, setAmountUsd] = useState("");
  const [frequency, setFrequency] = useState<IncomeFrequency>("mensual");

  const { reload } = resource;
  useEffect(() => {
    function onSwitch() {
      void reload();
    }
    window.addEventListener("lc:household-switched", onSwitch);
    return () => window.removeEventListener("lc:household-switched", onSwitch);
  }, [reload]);

  function onPeriodChange(next: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (next === fallback) params.delete("period");
    else params.set("period", next);
    const qs = params.toString();
    router.replace(qs ? `/ingresos?${qs}` : "/ingresos", { scroll: false });
  }

  const recurringRows = useMemo(
    () => rows.filter((r) => r.kind === "recurring"),
    [rows],
  );

  const clientEntries = useMemo(() => {
    if (periodEntries.length > 0) return periodEntries;
    return periodIncomeEntries(rows, period);
  }, [periodEntries, rows, period]);

  async function submit() {
    setSaving(true);
    setActionError(null);
    setOk(null);
    try {
      const ars = amountArs.trim() ? Number(amountArs.replace(",", ".")) : null;
      const usd = amountUsd.trim() ? Number(amountUsd.replace(",", ".")) : null;
      const res = await fetch("/api/incomes", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date,
          label,
          amountArs: ars,
          amountUsd: usd,
          kind: mode,
          frequency: mode === "recurring" ? frequency : null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Error");
      setLabel("");
      setAmountArs("");
      setAmountUsd("");
      setOk(
        mode === "recurring"
          ? "Sueldo recurrente guardado"
          : "Ingreso variable guardado",
      );
      await resource.reload();
      setIncomeTick((tick) => tick + 1);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Error");
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    setActionError(null);
    try {
      const res = await fetch(`/api/incomes?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Error");
      await resource.reload();
      setIncomeTick((tick) => tick + 1);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Error");
    }
  }

  if (loading) return <ListSkeleton label="Cargando ingresos…" rows={4} />;

  return (
    <PageStack className="!space-y-4">
      <PageHeader
        title="Ingresos"
        description={`Sueldos y cobros · ${formatPeriodLabel(period)}. Las transferencias internas no son ingreso. La neta del inicio es esto menos los gastos.`}
        actions={
          <select
            value={period}
            onChange={(e) => onPeriodChange(e.target.value)}
            className="lc-input min-h-11 min-w-[10rem]"
            aria-label="Período"
          >
            {periods.map((p) => (
              <option key={p} value={p}>
                {formatPeriodTitle(p)}
              </option>
            ))}
          </select>
        }
      />

      <SectionNav section="movimientos" />

      {error && (
        <p className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40">
          {error}
        </p>
      )}
      {ok && <Toast>{ok}</Toast>}

      <IncomeByMonthChart refreshKey={incomeTick} />

      <SegmentedControl
        value={mode}
        onChange={setMode}
        options={[
          { id: "recurring", label: "Sueldo recurrente" },
          { id: "variable", label: "Variables" },
        ]}
      />

      <Surface className="space-y-3 !p-4">
        <p className="text-sm font-semibold">
          {mode === "recurring" ? "Sueldo" : "Cobro puntual"}
        </p>
        <p className="text-xs text-[var(--muted-fg)]">
          {mode === "recurring"
            ? "Frecuencia y monto. En el mes aparecen las fechas que caen, no inventamos cobros."
            : "Una venta, un extra, un cobro del día."}
        </p>

        <div>
          <FieldLabel>
            {mode === "recurring" ? "Desde / primer cobro" : "Fecha"}
          </FieldLabel>
          <input
            type="date"
            className="lc-input w-full"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>

        {mode === "recurring" && (
          <div>
            <FieldLabel>Frecuencia</FieldLabel>
            <div className="grid grid-cols-3 gap-2">
              {INCOME_FREQUENCIES.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setFrequency(f.id)}
                  className={cn(
                    "min-h-10 rounded-xl border px-2 py-2 text-center text-xs font-medium transition",
                    frequency === f.id
                      ? "border-[var(--brand)] bg-[var(--brand-soft)] text-[var(--brand-fg)]"
                      : "border-[var(--border)] text-[var(--muted-fg)] hover:bg-[var(--surface-muted)]",
                  )}
                >
                  <div>{f.label}</div>
                  <div className="mt-0.5 text-[10px] font-normal opacity-80">
                    {f.hint}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        <div>
          <FieldLabel>Qué es</FieldLabel>
          <input
            className="lc-input w-full"
            placeholder={
              mode === "recurring"
                ? "Sueldo, honorarios…"
                : "Venta, ingreso del día, freelance…"
            }
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <FieldLabel>Pesos</FieldLabel>
            <input
              className="lc-input w-full"
              inputMode="decimal"
              placeholder="0"
              value={amountArs}
              onChange={(e) => setAmountArs(e.target.value)}
            />
          </div>
          <div>
            <FieldLabel>Dólares</FieldLabel>
            <input
              className="lc-input w-full"
              inputMode="decimal"
              placeholder="0"
              value={amountUsd}
              onChange={(e) => setAmountUsd(e.target.value)}
            />
          </div>
        </div>
        <button
          type="button"
          className="lc-btn lc-btn-primary w-full"
          disabled={saving || !label.trim()}
          onClick={() => void submit()}
        >
          {saving
            ? "Guardando…"
            : mode === "recurring"
              ? "Guardar sueldo"
              : "Guardar ingreso"}
        </button>
      </Surface>

      {recurringRows.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--muted-fg)]">
            Sueldos recurrentes
          </h2>
          <ul className="space-y-2">
            {recurringRows.map((r) => {
              const expected = clientEntries.filter(
                (e) => e.sourceId === r.id && e.expected,
              );
              return (
                <li
                  key={r.id}
                  className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-3.5 py-3"
                >
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{r.label}</p>
                      <p className="text-xs text-[var(--muted-fg)]">
                        {frequencyLabel(r.frequency)} · desde{" "}
                        {formatDateAr(r.date)}
                      </p>
                    </div>
                    <div className="lc-amount max-w-[42%] shrink-0 text-right text-sm font-semibold text-[var(--brand-fg)]">
                      {r.amountArs != null && <div>{formatArs(r.amountArs)}</div>}
                      {r.amountUsd != null && (
                        <div
                          className={cn(
                            r.amountArs != null && "text-xs font-medium",
                          )}
                        >
                          {formatUsd(r.amountUsd)}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      className="inline-flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-lg text-[var(--muted-fg)] hover:bg-[var(--surface-muted)] hover:text-red-600"
                      aria-label="Borrar sueldo recurrente"
                      onClick={() => void remove(r.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="mt-2 rounded-xl bg-[var(--surface-muted)]/70 px-2.5 py-2">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--muted-fg)]">
                      Esperado este mes
                    </p>
                    {expected.length === 0 ? (
                      <p className="mt-1 text-xs text-[var(--muted-fg)]">
                        Ningún cobro cae en {formatPeriodLabel(period)} (revisá
                        la fecha ancla).
                      </p>
                    ) : (
                      <ul className="mt-1 space-y-1">
                        {expected.map((e) => (
                          <li
                            key={`${e.sourceId}-${e.date}`}
                            className="flex justify-between gap-2 text-xs"
                          >
                            <span>{formatDateAr(e.date)} · esperado</span>
                            <span className="tabular-nums font-medium">
                              {e.amountArs != null && formatArs(e.amountArs)}
                              {e.amountArs != null &&
                                e.amountUsd != null &&
                                " · "}
                              {e.amountUsd != null && formatUsd(e.amountUsd)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--muted-fg)]">
          Este mes
        </h2>
        {clientEntries.length === 0 ? (
          <EmptyState
            title="Todavía no hay ingresos"
            description="Cargá el sueldo y el inicio deja de mostrar solo gastos: aparece la neta de verdad."
          />
        ) : (
          <ul className="space-y-2">
            {clientEntries.map((r) => (
              <li
                key={`${r.sourceId}-${r.date}-${r.expected ? "e" : "v"}`}
                className="flex items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-3.5 py-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{r.label}</p>
                  <p className="text-xs text-[var(--muted-fg)]">
                    {formatDateAr(r.date)}
                    {r.expected
                      ? ` · esperado (${frequencyLabel(r.frequency)})`
                      : " · variable"}
                  </p>
                </div>
                <div className="lc-amount max-w-[42%] shrink-0 text-right text-sm font-semibold text-[var(--brand-fg)]">
                  {r.amountArs != null && <div>{formatArs(r.amountArs)}</div>}
                  {r.amountUsd != null && (
                    <div
                      className={cn(
                        r.amountArs != null && "text-xs font-medium",
                      )}
                    >
                      {formatUsd(r.amountUsd)}
                    </div>
                  )}
                </div>
                {!r.expected && (
                  <button
                    type="button"
                    className="inline-flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-lg text-[var(--muted-fg)] hover:bg-[var(--surface-muted)] hover:text-red-600"
                    aria-label="Borrar"
                    onClick={() => void remove(r.sourceId)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </PageStack>
  );
}
