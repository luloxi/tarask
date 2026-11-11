"use client";

import { useCallback, useEffect, useState } from "react";
import { isAbortError } from "@/hooks/use-json-resource";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { SectionNav } from "@/components/section-nav";
import { cn, formatArs, formatUsd, formatDateAr } from "@/lib/utils";
import {
  FieldLabel,
  ListSkeleton,
  SegmentedControl,
  Surface,
} from "@/components/ui";

type PaymentRow = {
  id: string;
  date: string;
  description: string;
  amountArs: number | null;
  amountUsd: number | null;
  kind: "payment" | "credit";
};

type OpenInstallment = {
  description: string;
  current: number;
  total: number;
  remainingCount: number;
  installmentArs: number;
  remainingArs: number;
  date: string;
};

type OpenCharge = {
  id?: string;
  date: string;
  description: string;
  amountArs: number;
  amountUsd: number;
};

type Summary = {
  currentBalanceArs: number;
  currentBalanceUsd: number;
  peakBalanceArs: number;
  totalPaidArs: number;
  totalPaidUsd: number;
  totalChargesArs: number;
  totalChargesUsd: number;
  settled?: boolean;
  forceSettled?: boolean;
  mode?: string;
  primaryCardLast4?: string | null;
  /** Live snapshot / installments open saldo when present. */
  saldoSnapshotArs?: number;
  netDebtArs?: number;
};

type DebtSettings = {
  ratePct: number | null;
  minPaymentArs: number | null;
  dueDay: number | null;
  notes: string | null;
  forceSettled?: boolean;
  cardLast4?: string | null;
  saldoDeudaArs?: number | null;
  saldoDeudaUsd?: number | null;
};

type PastStatement = {
  id: string;
  fileName: string | null;
  source: string;
  status?: string;
  closedAt: string | null;
  importedAt?: string | null;
  rowCount?: number;
  periodFrom?: string | null;
  periodTo?: string | null;
};

type PastCuota = {
  date: string;
  description: string;
  installment: string | null;
  amountArs: number | null;
};

type DebtTab = "evolucion" | "pagos";

function tabFromParam(raw: string | null): DebtTab {
  return raw === "pagos" ? "pagos" : "evolucion";
}

function MiniStat({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "brand" | "danger";
}) {
  return (
    <div
      className={cn(
        "min-w-0 flex-1 rounded-xl border px-2.5 py-2 text-center",
        tone === "danger" &&
          "border-red-200/80 bg-red-50/80 dark:border-red-900/50 dark:bg-red-950/30",
        tone === "brand" &&
          "border-emerald-200/80 bg-emerald-50/80 dark:border-emerald-900/50 dark:bg-emerald-950/30",
        tone === "neutral" &&
          "border-zinc-200/90 bg-white/80 dark:border-zinc-800 dark:bg-zinc-950/60",
      )}
    >
      <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
        {label}
      </p>
      <p
        className={cn(
          "mt-0.5 text-sm font-bold tabular-nums tracking-tight sm:text-base",
          tone === "danger" && "text-red-800 dark:text-red-200",
          tone === "brand" && "text-emerald-900 dark:text-emerald-100",
          tone === "neutral" && "text-zinc-900 dark:text-zinc-50",
        )}
      >
        {value}
      </p>
    </div>
  );
}

function nextDueLabel(dueDay: number | null): string | null {
  if (dueDay == null || dueDay < 1 || dueDay > 31) return null;
  const now = new Date();
  let y = now.getFullYear();
  let m = now.getMonth();
  const today = now.getDate();
  if (today > dueDay) {
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
  }
  const dim = new Date(y, m + 1, 0).getDate();
  const day = Math.min(dueDay, dim);
  const d = String(day).padStart(2, "0");
  const mo = String(m + 1).padStart(2, "0");
  return `${d}/${mo}/${y}`;
}

