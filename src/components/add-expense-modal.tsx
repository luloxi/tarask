"use client";

import { useEffect, useRef, useState } from "react";
import {
  Camera,
  FileSpreadsheet,
  ImagePlus,
  Loader2,
  PenLine,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { compressImageForUpload } from "@/lib/image-compress";
import type { AddExpensePreset } from "@/components/add-expense-provider";
import {
  buildExpenseDraft,
  lineItemsTotal,
  nextCategoryId,
  nextPayerId,
} from "@/lib/expense-form";
import {
  STATEMENT_FILE_ACCEPT,
  filesFromDrop,
  isStatementFileName,
  statementFileRejectMessage,
} from "@/lib/import/file-accept";

type Category = { id: string; slug: string; name: string };
type Member = { userId: string; name: string };
type LineItem = {
  key: string;
  name: string;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
  productCategory: string;
};

const PRODUCT_SUBCATS = [
  "Lácteos", "Panadería", "Bebidas", "Carnes", "Verduras", "Frutas",
  "Limpieza", "Higiene", "Snacks", "Congelados", "Almacén", "Otros",
];

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function newItem(partial?: Partial<LineItem>): LineItem {
  return {
    key: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: "",
    quantity: "1",
    unitPrice: "",
    lineTotal: "",
    productCategory: "",
    ...partial,
  };
}

function memberLabel(m: Member) {
  const n = m.name.trim();
  return n ? (n.split(/\s+/)[0] ?? n) : "Sin nombre";
}

function categoryLabel(name: string) {
  return name.toLowerCase() === "uncategorized" ? "Sin categoría" : name;
}

async function readErrorMessage(res: Response): Promise<string> {
  const text = await res.text();
  if (!text) {
    if (res.status === 413) return "El archivo es demasiado grande.";
    return `Error ${res.status}`;
  }
  try {
    const data = JSON.parse(text) as { error?: string };
    if (data.error) return data.error;
  } catch {
    if (res.status === 413 || /entity too large/i.test(text)) {
      return "El archivo es demasiado grande.";
    }
    if (text.length < 200) return text;
  }
  return `Error ${res.status}`;
}

function isImageFile(file: File) {
  return (
    file.type.startsWith("image/") ||
    /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(file.name)
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-1.5 block text-[11px] font-medium tracking-wide text-[var(--muted-fg)]">
      {children}
    </span>
  );
}

function ChoiceRow({
  icon,
  title,
  hint,
  onClick,
  disabled,
  primary = false,
  busy = false,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "group flex w-full cursor-pointer items-center gap-3.5 rounded-2xl border px-3.5 py-3.5 text-left transition active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60",
        primary
          ? "border-[var(--brand)]/35 bg-[var(--brand-soft)] hover:border-[var(--brand)]/55"
          : "border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-muted)]",
      )}
    >
      <span
        className={cn(
          "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition",
          primary
            ? "bg-[var(--brand)] text-[var(--on-accent)]"
            : "bg-[var(--surface-muted)] text-[var(--foreground)] group-hover:bg-[var(--surface)]",
        )}
      >
        {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-semibold tracking-tight text-[var(--foreground)]">
          {title}
        </span>
        <span className="mt-0.5 block text-[12px] leading-snug text-[var(--muted-fg)]">
          {hint}
        </span>
      </span>
    </button>
  );
}

