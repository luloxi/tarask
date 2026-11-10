/**
 * Money columns are TEXT decimals. Aggregates use CAST(x AS REAL), which is
 * an IEEE approximation good enough for dashboard display. Exact row amounts
 * stay strings until the client calls Number() on a single value.
 *
 * Dashboard expense rows approximate `isExpenseRow` in SQL so we never pull
 * the household into JS:
 * - not a payment, not a credit
 * - not a period-xls / resumen-pdf source (bbva_period, bbva_pdf)
 * - Casita rows linked to Invoice IOG are excluded; invoice_iog itself counts
 * - `BANK_ACCOUNTING_SQL` keeps the phrase list (cuenta tuya, cambio de
 *   moneda, pesificación, transf deuda, compra/venta KO, COMPRA/VENTA ME,
 *   RETIRO, DEPOSITO, CONVERSION, yields).
 *   Wallet rows are only the exact codes TRANSFERENCIA ARS|USD|USDC|USDT.
 *   COMPRA/VENTA of a single wallet code are only USD, USDC, USDT, USDB, ME
 *   (KO stays on the existing LIKE). COMPRA SUPER, COMPRA MERCADOLIBRE and
 *   TRANSFERENCIA A <persona> stay spends.
 *   "Transferencia inmediata" and a bare "TRANSFERENCIA" stay spends unless
 *   the id is in the dup set. That set is Fiwind echo ids union internal
 *   transfers from `classifyTransferRows` (own-account id or an opposite
 *   incoming twin). A generic transfer with no payee still counts.
 *   Own-account labels already treated as internal on Consumos (BBNK self
 *   move, TRANSF CLIENTE CTA/CAP) are bank accounting too — they must not
 *   inflate dashboard / chart / mes-a-mes expense totals. Income uses the
 *   same data rule in `worker/income.ts`: the income twin drops a variable
 *   row only when both the label and the outgoing row are transfers (or
 *   own-account credits), not when any same-amount spend is nearby.
 *   A numeric-only description (digits and dots) is not accounting by
 *   itself. Unpaired Fiwind numeric rows stay counted. JS
 *   `isBankAccountingEntry` still treats every amount-only tipo as
 *   accounting; that difference is intentional.
 *
 * Fiwind numeric echoes are paired in `worker/fiwind-dups.ts`
 * (`pairFiwindEchoes`), outside SQL. The Workers free plan cannot spend
 * the CPU of a correlated scan. Each request loads candidates for the
 * requesting user with one indexed query and passes the numeric ids to
 * drop into `expenseSql` / `bankAccountingSql` / `consumosVisibleSql`.
 * An empty set adds no clause, so `EXPENSE_SQL` and `BANK_ACCOUNTING_SQL`
 * stay valid for callers that have no dup set. A loader error counts
 * every row.
 *
 * Rule: a Fiwind row whose description is only digits and dots is dropped
 * when a named twin takes its slot. A named twin is any other non-numeric
 * row (any bank or source, payment and credit included). Eligible pairs
 * are the same household and at most 2 calendar days apart, or two
 * households of the same user on the same calendar day. The amount is the
 * numeric row's own currency, signed and the same direction: USD when
 * |amount_usd| >= 0.005 and the ARS counted amount is 0 the way `ARS_EXPR`
 * is 0 when both sides are nonzero, otherwise ARS. Tolerance is strictly
 * under 0.01 ARS or 0.005 USD. Pairs are taken closest-first, then
 * same-household before cross-household, then numeric date, numeric id,
 * named date, named id. Each row is used once. The named twin stays.
 * Households the user does not belong to are not candidates.
 *
 * Consumos shows real spends plus internal transfers and the payment
 * exceptions in `isConsumosHiddenPayment`. Other bank-accounting lines
 * (paired numeric Fiwind echoes, pesificación, Retiro) stay out of the list.
 * Unpaired numeric descriptions stay visible, unlike the legacy JS filter.
 * Internal-transfer ids are in the dup set (out of totals) and are also
 * passed as `visibleIds`, so they stay on Consumos. A generic transfer
 * stays on the list and counts.
 */

/** Ids safe to inline. Anything else is dropped before it can reach SQL. */
const DUP_ID = /^[A-Za-z0-9-]{1,64}$/;

/**
 * `OR t.id IN (SELECT value FROM json_each('<json array>'))`, or "".
 * Ids are filtered with `DUP_ID`, JSON.stringified, and single quotes are
 * doubled so the literal stays inside the SQL string.
 */
function fiwindDupClause(dupIds?: Iterable<string>): string {
  if (!dupIds) return "";
  const safe: string[] = [];
  for (const id of dupIds) {
    if (typeof id === "string" && DUP_ID.test(id)) safe.push(id);
  }
  if (safe.length === 0) return "";
  safe.sort();
  const literal = JSON.stringify(safe).replaceAll("'", "''");
  return `OR t.id IN (SELECT value FROM json_each('${literal}'))`;
}

