import { expenseAmountText, parseExpenseAmount } from "../src/lib/manual-expense";
import {
  TRUSTED_DEBT_MONTHS,
  appendSettledZero,
  applySettledDebtHistory,
  assetsEquivalent,
  historyNote,
  historyStartsAt,
  mergeStatementDebtHistory,
  pricedNetWorth,
  readDebt,
  usableFxRate,
  type PatrimonioPoint,
  type StatementDebtInput,
} from "../src/lib/patrimonio";
import type { SessionUser } from "./auth";
import type { Env } from "./env";
import { loadFx, monthEndBuy } from "./fx";
import { activeHousehold, forceSharedOnly } from "./household";
import { sumIncomeArs } from "./income";
import { json, num, periodRange, shiftPeriod, todayAr } from "./http";
import { loadExcludedMovementIds } from "./transfer-class";
import { ARS_EXPR, CLOSED_STATEMENT_SQL, expenseSql } from "./sql";

const EVM = /^0x[a-fA-F0-9]{40}$/;

type SavingsRow = {
  id: string;
  kind: "bank" | "evm" | "cardano";
  label: string;
  address: string | null;
  amount_ars: string | null;
  amount_usd: string | null;
  last_balance_usd: string | null;
  last_synced_at: number | null;
};

type DebtRow = {
  closed_statements?: number | null;
  open_statements?: number | null;
  force_settled: number | null;
  saldo_deuda_ars: string | null;
  saldo_deuda_usd: string | null;
  card_last4: string | null;
  rate_pct: string | null;
  min_payment_ars: string | null;
  due_day: number | null;
  notes: string | null;
  cleared_at: number | null;
  updated_at: number | null;
};

export async function handleAhorros(req: Request, env: Env, user: SessionUser): Promise<Response> {
  if (req.method === "GET") return listAhorros(req, env, user);
  if (req.method === "POST") return createAhorro(req, env, user);
  if (req.method === "PATCH" || req.method === "PUT") return patchAhorro(req, env, user);
  if (req.method === "DELETE") {
    return json(
      { error: "No se borran ahorros desde acá. El historial se conserva." },
      405,
    );
  }
  return json({ error: "Método no permitido" }, 405);
}

export async function handleDebtSettings(req: Request, env: Env, user: SessionUser): Promise<Response> {
  if (req.method === "GET") {
    const row = await debtRow(env, user.id);
    return json({ settings: serializeSettings(row) });
  }
  if (req.method === "POST" || req.method === "PATCH" || req.method === "PUT") {
    return saveDebtSettings(req, env, user);
  }
  return json({ error: "Método no permitido" }, 405);
}

export async function handleDebtStats(req: Request, env: Env, user: SessionUser): Promise<Response> {
  if (req.method !== "GET") return json({ error: "Método no permitido" }, 405);
  return json(await buildDebtStats(env, user));
}

export async function buildDebtStats(env: Env, user: SessionUser) {
  const row = await debtRow(env, user.id);
  const reading = debtReading(row);
  const [statements, pastInstallments] = await Promise.all([
    closedStatements(env, user.id),
    pastCuotas(env, user.id),
  ]);
  return {
    cardStatus: reading.cardStatus,
    payments: [] as [],
    openInstallments: [] as [],
    openCharges: [] as [],
    summary: {
      currentBalanceArs: reading.balanceArs,
      currentBalanceUsd: reading.balanceUsd,
      settled: reading.settled,
      forceSettled: reading.forceSettled,
      mode: reading.forceSettled ? "forced" : reading.cardStatus === "sin_snapshot" ? "empty" : "manual",
      primaryCardLast4: reading.activeCard ? row?.card_last4 ?? null : null,
      peakBalanceArs: 0,
      totalPaidArs: 0,
      totalPaidUsd: 0,
      totalChargesArs: 0,
      totalChargesUsd: 0,
      saldoSnapshotArs: reading.balanceArs,
      netDebtArs: reading.balanceArs,
    },
    statements,
    pastInstallments,
    trustedMonths: TRUSTED_DEBT_MONTHS,
  };
}

export async function handlePatrimonio(req: Request, env: Env, user: SessionUser): Promise<Response> {
  if (req.method !== "GET") return json({ error: "Método no permitido" }, 405);
  return json(await buildPatrimonio(req, env, user));
}

export async function buildPatrimonio(req: Request, env: Env, user: SessionUser) {
  return patrimonioPayload(req, env, user.id);
}

export async function handlePatrimonioSnapshot(req: Request, env: Env, user: SessionUser): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  const snapshot = await captureUserSnapshot(env, user.id, undefined, "force");
  const payload = await buildPatrimonio(req, env, user);
  return json({ ...payload, snapshot });
}

