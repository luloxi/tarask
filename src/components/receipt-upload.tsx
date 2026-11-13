"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Camera, CheckCircle2, Loader2 } from "lucide-react";
import { formatArs } from "@/lib/utils";
import {
  previewReceipt,
  saveReceipt,
  type ReceiptPreview,
  type ReceiptSaved,
} from "@/lib/receipts/client";

/** Receipt photo → read it → let the user fix merchant/date/total → save. */
export function ReceiptUpload({ onDone }: { onDone?: () => void }) {
  const [busy, setBusy] = useState<"reading" | "saving" | null>(null);
  const [draft, setDraft] = useState<ReceiptPreview | null>(null);
  const [merchant, setMerchant] = useState("");
  const [date, setDate] = useState("");
  const [total, setTotal] = useState("");
  const [saved, setSaved] = useState<ReceiptSaved | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  async function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.files?.[0];
    e.target.value = "";
    if (!raw) return;
    setBusy("reading");
    setError(null);
    setInfo(null);
    setSaved(null);
    setDraft(null);
    try {
      const p = await previewReceipt(raw);
      setPreview(URL.createObjectURL(p.file));
      setDraft(p);
      setMerchant(p.ocr.merchant ?? "");
      setDate(p.ocr.date ?? "");
      setTotal(p.ocr.total != null ? String(p.ocr.total).replace(".", ",") : "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No pudimos leer el ticket");
    } finally {
      setBusy(null);
    }
  }

  const totalNumber = Number(total.replace(/\./g, "").replace(",", "."));
  const totalOk = total.trim() !== "" && Number.isFinite(totalNumber) && totalNumber > 0;
  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(date);

  async function onSave() {
    if (!draft) return;
    setBusy("saving");
    setError(null);
    try {
      const ocr = {
        ...draft.ocr,
        merchant: merchant.trim() || null,
        date: dateOk ? date : null,
        total: totalOk ? totalNumber : null,
      };
      const res = await saveReceipt(draft.file, ocr);
      setSaved(res);
      setDraft(null);
      window.dispatchEvent(new Event("lc:expense-created"));
      onDone?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : "No se pudo guardar";
      if (err && typeof err === "object" && "duplicate" in err && err.duplicate) {
        setDraft(null);
        setInfo(message);
      } else {
        setError(message);
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4" data-testid="receipt-upload">
      <label className="flex cursor-pointer flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-[var(--ok)]/40 bg-[var(--surface)] px-4 py-6 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--ok)] text-[var(--on-accent)]">
          {busy === "reading" ? <Loader2 className="h-6 w-6 animate-spin" /> : <Camera className="h-6 w-6" />}
        </div>
        <div>
          <p className="font-semibold">Foto del ticket</p>
          <p className="mt-1 text-sm text-[var(--muted-fg)]">
            Leemos comercio, fecha y total. Revisás y confirmás: se asocia al gasto del banco del mismo día, o se crea.
          </p>
        </div>
        <input
          type="file"
          accept="image/*"
          capture="environment"
          className="sr-only"
          data-testid="receipt-input"
          onChange={(ev) => void onChange(ev)}
          disabled={busy !== null}
        />
        <span className="rounded-lg bg-[var(--ok)] px-4 py-2 text-sm font-medium text-[var(--on-accent)]">
          {busy === "reading" ? "Leyendo ticket…" : "Sacar o elegir foto"}
        </span>
      </label>

      {error && (
        <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{error}</p>
        </div>
      )}
      {info && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--warm-soft)] p-3 text-sm">{info}</div>
      )}

      {draft && (
        <div className="space-y-3 rounded-2xl border border-[var(--border)] p-4" data-testid="receipt-draft">
          {preview && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview} alt="Ticket" className="mx-auto max-h-48 rounded-xl border border-[var(--border)] object-contain" />
          )}
          <p className="text-sm text-[var(--muted-fg)]">Revisá los datos antes de guardar.</p>
          <label className="block text-sm">
            <span className="mb-1 block text-xs font-medium text-[var(--muted-fg)]">Comercio</span>
            <input className="lc-input w-full" value={merchant} onChange={(e) => setMerchant(e.target.value)} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm">
              <span className="mb-1 block text-xs font-medium text-[var(--muted-fg)]">Fecha</span>
              <input type="date" className="lc-input w-full" value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-xs font-medium text-[var(--muted-fg)]">Total (ARS)</span>
              <input
                inputMode="decimal"
                className="lc-input w-full"
                value={total}
                onChange={(e) => setTotal(e.target.value)}
                aria-label="Total"
              />
            </label>
          </div>
          {draft.ocr.items.length > 0 && (
            <ul className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)] text-sm">
              {draft.ocr.items.slice(0, 12).map((item, i) => (
                <li key={i} className="flex justify-between gap-2 px-3 py-2">
                  <span className="truncate">
                    {item.quantity && item.quantity !== 1 ? `${item.quantity}× ` : ""}
                    {item.name}
                  </span>
                  <span className="tabular-nums text-[var(--muted-fg)]">{formatArs(item.line_total)}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-[var(--muted-fg)]">
            {draft.match.transactionId
              ? "Coincide con un movimiento del banco: se asocia."
              : draft.willCreateExpense
                ? "No hay un movimiento del banco que coincida: se crea el gasto."
                : draft.match.reason}
          </p>
          <div className="flex gap-2">
            <button type="button" className="lc-btn lc-btn-primary flex-1" disabled={busy !== null || !totalOk || !dateOk} onClick={() => void onSave()}>
              {busy === "saving" ? "Guardando…" : "Guardar ticket"}
            </button>
            <button type="button" className="lc-btn flex-1" disabled={busy !== null} onClick={() => setDraft(null)}>
              Descartar
            </button>
          </div>
          {(!totalOk || !dateOk) && (
            <p className="text-xs text-red-600">Falta {!totalOk ? "el total" : "la fecha"} para poder guardar.</p>
          )}
        </div>
      )}

      {saved && (
        <div className="flex items-start gap-3 rounded-2xl border border-[var(--brand)]/25 bg-[var(--brand-soft)] p-4" data-testid="receipt-saved">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-[var(--brand-fg)]" />
          <div className="text-sm">
            <p className="font-semibold text-[var(--brand-fg)]">Ticket guardado</p>
            <p className="mt-0.5">
              {saved.ocr.merchant || "Comercio"} · {formatArs(saved.ocr.total)}
              {" · "}
              {saved.createdTransaction
                ? "gasto creado"
                : saved.match.transactionId
                  ? "asociado a un movimiento del banco"
                  : "sin gasto asociado"}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
