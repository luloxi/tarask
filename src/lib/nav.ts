/**
 * Navegación de Tarask (rediseño 2026-11).
 *
 * Barra de abajo (4 pestañas + Más):
 *   Resumen · Movimientos · Patrimonio · Hogar · Más
 * Lo demás vive un nivel más adentro, como chips dentro de cada pestaña
 * (`SECTION_TABS`). Ninguna ruta vieja desapareció: /ingresos, /ahorros, /deuda,
 * /grupo, /supermercado, /categorias y /mcp siguen existiendo.
 * /analisis y /mes-a-mes ya no son pantallas aparte: abren Movimientos > Gráficos / Por mes.
 */

export const MAIN_TABS = [
  {
    href: "/dashboard",
    label: "Resumen",
    match: ["/dashboard"],
  },
  {
    href: "/consumos",
    label: "Movimientos",
    match: ["/consumos", "/ingresos", "/mes-a-mes", "/analisis"],
  },
  {
    href: "/patrimonio",
    label: "Patrimonio",
    match: ["/patrimonio", "/ahorros", "/saldos", "/deuda", "/cargas"],
  },
  {
    href: "/compartido",
    label: "Hogar",
    match: ["/compartido", "/grupo", "/pareja", "/supermercado"],
  },
] as const;

/** Debajo de "Más". Categorías y MCP no estaban en la barra principal de gastos. */
export const MORE_LINKS = [
  { href: "/categorias", label: "Categorías" },
  { href: "/mcp", label: "Conectar con IA" },
] as const;

export const ADMIN_NAV_LINK = {
  href: "/admin",
  label: "Administración",
} as const;

export type MainTabHref = (typeof MAIN_TABS)[number]["href"];
export type MoreHref = (typeof MORE_LINKS)[number]["href"] | typeof ADMIN_NAV_LINK.href;
export type NavLink = { href: string; label: string };

export function moreLinksFor(isAdmin: boolean): readonly NavLink[] {
  const links: NavLink[] = MORE_LINKS.map((l) => ({ href: l.href, label: l.label }));
  if (isAdmin) links.push({ href: ADMIN_NAV_LINK.href, label: ADMIN_NAV_LINK.label });
  return links;
}

function normalize(pathname: string): string {
  return pathname.replace(/\/$/, "") || "/";
}

function pathMatches(pathname: string, base: string): boolean {
  const p = normalize(pathname);
  return p === base || p.startsWith(`${base}/`);
}

/** Pestaña principal que contiene esta ruta, o null si es de "Más". */
export function activeMainTab(pathname: string): MainTabHref | null {
  for (const tab of MAIN_TABS) {
    if (tab.match.some((base) => pathMatches(pathname, base))) return tab.href;
  }
  return null;
}

export function isMoreActive(pathname: string): boolean {
  return [...MORE_LINKS, ADMIN_NAV_LINK].some((l) => pathMatches(pathname, l.href));
}

export type SectionTab = {
  id: string;
  label: string;
  href: string;
  /** Ruta que la marca activa. Si hay `tab`, además tiene que coincidir ?tab=. */
  path: string;
  tab?: string;
};

export type SectionId = "movimientos" | "patrimonio" | "hogar";

export const SECTION_TABS: Record<SectionId, readonly SectionTab[]> = {
  movimientos: [
    { id: "gastos", label: "Gastos", href: "/consumos?tab=lista", path: "/consumos", tab: "lista" },
    { id: "ingresos", label: "Ingresos", href: "/ingresos", path: "/ingresos" },
    { id: "por-mes", label: "Por mes", href: "/consumos?tab=resumen", path: "/consumos", tab: "resumen" },
    { id: "graficos", label: "Gráficos", href: "/consumos?tab=charts", path: "/consumos", tab: "charts" },
    { id: "fiwind", label: "Fiwind", href: "/consumos?tab=fiwind", path: "/consumos", tab: "fiwind" },
  ],
  patrimonio: [
    { id: "evolucion", label: "Evolución", href: "/patrimonio", path: "/patrimonio" },
    { id: "ahorros", label: "Ahorros", href: "/ahorros", path: "/ahorros" },
    { id: "saldos", label: "Saldos", href: "/saldos", path: "/saldos" },
    { id: "deuda", label: "Deuda", href: "/deuda", path: "/deuda" },
    { id: "resumenes", label: "Resúmenes", href: "/cargas", path: "/cargas" },
  ],
  hogar: [
    { id: "hogar", label: "Gastos", href: "/compartido", path: "/compartido" },
    { id: "grupo", label: "Grupo", href: "/grupo", path: "/grupo" },
    { id: "super", label: "Supermercado", href: "/supermercado", path: "/supermercado" },
  ],
};

/** Tab del chip activo. `tabParam` es el valor de ?tab= (o null). */
export function activeSectionTab(
  section: SectionId,
  pathname: string,
  tabParam: string | null,
): string {
  const tabs = SECTION_TABS[section];
  const hit = tabs.find((t) => {
    if (!pathMatches(pathname, t.path)) return false;
    if (t.tab == null) return true;
    const want = tabParam ?? tabs.find((x) => x.path === t.path)?.tab;
    return want === t.tab;
  });
  return hit?.id ?? tabs[0]!.id;
}

/**
 * Rutas que no aparecen en la navegación: se llega por enlace, o redirigen.
 * (Suscripción e Importar redirigen a Resumen. Cargas es el historial de resúmenes.)
 */
const UNLISTED_HREFS = new Set([
  "/importar",
  "/suscripcion",
  "/share-target",
]);

/** True when the href is a section that must not appear in the nav. */
export function isUnlistedNavHref(href: string): boolean {
  return UNLISTED_HREFS.has(href);
}

/** Home hero: read-only. Never an upload, billing, or add-expense link. */
export function homeNextAction(monthTxCount: number): {
  href: "/consumos";
  label: string;
} {
  void monthTxCount;
  return { href: "/consumos", label: "Ver movimientos" };
}
