/** Public catalogue of MCP tools (UI + docs). No secrets. */
export const MCP_TOOLS = [
  {
    name: "resumen_mensual",
    summary:
      "Resumen mensual de ingresos y gastos (from/to en YYYY-MM; por defecto los últimos 6 meses).",
  },
  {
    name: "deuda_ahorro_patrimonio",
    summary: "Deuda, ahorros y patrimonio del hogar, con el cambio en el tiempo.",
  },
  {
    name: "ultimos_movimientos",
    summary: "Últimos movimientos (limit, period YYYY-MM y query opcionales).",
  },
  {
    name: "gastos_del_mes",
    summary: "Totales reales del mes (period: YYYY-MM, latest, o el mes actual AR).",
  },
  {
    name: "listar_cargas",
    summary: "Historial de cargas (resúmenes, tickets, manuales).",
  },
] as const;

export const MCP_PUBLIC_PATH = "/api/mcp";

/** Live app origin. Override with NEXT_PUBLIC_APP_URL at build time. */
const APP_ORIGIN =
  process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, "") ||
  "https://tarask.lulox.com.ar";

export const MCP_PUBLIC_URL = `${APP_ORIGIN}/api/mcp`;