async function listAhorros(_req: Request, env: Env, user: SessionUser): Promise<Response> {
  return json(await buildAhorros(env, user));
}

export async function buildAhorros(env: Env, user: SessionUser) {
  const rows = await savingsRows(env, user.id);
  const fx = await loadFx();
  const summary = summarize(rows, usableFxRate(fx.blue));
  return {
    assets: rows.map(publicAsset),
    summary: {
      ...summary,
      balanceNote: "Saldos guardados, sin sync en vivo." as const,
    },
  };
}

async function createAhorro(req: Request, env: Env, user: SessionUser): Promise<Response> {
  const { active } = await activeHousehold(req, env, user.id);
  if (!active) return json({ error: "Sin espacio" }, 400);
  const body = (await req.json().catch(() => null)) as {
    kind?: string;
    label?: string;
    address?: string;
    amountArs?: unknown;
    amountUsd?: unknown;
  } | null;
  if (!body) return json({ error: "JSON inválido" }, 400);
  const kind = body.kind;
  if (kind !== "bank" && kind !== "evm" && kind !== "cardano") {
    return json({ error: "Tipo inválido" }, 400);
  }
  const label = (body.label ?? "").trim().slice(0, 80) || defaultLabel(kind);
  const ars = parseExpenseAmount(body.amountArs);
  const usd = parseExpenseAmount(body.amountUsd);
  if (!ars.ok || !usd.ok) return json({ error: "Monto inválido" }, 400);

  let address: string | null = null;
  let amountArs: string | null = null;
  let amountUsd: string | null = null;
  let lastBalance: string | null = null;
  if (kind === "bank") {
    amountArs = expenseAmountText(ars.amount ?? 0);
    amountUsd = expenseAmountText(usd.amount ?? 0);
  } else {
    const raw = (body.address ?? "").trim();
    if (kind === "evm") {
      if (!EVM.test(raw)) {
        return json({ error: "Pegá la address 0x. El nombre ENS no se resuelve acá." }, 400);
      }
      address = raw.toLowerCase();
    } else {
      if (raw.length < 5 || raw.length > 120) {
        return json({ error: "Dirección de Cardano inválida" }, 400);
      }
      address = raw;
    }
    lastBalance = expenseAmountText(usd.amount);
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO savings_assets (
       id, user_id, household_id, kind, label, address,
       amount_ars, amount_usd, last_balance_usd, last_synced_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      user.id,
      active.id,
      kind,
      label,
      address,
      amountArs,
      amountUsd,
      lastBalance,
      lastBalance != null ? now : null,
      now,
      now,
    )
    .run();
  await rememberSnapshot(env, user.id);
  return json({ id }, 201);
}

async function patchAhorro(req: Request, env: Env, user: SessionUser): Promise<Response> {
  const body = (await req.json().catch(() => null)) as {
    id?: string;
    label?: string;
    amountArs?: unknown;
    amountUsd?: unknown;
    address?: string;
  } | null;
  if (!body?.id) return json({ error: "Falta id" }, 400);
  const existing = await env.DB.prepare(
    `SELECT id, kind, label, address FROM savings_assets WHERE id = ? AND user_id = ?`,
  )
    .bind(body.id, user.id)
    .first<{ id: string; kind: string; label: string; address: string | null }>();
  if (!existing) return json({ error: "No encontrado" }, 404);

  const sets: string[] = ["updated_at = ?"];
  const binds: unknown[] = [Date.now()];
  if (body.label != null) {
    const label = body.label.trim().slice(0, 80);
    if (label) {
      sets.push("label = ?");
      binds.push(label);
    }
  }
  if (existing.kind === "bank") {
    if (body.amountArs !== undefined) {
      const parsed = parseExpenseAmount(body.amountArs);
      if (!parsed.ok) return json({ error: "Monto inválido" }, 400);
      sets.push("amount_ars = ?");
      binds.push(expenseAmountText(parsed.amount ?? 0));
    }
    if (body.amountUsd !== undefined) {
      const parsed = parseExpenseAmount(body.amountUsd);
      if (!parsed.ok) return json({ error: "Monto inválido" }, 400);
      sets.push("amount_usd = ?");
      binds.push(expenseAmountText(parsed.amount ?? 0));
    }
  } else if (body.amountUsd !== undefined) {
    const parsed = parseExpenseAmount(body.amountUsd);
    if (!parsed.ok) return json({ error: "Monto inválido" }, 400);
    sets.push("last_balance_usd = ?");
    binds.push(expenseAmountText(parsed.amount));
    sets.push("last_synced_at = ?");
    binds.push(Date.now());
    sets.push("sync_error = NULL");
  }
  if (existing.kind !== "bank" && body.address) {
    const raw = body.address.trim();
    if (existing.kind === "evm") {
      if (!EVM.test(raw)) {
        return json({ error: "Pegá la address 0x. El nombre ENS no se resuelve acá." }, 400);
      }
      sets.push("address = ?");
      binds.push(raw.toLowerCase());
    } else if (raw.length >= 5 && raw.length <= 120) {
      sets.push("address = ?");
      binds.push(raw);
    }
  }
  binds.push(existing.id, user.id);
  await env.DB.prepare(
    `UPDATE savings_assets SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`,
  )
    .bind(...binds)
    .run();
  await rememberSnapshot(env, user.id);
  return json({ ok: true });
}

const FLOW_MONTHS = 24;

export type SnapshotOutcome = "missing_fx" | "unchanged" | "written";

/**
 * How today's patrimonio row is written.
 * - cron: insert only when that user has no row today. Never update.
 * - change: upsert when the asset or debt amounts differ. A blue move or a
 *   net-worth move alone does not write. `assets_ars` is stored already
 *   marked to blue, so the peso leg is compared after removing that mark
 *   and USD balances are compared in dollars.
 * - force: always upsert today's row at the current blue.
 */
export type SnapshotMode = "cron" | "change" | "force";

type LivePosition = {
  assetsArs: number;
  assetsUsd: number;
  debtArs: number;
  debtUsd: number;
  netWorthArs: number | null;
  fxRate: number | null;
  fxAvailable: boolean;
  cardStatus: "sin_tarjeta_activa" | "activa" | "sin_snapshot";
};

type StoredSnapshot = {
  assets_ars: string;
  assets_usd: string;
  debt_ars: string;
  debt_usd: string;
  net_worth_ars: string;
  fx_rate: string | null;
};

export type FlowPoint = {
  month: string;
  incomeArs: number;
  expenseArs: number;
  flowArs: number;
};

/** Cron entry. One failure stays inside this function. Does not rewrite today's row. */
export async function captureDailySnapshots(
  env: Env,
  fxRate?: number | null,
): Promise<{ written: number; unchanged: number; missingFx: boolean }> {
  const res = await env.DB.prepare(
    `SELECT user_id AS user_id FROM savings_assets
     UNION
     SELECT user_id AS user_id FROM debt_settings`,
  ).all<{ user_id: string }>();
  const userIds = (res.results ?? []).map((row) => row.user_id);
  if (userIds.length === 0) return { written: 0, unchanged: 0, missingFx: false };
  const rate = await resolveFx(fxRate);
  if (rate == null) return { written: 0, unchanged: 0, missingFx: true };
  let written = 0;
  let unchanged = 0;
  for (const userId of userIds) {
    try {
      const outcome = await captureUserSnapshot(env, userId, rate, "cron");
      if (outcome === "written") written += 1;
      else if (outcome === "unchanged") unchanged += 1;
    } catch (err) {
      console.error("patrimonio snapshot failed", err instanceof Error ? err.message : "error");
    }
  }
  return { written, unchanged, missingFx: false };
}

/**
 * Write today's snapshot. Never writes without a usable blue rate.
 * Default mode is `change` (savings and debt saves).
 */
export async function captureUserSnapshot(
  env: Env,
  userId: string,
  fxRate?: number | null,
  mode: SnapshotMode = "change",
): Promise<SnapshotOutcome> {
  const rate = await resolveFx(fxRate);
  if (rate == null) return "missing_fx";
  const date = todayAr();
  if (mode === "cron") {
    const existing = await env.DB.prepare(
      `SELECT 1 AS ok FROM patrimonio_snapshots WHERE user_id = ? AND date = ?`,
    )
      .bind(userId, date)
      .first<{ ok: number }>();
    if (existing) return "unchanged";
  }
  const position = await livePosition(env, userId, rate);
  if (position.netWorthArs == null) return "missing_fx";
  const next = snapshotTexts({ ...position, netWorthArs: position.netWorthArs, fxRate: rate });
  if (mode === "change") {
    const existing = await env.DB.prepare(
      `SELECT assets_ars, assets_usd, debt_ars, debt_usd, net_worth_ars, fx_rate
       FROM patrimonio_snapshots
       WHERE user_id = ? AND date = ?`,
    )
      .bind(userId, date)
      .first<StoredSnapshot>();
    if (existing && samePosition(existing, next)) return "unchanged";
  }
  const changes = await writeSnapshot(env, userId, date, next, mode === "cron" ? "nothing" : "update");
  if (mode === "cron" && changes === 0) return "unchanged";
  return "written";
}

async function rememberSnapshot(env: Env, userId: string): Promise<void> {
  try {
    await captureUserSnapshot(env, userId, undefined, "change");
  } catch (err) {
    console.error("patrimonio snapshot failed", err instanceof Error ? err.message : "error");
  }
}

async function writeSnapshot(
  env: Env,
  userId: string,
  date: string,
  next: ReturnType<typeof snapshotTexts>,
  conflict: "nothing" | "update",
): Promise<number> {
  const update = conflict === "update"
    ? `ON CONFLICT(user_id, date) DO UPDATE SET
       assets_ars = excluded.assets_ars,
       assets_usd = excluded.assets_usd,
       debt_ars = excluded.debt_ars,
       debt_usd = excluded.debt_usd,
       net_worth_ars = excluded.net_worth_ars,
       fx_rate = excluded.fx_rate,
       source = excluded.source`
    : `ON CONFLICT(user_id, date) DO NOTHING`;
  const result = await env.DB.prepare(
    `INSERT INTO patrimonio_snapshots (
       id, user_id, date, assets_ars, assets_usd, debt_ars, debt_usd, net_worth_ars, fx_rate, source, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'snapshot', ?)
     ${update}`,
  )
    .bind(
      crypto.randomUUID(),
      userId,
      date,
      next.assets_ars,
      next.assets_usd,
      next.debt_ars,
      next.debt_usd,
      next.net_worth_ars,
      next.fx_rate,
      Date.now(),
    )
    .run();
  return result.meta?.changes ?? 1;
}

async function resolveFx(fxRate?: number | null): Promise<number | null> {
  if (fxRate !== undefined) return usableFxRate(fxRate);
  const fx = await loadFx();
  return usableFxRate(fx.blue);
}

async function patrimonioPayload(req: Request, env: Env, userId: string) {
  const fx = await loadFx();
  const rate = usableFxRate(fx.blue);
  const date = todayAr();
  const [position, stored, debt, visa] = await Promise.all([
    livePosition(env, userId, rate),
    env.DB.prepare(
      `SELECT date, assets_ars, assets_usd, debt_ars, debt_usd, net_worth_ars, fx_rate, source
       FROM patrimonio_snapshots
       WHERE user_id = ?
       ORDER BY date DESC
       LIMIT 400`,
    )
      .bind(userId)
      .all<{
        date: string;
        assets_ars: string;
        assets_usd: string;
        debt_ars: string;
        debt_usd: string;
        net_worth_ars: string;
        fx_rate: string | null;
        source: string;
      }>(),
    debtRow(env, userId),
    visaStatementDebt(env, userId),
  ]);
  const reading = debtReading(debt);
  const clearedOn =
    debt?.cleared_at != null ? todayAr(new Date(Number(debt.cleared_at))) : null;
  const snapshots: PatrimonioPoint[] = (stored.results ?? [])
    .map((row) => ({
      date: row.date,
      assetsArs: num(row.assets_ars),
      assetsUsd: num(row.assets_usd),
      debtArs: num(row.debt_ars),
      debtUsd: num(row.debt_usd),
      netWorthArs: num(row.net_worth_ars),
      fxRate: row.fx_rate != null ? num(row.fx_rate) : null,
      source: snapshotSource(row.source),
    }))
    .reverse();
  const merged = mergeStatementDebtHistory(snapshots, visa, rate);
  const withSettle = appendSettledZero(merged, reading.settled ? clearedOn : null);
  const series: PatrimonioPoint[] = applySettledDebtHistory(withSettle, {
    settled: reading.settled,
    clearedOn,
  });
  const starts = historyStartsAt(series);
  const usesStatementTotals = series.some((point) => point.debtKind === "statement_total");
  const flujo = await monthlyFlow(req, env, userId, fx);
  return {
    current: {
      date,
      assetsArs: position.assetsArs,
      assetsUsd: position.assetsUsd,
      debtArs: position.debtArs,
      debtUsd: position.debtUsd,
      netWorthArs: position.netWorthArs,
      fxRate: position.fxRate,
      fxAvailable: position.fxAvailable,
      source: "snapshot" as const,
      cardStatus: position.cardStatus,
    },
    series,
    flujo,
    historyStartsAt: starts,
    note: historyNote(starts, { statementTotals: usesStatementTotals }),
    trustedMonths: TRUSTED_DEBT_MONTHS,
    derived: series.some((point) => point.source === "derived"),
  };
}

/** Visa PDF / period xls. No closing-balance column: charges minus payments. */
async function visaStatementDebt(env: Env, userId: string): Promise<StatementDebtInput[]> {
  const res = await env.DB.prepare(
    `SELECT s.id AS id, s.source AS source, s.file_name AS file_name, s.closed_at AS closed_at,
            MAX(t.date) AS period_to,
            SUM(CASE WHEN IFNULL(t.is_payment, 0) = 0 AND IFNULL(t.is_credit, 0) = 0
                 THEN abs(CAST(IFNULL(t.amount_ars, '0') AS REAL)) ELSE 0 END) AS charge_ars,
            SUM(CASE WHEN IFNULL(t.is_payment, 0) = 1 OR IFNULL(t.is_credit, 0) = 1
                 THEN abs(CAST(IFNULL(t.amount_ars, '0') AS REAL)) ELSE 0 END) AS pay_ars,
            SUM(CASE WHEN IFNULL(t.is_payment, 0) = 0 AND IFNULL(t.is_credit, 0) = 0
                 THEN abs(CAST(IFNULL(t.amount_usd, '0') AS REAL)) ELSE 0 END) AS charge_usd,
            SUM(CASE WHEN IFNULL(t.is_payment, 0) = 1 OR IFNULL(t.is_credit, 0) = 1
                 THEN abs(CAST(IFNULL(t.amount_usd, '0') AS REAL)) ELSE 0 END) AS pay_usd
     FROM card_statements s
     INNER JOIN household_members m ON m.household_id = s.household_id
     LEFT JOIN transactions t ON t.statement_id = s.id
     WHERE m.user_id = ?
       AND (
         s.source IN ('bbva_pdf', 'bbva_period')
         OR lower(IFNULL(s.file_name, '')) LIKE '%visa%'
       )
     GROUP BY s.id`,
  )
    .bind(userId)
    .all<{
      id: string;
      source: string;
      file_name: string | null;
      closed_at: number | null;
      period_to: string | null;
      charge_ars: number | null;
      pay_ars: number | null;
      charge_usd: number | null;
      pay_usd: number | null;
    }>();

  const out: StatementDebtInput[] = [];
  for (const row of res.results ?? []) {
    const fromClosed =
      row.closed_at != null && Number(row.closed_at) >= 1_577_836_800_000
        ? todayAr(new Date(Number(row.closed_at)))
        : null;
    const date = row.period_to || fromClosed;
    if (!date) continue;
    out.push({
      date,
      debtArs: Math.max(0, num(row.charge_ars) - num(row.pay_ars)),
      debtUsd: Math.max(0, num(row.charge_usd) - num(row.pay_usd)),
      debtKind: "statement_total",
    });
  }
  return out;
}

async function livePosition(env: Env, userId: string, fxRate: number | null): Promise<LivePosition> {
  const [sums, debt] = await Promise.all([
    env.DB.prepare(
      `SELECT
         SUM(CASE WHEN kind = 'bank' THEN CAST(IFNULL(amount_ars, '0') AS REAL) ELSE 0 END) AS ars,
         SUM(CASE WHEN kind = 'bank' THEN CAST(IFNULL(amount_usd, '0') AS REAL) ELSE 0 END) AS usd,
         SUM(CASE WHEN kind != 'bank' THEN CAST(IFNULL(last_balance_usd, '0') AS REAL) ELSE 0 END) AS usdc
       FROM savings_assets WHERE user_id = ?`,
    )
      .bind(userId)
      .first<{ ars: number | null; usd: number | null; usdc: number | null }>(),
    debtRow(env, userId),
  ]);
  const reading = debtReading(debt);
  const assets = assetsEquivalent({
    bankArs: num(sums?.ars),
    bankUsd: num(sums?.usd),
    walletUsd: num(sums?.usdc),
    fxRate,
  });
  const priced = pricedNetWorth({
    assetsArs: assets.assetsArs,
    assetsUsd: assets.assetsUsd,
    debtArs: reading.balanceArs,
    debtUsd: reading.balanceUsd,
    fxRate,
  });
  return {
    assetsArs: assets.assetsArs,
    assetsUsd: assets.assetsUsd,
    debtArs: reading.balanceArs,
    debtUsd: reading.balanceUsd,
    netWorthArs: priced.netWorthArs,
    fxRate,
    fxAvailable: priced.fxAvailable,
    cardStatus: reading.cardStatus,
  };
}

function debtReading(row: DebtRow | null) {
  return readDebt({
    forceSettled: Boolean(row?.force_settled),
    saldoArs: row?.saldo_deuda_ars == null ? null : num(row.saldo_deuda_ars),
    saldoUsd: row?.saldo_deuda_usd == null ? null : num(row.saldo_deuda_usd),
    cardLast4: row?.card_last4 ?? null,
    closedStatements: num(row?.closed_statements),
    openStatements: num(row?.open_statements),
  });
}

function snapshotTexts(position: LivePosition & { netWorthArs: number; fxRate: number }) {
  return {
    assets_ars: expenseAmountText(position.assetsArs) ?? "0.00",
    assets_usd: expenseAmountText(position.assetsUsd) ?? "0.00",
    debt_ars: expenseAmountText(position.debtArs) ?? "0.00",
    debt_usd: expenseAmountText(position.debtUsd) ?? "0.00",
    net_worth_ars: expenseAmountText(position.netWorthArs) ?? "0.00",
    fx_rate: expenseAmountText(position.fxRate),
  };
}

/** True when savings and debt amounts match, ignoring the blue mark and net worth. */
function samePosition(
  row: StoredSnapshot,
  next: ReturnType<typeof snapshotTexts>,
): boolean {
  return row.assets_usd === next.assets_usd
    && row.debt_ars === next.debt_ars
    && row.debt_usd === next.debt_usd
    && rawArsCents(row.assets_ars, row.assets_usd, row.fx_rate)
      === rawArsCents(next.assets_ars, next.assets_usd, next.fx_rate);
}

function rawArsCents(assetsArs: string, assetsUsd: string, fxRate: string | null): number {
  const fx = fxRate == null || fxRate === "" ? 0 : num(fxRate);
  return Math.round((num(assetsArs) - num(assetsUsd) * fx) * 100);
}

async function monthlyFlow(
  req: Request,
  env: Env,
  userId: string,
  fx: Awaited<ReturnType<typeof loadFx>>,
): Promise<FlowPoint[]> {
  const { active } = await activeHousehold(req, env, userId);
  if (!active) return [];
  const endPeriod = todayAr().slice(0, 7);
  const startPeriod = shiftPeriod(endPeriod, -(FLOW_MONTHS - 1));
  const start = periodRange(startPeriod);
  const end = periodRange(endPeriod);
  if (!start || !end) return [];
  const sharedOnly = forceSharedOnly(active.name);
  const visibility = sharedOnly
    ? "t.ownership = 'shared'"
    : "(t.ownership = 'shared' OR t.paid_by_user_id = ?)";
  const visibilityBinds = sharedOnly ? [] : [userId];
  const movements = await loadExcludedMovementIds(env.DB, userId, env.OWN_ACCOUNT_IDS);
  const [expenses, incomes] = await Promise.all([
    env.DB.prepare(
      `SELECT substr(t.date, 1, 7) AS month, SUM(${ARS_EXPR}) AS ars
       FROM transactions t
       WHERE t.household_id = ?
         AND t.date >= ?
         AND t.date < ?
         AND ${expenseSql(movements.excludedIds)}
         AND ${visibility}
       GROUP BY month`,
    )
      .bind(active.id, start.start, end.end, ...visibilityBinds)
      .all<{ month: string | null; ars: number | null }>(),
    env.DB.prepare(
      `SELECT id, household_id, date, label, kind, frequency, amount_ars, amount_usd
       FROM incomes
       WHERE user_id = ? AND household_id = ?
       ORDER BY date DESC
       LIMIT 400`,
    )
      .bind(userId, active.id)
      .all<{
        id: string;
        household_id: string;
        date: string;
        label: string;
        kind: string | null;
        frequency: string | null;
        amount_ars: string | null;
        amount_usd: string | null;
      }>(),
  ]);
  const expenseByMonth = new Map<string, number>();
  for (const row of expenses.results ?? []) {
    if (row.month) expenseByMonth.set(row.month, num(row.ars));
  }
  const incomeRows = incomes.results ?? [];
  const points: FlowPoint[] = [];
  for (let i = 0; i < FLOW_MONTHS; i += 1) {
    const month = shiftPeriod(startPeriod, i);
    const incomeArs = sumIncomeArs(incomeRows, month, monthEndBuy(fx, month), {
      ownIds: movements.ownIds,
      userHouseholdIds: movements.userHouseholdIds,
      outgoing: movements.incomeOutgoing,
    });
    const expenseArs = expenseByMonth.get(month) ?? 0;
    points.push({
      month,
      incomeArs,
      expenseArs,
      flowArs: incomeArs - expenseArs,
    });
  }
  return points;
}

async function savingsRows(env: Env, userId: string): Promise<SavingsRow[]> {
  const res = await env.DB.prepare(
    `SELECT id, kind, label, address, amount_ars, amount_usd, last_balance_usd, last_synced_at
     FROM savings_assets WHERE user_id = ? ORDER BY kind, label`,
  )
    .bind(userId)
    .all<SavingsRow>();
  return res.results ?? [];
}

function publicAsset(row: SavingsRow) {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    address: row.address,
    amountArs: row.amount_ars != null ? num(row.amount_ars) : null,
    amountUsd: row.amount_usd != null ? num(row.amount_usd) : null,
    lastBalanceUsd: row.last_balance_usd != null ? num(row.last_balance_usd) : null,
    lastSyncedAt: row.last_synced_at != null ? new Date(row.last_synced_at).toISOString() : null,
    syncError: null,
  };
}

