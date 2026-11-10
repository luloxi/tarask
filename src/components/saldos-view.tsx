"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useJsonResource } from "@/hooks/use-json-resource";
import type { Currency } from "@/lib/stats/currency";
import { formatCurrencyAmount, formatDateAr, todayDateAr } from "@/lib/utils";
import { SectionNav } from "@/components/section-nav";
import { CURRENCY_OPTIONS, ChoiceRow, Legend, MoneyLineChart } from "@/components/money-charts";
import { EmptyState, LoadingBlock, PageHeader, PageStack, Surface } from "@/components/ui";

type BalanceResponse = {
  today: string;
  currency: Currency;
  latest: { account: string; currency: string; amount: number; date: string; source: string }[];
  totals: { currency: string; total: number }[];
  series: { account: string; date: string; amount: number }[];
  accounts: string[];
};

export function SaldosView() {
  const [currency, setCurrency] = useState<Currency>("ARS");
  const resource = useJsonResource<BalanceResponse>(`/api/balances?currency=${currency}`, [currency], {
    fallbackError: "No se pudieron leer los saldos",
    staleWhileReload: true,
  });
  const { reload } = resource;
  useEffect(() => {
    function onSwitch() {
      void reload();
    }
    window.addEventListener("lc:household-switched", onSwitch);
    return () => window.removeEventListener("lc:household-switched", onSwitch);
  }, [reload]);

  const series = useMemo(() => {
    const data = resource.data;
    if (!data) return [];
    const names = [...new Set(data.series.map((point) => point.account))];
    return names.map((name) => ({
      name,
      points: data.series
        .filter((point) => point.account === name)
        .map((point) => ({ x: point.date, y: point.amount })),
    }));
  }, [resource.data]);

  const data = resource.data;

  return (
    <PageStack className="!space-y-4">
      <PageHeader
        title="Saldos"
        description="Último saldo de cada cuenta. ARS, USDT y USD se muestran aparte, sin conversión. Lo que ves en Tenés sigue saliendo de Ahorros."
      />
      <SectionNav section="patrimonio" />
      {resource.loading && !data ? <LoadingBlock label="Cargando saldos…" /> : null}
      {resource.error ? <p className="text-[15px] text-[var(--err-text)]">{resource.error}</p> : null}
      {!resource.loading && !resource.error && !data ? (
        <EmptyState
          title="Todavía no hay saldos"
          description="Cuando cargues un saldo de cuenta, aparece acá."
        />
      ) : null}
      {data ? (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {(["ARS", "USDT", "USD"] as const).map((code) => {
              const found = data.totals.find((item) => item.currency === code);
              return (
                <Surface key={code} className="!p-4">
                  <p className="text-[13px] font-medium text-[var(--muted-fg)]">{code}</p>
                  <p className="lc-amount mt-1 text-[1.25rem] font-semibold">
                    {found ? formatCurrencyAmount(code, found.total) : "Sin datos"}
                  </p>
                </Surface>
              );
            })}
          </div>
          <Surface className="!p-0">
            <ul className="divide-y divide-[var(--border)]">
              {data.latest.length === 0 ? (
                <li className="px-4 py-4 text-[15px] text-[var(--muted-fg)]">Todavía no hay saldos cargados.</li>
              ) : (
                data.latest.map((row) => (
                  <li key={`${row.account}-${row.currency}`} className="flex items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[15px] font-medium">{row.account}</p>
                      <p className="text-[13px] text-[var(--muted-fg)]">
                        {row.currency} · {formatDateAr(row.date)} · {row.source === "routine" ? "Rutina" : "Manual"}
                      </p>
                    </div>
                    <p className="lc-amount max-w-[48%] shrink-0 text-right font-semibold">
                      {formatCurrencyAmount(row.currency as Currency, row.amount)}
                    </p>
                  </li>
                ))
              )}
            </ul>
          </Surface>
          <Surface className="space-y-3">
            <h2 className="text-sm font-semibold">Evolución del saldo</h2>
            <ChoiceRow label="Moneda del gráfico" value={currency} options={CURRENCY_OPTIONS} onChange={setCurrency} />
            <MoneyLineChart series={series} ariaLabel="Saldo por cuenta" currency={currency} />
            <Legend items={series} />
          </Surface>
          <BalanceForm accounts={data.accounts} onSaved={() => void reload()} />
        </>
      ) : null}
    </PageStack>
  );
}

