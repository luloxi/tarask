"use client";

import { useCallback, useEffect, useState } from "react";
import { isAbortError } from "@/hooks/use-json-resource";
import {
  ExternalLink,
  Landmark,
  Plus,
  RefreshCw,
  Wallet,
} from "lucide-react";
import { cn, formatArs, formatUsd } from "@/lib/utils";
import { LoadingBlock, PageStack, Surface } from "@/components/ui";
import { SectionNav } from "@/components/section-nav";
import { AddressInput } from "@/components/address-input";
import { AddressDisplay } from "@/components/address-display";
import type { EnsResolution } from "@/lib/ens";

type Asset = {
  id: string;
  kind: "evm" | "cardano" | "bank";
  label: string;
  address: string | null;
  amountArs: number | null;
  amountUsd: number | null;
  lastBalanceUsd: number | null;
  lastSyncedAt: string | null;
  syncError: string | null;
};

type Summary = {
  totalArs: number;
  totalUsd: number;
  totalUsdBanks: number;
  totalUsdc: number;
  netArs: number | null;
  blueRate: number | null;
  balanceNote?: string | null;
};

type AddKind = "evm" | "cardano" | "bank" | null;

async function fetchAhorros(refresh: boolean, signal?: AbortSignal) {
  const res = await fetch(`/api/ahorros${refresh ? "?refresh=1" : ""}`, {
    credentials: "include",
    signal,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Error");
  return data as { assets?: Asset[]; summary?: Summary | null };
}

function looksLikeEnsLabel(label: string) {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(label.trim());
}

function debankProfileUrl(address: string | null | undefined): string | null {
  if (!address) return null;
  const addr = address.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(addr)) return null;
  return `https://debank.com/profile/${addr}`;
}

function DebankLink({ address }: { address: string | null }) {
  const href = debankProfileUrl(address);
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex min-h-11 items-center gap-1 text-[13px] font-medium text-[var(--brand-fg)] hover:underline"
    >
      ver en DeBank
      <ExternalLink className="h-3 w-3" />
    </a>
  );
}