function AddExpenseForm({
  open,
  onClose,
  onCreated,
  categories,
  members,
  viewerUserId = null,
  preset = null,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  categories: Category[];
  members: Member[];
  viewerUserId?: string | null;
  preset?: AddExpensePreset | null;
}) {
  const scanRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLInputElement>(null);
  const [draft] = useState(() =>
    buildExpenseDraft({
      preset,
      categories,
      members,
      viewerUserId,
      today: todayISO(),
    }),
  );
  const [mode, setMode] = useState<"choose" | "manual">(draft.mode);
  const [fromScan, setFromScan] = useState(false);
  const [date, setDate] = useState(draft.date);
  const [description, setDescription] = useState(draft.description);
  const [amountArs, setAmountArs] = useState(draft.amountArs);
  const [amountUsd, setAmountUsd] = useState(draft.amountUsd);
  const [categoryId, setCategoryId] = useState(draft.categoryId);
  const [paidByUserId, setPaidByUserId] = useState(draft.paidByUserId);
  const [ownership, setOwnership] = useState<"personal" | "shared">(
    draft.ownership,
  );
  const [complex, setComplex] = useState(false);
  const [items, setItems] = useState<LineItem[]>(() => [newItem()]);
  const [pricedItems, setPricedItems] = useState<LineItem[] | null>(null);
  const [pricedComplex, setPricedComplex] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicateNote, setDuplicateNote] = useState<string | null>(null);
  const [scanNote, setScanNote] = useState<string | null>(null);
  const [importNote, setImportNote] = useState<string | null>(null);

  if (open) {
    const categoryNext = nextCategoryId(
      categoryId,
      categories,
      preset?.categorySlug,
    );
    if (categoryNext != null) setCategoryId(categoryNext);
    const payerNext = nextPayerId(
      paidByUserId,
      members,
      preset?.paidByUserId,
      viewerUserId,
    );
    if (payerNext != null) setPaidByUserId(payerNext);
    const lineSum = lineItemsTotal(items);
    if (complex) {
      if ((items !== pricedItems || !pricedComplex) && lineSum > 0) {
        setPricedItems(items);
        setPricedComplex(true);
        setAmountArs(lineSum.toFixed(2));
      } else if (!pricedComplex) {
        setPricedItems(items);
        setPricedComplex(true);
      }
    } else if (pricedComplex) {
      setPricedComplex(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving && !scanning && !importing) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, saving, scanning, importing, onClose]);

  async function onScanFile(file: File) {
    setScanning(true);
    setError(null);
    setScanNote(null);
    try {
      // PDF o imagen: imágenes se comprimen; PDF se manda tal cual
      const payload = isImageFile(file)
        ? await compressImageForUpload(file)
        : file;

      const fd = new FormData();
      fd.set("file", payload);
      fd.set("dryRun", "1");
      const res = await fetch("/api/receipts", {
        method: "POST",
        body: fd,
        credentials: "include",
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `Error ${res.status}`);
      const ocr = data.ocr as {
        merchant?: string | null;
        date?: string | null;
        total?: number | null;
        items?: Array<{
          name: string;
          quantity?: number | null;
          unit_price?: number | null;
          line_total?: number | null;
        }>;
      };
      if (ocr.merchant) setDescription(ocr.merchant);
      if (ocr.date) setDate(ocr.date);
      if (ocr.total != null) setAmountArs(String(ocr.total));
      const superCat = categories.find((c) => c.slug === "supermercado");
      if (superCat) setCategoryId(superCat.id);
      setOwnership("shared");
      const ocrItems = ocr.items ?? [];
      if (ocrItems.length > 0) {
        setComplex(true);
        setItems(
          ocrItems.map((it) =>
            newItem({
              name: it.name || "",
              quantity: it.quantity != null ? String(it.quantity) : "1",
              unitPrice: it.unit_price != null ? String(it.unit_price) : "",
              lineTotal: it.line_total != null ? String(it.line_total) : "",
            }),
          ),
        );
        setScanNote(`${ocrItems.length} ítems leídos`);
      } else {
        setScanNote("Listo — revisá y guardá");
      }
      setFromScan(true);
      setMode("manual");
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo leer el comprobante");
    } finally {
      setScanning(false);
    }
  }

  async function onCardFiles(fileList: FileList | File[]) {
    const raw = Array.from(fileList);
    if (!raw.length) {
      setError("No se recibió ningún archivo.");
      return;
    }
    const files = raw.filter(
      (f) => !f.name.includes(".") || isStatementFileName(f.name),
    );
    if (!files.length) {
      setError(statementFileRejectMessage(raw[0]?.name ?? "el archivo"));
      return;
    }
    setImporting(true);
    setError(null);
    setImportNote(null);
    try {
      let total = 0;
      let inserted = 0;
      let already = 0;
      const msgs: string[] = [];

      for (const file of files) {
        const fd = new FormData();
        fd.set("file", file);
        fd.set("kind", "bbva");
        const res = await fetch("/api/import/bbva", {
          method: "POST",
          body: fd,
          credentials: "include",
        });
        if (!res.ok) {
          throw new Error(`${file.name}: ${await readErrorMessage(res)}`);
        }
        const data = (await res.json()) as {
          total?: number;
          inserted?: number;
          alreadyExists?: number;
          skipped?: number;
          message?: string;
          hint?: string | null;
        };
        if ((data.total ?? 0) === 0) {
          throw new Error(
            `${data.message || `Sin movimientos en “${file.name}”.`}${
              data.hint ? ` ${data.hint}` : ""
            }`,
          );
        }
        total += data.total ?? 0;
        inserted += data.inserted ?? 0;
        already += data.alreadyExists ?? data.skipped ?? 0;
        if (data.message) msgs.push(data.message);
      }

      const note =
        files.length > 1
          ? `${files.length} archivos · ${inserted} nuevos · ${already} ya estaban · ${total} filas`
          : msgs[0] || `${inserted} nuevos · ${already} ya estaban`;
      setImportNote(note);
      window.dispatchEvent(new Event("lc:card-imported"));
      onCreated();
      window.setTimeout(() => onClose(), 900);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo importar");
    } finally {
      setImporting(false);
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        date,
        description: description.trim(),
        amountArs: amountArs ? amountArs.replace(",", ".") : null,
        amountUsd: amountUsd ? amountUsd.replace(",", ".") : null,
        categoryId: categoryId || null,
        paidByUserId: paidByUserId || null,
        ownership,
      };
      if (complex) {
        payload.items = items
          .filter((i) => i.name.trim())
          .map((i) => ({
            name: i.name.trim(),
            quantity: i.quantity
              ? parseFloat(i.quantity.replace(",", "."))
              : 1,
            unitPrice: i.unitPrice
              ? parseFloat(i.unitPrice.replace(",", "."))
              : null,
            lineTotal: i.lineTotal
              ? parseFloat(i.lineTotal.replace(",", "."))
              : null,
            productCategory: i.productCategory || null,
          }));
      }
      const res = await fetch("/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => null)) as {
        error?: string;
        possibleDuplicate?: boolean;
      } | null;
      if (!res.ok) throw new Error(data?.error || "No se pudo guardar");
      if (data?.possibleDuplicate) {
        setDuplicateNote(
          "Posible duplicado: ya hay un gasto igual ese día. Se guardó igual.",
        );
        // onCreated() closes the dialog immediately. Refresh the lists and
        // leave this note up until the delayed close.
        window.dispatchEvent(new Event("lc:expense-created"));
        window.setTimeout(() => onClose(), 2400);
        return;
      }
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al guardar");
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;
  const busy = saving || scanning || importing;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
    >
      <button
        type="button"
        className="absolute inset-0 bg-[#121110]/60 backdrop-blur-[4px]"
        aria-label="Cerrar"
        disabled={busy}
        onClick={() => {
          if (!busy) onClose();
        }}
      />

      <div className="animate-fade-up relative z-10 flex max-h-[min(92dvh,640px)] w-full max-w-md flex-col overflow-hidden rounded-t-3xl border border-[var(--border)] bg-[var(--surface)] shadow-[0_24px_64px_-20px_rgba(0,0,0,0.45)] sm:rounded-3xl">
        {/* Handle mobile */}
        <div className="flex justify-center pt-2 sm:hidden" aria-hidden>
          <span className="h-1 w-10 rounded-full bg-[var(--border-strong)]" />
        </div>

        <div className="flex shrink-0 items-center justify-between gap-3 px-5 pb-2 pt-3 sm:pt-5">
          <h2 className="text-base font-semibold tracking-tight text-[var(--foreground)]">
            {mode === "choose"
              ? "Agregar"
              : fromScan
                ? "Revisar"
                : "A mano"}
          </h2>
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="rounded-full p-2 text-[var(--muted-fg)] transition hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)]"
          >
            <X className="h-5 w-5" strokeWidth={1.75} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-1">
          {/* Galería / cámara / PDF — sin capture forzoso */}
          <input
            ref={scanRef}
            type="file"
            accept="image/*,application/pdf,.pdf"
            className="hidden"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void onScanFile(f);
            }}
          />
          <input
            ref={cardRef}
            type="file"
            accept={STATEMENT_FILE_ACCEPT}
            multiple
            className="hidden"
            disabled={busy}
            onChange={(e) => {
              const list = e.target.files;
              e.target.value = "";
              if (!list?.length) {
                setError("No se recibió ningún archivo.");
                return;
              }
              void onCardFiles(list);
            }}
          />

          {mode === "choose" && (
            <div
              className="flex flex-col gap-2"
              data-no-swipe
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const list = filesFromDrop(e.dataTransfer);
                if (!list.length) {
                  setError(
                    "No se recibió ningún archivo. Probá elegirlo con el botón.",
                  );
                  return;
                }
                const images = list.filter(
                  (f) =>
                    f.type.startsWith("image/") ||
                    /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(f.name),
                );
                const statements = list.filter(
                  (f) => !images.includes(f),
                );
                if (statements.length) void onCardFiles(statements);
                else if (images[0]) void onScanFile(images[0]);
                else setError("No se recibió ningún archivo.");
              }}
            >
              <ChoiceRow
                primary
                busy={scanning}
                disabled={busy}
                icon={<ImagePlus className="h-5 w-5" strokeWidth={1.85} />}
                title={scanning ? "Leyendo…" : "Foto o PDF"}
                hint="Ticket o comprobante · IA completa"
                onClick={() => scanRef.current?.click()}
              />
              <ChoiceRow
                disabled={busy}
                icon={<PenLine className="h-5 w-5" strokeWidth={1.75} />}
                title="A mano"
                hint="Comercio y monto"
                onClick={() => {
                  setFromScan(false);
                  setScanNote(null);
                  setMode("manual");
                }}
              />
              <ChoiceRow
                busy={importing}
                disabled={busy}
                icon={<FileSpreadsheet className="h-5 w-5" strokeWidth={1.75} />}
                title={importing ? "Importando…" : "Resumen tarjeta"}
                hint="Excel o PDF · arrastrá o elegí"
                onClick={() => cardRef.current?.click()}
              />

              {importNote && (
                <p className="mt-1 rounded-xl bg-[var(--brand-soft)] px-3 py-2 text-xs font-medium text-[var(--brand-fg)]">
                  {importNote}
                </p>
              )}
              {error && (
                <p className="mt-1 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
                  {error}
                </p>
              )}
            </div>
          )}

          {mode === "manual" && (
            <div className="space-y-3.5">
              {fromScan && scanNote && (
                <div className="flex items-center justify-between gap-2 rounded-xl bg-[var(--brand-soft)] px-3 py-2">
                  <p className="text-xs font-medium text-[var(--brand-fg)]">
                    {scanNote}
                  </p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => scanRef.current?.click()}
                    className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-semibold text-[var(--brand-fg)] hover:bg-[var(--surface)]"
                  >
                    <Camera className="h-3.5 w-3.5" />
                    {scanning ? "…" : "Otra"}
                  </button>
                </div>
              )}

              <div className="grid grid-cols-2 gap-2.5">
                <label className="block">
                  <FieldLabel>Fecha</FieldLabel>
                  <input
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    className="lc-input w-full"
                  />
                </label>
                <label className="block">
                  <FieldLabel>Categoría</FieldLabel>
                  <select
                    value={categoryId}
                    onChange={(e) => setCategoryId(e.target.value)}
                    className="lc-input w-full"
                  >
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {categoryLabel(c.name)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="block">
                <FieldLabel>Comercio</FieldLabel>
                <input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Carrefour, Uber…"
                  autoFocus={!fromScan}
                  className="lc-input w-full"
                />
              </label>

              <div className="grid grid-cols-2 gap-2.5">
                <label className="block">
                  <FieldLabel>Pesos</FieldLabel>
                  <input
                    inputMode="decimal"
                    value={amountArs}
                    onChange={(e) => setAmountArs(e.target.value)}
                    placeholder="0,00"
                    className="lc-input w-full tabular-nums"
                  />
                </label>
                <label className="block">
                  <FieldLabel>Dólares</FieldLabel>
                  <input
                    inputMode="decimal"
                    value={amountUsd}
                    onChange={(e) => setAmountUsd(e.target.value)}
                    placeholder="—"
                    className="lc-input w-full tabular-nums"
                  />
                </label>
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <label className="block">
                  <FieldLabel>Pagó</FieldLabel>
                  <select
                    value={paidByUserId}
                    onChange={(e) => setPaidByUserId(e.target.value)}
                    className="lc-input w-full"
                  >
                    {members.map((m) => (
                      <option key={m.userId} value={m.userId}>
                        {memberLabel(m)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <FieldLabel>Visibilidad</FieldLabel>
                  <select
                    value={ownership}
                    onChange={(e) =>
                      setOwnership(e.target.value as "personal" | "shared")
                    }
                    className="lc-input w-full"
                  >
                    <option value="personal">Solo yo</option>
                    <option value="shared">Hogar</option>
                  </select>
                </label>
              </div>

              <button
                type="button"
                onClick={() =>
                  setComplex((v) => {
                    if (!v && items.length === 0) setItems([newItem()]);
                    return !v;
                  })
                }
                className={cn(
                  "flex w-full cursor-pointer items-center justify-between rounded-xl border px-3.5 py-2.5 text-sm",
                  complex
                    ? "border-[var(--brand)]/40 bg-[var(--brand-soft)]"
                    : "border-[var(--border)]",
                )}
              >
                <span className="font-medium text-[var(--foreground)]">
                  Ítems
                </span>
                <span
                  className={cn(
                    "relative h-6 w-11 rounded-full transition",
                    complex ? "bg-[var(--brand)]" : "bg-[var(--border-strong)]",
                  )}
                >
                  <span
                    className={cn(
                      "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition",
                      complex ? "left-5" : "left-0.5",
                    )}
                  />
                </span>
              </button>

              {complex && (
                <div className="space-y-2 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/40 p-2.5">
                  {items.map((it, idx) => (
                    <div
                      key={it.key}
                      className="space-y-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2.5"
                    >
                      <div className="flex gap-2">
                        <input
                          value={it.name}
                          onChange={(e) =>
                            setItems((list) =>
                              list.map((row, i) =>
                                i === idx
                                  ? { ...row, name: e.target.value }
                                  : row,
                              ),
                            )
                          }
                          placeholder={`Producto ${idx + 1}`}
                          className="lc-input min-w-0 flex-1 !py-1.5"
                        />
                        <button
                          type="button"
                          onClick={() =>
                            setItems((list) =>
                              list.length <= 1
                                ? [newItem()]
                                : list.filter((_, i) => i !== idx),
                            )
                          }
                          className="cursor-pointer p-1.5 text-[var(--muted-fg)] hover:text-red-600"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        <input
                          value={it.quantity}
                          onChange={(e) =>
                            setItems((list) =>
                              list.map((row, i) =>
                                i === idx
                                  ? { ...row, quantity: e.target.value }
                                  : row,
                              ),
                            )
                          }
                          placeholder="Cant."
                          inputMode="decimal"
                          className="lc-input !px-2 !py-1.5 text-xs"
                        />
                        <input
                          value={it.unitPrice}
                          onChange={(e) =>
                            setItems((list) =>
                              list.map((row, i) =>
                                i === idx
                                  ? { ...row, unitPrice: e.target.value }
                                  : row,
                              ),
                            )
                          }
                          placeholder="P. unit."
                          inputMode="decimal"
                          className="lc-input !px-2 !py-1.5 text-xs"
                        />
                        <input
                          value={it.lineTotal}
                          onChange={(e) =>
                            setItems((list) =>
                              list.map((row, i) =>
                                i === idx
                                  ? { ...row, lineTotal: e.target.value }
                                  : row,
                              ),
                            )
                          }
                          placeholder="Total"
                          inputMode="decimal"
                          className="lc-input !px-2 !py-1.5 text-xs"
                        />
                      </div>
                      <select
                        value={it.productCategory}
                        onChange={(e) =>
                          setItems((list) =>
                            list.map((row, i) =>
                              i === idx
                                ? { ...row, productCategory: e.target.value }
                                : row,
                            ),
                          )
                        }
                        className="lc-input w-full !py-1.5 text-xs"
                      >
                        <option value="">Subcategoría…</option>
                        {PRODUCT_SUBCATS.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => setItems((list) => [...list, newItem()])}
                    className="inline-flex items-center gap-1 text-xs font-medium text-[var(--brand-fg)]"
                  >
                    <Plus className="h-3.5 w-3.5" /> Ítem
                  </button>
                </div>
              )}

              {error && (
                <p className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
                  {error}
                </p>
              )}
              {duplicateNote && (
                <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
                  {duplicateNote}
                </p>
              )}

              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setMode("choose");
                    setFromScan(false);
                    setScanNote(null);
                  }}
                  className="lc-btn lc-btn-secondary flex-1 !py-3"
                >
                  Atrás
                </button>
                <button
                  type="button"
                  disabled={busy || !description.trim()}
                  onClick={() => void save()}
                  className="lc-btn lc-btn-primary flex-1 !py-3 disabled:opacity-50"
                >
                  {saving && <Loader2 className="h-4 w-4 animate-spin" />}{" "}
                  Guardar
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function AddExpenseModal(props: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  categories: Category[];
  members: Member[];
  viewerUserId?: string | null;
  preset?: AddExpensePreset | null;
}) {
  const [wasOpen, setWasOpen] = useState(props.open);
  const [generation, setGeneration] = useState(0);
  if (props.open !== wasOpen) {
    setWasOpen(props.open);
    if (props.open) setGeneration((value) => value + 1);
  }
  if (!props.open) return null;
  return <AddExpenseForm key={generation} {...props} />;
}