function summarize(rows: SavingsRow[], blue: number | null) {
  let totalArs = 0;
  let totalUsdBanks = 0;
  let totalUsdc = 0;
  for (const row of rows) {
    if (row.kind === "bank") {
      totalArs += num(row.amount_ars);
      totalUsdBanks += num(row.amount_usd);
    } else {
      totalUsdc += num(row.last_balance_usd);
    }
  }
  const totalUsd = totalUsdBanks + totalUsdc;
  const rate = blue != null && blue > 0 ? blue : null;
  return {
    totalArs,
    totalUsd,
    totalUsdBanks,
    totalUsdc,
    netArs: rate == null && totalUsd > 0 ? null : totalArs + totalUsd * (rate ?? 0),
    blueRate: rate,
  };
}

async function debtRow(env: Env, userId: string): Promise<DebtRow | null> {
  return env.DB.prepare(
    `SELECT force_settled, saldo_deuda_ars, saldo_deuda_usd, card_last4,
            rate_pct, min_payment_ars, due_day, notes, cleared_at, updated_at,
            (SELECT COUNT(*) FROM card_statements cs
               INNER JOIN household_members hm ON hm.household_id = cs.household_id
              WHERE hm.user_id = debt_settings.user_id AND ${CLOSED_STATEMENT_SQL}) AS closed_statements,
            (SELECT COUNT(*) FROM card_statements cs
               INNER JOIN household_members hm ON hm.household_id = cs.household_id
              WHERE hm.user_id = debt_settings.user_id AND NOT (${CLOSED_STATEMENT_SQL})) AS open_statements
     FROM debt_settings WHERE user_id = ?`,
  )
    .bind(userId)
    .first<DebtRow>();
}