/**
 * Own-account labels that Consumos already treats as internal (visible,
 * out of neta). Same clauses belong in bank accounting so dashboard /
 * charts / mes-a-mes do not count them as gasto.
 */
const OWN_ACCOUNT_LABEL_SQL = `
  OR (
    upper(t.description_normalized) LIKE '%TRANSF%CLIENTE%'
    AND (
      upper(t.description_normalized) LIKE '%CTA%'
      OR upper(t.description_normalized) LIKE '%CAP%'
    )
  )
  OR (
    upper(t.description_normalized) LIKE '%BBNK%'
    AND (
      upper(t.description_normalized) LIKE '%TRANSFERENCIA%'
      OR upper(t.description_normalized) LIKE '%TRANSF %'
    )
  )`;

const BANK_ACCOUNTING_BODY = `
  upper(t.description_normalized) LIKE '%CAMBIO DE MONEDA%'
  OR upper(t.description_normalized) LIKE '%CAMBIO MONEDA%'
  OR upper(t.description_normalized) LIKE '%CUENTA TUYA%'
  OR upper(t.description_normalized) LIKE '%CUENTA PROPIA%'
  OR upper(t.description_normalized) LIKE '%ENTRE CUENTAS%'
  OR upper(t.description_normalized) LIKE '%PESIFICACION%'
  OR upper(t.description_normalized) LIKE '%PESIFICACIÓN%'
  OR upper(t.description_normalized) LIKE '%TRANSFERENCIA DEUDA%'
  OR upper(t.description_normalized) LIKE '%TRANSF%DEUDA%'
  OR upper(t.description_normalized) LIKE '%CREDITOS VS EN USD%'
  OR upper(t.description_normalized) LIKE '%CREDITO VS EN USD%'
  OR upper(t.description_normalized) LIKE '%COMPRA KO%'
  OR upper(t.description_normalized) LIKE '%VENTA KO%'
  OR upper(t.description_normalized) LIKE '%TRANSFERENCIA INTERNA%'
  OR upper(t.description_normalized) LIKE '%CUENTA A CUENTA%'
  OR upper(t.description_normalized) LIKE '%CTA A CTA%'
  OR upper(t.description_normalized) LIKE '%CR TRF%'
  OR upper(t.description_normalized) LIKE '%CR TBE%'
  OR upper(t.description_normalized) LIKE '%INM COE%'
  OR upper(t.description_normalized) LIKE '%TRANSF CREDITO%'
  OR upper(t.description_normalized) LIKE '%TRANSF. CREDITO%'
  OR upper(t.description_normalized) LIKE '%TRANSFERENCIA CREDITO%'
  OR upper(t.description_normalized) LIKE '%OPERACION DE CAMBIO%'
  OR upper(t.description_normalized) LIKE '%OPERACIONES DE CAMBIO%'
  OR upper(t.description_normalized) LIKE '%OPERACION CAMBIO%'
  OR upper(t.description_normalized) LIKE '%OPERACIONES CAMBIO%'
  OR upper(trim(t.description_normalized)) GLOB 'COMPRA ME'
  OR upper(trim(t.description_normalized)) GLOB 'COMPRA ME *'
  OR upper(trim(t.description_normalized)) GLOB '* COMPRA ME'
  OR upper(trim(t.description_normalized)) GLOB '* COMPRA ME *'
  OR upper(trim(t.description_normalized)) GLOB 'VENTA ME'
  OR upper(trim(t.description_normalized)) GLOB 'VENTA ME *'
  OR upper(trim(t.description_normalized)) GLOB '* VENTA ME'
  OR upper(trim(t.description_normalized)) GLOB '* VENTA ME *'
  OR upper(trim(t.description_normalized)) = 'RETIRO'
  OR upper(trim(t.description_normalized)) GLOB 'DEPOSITO'
  OR upper(trim(t.description_normalized)) GLOB 'DEPOSITO *'
  OR upper(trim(t.description_normalized)) GLOB 'CONVERSION*'
  OR upper(trim(t.description_normalized)) GLOB 'GANANCIA*'
  OR upper(trim(t.description_normalized)) GLOB 'RENDIMIENTO*'
  OR upper(trim(t.description_normalized)) IN (
    'TRANSFERENCIA ARS',
    'TRANSFERENCIA USD',
    'TRANSFERENCIA USDC',
    'TRANSFERENCIA USDT'
  )
  OR upper(trim(t.description_normalized)) IN (
    'COMPRA USD', 'COMPRA USDC', 'COMPRA USDT', 'COMPRA USDB',
    'VENTA USD', 'VENTA USDC', 'VENTA USDT', 'VENTA USDB'
  )
  ${OWN_ACCOUNT_LABEL_SQL}`;