function estimateMonthlyInterest(
  balanceArs: number,
  ratePct: number | null,
): number | null {
  if (ratePct == null || ratePct <= 0 || balanceArs <= 0) return null;
  return (balanceArs * ratePct) / 100 / 12;
}

export function DeudaView() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [openInstallments, setOpenInstallments] = useState<OpenInstallment[]>(
    [],
  );
  const [openCharges, setOpenCharges] = useState<OpenCharge[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const urlTab = tabFromParam(searchParams.get("tab"));
  const [tab, setTab] = useState<DebtTab>(urlTab);
  const [seenTab, setSeenTab] = useState(urlTab);
  if (urlTab !== seenTab) {
    setSeenTab(urlTab);
    setTab(urlTab);
  }
  const [settings, setSettings] = useState<DebtSettings>({
    ratePct: null,
    minPaymentArs: null,
    dueDay: null,
    notes: null,
    forceSettled: false,
    saldoDeudaArs: null,
    saldoDeudaUsd: null,
  });
  const [rateInput, setRateInput] = useState("");
  const [minInput, setMinInput] = useState("");
  const [dueInput, setDueInput] = useState("");
  const [notesInput, setNotesInput] = useState("");
  const [saldoArsInput, setSaldoArsInput] = useState("");
  const [saldoUsdInput, setSaldoUsdInput] = useState("");
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsMsg, setSettingsMsg] = useState<string | null>(null);
  const [statements, setStatements] = useState<PastStatement[]>([]);
  const [pastCuotas, setPastCuotas] = useState<PastCuota[]>([]);
  const [cardStatus, setCardStatus] = useState<string | null>(null);

  const onTab = useCallback(
    (v: DebtTab) => {
      setTab(v);
      router.replace(`/deuda?tab=${v}`, { scroll: false });
    },
    [router],
  );

  const storeDeuda = useCallback(
    (
      data: {
        payments?: PaymentRow[];
        openInstallments?: OpenInstallment[];
        openCharges?: OpenCharge[];
        summary?: Summary | null;
        statements?: PastStatement[];
        pastInstallments?: PastCuota[];
        cardStatus?: string | null;
      },
      settingsOk: boolean,
      setData: { settings?: DebtSettings },
    ) => {
      setPayments(data.payments ?? []);
      setOpenInstallments(data.openInstallments ?? []);
      setOpenCharges(data.openCharges ?? []);
      setSummary(data.summary ?? null);
      setStatements(data.statements ?? []);
      setPastCuotas(data.pastInstallments ?? []);
      setCardStatus(data.cardStatus ?? null);
      if (settingsOk && setData.settings) {
        const s = setData.settings;
        setSettings(s);
        setRateInput(s.ratePct != null ? String(s.ratePct) : "");
        setMinInput(s.minPaymentArs != null ? String(s.minPaymentArs) : "");
        setDueInput(s.dueDay != null ? String(s.dueDay) : "");
        setNotesInput(s.notes ?? "");
        setSaldoArsInput(s.saldoDeudaArs != null ? String(s.saldoDeudaArs) : "");
        setSaldoUsdInput(s.saldoDeudaUsd != null ? String(s.saldoDeudaUsd) : "");
      }
    },
    [],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [debtRes, setRes] = await Promise.all([
        fetch("/api/stats/deuda", { credentials: "include" }),
        fetch("/api/debt-settings", { credentials: "include" }),
      ]);
      const data = await debtRes.json();
      if (!debtRes.ok) throw new Error(data.error || "Error");
      const setData = await setRes.json();
      storeDeuda(data, setRes.ok, setData);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error de red");
    } finally {
      setLoading(false);
    }
  }, [storeDeuda]);

  useEffect(() => {
    const ac = new AbortController();
    Promise.all([
      fetch("/api/stats/deuda", { credentials: "include", signal: ac.signal }),
      fetch("/api/debt-settings", { credentials: "include", signal: ac.signal }),
    ])
      .then(async ([debtRes, setRes]) => {
        const data = await debtRes.json();
        if (!debtRes.ok) throw new Error(data.error || "Error");
        const setData = await setRes.json();
        return { data, settingsOk: setRes.ok, setData };
      })
      .then((payload) => {
        if (ac.signal.aborted) return;
        storeDeuda(payload.data, payload.settingsOk, payload.setData);
        setError(null);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted || isAbortError(e)) return;
        setError(e instanceof Error ? e.message : "Error de red");
        setLoading(false);
      });
    return () => ac.abort();
  }, [storeDeuda]);

  async function saveSettings(patch?: Partial<DebtSettings>) {
    setSavingSettings(true);
    setSettingsMsg(null);
    try {
      const res = await fetch("/api/debt-settings", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ratePct: rateInput.trim() ? Number(rateInput.replace(",", ".")) : null,
          minPaymentArs: minInput.trim()
            ? Number(minInput.replace(",", "."))
            : null,
          dueDay: dueInput.trim() ? Number(dueInput) : null,
          notes: notesInput.trim() || null,
          saldoDeudaArs: saldoArsInput.trim()
            ? Number(saldoArsInput.replace(",", "."))
            : null,
          saldoDeudaUsd: saldoUsdInput.trim()
            ? Number(saldoUsdInput.replace(",", "."))
            : null,
          forceSettled:
            patch?.forceSettled !== undefined
              ? patch.forceSettled
              : settings.forceSettled,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Error");
      const s = data.settings as DebtSettings;
      setSettings(s);
      setSaldoArsInput(
        s.saldoDeudaArs != null ? String(s.saldoDeudaArs) : "",
      );
      setSaldoUsdInput(
        s.saldoDeudaUsd != null ? String(s.saldoDeudaUsd) : "",
      );
      setSettingsMsg("Guardado");
      // Saldo / forceSettled change the hero — refresh summary.
      await load();
    } catch (e) {
      setSettingsMsg(e instanceof Error ? e.message : "Error");
    } finally {
      setSavingSettings(false);
    }
  }

  if (loading) {
    return <ListSkeleton label="Calculando deuda y pagos…" rows={5} />;
  }
  if (error) {
    return (
      <p className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40">
        {error}
      </p>
    );
  }

  const onlyPayments = payments.filter((p) => p.kind === "payment");
  const forced = Boolean(settings.forceSettled || summary?.forceSettled);
  const mode = summary?.mode ?? "empty";
  // Rainman: saldo_deuda (manual / import) is the only balance SoT.
  const hasSaldo =
    mode === "manual" ||
    mode === "snapshot" ||
    settings.saldoDeudaArs != null ||
    settings.saldoDeudaUsd != null;
  // Never infer Saldada from a $0 balance — empty / no saldo is not settled.
  const settled = Boolean(summary?.settled);
  // Without saldo_deuda → Sin snapshot. User can type it or import card resumen.
  const missingSnapshot = !forced && !hasSaldo && mode === "empty";
  const paymentRows = onlyPayments.length ? onlyPayments : payments;
  const balance = Math.max(
    summary?.saldoSnapshotArs ??
      summary?.netDebtArs ??
      summary?.currentBalanceArs ??
      0,
    0,
  );
  const interestEst = estimateMonthlyInterest(balance, settings.ratePct);
  const dueLabel = nextDueLabel(settings.dueDay);

  const noCard =
    cardStatus === "sin_tarjeta_activa" ||
    (settled && !summary?.primaryCardLast4 && balance === 0);
  const heroLabel = settled ? "Estado" : "Deuda";
  const heroValue = noCard
    ? "Sin deuda"
    : settled
      ? "Saldada"
      : !hasSaldo || mode === "empty"
        ? "Sin snapshot"
        : formatArs(balance);
  const heroTone: "neutral" | "brand" | "danger" = settled
    ? "brand"
    : !hasSaldo || mode === "empty"
      ? "neutral"
      : "danger";

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-[1.6rem] font-semibold leading-tight tracking-tight">Deuda</h1>
        <p className="mt-1 text-[15px] text-[var(--muted-fg)]">Tu tarjeta y lo que falta pagar.</p>
      </div>
      <SectionNav section="patrimonio" />
      <Surface className="space-y-3 !p-4">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">
            {noCard ? "Sin tarjeta activa" : "Tu tarjeta"}
          </h2>
          <p className="text-[15px] text-[var(--muted-fg)]">
            {noCard
              ? "Hoy no hay deuda. Los resúmenes viejos quedan en el historial."
              : "El saldo lo cargás vos. No inventamos números desde la cuenta."}
          </p>
        </div>
        <details className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2">
          <summary className="cursor-pointer text-[15px] font-medium">Ajustes</summary>
          <div className="mt-3 space-y-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div>
            <FieldLabel>Tasa TNA %</FieldLabel>
            <input
              className="lc-input w-full"
              inputMode="decimal"
              placeholder="ej. 90"
              value={rateInput}
              onChange={(e) => setRateInput(e.target.value)}
            />
          </div>
          <div>
            <FieldLabel>Pago mínimo</FieldLabel>
            <input
              className="lc-input w-full"
              inputMode="decimal"
              placeholder="ARS"
              value={minInput}
              onChange={(e) => setMinInput(e.target.value)}
            />
          </div>
          <div>
            <FieldLabel>Vence día</FieldLabel>
            <input
              className="lc-input w-full"
              inputMode="numeric"
              placeholder="1–31"
              value={dueInput}
              onChange={(e) => setDueInput(e.target.value)}
            />
          </div>
          <div className="col-span-2 sm:col-span-1">
            <FieldLabel>Notas</FieldLabel>
            <input
              className="lc-input w-full"
              placeholder="opcional"
              value={notesInput}
              onChange={(e) => setNotesInput(e.target.value)}
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div>
            <FieldLabel>Saldo deuda ARS</FieldLabel>
            <input
              className="lc-input w-full"
              inputMode="decimal"
              placeholder="ej. 2895037"
              value={saldoArsInput}
              onChange={(e) => setSaldoArsInput(e.target.value)}
            />
          </div>
          <div>
            <FieldLabel>Saldo deuda USD</FieldLabel>
            <input
              className="lc-input w-full"
              inputMode="decimal"
              placeholder="opcional"
              value={saldoUsdInput}
              onChange={(e) => setSaldoUsdInput(e.target.value)}
            />
          </div>
        </div>
        {(interestEst != null || dueLabel || settings.minPaymentArs != null) && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-zinc-100 pt-2 text-[11px] text-zinc-500 dark:border-zinc-800">
            {dueLabel && (
              <span>
                Próximo vencimiento{" "}
                <span className="font-medium text-zinc-800 dark:text-zinc-200">
                  {dueLabel}
                </span>
              </span>
            )}
            {settings.minPaymentArs != null && (
              <span>
                Mínimo{" "}
                <span className="font-medium tabular-nums text-zinc-800 dark:text-zinc-200">
                  {formatArs(settings.minPaymentArs)}
                </span>
              </span>
            )}
            {interestEst != null && (
              <span>
                Interés est. / mes{" "}
                <span className="font-medium tabular-nums text-amber-800 dark:text-amber-200">
                  {formatArs(interestEst)}
                </span>
                <span className="opacity-70"> · TNA÷12×saldo</span>
              </span>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="lc-btn lc-btn-primary min-h-10 min-w-10 cursor-pointer !px-3 text-sm"
            disabled={savingSettings}
            onClick={() => void saveSettings()}
          >
            {savingSettings ? "Guardando…" : "Guardar"}
          </button>
          <button
            type="button"
            className="lc-btn lc-btn-ghost min-h-10 min-w-10 cursor-pointer !px-3 text-sm"
            disabled={savingSettings}
            onClick={() => void saveSettings({ forceSettled: !forced })}
          >
            {forced ? "Mostrar saldo real" : "Marcar saldada"}
          </button>
          {settingsMsg && (
            <span className="text-xs text-zinc-500">{settingsMsg}</span>
          )}
        </div>
          </div>
        </details>
      </Surface>

      <div className="flex justify-end">
        <SegmentedControl
          value={tab}
          onChange={onTab}
          options={[
            { id: "evolucion", label: "Cuotas" },
            { id: "pagos", label: "Pagos" },
          ]}
        />
      </div>

      {summary && (
        <div className="flex gap-2">
          <MiniStat label={heroLabel} value={heroValue} tone={heroTone} />
          <MiniStat
            label="Pagado"
            value={formatArs(summary.totalPaidArs)}
            tone="neutral"
          />
          <MiniStat
            label="Cargos abiertos"
            value={String(openInstallments.length + openCharges.length)}
          />
        </div>
      )}

      {missingSnapshot && (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
          Sin saldo de deuda. Escribí el{" "}
          <span className="font-semibold">Saldo actual</span> de tu tarjeta
          arriba. El saldo de la cuenta corriente no cuenta como deuda.
        </p>
      )}

      {(statements.length > 0 || pastCuotas.length > 0) && (
        <details className="rounded-2xl border border-[var(--border)] bg-[var(--surface)]" open>
          <summary className="cursor-pointer px-4 py-3 text-[15px] font-medium">
            Historial de resúmenes
          </summary>
          <div className="space-y-3 px-4 pb-4 text-[15px] text-[var(--muted-fg)]">
            <p>
              Lo que se importó en LlevaCuentas. No suma deuda de hoy.{" "}
              <Link href="/cargas" className="font-medium text-[var(--accent-text)] underline-offset-2 hover:underline">
                Ver todos
              </Link>
            </p>
            {statements.length > 0 && (
              <ul className="space-y-2">
                {statements.map((row) => (
                  <li key={row.id} className="flex justify-between gap-3">
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-[var(--text)]">
                        {row.fileName || row.source}
                      </span>
                      {row.periodFrom && row.periodTo && (
                        <span className="block text-[13px]">
                          {row.periodFrom === row.periodTo
                            ? formatDateAr(row.periodFrom)
                            : `${formatDateAr(row.periodFrom)} – ${formatDateAr(row.periodTo)}`}
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 text-[13px]">
                      {row.status === "closed" ? "cerrado" : "abierto"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {pastCuotas.length > 0 && (
              <ul className="space-y-1">
                {pastCuotas.map((row, index) => (
                  <li key={`${row.date}-${index}`} className="flex justify-between gap-3">
                    <span className="min-w-0 truncate">
                      {formatDateAr(row.date)} · {row.description}
                      {row.installment ? ` · ${row.installment}` : ""}
                    </span>
                    <span className="shrink-0 tabular-nums">
                      {row.amountArs != null ? formatArs(row.amountArs) : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </details>
      )}

      {tab === "evolucion" ? (
        <div className="space-y-3">
          {forced && (
            <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100">
              {noCard
                ? "Sin deuda y sin tarjeta activa. El historial queda guardado."
                : "Marcaste la deuda como saldada. La tarjeta y este número quedan en 0."}
            </p>
          )}

          <Surface>
            <h2 className="mb-1 text-sm font-semibold tracking-tight">
              Cuotas abiertas
            </h2>
            <p className="mb-3 text-[11px] text-zinc-500">
              Solo 4/6, 2/3 y similares. Las 3/3 o 6/6 ya no cuentan.
            </p>
            {openInstallments.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-zinc-200 px-4 py-8 text-center text-sm text-zinc-500 dark:border-zinc-800">
                No hay cuotas abiertas en tu tarjeta.
              </p>
            ) : (
              <ul className="space-y-2">
                {openInstallments.map((p) => (
                  <li
                    key={`${p.description}|${p.total}|${p.installmentArs}`}
                    className="flex items-start justify-between gap-3 rounded-2xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium leading-snug">
                        {p.description}
                      </p>
                      <p className="mt-0.5 text-xs text-zinc-500">
                        Cuota {p.current}/{p.total} · restan {p.remainingCount}{" "}
                        de {formatArs(p.installmentArs)}
                      </p>
                    </div>
                    <p className="shrink-0 text-sm font-semibold tabular-nums text-red-800 dark:text-red-200">
                      {formatArs(p.remainingArs)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Surface>

          <Surface>
            <h2 className="mb-1 text-sm font-semibold tracking-tight">
              Cargos abiertos
            </h2>
            <p className="mb-3 text-[11px] text-zinc-500">
              Del último “Últimos movimientos”: TEMBICI, Ecobici y similares.
            </p>
            {openCharges.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-zinc-200 px-4 py-8 text-center text-sm text-zinc-500 dark:border-zinc-800">
                No hay cargos chicos pendientes.
              </p>
            ) : (
              <ul className="space-y-2">
                {openCharges.map((c) => (
                  <li
                    key={`${c.date}|${c.description}|${c.amountArs}`}
                    className="flex items-start justify-between gap-3 rounded-2xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium leading-snug">
                        {c.description}
                      </p>
                      <p className="mt-0.5 text-xs text-zinc-500">
                        {formatDateAr(c.date)}
                      </p>
                    </div>
                    <p className="shrink-0 text-sm font-semibold tabular-nums">
                      {c.amountArs > 0
                        ? formatArs(c.amountArs)
                        : formatUsd(c.amountUsd)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Surface>
        </div>
      ) : (
        <>
          <ul className="space-y-2 md:hidden">
            {paymentRows.map((p) => (
              <li
                key={p.id}
                className="rounded-2xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium leading-snug">
                      {p.description}
                    </p>
                    <p className="mt-0.5 text-xs text-zinc-500">
                      {formatDateAr(p.date)}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase",
                        p.kind === "payment"
                          ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
                          : "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200",
                      )}
                    >
                      {p.kind === "payment" ? "Pago" : "Crédito"}
                    </span>
                    <p className="mt-1 text-sm font-semibold tabular-nums text-emerald-700 dark:text-emerald-300">
                      {p.amountArs != null
                        ? formatArs(Math.abs(p.amountArs))
                        : p.amountUsd != null
                          ? formatUsd(Math.abs(p.amountUsd))
                          : "—"}
                    </p>
                  </div>
                </div>
              </li>
            ))}
            {paymentRows.length === 0 && (
              <li className="rounded-2xl border border-dashed border-zinc-200 px-4 py-8 text-center text-sm text-zinc-500 dark:border-zinc-800">
                Todavía no hay pagos en tus resúmenes importados.
              </li>
            )}
          </ul>

          <div className="lc-table-wrap hidden md:block">
            <table>
              <thead>
                <tr>
                  <th className="px-3 py-2.5 text-left">Fecha</th>
                  <th className="px-3 py-2.5 text-left">Descripción</th>
                  <th className="px-3 py-2.5 text-left">Tipo</th>
                  <th className="px-3 py-2.5 text-right">Monto</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {paymentRows.map((p) => (
                  <tr key={p.id}>
                    <td className="whitespace-nowrap px-3 py-2 text-zinc-600">
                      {formatDateAr(p.date)}
                    </td>
                    <td className="px-3 py-2 font-medium">{p.description}</td>
                    <td className="px-3 py-2">
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase",
                          p.kind === "payment"
                            ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
                            : "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200",
                        )}
                      >
                        {p.kind === "payment" ? "Pago" : "Crédito"}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium text-emerald-700 dark:text-emerald-300">
                      {p.amountArs != null
                        ? formatArs(Math.abs(p.amountArs))
                        : p.amountUsd != null
                          ? formatUsd(Math.abs(p.amountUsd))
                          : "—"}
                    </td>
                  </tr>
                ))}
                {paymentRows.length === 0 && (
                  <tr>
                    <td
                      colSpan={4}
                      className="px-3 py-8 text-center text-zinc-500"
                    >
                      Todavía no hay pagos en tus resúmenes importados.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
