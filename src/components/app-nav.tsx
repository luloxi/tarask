"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Home,
  List,
  TrendingUp,
  Users,
  LogOut,
  Moon,
  Sun,
  Tags,
  Plug,
  Shield,
  MoreHorizontal,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { apiGet, invalidateApi } from "@/lib/api/client";
import { BrandLogo } from "@/components/brand-logo";
import { HouseholdSwitcher } from "@/components/household-switcher";
import { useTheme } from "@/components/theme-provider";
import {
  MAIN_TABS,
  activeMainTab,
  isMoreActive,
  moreLinksFor,
  type MainTabHref,
} from "@/lib/nav";

const TAB_ICONS: Record<MainTabHref, typeof Home> = {
  "/dashboard": Home,
  "/consumos": List,
  "/patrimonio": TrendingUp,
  "/compartido": Users,
};

const MORE_ICONS: Record<string, typeof Home> = {
  "/categorias": Tags,
  "/mcp": Plug,
  "/admin": Shield,
};

export function AppNav() {
  const pathname = usePathname();
  const { resolved, toggle } = useTheme();
  const [isAdmin, setIsAdmin] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [seenPath, setSeenPath] = useState(pathname);
  if (pathname !== seenPath) {
    setSeenPath(pathname);
    setMoreOpen(false);
  }

  useEffect(() => {
    let cancelled = false;
    void apiGet<{ flags?: { isAdmin?: boolean } }>("/api/me", 5000).then((res) => {
      if (cancelled || !res.ok) return;
      setIsAdmin(res.data?.flags?.isAdmin === true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!moreOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMoreOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [moreOpen]);

  async function logout() {
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    } catch {
      // ignore
    }
    invalidateApi();
    // Full navigation: nothing of the signed-in account stays in memory or in the page.
    window.location.replace("/login?signedout=1");
  }

  const current = activeMainTab(pathname);
  const moreActive = isMoreActive(pathname);
  const more = moreLinksFor(isAdmin);

  return (
    <>
      {/* Escritorio: barra de arriba con las mismas 4 pestañas */}
      <header className="sticky top-0 z-40 hidden border-b border-[var(--border)] bg-[var(--surface)]/85 backdrop-blur-md md:block">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-2.5">
          <Link
            href="/dashboard"
            className="group flex min-h-11 cursor-pointer items-center gap-2.5 font-semibold tracking-tight text-[var(--text)]"
          >
            <BrandLogo size={32} />
            <span className="text-[16px]">Tarask</span>
          </Link>
          <nav className="flex items-center gap-1" aria-label="Secciones">
            {MAIN_TABS.map(({ href, label }) => {
              const Icon = TAB_ICONS[href];
              const active = current === href;
              return (
                <Link
                  key={href}
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex min-h-11 cursor-pointer items-center gap-2 rounded-full px-4 text-[15px] font-semibold transition-colors",
                    active
                      ? "bg-[color-mix(in_srgb,var(--accent)_24%,var(--surface))] text-[var(--text)]"
                      : "text-[var(--muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--text)]",
                  )}
                >
                  <Icon className="h-[18px] w-[18px]" strokeWidth={active ? 2.3 : 1.8} />
                  {label}
                </Link>
              );
            })}
          </nav>
          <button
            type="button"
            aria-expanded={moreOpen}
            aria-haspopup="dialog"
            onClick={() => setMoreOpen((o) => !o)}
            className={cn(
              "flex min-h-11 min-w-11 cursor-pointer items-center justify-center gap-1.5 rounded-full px-3 text-[15px] font-semibold transition-colors",
              moreOpen || moreActive
                ? "bg-[color-mix(in_srgb,var(--accent)_24%,var(--surface))] text-[var(--text)]"
                : "text-[var(--muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--text)]",
            )}
          >
            <MoreHorizontal className="h-5 w-5" />
            Más
          </button>
        </div>
      </header>

      {/* Celu: barra de abajo */}
      <nav
        className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--border)] bg-[var(--surface)]/92 backdrop-blur-md md:hidden"
        aria-label="Secciones"
      >
        <div
          className="mx-auto grid max-w-lg grid-cols-5 gap-0.5 px-2 pt-1.5"
          style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}
        >
          {MAIN_TABS.map(({ href, label }) => {
            const Icon = TAB_ICONS[href];
            const active = current === href;
            return (
              <NavSlot key={href} href={href} label={label} active={active}>
                <Icon className="h-[22px] w-[22px]" strokeWidth={active ? 2.2 : 1.7} />
              </NavSlot>
            );
          })}
          <button
            type="button"
            aria-expanded={moreOpen}
            aria-haspopup="dialog"
            onClick={() => setMoreOpen((o) => !o)}
            className={cn(
              "relative flex min-h-12 min-w-12 cursor-pointer flex-col items-center gap-0.5 rounded-2xl px-0.5 py-1 text-[10.5px] font-semibold transition-colors",
              moreOpen || moreActive ? "text-[var(--text)]" : "text-[var(--muted)]",
            )}
          >
            <span
              className={cn(
                "flex h-8 w-14 items-center justify-center rounded-full transition-colors",
                (moreOpen || moreActive) && "bg-[color-mix(in_srgb,var(--accent)_26%,var(--surface))]",
              )}
            >
              <MoreHorizontal className="h-[22px] w-[22px]" strokeWidth={moreOpen || moreActive ? 2.2 : 1.7} />
            </span>
            Más
          </button>
        </div>
      </nav>

      {moreOpen && (
        <>
          <button
            type="button"
            aria-label="Cerrar menú"
            className="fixed inset-0 z-40 cursor-pointer bg-[#0b0b12]/40 backdrop-blur-[2px]"
            onClick={() => setMoreOpen(false)}
          />
          <div
            id="app-nav-more"
            role="dialog"
            aria-label="Más opciones"
            className="fixed inset-x-0 bottom-0 z-50 max-h-[85dvh] overflow-y-auto rounded-t-[1.75rem] border border-b-0 border-[var(--border)] bg-[var(--surface)] px-4 pt-4 shadow-[var(--card-shadow-lg)] md:inset-x-auto md:bottom-auto md:right-6 md:top-16 md:w-80 md:rounded-[1.5rem] md:border-b"
            style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
          >
            <div className="mb-3 flex items-center justify-between">
              <p className="text-base font-semibold">Más</p>
              <button
                type="button"
                onClick={() => setMoreOpen(false)}
                aria-label="Cerrar"
                className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-full text-[var(--muted)] hover:bg-[var(--surface-muted)]"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="mb-3">
              <HouseholdSwitcher />
            </div>

            <ul className="space-y-1">
              {more.map(({ href, label }) => {
                const Icon = MORE_ICONS[href] ?? Tags;
                const active = pathname.startsWith(href);
                return (
                  <li key={href}>
                    <Link
                      href={href}
                      onClick={() => setMoreOpen(false)}
                      className={cn(
                        "flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-2xl px-3 text-[15px] font-medium transition-colors hover:bg-[var(--surface-muted)]",
                        active && "bg-[color-mix(in_srgb,var(--accent)_20%,var(--surface))]",
                      )}
                    >
                      <Icon className="h-5 w-5 text-[var(--muted)]" strokeWidth={1.8} />
                      {label}
                    </Link>
                  </li>
                );
              })}
              <li>
                <button
                  type="button"
                  onClick={toggle}
                  className="flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-2xl px-3 text-left text-[15px] font-medium transition-colors hover:bg-[var(--surface-muted)]"
                >
                  {resolved === "dark" ? (
                    <Sun className="h-5 w-5 text-[var(--muted)]" strokeWidth={1.8} />
                  ) : (
                    <Moon className="h-5 w-5 text-[var(--muted)]" strokeWidth={1.8} />
                  )}
                  {resolved === "dark" ? "Pasar a tema claro" : "Pasar a tema oscuro"}
                </button>
              </li>
              <li>
                <button
                  type="button"
                  onClick={() => void logout()}
                  className="flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-2xl px-3 text-left text-[15px] font-medium text-[var(--muted)] transition-colors hover:bg-[var(--surface-muted)] hover:text-[var(--text)]"
                >
                  <LogOut className="h-5 w-5" strokeWidth={1.8} />
                  Salir
                </button>
              </li>
            </ul>
          </div>
        </>
      )}
    </>
  );
}

function NavSlot({
  href,
  label,
  active,
  children,
}: {
  href: string;
  label: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex min-h-12 min-w-12 cursor-pointer flex-col items-center gap-0.5 rounded-2xl px-0 py-1 text-[10.5px] font-semibold transition-colors",
        active ? "text-[var(--text)]" : "text-[var(--muted)]",
      )}
    >
      <span
        className={cn(
          "flex h-8 w-14 items-center justify-center rounded-full transition-colors",
          active && "bg-[color-mix(in_srgb,var(--accent)_26%,var(--surface))]",
        )}
      >
        {children}
      </span>
      <span className="max-w-full text-center leading-tight tracking-tight">{label}</span>
    </Link>
  );
}
