/**
 * GET /api/export/sheets: the data behind "Guardar en Google Sheets".
 *
 * The browser writes the Sheet itself with a short-lived Google token
 * (drive.file). The server never sees or stores a Google token: it only
 * returns the rows this user already sees in the active hogar.
 *
 * Scope rules (same as the web):
 * - Movimientos: shared rows of the hogar plus the viewer's own personal rows.
 *   Another member's personal rows never leave the server.
 * - Ingresos, Ahorros, Saldos: the viewer's own rows in the hogar.
 * - Deuda and Patrimonio: the viewer's own settings and snapshots.
 */
import type { SessionUser } from "./auth";
import type { Env } from "./env";
import { activeHousehold, listMembers } from "./household";
import { json, sha256Hex } from "./http";

export type SheetCell = string | number | null;
export type SheetTab = { title: string; columns: string[]; rows: SheetCell[][] };
export type SheetsExport = {
  clientId: string | null;
  appName: "Tarask";
  fileTitle: string;
  exportKey: string;
  loginHint: string | null;
  tabs: SheetTab[];
};

/** Hard cap so one export stays well inside Worker and Sheets limits. */
export const MAX_MOVEMENTS = 20000;

function money(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function dateOf(ms: unknown): string {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "";
  return new Date(n).toISOString().slice(0, 10);
}

export async function handleSheetsExport(req: Request, env: Env, user: SessionUser): Promise<Response> {
  if (req.method !== "GET") return json({ error: "Método no permitido" }, 405);
  const { active } = await activeHousehold(req, env, user.id);
  if (!active) return json({ error: "Todavía no tenés un espacio en Tarask" }, 404);
  const data = await buildSheetsExport(env, user, active);
  return json(data);
}

export async function buildSheetsExport(
  env: Env,
  user: SessionUser,
  household: { id: string; name: string },
): Promise<SheetsExport> {
  const hid = household.id;
  const uid = user.id;
  const [members, tx, incomes, savings, balances, debt, patrimonio] = await Promise.all([
    listMembers(env, hid),
    env.DB.prepare(
      `SELECT t.date, t.description_raw, c.name AS category, t.amount_ars, t.amount_usd,
              t.installment, t.ownership, t.paid_by_user_id, t.bank, t.source,
              t.is_payment, t.is_credit
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.household_id = ? AND (t.ownership = 'shared' OR t.paid_by_user_id = ?)
       ORDER BY t.date DESC, t.created_at DESC
       LIMIT ${MAX_MOVEMENTS}`,
    )
      .bind(hid, uid)
      .all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT date, label, kind, frequency, amount_ars, amount_usd
       FROM incomes WHERE user_id = ? AND household_id = ?
       ORDER BY date DESC LIMIT 5000`,
    )
      .bind(uid, hid)
      .all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT kind, label, amount_ars, amount_usd, last_balance_usd, last_synced_at, updated_at
       FROM savings_assets WHERE user_id = ? AND household_id = ?
       ORDER BY label LIMIT 1000`,
    )
      .bind(uid, hid)
      .all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT date, account_name, currency, amount, source
       FROM balance_snapshots WHERE user_id = ? AND household_id = ?
       ORDER BY date DESC, account_name LIMIT 5000`,
    )
      .bind(uid, hid)
      .all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT saldo_deuda_ars, saldo_deuda_usd, rate_pct, min_payment_ars, due_day, force_settled, updated_at
       FROM debt_settings WHERE user_id = ? LIMIT 1`,
    )
      .bind(uid)
      .all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT date, assets_ars, assets_usd, debt_ars, debt_usd, net_worth_ars, fx_rate
       FROM patrimonio_snapshots WHERE user_id = ?
       ORDER BY date DESC LIMIT 3000`,
    )
      .bind(uid)
      .all<Record<string, unknown>>(),
  ]);

  const names = new Map(members.map((m) => [m.userId, m.name]));
  const tabs: SheetTab[] = [
    {
      title: "Movimientos",
      columns: ["Fecha", "Descripción", "Categoría", "Pesos", "Dólares", "Cuota", "Tipo", "Pagó", "Banco"],
      rows: (tx.results ?? []).map((r) => [
        text(r.date),
        text(r.description_raw),
        text(r.category) || (Number(r.is_payment) === 1 ? "Pago" : ""),
        money(r.amount_ars),
        money(r.amount_usd),
        text(r.installment),
        r.ownership === "shared" ? "Compartido" : "Personal",
        names.get(text(r.paid_by_user_id)) ?? "",
        text(r.bank),
      ]),
    },
    {
      title: "Ingresos",
      columns: ["Fecha", "Detalle", "Tipo", "Frecuencia", "Pesos", "Dólares"],
      rows: (incomes.results ?? []).map((r) => [
        text(r.date),
        text(r.label),
        r.kind === "recurring" ? "Fijo" : "Puntual",
        text(r.frequency),
        money(r.amount_ars),
        money(r.amount_usd),
      ]),
    },
    {
      title: "Ahorros",
      columns: ["Nombre", "Tipo", "Pesos", "Dólares", "Último saldo (USD)", "Actualizado"],
      rows: (savings.results ?? []).map((r) => [
        text(r.label),
        r.kind === "bank" ? "Banco" : r.kind === "evm" ? "Billetera EVM" : r.kind === "cardano" ? "Cardano" : text(r.kind),
        money(r.amount_ars),
        money(r.amount_usd),
        money(r.last_balance_usd),
        dateOf(r.last_synced_at ?? r.updated_at),
      ]),
    },
    {
      title: "Saldos",
      columns: ["Fecha", "Cuenta", "Moneda", "Saldo"],
      rows: (balances.results ?? []).map((r) => [text(r.date), text(r.account_name), text(r.currency), money(r.amount)]),
    },
    {
      title: "Deuda",
      columns: ["Saldo tarjeta (pesos)", "Saldo tarjeta (dólares)", "TNA %", "Pago mínimo", "Vence el día", "Saldada", "Actualizado"],
      rows: (debt.results ?? []).map((r) => [
        money(r.saldo_deuda_ars),
        money(r.saldo_deuda_usd),
        money(r.rate_pct),
        money(r.min_payment_ars),
        r.due_day == null ? null : Number(r.due_day),
        Number(r.force_settled) === 1 ? "Sí" : "No",
        dateOf(r.updated_at),
      ]),
    },
    {
      title: "Patrimonio",
      columns: ["Fecha", "Activos (pesos)", "Activos (dólares)", "Deuda (pesos)", "Deuda (dólares)", "Patrimonio neto (pesos)", "Dólar usado"],
      rows: (patrimonio.results ?? []).map((r) => [
        text(r.date),
        money(r.assets_ars),
        money(r.assets_usd),
        money(r.debt_ars),
        money(r.debt_usd),
        money(r.net_worth_ars),
        money(r.fx_rate),
      ]),
    },
  ];

  return {
    clientId: env.GOOGLE_CLIENT_ID?.trim() || null,
    appName: "Tarask",
    fileTitle: `Tarask – ${household.name}`,
    // Opaque per user + hogar: lets the browser find "its" Sheet without putting ids in Drive.
    exportKey: (await sha256Hex(`tarask-sheets:${uid}:${hid}`)).slice(0, 40),
    loginHint: user.email || null,
    tabs,
  };
}
