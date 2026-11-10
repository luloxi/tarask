import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function PageStack({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("animate-fade-up space-y-5", className)}>{children}</div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        {eyebrow && (
          <p className="text-[13px] font-semibold text-[var(--muted-fg)]">
            {eyebrow}
          </p>
        )}
        <h1 className="mt-0.5 text-[1.6rem] font-semibold leading-tight tracking-tight text-[var(--foreground)]">
          {title}
        </h1>
        {description && (
          <p className="mt-1.5 max-w-xl text-[15px] leading-relaxed text-[var(--muted-fg)]">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Surface({
  children,
  className,
  elevated = false,
  padding = true,
}: {
  children: ReactNode;
  className?: string;
  elevated?: boolean;
  padding?: boolean;
}) {
  return (
    <div
      className={cn(
        elevated ? "lc-card-elevated" : "lc-card",
        padding && "p-4 sm:p-5",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Full-width, edge-flush internal tabs. */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ id: T; label: string; icon?: ReactNode }>;
  className?: string;
}) {
  return (
    <div className={cn("lc-seg", className)} role="tablist">
      {options.map((opt, i) => (
        <button
          key={opt.id}
          type="button"
          role="tab"
          aria-selected={value === opt.id}
          data-active={value === opt.id}
          onClick={() => onChange(opt.id)}
          className={cn(
            "lc-seg-item",
            i < options.length - 1 && "lc-seg-item-divide",
          )}
        >
          {opt.icon}
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function StatTile({
  label,
  value,
  hint,
  tone = "neutral",
  icon,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "neutral" | "brand" | "danger" | "violet" | "amber";
  icon?: ReactNode;
}) {
  const tones = {
    neutral:
      "border-[var(--border)] bg-[var(--surface)]",
    brand:
      "border-[var(--border)] bg-[var(--brand-soft)]",
    danger:
      "border-[color-mix(in_srgb,var(--err)_50%,var(--border))] bg-[color-mix(in_srgb,var(--err)_12%,var(--surface))]",
    violet:
      "border-[color-mix(in_srgb,var(--a2)_50%,var(--border))] bg-[color-mix(in_srgb,var(--a2)_12%,var(--surface))]",
    amber:
      "border-[color-mix(in_srgb,var(--warn)_60%,var(--border))] bg-[color-mix(in_srgb,var(--warn)_14%,var(--surface))]",
  } as const;

  const valueTone = {
    neutral: "text-[var(--foreground)]",
    brand: "text-[var(--brand-fg)]",
    danger: "text-[var(--err-text)]",
    violet: "text-[var(--foreground)]",
    amber: "text-[var(--foreground)]",
  } as const;

  return (
    <div className={cn("rounded-[1.25rem] border p-4 shadow-[var(--card-shadow)]", tones[tone])}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-[13px] font-semibold text-[var(--muted-fg)]">
          {label}
        </p>
        {icon && (
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-[var(--surface-muted)] text-[var(--brand-fg)]">
            {icon}
          </div>
        )}
      </div>
      <p className={cn("mt-1.5 text-xl font-semibold tabular-nums tracking-tight", valueTone[tone])}>
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-[var(--muted-fg)]">{hint}</p>}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="lc-card flex flex-col items-center px-6 py-14 text-center">
      {icon && (
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--surface-muted)] text-[var(--muted-fg)]">
          {icon}
        </div>
      )}
      <h3 className="text-[17px] font-semibold tracking-tight">{title}</h3>
      {description && (
        <p className="mt-2 max-w-sm text-[15px] leading-relaxed text-[var(--muted-fg)]">
          {description}
        </p>
      )}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}

export function LoadingBlock({ label = "Cargando…" }: { label?: string }) {
  return (
    <div className="lc-card space-y-3 p-5" role="status" aria-live="polite">
      <div className="flex items-center gap-2 text-sm text-[var(--muted-fg)]">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-[var(--brand)]" />
        {label}
      </div>
      <div className="skeleton h-3 w-2/5" />
      <div className="skeleton h-10 w-full" />
      <div className="skeleton h-10 w-full" />
      <div className="skeleton h-10 w-4/5" />
    </div>
  );
}

/** Resumen: cabecera + tarjetas a todo el ancho, como la pantalla real. */
export function DashboardSkeleton() {
  return (
    <div
      className="mx-auto flex w-full max-w-xl flex-col gap-4"
      role="status"
      aria-live="polite"
      aria-label="Cargando resumen"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="skeleton h-7 w-48" />
          <div className="skeleton h-4 w-28" />
        </div>
        <div className="skeleton h-9 w-36 !rounded-full" />
      </div>
      <div className="skeleton h-36 w-full !rounded-[1.5rem]" />
      <div className="skeleton h-32 w-full !rounded-[1.5rem]" />
      <div className="skeleton h-40 w-full !rounded-[1.5rem]" />
      <div className="skeleton h-28 w-full !rounded-[1.5rem]" />
    </div>
  );
}

/** Lista de consumos/gastos: filas skeleton. */
export function ListSkeleton({
  rows = 6,
  label = "Cargando…",
}: {
  rows?: number;
  label?: string;
}) {
  return (
    <div className="space-y-2" role="status" aria-live="polite" aria-label={label}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="skeleton h-5 w-24" />
        <div className="skeleton h-8 w-28 !rounded-full" />
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 rounded-[1.25rem] border border-[var(--border)] bg-[var(--surface)] px-3.5 py-3"
        >
          <div className="skeleton h-9 w-9 shrink-0 !rounded-xl" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="skeleton h-3.5 w-3/5" />
            <div className="skeleton h-2.5 w-2/5" />
          </div>
          <div className="skeleton h-4 w-16 shrink-0" />
        </div>
      ))}
    </div>
  );
}

/** Hogar / compartido: summary + filas. */
export function HogarSkeleton({ label = "Cargando hogar…" }: { label?: string }) {
  return (
    <div className="space-y-3" role="status" aria-live="polite" aria-label={label}>
      <div className="flex items-center justify-between gap-2">
        <div className="skeleton h-5 w-28" />
        <div className="skeleton h-9 w-40 !rounded-full" />
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <div className="skeleton h-20 w-full !rounded-2xl" />
        <div className="skeleton h-20 w-full !rounded-2xl" />
        <div className="skeleton h-20 w-full !rounded-2xl col-span-2 sm:col-span-1" />
      </div>
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 rounded-[1.25rem] border border-[var(--border)] bg-[var(--surface)] px-3.5 py-3"
        >
          <div className="skeleton h-8 w-8 shrink-0 !rounded-lg" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="skeleton h-3.5 w-1/2" />
            <div className="skeleton h-2.5 w-1/3" />
          </div>
          <div className="skeleton h-4 w-14 shrink-0" />
        </div>
      ))}
    </div>
  );
}

export function Toast({
  children,
  tone = "ok",
}: {
  children: ReactNode;
  tone?: "ok" | "warn";
}) {
  return (
    <div
      role="status"
      className={cn("lc-toast", tone === "ok" ? "lc-toast-ok" : "lc-toast-warn")}
    >
      {children}
    </div>
  );
}

export function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <span className="mb-1 block text-xs font-medium text-[var(--muted-fg)]">
      {children}
    </span>
  );
}
