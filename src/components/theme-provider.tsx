"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import {
  THEME_STORAGE_KEY,
  parseStoredTheme,
  resolveTheme,
  toggledTheme,
  type ResolvedTheme,
  type ThemeMode,
} from "@/lib/theme-mode";

export type { ResolvedTheme, ThemeMode };

type ThemeContextValue = {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
  toggle: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function subscribeTheme(onChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY || event.key == null) onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener("lc:theme", onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("lc:theme", onChange);
  };
}

function readThemeMode(): ThemeMode {
  try {
    return parseStoredTheme(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

function serverThemeMode(): ThemeMode {
  return "system";
}

function subscribeSystem(onChange: () => void) {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function readSystemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function serverSystemTheme(): ResolvedTheme {
  return "light";
}

function persistTheme(mode: ThemeMode) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event("lc:theme"));
}

function applyResolved(resolved: ResolvedTheme) {
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.classList.toggle("light", resolved === "light");
  root.style.colorScheme = resolved;
  // Keep iOS status bar / theme-color roughly in sync
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute("content", resolved === "dark" ? "#141210" : "#f8f3ea");
  }
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const mode = useSyncExternalStore(
    subscribeTheme,
    readThemeMode,
    serverThemeMode,
  );
  const system = useSyncExternalStore(
    subscribeSystem,
    readSystemTheme,
    serverSystemTheme,
  );
  const resolved = resolveTheme(mode, system);

  useEffect(() => {
    applyResolved(resolved);
  }, [resolved]);

  const setMode = useCallback((next: ThemeMode) => {
    persistTheme(next);
  }, []);

  const toggle = useCallback(() => {
    persistTheme(toggledTheme(mode, system));
  }, [mode, system]);

  const value = useMemo(
    () => ({ mode, resolved, setMode, toggle }),
    [mode, resolved, setMode, toggle],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return ctx;
}
