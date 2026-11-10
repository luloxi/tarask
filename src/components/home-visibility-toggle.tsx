"use client";

import { useSyncExternalStore } from "react";
import { Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";

const KEYS = {
  debt: "lc:home-show-debt",
  hogar: "lc:home-show-hogar",
} as const;

export type HomeVisibilitySection = keyof typeof KEYS;

const listeners = new Map<string, Set<() => void>>();

function subscribeFlag(key: string) {
  return (onChange: () => void) => {
    let bucket = listeners.get(key);
    if (!bucket) {
      bucket = new Set();
      listeners.set(key, bucket);
    }
    bucket.add(onChange);
    const onStorage = (event: StorageEvent) => {
      if (event.key === key || event.key == null) onChange();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      bucket?.delete(onChange);
      window.removeEventListener("storage", onStorage);
    };
  };
}

const subscribeByKey = new Map<string, (onChange: () => void) => () => void>();
const snapshotByKey = new Map<string, () => boolean>();

function subscribeFor(key: string) {
  let fn = subscribeByKey.get(key);
  if (!fn) {
    fn = subscribeFlag(key);
    subscribeByKey.set(key, fn);
  }
  return fn;
}

/** Missing or unreadable storage means the card stays visible. */
export function readShowFlag(key: string): boolean {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return true;
    return raw !== "0" && raw !== "false";
  } catch {
    return true;
  }
}

function snapshotFor(key: string) {
  let fn = snapshotByKey.get(key);
  if (!fn) {
    fn = () => readShowFlag(key);
    snapshotByKey.set(key, fn);
  }
  return fn;
}

function serverShow(): boolean {
  return true;
}

function writeShowFlag(key: string, show: boolean) {
  try {
    window.localStorage.setItem(key, show ? "1" : "0");
  } catch {
    return;
  }
  const bucket = listeners.get(key);
  if (!bucket) return;
  for (const listener of bucket) listener();
}

export function HomeVisibilityToggle({
  section,
  className,
}: {
  section: HomeVisibilitySection;
  className?: string;
}) {
  const key = KEYS[section];
  const showOnHome = useSyncExternalStore(
    subscribeFor(key),
    snapshotFor(key),
    serverShow,
  );

  function toggle() {
    writeShowFlag(key, !showOnHome);
  }

  return (
    <button
      type="button"
      onClick={toggle}
      className={cn(
        "inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-medium transition",
        showOnHome
          ? "border-[var(--border)] bg-[var(--surface)] text-[var(--muted-fg)] hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)]"
          : "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400",
        className,
      )}
      title={
        showOnHome
          ? "Ocultar esta tarjeta del inicio"
          : "Mostrar esta tarjeta en el inicio"
      }
    >
      {showOnHome ? (
        <>
          <EyeOff className="h-3.5 w-3.5" strokeWidth={1.75} />
          Ocultar del inicio
        </>
      ) : (
        <>
          <Eye className="h-3.5 w-3.5" strokeWidth={1.75} />
          Mostrar en inicio
        </>
      )}
    </button>
  );
}
