"use client";

import { useEffect, useMemo, useState } from "react";
import { useJsonResource } from "@/hooks/use-json-resource";
import {
  FileSpreadsheet,
  Loader2,
  PenLine,
  Receipt,
  RefreshCw,
  Upload,
} from "lucide-react";
import { ImportForm } from "@/components/import-form";
import { EmptyState, PageHeader, PageStack, Surface } from "@/components/ui";
import { formatDateAr, cn } from "@/lib/utils";

type CargaItem = {
  id: string;
  kind: "statement" | "receipt" | "manual";
  typeLabel: string;
  date: string;
  fileName: string | null;
  count: number;
  status: string;
  source: string | null;
  detail: string | null;
};

type Filter = "all" | "statement" | "receipt" | "manual";

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return formatDateAr(iso.slice(0, 10));
  }
  return new Intl.DateTimeFormat("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(d);
}

function KindIcon({ kind }: { kind: CargaItem["kind"] }) {
  if (kind === "receipt") return <Receipt className="h-4 w-4" />;
  if (kind === "manual") return <PenLine className="h-4 w-4" />;
  return <FileSpreadsheet className="h-4 w-4" />;
}

export function CargasView() {
  const {
    data,
    error,
    loading,
    reload: load,
  } = useJsonResource<{ items?: CargaItem[] }>("/api/cargas", [], {
    fallbackError: "No se pudieron cargar las cargas",
    networkError: "Error",
  });
  const items = useMemo(() => data?.items ?? [], [data?.items]);
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    function onSwitch() {
      void load();
    }
    window.addEventListener("lc:household-switched", onSwitch);
    window.addEventListener("lc:card-imported", onSwitch);
    return () => {
      window.removeEventListener("lc:household-switched", onSwitch);
      window.removeEventListener("lc:card-imported", onSwitch);
    };
  }, [load]);

  const filtered = useMemo(() => {
    if (filter === "all") return items;
    return items.filter((i) => i.kind === filter);
  }, [items, filter]);

  const filters: Array<{ id: Filter; label: string }> = [
    { id: "all", label: "Todas" },
    { id: "statement", label: "Resúmenes" },
    { id: "receipt", label: "Tickets" },
    { id: "manual", label: "Manuales" },
  ];

  return (
    <PageStack>
      <PageHeader
        title="Cargas"
        description="Tirale el Excel o el PDF. Los duplicados no entran de nuevo. El período de la tarjeta va a Deuda, no a la neta."
        actions={
          <button
            type="button"
            onClick={() => void load()}
            className="lc-btn lc-btn-ghost cursor-pointer !px-3 !py-2 text-sm"
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Actualizar
          </button>
        }
      />

      <Surface elevated>
        <ImportForm
          compact
          onDone={() => {
            void load();
            window.dispatchEvent(new Event("lc:card-imported"));
          }}
        />
      </Surface>

      <p className="text-[13px] leading-relaxed text-[var(--muted-fg)]">
        <span className="font-medium text-[var(--foreground)]">Fiwind:</span>{" "}
        Actividad → compartir Excel o CSV. Conversiones, TRANSFERENCIA ARS y
        montos sueltos no entran en gastos.{" "}
        <span className="font-medium text-[var(--foreground)]">BBVA:</span>{" "}
        Tarjetas → Últimos movimientos (Excel).
      </p>

      <div className="flex flex-wrap gap-1.5">
        {filters.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            className={cn(
              "min-h-10 cursor-pointer rounded-full px-3 py-2 text-xs font-medium transition",
              filter === f.id
                ? "bg-[var(--brand-soft)] text-[var(--brand-fg)]"
                : "bg-[var(--surface-muted)] text-[var(--muted-fg)] hover:text-[var(--foreground)]",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      )}

      {loading && items.length === 0 ? (
        <Surface className="flex items-center justify-center gap-2 py-12 text-sm text-[var(--muted-fg)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          Cargando historial…
        </Surface>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Upload className="h-7 w-7" />}
          title={
            filter === "all"
              ? "Todavía no cargaste nada"
              : "Nada de este tipo"
          }
          description={
            filter === "all"
              ? "El primer resumen es el que prende la luz. Subilo arriba y listo."
              : "Probá otra pestaña, o subí un archivo nuevo."
          }
        />
      ) : (
        <Surface padding={false} className="overflow-hidden">
          <ul className="divide-y divide-[var(--border)]">
            {filtered.map((item) => (
              <li
                key={item.id}
                className="flex items-start gap-3 px-4 py-3 sm:px-5"
              >
                <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--surface-muted)] text-[var(--brand-fg)]">
                  <KindIcon kind={item.kind} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                    <p className="text-sm font-medium text-[var(--foreground)]">
                      {item.typeLabel}
                    </p>
                    <p className="text-xs text-[var(--muted-fg)]">
                      {formatWhen(item.date)}
                    </p>
                  </div>
                  <p className="mt-0.5 truncate text-sm text-[var(--muted-fg)]">
                    {item.fileName ||
                      (item.kind === "manual"
                        ? `Gastos del ${formatDateAr(item.detail)}`
                        : "Sin nombre")}
                  </p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
                    <span className="rounded-md bg-[var(--surface-muted)] px-2 py-0.5 font-medium text-[var(--foreground)]">
                      {item.count}{" "}
                      {item.kind === "receipt"
                        ? item.count === 1
                          ? "ítem"
                          : "ítems"
                        : item.count === 1
                          ? "movimiento"
                          : "movimientos"}
                    </span>
                    <span className="rounded-md bg-[var(--brand-soft)]/60 px-2 py-0.5 text-[var(--brand-fg)]">
                      {item.status}
                    </span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Surface>
      )}
    </PageStack>
  );
}
