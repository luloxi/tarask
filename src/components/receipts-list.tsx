"use client";

import { useState } from "react";
import { useJsonResource } from "@/hooks/use-json-resource";
import { Receipt, Trash2 } from "lucide-react";
import { formatArs, formatDateAr } from "@/lib/utils";
import { EmptyState, LoadingBlock } from "@/components/ui";

type Receipt = {
  id: string;
  merchantName: string | null;
  receiptDate: string | null;
  totalArs: number | null;
  status: string;
  transactionId: string | null;
  items: Array<{
    id: string;
    name: string;
    quantity: number | null;
    lineTotal: number | null;
  }>;
};

export function ReceiptsList({
  refreshKey,
  onChanged,
  readOnly = false,
}: {
  refreshKey?: number;
  onChanged?: () => void;
  /** Hide delete. The worker list route does not write. */
  readOnly?: boolean;
}) {
  const resource = useJsonResource<{ receipts?: Receipt[] }>(
    "/api/receipts",
    [refreshKey ?? 0],
    { fallbackError: "Error", networkError: "Error" },
  );
  const receipts = resource.data?.receipts ?? [];
  const [actionError, setActionError] = useState<string | null>(null);
  const error = actionError ?? resource.error;
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function removeOne(id: string) {
    if (!confirm("¿Borrar este ticket y el gasto generado si lo hubiera?")) return;
    setBusy(id);
    try {
      const res = await fetch("/api/receipts", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ id }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setActionError(data?.error || "No se pudo borrar");
        return;
      }
      setActionError(null);
      await resource.reload();
      onChanged?.();
    } finally {
      setBusy(null);
    }
  }

  async function removeAll() {
    if (
      !confirm(
        "¿Borrar TODOS los tickets de supermercado y los gastos creados desde tickets?",
      )
    ) {
      return;
    }
    setBusy("all");
    try {
      const res = await fetch("/api/receipts", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ all: true }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setActionError(data?.error || "No se pudo borrar");
        return;
      }
      setActionError(null);
      await resource.reload();
      onChanged?.();
    } finally {
      setBusy(null);
    }
  }

  if (error) {
    return <p className="text-sm text-red-600">{error}</p>;
  }

  if (resource.loading && receipts.length === 0) {
    return <LoadingBlock label="Cargando tickets…" />;
  }

  if (receipts.length === 0) {
    return (
      <EmptyState
        icon={<Receipt className="h-7 w-7" />}
        title="Todavía no hay tickets"
        description="Cuando alguien suba un ticket de súper, aparece acá con los ítems y el total."
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-zinc-500">{receipts.length} ticket(s)</p>
        {!readOnly && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void removeAll()}
            className="inline-flex min-h-10 cursor-pointer items-center text-xs font-medium text-red-600 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === "all" ? "Borrando…" : "Borrar todos"}
          </button>
        )}
      </div>
      {receipts.map((r) => (
        <div
          key={r.id}
          className="rounded-xl border border-zinc-200 dark:border-zinc-800"
        >
          <div className="flex w-full items-center gap-2 px-3 py-2.5">
            <button
              type="button"
              onClick={() => setOpenId(openId === r.id ? null : r.id)}
              className="flex min-h-10 min-w-0 flex-1 cursor-pointer items-center text-left"
            >
              <div className="font-medium">
                {r.merchantName || "Ticket"}
              </div>
              <div className="text-xs text-zinc-500">
                {formatDateAr(r.receiptDate)} · {r.items.length} ítems ·{" "}
                {r.status}
                {r.transactionId ? " · vinculado" : ""}
              </div>
            </button>
            <div className="font-semibold tabular-nums text-sm">
              {formatArs(r.totalArs)}
            </div>
            {!readOnly && (
              <button
                type="button"
                title="Borrar ticket"
                disabled={busy === r.id}
                onClick={() => void removeOne(r.id)}
                className="inline-flex min-h-10 min-w-10 cursor-pointer items-center justify-center rounded-lg text-zinc-400 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-red-950/40"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>
          {openId === r.id && (
            <ul className="border-t border-zinc-100 px-4 py-2 text-sm dark:border-zinc-800">
              {r.items.map((i) => (
                <li
                  key={i.id}
                  className="flex justify-between gap-2 border-b border-zinc-50 py-1.5 last:border-0 dark:border-zinc-900"
                >
                  <span>
                    {i.quantity && i.quantity !== 1 ? `${i.quantity}× ` : ""}
                    {i.name}
                  </span>
                  <span className="tabular-nums text-zinc-600">
                    {formatArs(i.lineTotal)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}