/**
 * Phrase list, plus ids already decided outside SQL (Fiwind echoes and
 * internal transfers). An empty dup set is the phrase list alone.
 */
export function bankAccountingSql(dupIds?: Iterable<string>): string {
  const dup = fiwindDupClause(dupIds);
  return `(${BANK_ACCOUNTING_BODY}${dup ? `\n  ${dup}` : ""}
)`;
}

/** Phrase list only. Same as `bankAccountingSql()` with no dup ids. */
export const BANK_ACCOUNTING_SQL = bankAccountingSql();

/**
 * Internal transfers stay on the Consumos list (out of the expense total).
 * Requires the categories join (`c`).
 * "Transferencia inmediata" and bare "TRANSFERENCIA" are spends, so they
 * are not listed here. Consumos still shows them because they fall outside
 * `BANK_ACCOUNTING_SQL`.
 */
export const INTERNAL_VISIBLE_SQL = `(
  IFNULL(c.slug, '') = 'transferencia-interna'
  OR upper(t.description_normalized) LIKE '%CUENTA TUYA%'
  OR upper(t.description_normalized) LIKE '%CUENTA PROPIA%'
  OR upper(t.description_normalized) LIKE '%ENTRE CUENTAS%'
  OR upper(t.description_normalized) LIKE '%TRANSFERENCIA INTERNA%'
  OR upper(t.description_normalized) LIKE '%CUENTA A CUENTA%'
  OR upper(t.description_normalized) LIKE '%CTA A CTA%'
  OR upper(t.description_normalized) LIKE '%CR TRF%'
  OR upper(t.description_normalized) LIKE '%CR TBE%'
  OR upper(t.description_normalized) LIKE '%INM COE%'
  OR upper(t.description_normalized) LIKE '%TRANSF CREDITO%'
  OR upper(t.description_normalized) LIKE '%TRANSF. CREDITO%'
  OR upper(t.description_normalized) LIKE '%TRANSFERENCIA CREDITO%'
  OR upper(t.description_normalized) LIKE '%CAMBIO DE MONEDA%'
  OR upper(t.description_normalized) LIKE '%CAMBIO MONEDA%'
  OR upper(t.description_normalized) LIKE '%OPERACION DE CAMBIO%'
  OR upper(t.description_normalized) LIKE '%OPERACIONES DE CAMBIO%'
  OR upper(t.description_normalized) LIKE '%OPERACION CAMBIO%'
  OR upper(t.description_normalized) LIKE '%OPERACIONES CAMBIO%'
  OR upper(trim(t.description_normalized)) GLOB 'COMPRA ME'
  OR upper(trim(t.description_normalized)) GLOB 'COMPRA ME *'
  OR upper(trim(t.description_normalized)) GLOB '* COMPRA ME'
  OR upper(trim(t.description_normalized)) GLOB '* COMPRA ME *'
  OR upper(trim(t.description_normalized)) GLOB 'VENTA ME'
  OR upper(trim(t.description_normalized)) GLOB 'VENTA ME *'
  OR upper(trim(t.description_normalized)) GLOB '* VENTA ME'
  OR upper(trim(t.description_normalized)) GLOB '* VENTA ME *'
  ${OWN_ACCOUNT_LABEL_SQL}
)`;

/**
 * Rows that are not household spend: own-account transfers, FX, and wallet
 * conversions. Yields and deposits stay out (they are not transfers).
 * The bound `json_each` argument is the internal-transfer id list.
 * Requires the categories join (`c`).
 */
export const INTERNAL_ASIDE_SQL = `(
  IFNULL(c.slug, '') = 'transferencia-interna'
  OR ${INTERNAL_VISIBLE_SQL}
  OR upper(trim(t.description_normalized)) GLOB 'CONVERSION*'
  OR upper(trim(t.description_normalized)) IN (
    'TRANSFERENCIA ARS',
    'TRANSFERENCIA USD',
    'TRANSFERENCIA USDC',
    'TRANSFERENCIA USDT',
    'COMPRA USD',
    'COMPRA USDC',
    'COMPRA USDT',
    'COMPRA USDB',
    'VENTA USD',
    'VENTA USDC',
    'VENTA USDT',
    'VENTA USDB'
  )
  OR t.id IN (SELECT value FROM json_each(?))
)`;

export function expenseSql(dupIds?: Iterable<string>): string {
  return `
  t.is_payment = 0
  AND t.is_credit = 0
  AND IFNULL(t.source, '') NOT IN ('bbva_period', 'bbva_pdf')
  AND (t.linked_transaction_id IS NULL OR t.source = 'invoice_iog')
  AND NOT ${bankAccountingSql(dupIds)}
`;
}