function serializeSettings(row: DebtRow | null) {
  if (!row) {
    return {
      ratePct: null,
      minPaymentArs: null,
      dueDay: null,
      notes: null,
      forceSettled: false,
      clearedAt: null,
      cardLast4: null,
      saldoDeudaArs: null,
      saldoDeudaUsd: null,
      updatedAt: null,
    };
  }
  return {
    ratePct: row.rate_pct != null ? num(row.rate_pct) : null,
    minPaymentArs: row.min_payment_ars != null ? num(row.min_payment_ars) : null,
    dueDay: row.due_day,
    notes: row.notes,
    forceSettled: Boolean(row.force_settled),
    clearedAt: row.cleared_at != null ? new Date(row.cleared_at).toISOString() : null,
    cardLast4: row.card_last4,
    saldoDeudaArs: row.saldo_deuda_ars != null ? num(row.saldo_deuda_ars) : null,
    saldoDeudaUsd: row.saldo_deuda_usd != null ? num(row.saldo_deuda_usd) : null,
    updatedAt: row.updated_at != null ? new Date(row.updated_at).toISOString() : null,
  };
}

async function saveDebtSettings(req: Request, env: Env, user: SessionUser): Promise<Response> {
  const body = (await req.json().catch(() => null)) as {
    ratePct?: number | null;
    minPaymentArs?: number | null;
    dueDay?: number | null;
    notes?: string | null;
    forceSettled?: boolean | null;
    cardLast4?: string | null;
    saldoDeudaArs?: number | null;
    saldoDeudaUsd?: number | null;
  } | null;
  if (!body) return json({ error: "JSON inválido" }, 400);
  const current = await debtRow(env, user.id);
  let dueDay = current?.due_day ?? null;
  if (body.dueDay !== undefined) {
    if (body.dueDay == null) dueDay = null;
    else {
      const day = Math.round(Number(body.dueDay));
      if (!Number.isFinite(day) || day < 1 || day > 31) {
        return json({ error: "El día de vencimiento tiene que ser entre 1 y 31" }, 400);
      }
      dueDay = day;
    }
  }
  const rate = body.ratePct !== undefined ? optionalMoney(body.ratePct) : current?.rate_pct ?? null;
  const minPay = body.minPaymentArs !== undefined ? optionalMoney(body.minPaymentArs) : current?.min_payment_ars ?? null;
  const saldoArs = body.saldoDeudaArs !== undefined ? optionalMoney(body.saldoDeudaArs) : current?.saldo_deuda_ars ?? null;
  const saldoUsd = body.saldoDeudaUsd !== undefined ? optionalMoney(body.saldoDeudaUsd) : current?.saldo_deuda_usd ?? null;
  if (rate === false || minPay === false || saldoArs === false || saldoUsd === false) {
    return json({ error: "Monto inválido" }, 400);
  }
  const notes = body.notes !== undefined
    ? (body.notes == null ? null : String(body.notes).trim().slice(0, 500) || null)
    : current?.notes ?? null;
  let force = Boolean(current?.force_settled);
  let cleared = current?.cleared_at ?? null;
  if (body.forceSettled !== undefined) {
    force = Boolean(body.forceSettled);
    cleared = force ? (cleared ?? Date.now()) : null;
  }
  let cardLast4 = current?.card_last4 ?? null;
  if (body.cardLast4 !== undefined) {
    if (body.cardLast4 == null || body.cardLast4 === "") cardLast4 = null;
    else {
      const match = String(body.cardLast4).match(/(\d{4})\s*$/);
      cardLast4 = match ? match[1] : String(body.cardLast4).replace(/\D/g, "").slice(-4) || null;
    }
  }
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO debt_settings (
       user_id, rate_pct, min_payment_ars, due_day, notes, force_settled, cleared_at,
       card_last4, saldo_deuda_ars, saldo_deuda_usd, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       rate_pct = excluded.rate_pct,
       min_payment_ars = excluded.min_payment_ars,
       due_day = excluded.due_day,
       notes = excluded.notes,
       force_settled = excluded.force_settled,
       cleared_at = excluded.cleared_at,
       card_last4 = excluded.card_last4,
       saldo_deuda_ars = excluded.saldo_deuda_ars,
       saldo_deuda_usd = excluded.saldo_deuda_usd,
       updated_at = excluded.updated_at`,
  )
    .bind(user.id, rate, minPay, dueDay, notes, force ? 1 : 0, cleared, cardLast4, saldoArs, saldoUsd, now)
    .run();
  await rememberSnapshot(env, user.id);
  const saved = await debtRow(env, user.id);
  return json({ settings: serializeSettings(saved) });
}

function optionalMoney(value: unknown): string | null | false {
  if (value == null || value === "") return null;
  const parsed = parseExpenseAmount(value);
  if (!parsed.ok) return false;
  return expenseAmountText(parsed.amount);
}

async function closedStatements(env: Env, userId: string) {
  const res = await env.DB.prepare(
    `SELECT s.id AS id, s.file_name AS file_name, s.source AS source, s.status AS status,
            s.closed_at AS closed_at, s.imported_at AS imported_at, s.row_count AS row_count,
            MIN(t.date) AS period_from, MAX(t.date) AS period_to
     FROM card_statements s
     INNER JOIN household_members m ON m.household_id = s.household_id
     LEFT JOIN transactions t ON t.statement_id = s.id
     WHERE m.user_id = ?
     GROUP BY s.id
     ORDER BY s.imported_at DESC
     LIMIT 100`,
  )
    .bind(userId)
    .all<{
      id: string;
      file_name: string | null;
      source: string;
      status: string;
      closed_at: number | null;
      imported_at: number | null;
      row_count: number | null;
      period_from: string | null;
      period_to: string | null;
    }>();
  return (res.results ?? []).map((row) => ({
    id: row.id,
    fileName: row.file_name,
    source: row.source,
    status: row.status,
    closedAt: row.closed_at != null ? new Date(row.closed_at).toISOString() : null,
    importedAt: row.imported_at != null ? new Date(row.imported_at).toISOString() : null,
    rowCount: num(row.row_count),
    periodFrom: row.period_from,
    periodTo: row.period_to,
  }));
}

async function pastCuotas(env: Env, userId: string) {
  const res = await env.DB.prepare(
    `SELECT t.date AS date, t.description_normalized AS description, t.installment AS installment, t.amount_ars AS amount_ars
     FROM transactions t
     INNER JOIN household_members m ON m.household_id = t.household_id
     WHERE m.user_id = ?
       AND (t.ownership = 'shared' OR t.paid_by_user_id = ?)
       AND t.installment IS NOT NULL
       AND length(trim(t.installment)) > 0
     ORDER BY t.date DESC
     LIMIT 15`,
  )
    .bind(userId, userId)
    .all<{ date: string; description: string; installment: string | null; amount_ars: string | null }>();
  return (res.results ?? []).map((row) => ({
    date: row.date,
    description: row.description,
    installment: row.installment,
    amountArs: row.amount_ars != null ? num(row.amount_ars) : null,
  }));
}

function snapshotSource(value: string): PatrimonioPoint["source"] {
  if (value === "derived" || value === "manual") return value;
  return "snapshot";
}

function defaultLabel(kind: "bank" | "evm" | "cardano"): string {
  if (kind === "evm") return "Wallet EVM";
  if (kind === "cardano") return "Wallet Cardano";
  return "Banco";
}