function BalanceForm({ accounts, onSaved }: { accounts: string[]; onSaved: () => void }) {
  const [picked, setPicked] = useState<string | null>(null);
  const choice =
    picked === "__new__" || (picked != null && accounts.includes(picked))
      ? picked
      : (accounts[0] ?? "__new__");
  const [custom, setCustom] = useState("");
  const [currency, setCurrency] = useState<Currency>("ARS");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(todayDateAr());
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const account = choice === "__new__" ? custom.trim() : choice;
    const parsed = parseAmount(amount);
    if (!account || account.length > 60) {
      setOk(false);
      setMessage("La cuenta tiene que tener entre 1 y 60 caracteres.");
      return;
    }
    if (parsed === null) {
      setOk(false);
      setMessage("El importe no es un número.");
      return;
    }
    setPending(true);
    setMessage(null);
    try {
      const res = await fetch("/api/balances/manual", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account, currency, amount: parsed, date: date || undefined }),
      });
      if (res.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (!res.ok) throw new Error("save");
      setOk(true);
      setMessage("Saldo guardado.");
      setAmount("");
      onSaved();
    } catch {
      setOk(false);
      setMessage("No se pudo guardar el saldo.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="lc-card space-y-3 p-4 sm:p-5" onSubmit={(event) => void submit(event)}>
      <h2 className="text-sm font-semibold">Cargar saldo</h2>
      <p className="text-[13px] text-[var(--muted-fg)]">Se guarda como origen manual, en la moneda que elijas.</p>
      <label className="block text-[13px] font-medium">
        Cuenta
        <select
          className="lc-input mt-1 w-full"
          value={choice}
          onChange={(event) => setPicked(event.target.value)}
        >
          {accounts.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
          <option value="__new__">Nueva cuenta…</option>
        </select>
      </label>
      {choice === "__new__" ? (
        <label className="block text-[13px] font-medium">
          Nombre
          <input
            className="lc-input mt-1 w-full"
            value={custom}
            onChange={(event) => setCustom(event.target.value)}
            maxLength={60}
            required
          />
        </label>
      ) : null}
      <label className="block text-[13px] font-medium">
        Moneda
        <select
          className="lc-input mt-1 w-full"
          value={currency}
          onChange={(event) => setCurrency(event.target.value as Currency)}
        >
          <option value="ARS">ARS</option>
          <option value="USDT">USDT</option>
          <option value="USD">USD</option>
        </select>
      </label>
      <label className="block text-[13px] font-medium">
        Importe
        <input
          className="lc-input mt-1 w-full"
          inputMode="decimal"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          required
          placeholder="0,00"
        />
      </label>
      <label className="block text-[13px] font-medium">
        Fecha
        <input className="lc-input mt-1 w-full" type="date" value={date} onChange={(event) => setDate(event.target.value)} required />
      </label>
      <button type="submit" className="lc-btn lc-btn-primary w-full" disabled={pending}>
        {pending ? "Guardando…" : "Guardar saldo"}
      </button>
      {message ? (
        <p className={ok ? "text-[14px] text-[var(--ok-text)]" : "text-[14px] text-[var(--err-text)]"}>{message}</p>
      ) : null}
    </form>
  );
}

function parseAmount(raw: string): number | null {
  const text = raw.trim().replace(/\s/g, "");
  if (!text) return null;
  const normalized = text.includes(",") && text.lastIndexOf(",") > text.lastIndexOf(".")
    ? text.replace(/\./g, "").replace(",", ".")
    : text.replace(/,/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}
