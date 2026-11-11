/**
 * GET `/api/cargas` — import history for the active household.
 * Read-only. Import / reclassify stay on their own routes.
 */

import { statementTypeLabel } from "../src/lib/import/source";
import type { SessionUser } from "./auth";
import type { Env } from "./env";
import { activeHousehold } from "./household";
import { json, num } from "./http";

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
  periodFrom: string | null;
  periodTo: string | null;
};

export async function handleCargas(
  req: Request,
  env: Env,
  user: SessionUser,
): Promise<Response> {
  if (req.method !== "GET") return json({ error: "Método no permitido" }, 405);
  const { active } = await activeHousehold(req, env, user.id);
  if (!active) return json({ error: "NO_HOUSEHOLD" }, 400);

  const [statements, receipts, manuals] = await Promise.all([
    env.DB.prepare(
      `SELECT id, source, file_name, imported_at, row_count, status
       FROM card_statements
       WHERE household_id = ?
       ORDER BY imported_at DESC
       LIMIT 100`,
    )
      .bind(active.id)
      .all<{
        id: string;
        source: string;
        file_name: string | null;
        imported_at: number | string | null;
        row_count: number | null;
        status: string | null;
      }>(),
    env.DB.prepare(
      `SELECT id, merchant_name, receipt_date, status, created_at
       FROM receipts
       WHERE household_id = ?
       ORDER BY created_at DESC
       LIMIT 100`,
    )
      .bind(active.id)
      .all<{
        id: string;
        merchant_name: string | null;
        receipt_date: string | null;
        status: string;
        created_at: number | string | null;
      }>(),
    env.DB.prepare(
      `SELECT date, COUNT(*) AS n, MAX(created_at) AS latest,
              MIN(description_normalized) AS sample
       FROM transactions
       WHERE household_id = ?
         AND source = 'manual'
         AND paid_by_user_id = ?
       GROUP BY date
       ORDER BY latest DESC
       LIMIT 200`,
    )
      .bind(active.id, user.id)
      .all<{
        date: string;
        n: number | null;
        latest: number | string | null;
        sample: string | null;
      }>(),
  ]);

  const statementRows = statements.results ?? [];
  const receiptRows = receipts.results ?? [];
  const bankByStatement = new Map<string, string>();
  const periodByStatement = new Map<string, { from: string; to: string }>();
  const itemCounts = new Map<string, number>();

  const statementIds = statementRows.map((row) => row.id);
  const receiptIds = receiptRows.map((row) => row.id);
  const extra: Promise<void>[] = [];
  if (statementIds.length > 0) {
    extra.push(
      (async () => {
        const { sql, binds } = inClause(statementIds);
        const res = await env.DB.prepare(
          `SELECT statement_id AS id, MAX(bank) AS bank, MIN(date) AS period_from, MAX(date) AS period_to
           FROM transactions
           WHERE household_id = ?
             AND statement_id IN (${sql})
           GROUP BY statement_id`,
        )
          .bind(active.id, ...binds)
          .all<{
            id: string | null;
            bank: string | null;
            period_from: string | null;
            period_to: string | null;
          }>();
        for (const row of res.results ?? []) {
          if (!row.id) continue;
          if (row.bank && !bankByStatement.has(row.id)) bankByStatement.set(row.id, row.bank);
          if (row.period_from && row.period_to) {
            periodByStatement.set(row.id, { from: row.period_from, to: row.period_to });
          }
        }
      })(),
    );
  }
  if (receiptIds.length > 0) {
    extra.push(
      (async () => {
        const { sql, binds } = inClause(receiptIds);
        const res = await env.DB.prepare(
          `SELECT receipt_id AS id, COUNT(*) AS n
           FROM receipt_items
           WHERE receipt_id IN (${sql})
           GROUP BY receipt_id`,
        )
          .bind(...binds)
          .all<{ id: string; n: number | null }>();
        for (const row of res.results ?? []) {
          itemCounts.set(row.id, num(row.n));
        }
      })(),
    );
  }
  if (extra.length) await Promise.all(extra);

  const items: CargaItem[] = [];
  for (const row of statementRows) {
    const count = num(row.row_count);
    const period = periodByStatement.get(row.id);
    const closed = row.status === "closed";
    items.push({
      id: `statement:${row.id}`,
      kind: "statement",
      typeLabel: statementTypeLabel(row.source, bankByStatement.get(row.id) ?? null),
      date: isoFromMs(row.imported_at),
      fileName: row.file_name,
      count,
      status: closed ? "Cerrado" : count > 0 ? "Importado" : "Sin filas",
      source: row.source,
      detail: bankByStatement.get(row.id) ?? null,
      periodFrom: period?.from ?? null,
      periodTo: period?.to ?? null,
    });
  }
  for (const row of receiptRows) {
    const count = itemCounts.get(row.id) ?? 0;
    items.push({
      id: `receipt:${row.id}`,
      kind: "receipt",
      typeLabel: "Ticket (OCR)",
      date: isoFromMs(row.created_at),
      fileName: row.merchant_name,
      count: count > 0 ? count : 1,
      status: receiptStatusLabel(row.status),
      source: "receipt",
      detail: row.receipt_date,
      periodFrom: row.receipt_date,
      periodTo: row.receipt_date,
    });
  }
  for (const row of manuals.results ?? []) {
    items.push({
      id: `manual:${row.date}`,
      kind: "manual",
      typeLabel: "Carga manual",
      date: isoFromMs(row.latest),
      fileName: row.sample,
      count: num(row.n),
      status: "Manual",
      source: "manual",
      detail: row.date,
      periodFrom: row.date,
      periodTo: row.date,
    });
  }
  items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  return json({
    items,
    counts: {
      statements: statementRows.length,
      receipts: receiptRows.length,
      manuals: (manuals.results ?? []).reduce((sum, row) => sum + num(row.n), 0),
    },
  });
}

function inClause(ids: string[]): { sql: string; binds: string[] } {
  return { sql: ids.map(() => "?").join(","), binds: ids };
}

function isoFromMs(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  if (Number.isFinite(n) && n > 0) return new Date(n).toISOString();
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return new Date(0).toISOString();
}

function receiptStatusLabel(status: string): string {
  switch (status) {
    case "matched":
      return "Vinculado";
    case "parsed":
      return "Leído";
    case "pending":
      return "Pendiente";
    case "failed":
      return "Falló";
    default:
      return status;
  }
}