/** Expense filter with no Fiwind dup clause. Same as `expenseSql()`. */
export const EXPENSE_SQL = expenseSql();

export const ARS_EXPR = `
  CASE
    WHEN ABS(CAST(IFNULL(t.amount_usd, '0') AS REAL)) > 0
     AND ABS(CAST(IFNULL(t.amount_ars, '0') AS REAL)) > 0
    THEN 0
    ELSE ABS(CAST(IFNULL(t.amount_ars, '0') AS REAL))
  END
`;

export const USD_EXPR = `ABS(CAST(IFNULL(t.amount_usd, '0') AS REAL))`;

/**
 * Linked card statement (`cs`) is closed history. Callers join
 * `card_statements cs ON cs.id = t.statement_id`.
 * `worker/finance.ts` on the patrimonio branch should select debt rows
 * through `DEBT_ROWS_SQL` so `statementClosed` is not left unset.
 */
export const CLOSED_STATEMENT_SQL = `IFNULL(cs.status, '') = 'closed'`;

/** One user's transactions, with `statement_closed` from `card_statements.status`. */
export const DEBT_ROWS_SQL = `
SELECT
  t.id AS id,
  t.date AS date,
  t.description_normalized AS description_normalized,
  t.amount_ars AS amount_ars,
  t.amount_usd AS amount_usd,
  t.installment AS installment,
  t.is_payment AS is_payment,
  t.is_credit AS is_credit,
  t.ownership AS ownership,
  t.paid_by_user_id AS paid_by_user_id,
  t.source AS source,
  t.bank AS bank,
  t.card_last4 AS card_last4,
  t.statement_id AS statement_id,
  CASE WHEN ${CLOSED_STATEMENT_SQL} THEN 1 ELSE 0 END AS statement_closed
FROM transactions t
LEFT JOIN card_statements cs ON cs.id = t.statement_id
INNER JOIN household_members m ON m.household_id = t.household_id
WHERE m.user_id = ?
`;

/** Rows Consumos is allowed to show (payments only when they are special tipos). */
/** Roommate payee SQL (names come from the REINTEGRO_PAYEES config, never from the repo). */
export function reintegroPayeeSql(raw: string | undefined): string {
  const groups = String(raw ?? "")
    .toUpperCase()
    .split(",")
    .map((g) => g.split("+").map((t) => t.replace(/[^A-Z0-9]/g, "")).filter(Boolean))
    .filter((g) => g.length > 0);
  return groups
    .map(
      (g) =>
        `    OR (${g
          .map((t) => `upper(t.description_normalized) LIKE '%${t}%'`)
          .join(" AND ")})`,
    )
    .join("\n");
}

export function consumosVisibleSql(
  reintegroPayees?: string,
  dupIds?: Iterable<string>,
  visibleIds?: Iterable<string>,
): string {
  const visible = fiwindDupClause(visibleIds);
  return CONSUMOS_VISIBLE_SQL.replace("/*REINTEGRO_PAYEES*/", reintegroPayeeSql(reintegroPayees))
    .replace("/*BANK_ACCOUNTING*/", bankAccountingSql(dupIds))
    .replace("/*INTERNAL_TRANSFER_IDS*/", visible ? `\n    ${visible}` : "");
}

const CONSUMOS_VISIBLE_SQL = `
  (
    t.is_payment = 0
    OR IFNULL(c.slug, '') = 'transferencia-interna'
    OR IFNULL(c.slug, '') IN ('alquiler', 'luz', 'agua', 'gas', 'internet', 'expensas')
    /*REINTEGRO_PAYEES*/
    OR upper(t.description_normalized) LIKE '%CUENTA TUYA%'
    OR upper(t.description_normalized) LIKE '%CUENTA PROPIA%'
    OR upper(t.description_normalized) LIKE '%CR TBE%'
    OR upper(t.description_normalized) LIKE '%CR TRF%'
    OR upper(t.description_normalized) LIKE '%INM COE%'
  )
  AND (
    t.is_credit = 0
    OR IFNULL(c.slug, '') = 'transferencia-interna'
    OR upper(t.description_normalized) LIKE '%CUENTA TUYA%'
    OR upper(t.description_normalized) LIKE '%CR TBE%'
    OR upper(t.description_normalized) LIKE '%CR TRF%'
    OR upper(t.description_normalized) LIKE '%INM COE%'
  )
  AND IFNULL(t.source, '') NOT IN ('bbva_period', 'bbva_pdf')
  AND (
    ${INTERNAL_VISIBLE_SQL}
    /*INTERNAL_TRANSFER_IDS*/
    OR NOT /*BANK_ACCOUNTING*/
  )
`;