export function AhorrosView() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addKind, setAddKind] = useState<AddKind>(null);
  const [label, setLabel] = useState("");
  const [address, setAddress] = useState("");
  const [resolvedEvm, setResolvedEvm] = useState<EnsResolution | null>(null);
  const [amountArs, setAmountArs] = useState("");
  const [amountUsd, setAmountUsd] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const data = await fetchAhorros(refresh);
      setAssets(data.assets ?? []);
      setSummary(data.summary ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error de red");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    fetchAhorros(false, ac.signal)
      .then((data) => {
        if (ac.signal.aborted) return;
        setAssets(data.assets ?? []);
        setSummary(data.summary ?? null);
        setError(null);
        setLoading(false);
        setRefreshing(false);
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted || isAbortError(e)) return;
        setError(e instanceof Error ? e.message : "Error de red");
        setLoading(false);
        setRefreshing(false);
      });
    return () => ac.abort();
  }, []);

  function openAdd(kind: Exclude<AddKind, null>) {
    setAddKind(kind);
    setLabel(
      kind === "evm"
        ? "Wallet EVM"
        : kind === "cardano"
          ? "Wallet Cardano"
          : "Banco",
    );
    setAddress("");
    setResolvedEvm(null);
    setAmountArs("");
    setAmountUsd("");
  }

  async function submitAdd() {
    if (!addKind) return;
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        kind: addKind,
        label: label.trim() || undefined,
      };
      if (addKind === "bank") {
        body.amountArs = amountArs ? Number(amountArs.replace(",", ".")) : 0;
        body.amountUsd = amountUsd ? Number(amountUsd.replace(",", ".")) : 0;
      } else if (addKind === "evm") {
        if (!resolvedEvm?.address) {
          throw new Error("Resolvé una address o ENS válida antes de guardar");
        }
        body.address = resolvedEvm.address;
        body.ens = resolvedEvm.ens;
        if (
          resolvedEvm.ens &&
          (!label.trim() || label.trim() === "Wallet EVM")
        ) {
          body.label = resolvedEvm.ens;
        }
        if (amountUsd) {
          body.amountUsd = Number(amountUsd.replace(",", "."));
        }
      } else {
        body.address = address.trim();
        if (amountUsd) {
          body.amountUsd = Number(amountUsd.replace(",", "."));
        }
      }
      const res = await fetch("/api/ahorros", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Error");
      setAddKind(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setSaving(false);
    }
  }

  async function saveWalletUsd(id: string, usd: string) {
    try {
      const res = await fetch("/api/ahorros", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          id,
          amountUsd: usd ? Number(usd.replace(",", ".")) : 0,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Error");
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    }
  }

  async function saveBank(id: string, ars: string, usd: string) {
    try {
      const res = await fetch("/api/ahorros", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          id,
          amountArs: ars ? Number(ars.replace(",", ".")) : 0,
          amountUsd: usd ? Number(usd.replace(",", ".")) : 0,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Error");
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    }
  }

  if (loading) return <LoadingBlock label="Cargando ahorros…" />;

  const wallets = assets.filter((a) => a.kind !== "bank");
  const banks = assets.filter((a) => a.kind === "bank");

  const canSaveEvm = addKind !== "evm" || Boolean(resolvedEvm?.address);

  return (
    <PageStack className="!space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h1 className="text-[1.6rem] font-semibold leading-tight tracking-tight">Ahorros</h1>
          <p className="text-xs text-[var(--muted-fg)]">
            Wallets y bancos · solo vos ves esto
          </p>
          <p className="text-xs text-[var(--muted-fg)]">
            {summary?.balanceNote || "Saldos guardados, sin sync en vivo."}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={refreshing}
          className="inline-flex min-h-10 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 text-[11px] font-medium text-[var(--muted-fg)] transition hover:text-[var(--foreground)] disabled:opacity-60"
        >
          <RefreshCw
            className={cn("h-3.5 w-3.5", refreshing && "animate-spin")}
          />
          Actualizar
        </button>
      </div>

      <SectionNav section="patrimonio" />

      {summary && (
        <Surface className="!p-4">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <p className="lc-amount text-3xl font-semibold tracking-tight text-[var(--foreground)]">
              {summary.netArs == null ? "Sin cotización" : formatArs(Math.round(summary.netArs))}
            </p>
            <p className="text-[11px] text-[var(--muted-fg)]">neto en pesos</p>
          </div>
          {summary.netArs == null && (
            <p className="mt-0.5 text-[10px] text-[var(--muted-fg)]">
              Sin cotización blue. No valuamos los dólares en 0.
            </p>
          )}
          {summary.blueRate != null && summary.blueRate > 0 && (
            <p className="mt-0.5 text-[10px] text-[var(--muted-fg)]">
              Incluye USD al blue (${Math.round(summary.blueRate).toLocaleString("es-AR")})
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-[var(--border)] pt-3 text-[11px] text-[var(--muted-fg)]">
            <span>
              Pesos{" "}
              <span className="tabular-nums font-medium text-[var(--foreground)]/85">
                {formatArs(summary.totalArs)}
              </span>
            </span>
            <span>
              USD{" "}
              <span className="tabular-nums font-medium text-[var(--foreground)]/85">
                {formatUsd(summary.totalUsd)}
              </span>
            </span>
            <span>
              USDC{" "}
              <span className="tabular-nums font-medium text-[var(--brand-fg)]">
                {formatUsd(summary.totalUsdc)}
              </span>
            </span>
          </div>
        </Surface>
      )}

      {error && (
        <p className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <AddChip
          icon={<Wallet className="h-3.5 w-3.5" />}
          label="EVM"
          onClick={() => openAdd("evm")}
        />
        <AddChip
          icon={<Wallet className="h-3.5 w-3.5" />}
          label="Cardano"
          onClick={() => openAdd("cardano")}
        />
        <AddChip
          icon={<Landmark className="h-3.5 w-3.5" />}
          label="Banco"
          onClick={() => openAdd("bank")}
        />
      </div>

      {addKind && (
        <Surface className="space-y-3 p-4">
          <p className="text-sm font-semibold">
            {addKind === "bank"
              ? "Agregar banco"
              : addKind === "evm"
                ? "Wallet EVM"
                : "Wallet Cardano"}
          </p>
          <input
            className="lc-input w-full"
            placeholder="Nombre (opcional)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          {addKind === "bank" ? (
            <div className="grid grid-cols-2 gap-2">
              <input
                className="lc-input w-full"
                inputMode="decimal"
                placeholder="Pesos"
                value={amountArs}
                onChange={(e) => setAmountArs(e.target.value)}
              />
              <input
                className="lc-input w-full"
                inputMode="decimal"
                placeholder="Dólares"
                value={amountUsd}
                onChange={(e) => setAmountUsd(e.target.value)}
              />
            </div>
          ) : addKind === "evm" ? (
            <>
              <AddressInput
                value={address}
                onChange={setAddress}
                onResolved={setResolvedEvm}
                placeholder="0x… o nombre.eth"
                disabled={saving}
              />
              <DebankLink address={resolvedEvm?.address ?? null} />
              <input
                className="lc-input w-full"
                inputMode="decimal"
                placeholder="Saldo en USD (a mano)"
                value={amountUsd}
                onChange={(e) => setAmountUsd(e.target.value)}
              />
              <p className="text-[11px] text-[var(--muted-fg)]">
                Cargá el saldo vos. El link abre esa wallet en DeBank para chequear.
              </p>
            </>
          ) : (
            <>
              <input
                className="lc-input w-full font-mono text-sm"
                placeholder="addr1…"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
              />
              <input
                className="lc-input w-full"
                inputMode="decimal"
                placeholder="Saldo en USD (a mano)"
                value={amountUsd}
                onChange={(e) => setAmountUsd(e.target.value)}
              />
            </>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              className="lc-btn lc-btn-primary min-h-10 flex-1 cursor-pointer"
              disabled={saving || !canSaveEvm}
              onClick={() => void submitAdd()}
            >
              {saving ? "Guardando…" : "Guardar"}
            </button>
            <button
              type="button"
              className="lc-btn lc-btn-secondary min-h-10 cursor-pointer"
              onClick={() => setAddKind(null)}
            >
              Cancelar
            </button>
          </div>
        </Surface>
      )}

      <section className="space-y-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--muted-fg)]">
          Wallets
        </h2>
        {wallets.length === 0 ? (
          <Empty>
            Agregá una wallet y cargá el saldo a mano. Si es EVM te dejo el
            link a esa wallet en DeBank para chequear.
          </Empty>
        ) : (
          <ul className="space-y-2">
            {wallets.map((a) => (
              <WalletRow
                key={a.id}
                asset={a}
                onSave={saveWalletUsd}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--muted-fg)]">
          Bancos
        </h2>
        {banks.length === 0 ? (
          <Empty>Cargá saldos en pesos y dólares de tus bancos.</Empty>
        ) : (
          <ul className="space-y-2">
            {banks.map((a) => (
              <BankRow
                key={a.id}
                asset={a}
                onSave={saveBank}
              />
            ))}
          </ul>
        )}
      </section>
    </PageStack>
  );
}

function AddChip({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex min-h-10 min-w-10 cursor-pointer items-center gap-1.5 rounded-full border border-dashed border-[var(--border)] px-3 text-xs font-semibold text-[var(--muted-fg)] transition hover:border-[var(--brand)]/40 hover:text-[var(--brand-fg)]"
    >
      <Plus className="h-3.5 w-3.5" />
      {icon}
      {label}
    </button>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-2xl border border-dashed border-[var(--border)] px-4 py-6 text-center text-sm text-[var(--muted-fg)]">
      {children}
    </p>
  );
}


function WalletRow({
  asset,
  onSave,
}: {
  asset: Asset;
  onSave: (id: string, usd: string) => Promise<void>;
}) {
  const balanceKey = `${asset.id}:${asset.lastBalanceUsd ?? ""}`;
  const [seenBalance, setSeenBalance] = useState(balanceKey);
  const [usd, setUsd] = useState(String(asset.lastBalanceUsd ?? ""));
  const [dirty, setDirty] = useState(false);
  if (balanceKey !== seenBalance) {
    setSeenBalance(balanceKey);
    setUsd(String(asset.lastBalanceUsd ?? ""));
    setDirty(false);
  }

  return (
    <li className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-1.5">
          <p className="text-sm font-medium">{asset.label}</p>
          {asset.kind === "evm" && asset.address ? (
            <div className="flex flex-wrap items-center gap-2">
              <AddressDisplay
                address={asset.address}
                ens={looksLikeEnsLabel(asset.label) ? asset.label : null}
              />
              <DebankLink address={asset.address} />
            </div>
          ) : (
            <p className="font-mono text-[11px] text-[var(--muted-fg)]">
              {asset.kind.toUpperCase()}
              {asset.address
                ? ` · ${asset.address.slice(0, 10)}…${asset.address.slice(-6)}`
                : ""}
            </p>
          )}
        </div>
      </div>
      <div>
        <p className="mb-1 text-[10px] font-semibold uppercase text-[var(--muted-fg)]">
          Dólares
        </p>
        <input
          className="lc-input w-full"
          inputMode="decimal"
          value={usd}
          onChange={(e) => {
            setUsd(e.target.value);
            setDirty(true);
          }}
        />
      </div>
      {dirty && (
        <button
          type="button"
          className="lc-btn lc-btn-primary mt-2 min-h-10 w-full cursor-pointer text-xs"
          onClick={() =>
            void onSave(asset.id, usd).then(() => setDirty(false))
          }
        >
          Guardar cambios
        </button>
      )}
    </li>
  );
}

function BankRow({
  asset,
  onSave,
}: {
  asset: Asset;
  onSave: (id: string, ars: string, usd: string) => Promise<void>;
}) {
  const balanceKey = `${asset.id}:${asset.amountArs ?? ""}:${asset.amountUsd ?? ""}`;
  const [seenBalance, setSeenBalance] = useState(balanceKey);
  const [ars, setArs] = useState(String(asset.amountArs ?? ""));
  const [usd, setUsd] = useState(String(asset.amountUsd ?? ""));
  const [dirty, setDirty] = useState(false);
  if (balanceKey !== seenBalance) {
    setSeenBalance(balanceKey);
    setArs(String(asset.amountArs ?? ""));
    setUsd(String(asset.amountUsd ?? ""));
    setDirty(false);
  }

  return (
    <li className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{asset.label}</p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase text-[var(--muted-fg)]">
            Pesos
          </p>
          <input
            className="lc-input w-full"
            inputMode="decimal"
            value={ars}
            onChange={(e) => {
              setArs(e.target.value);
              setDirty(true);
            }}
          />
        </div>
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase text-[var(--muted-fg)]">
            Dólares
          </p>
          <input
            className="lc-input w-full"
            inputMode="decimal"
            value={usd}
            onChange={(e) => {
              setUsd(e.target.value);
              setDirty(true);
            }}
          />
        </div>
      </div>
      {dirty && (
        <button
          type="button"
          className="lc-btn lc-btn-primary mt-2 min-h-10 w-full cursor-pointer text-xs"
          onClick={() =>
            void onSave(asset.id, ars, usd).then(() => setDirty(false))
          }
        >
          Guardar cambios
        </button>
      )}
    </li>
  );
}
