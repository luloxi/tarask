import { sql } from "drizzle-orm";
import {
  index,
  integer,
  numeric,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * SQLite / D1 column conventions (app tables keep the Postgres names):
 *
 * - ids: text, `crypto.randomUUID()` when the app generates them.
 * - timestamps: integer unix epoch **milliseconds**. Drizzle `timestamp_ms`
 *   maps them to `Date` at the TypeScript boundary. SQL default is
 *   `(unixepoch() * 1000)`, evaluated per insert.
 * - money / decimals: TEXT (no NUMERIC affinity) with Drizzle `numeric`
 *   mode `string`. Callers keep using `Number()` / `parseFloat` on the
 *   string, the same way they did with Postgres `numeric`. SQLite `SUM()`
 *   is IEEE float, so the app does not aggregate money in SQL.
 * - booleans: integer 0/1, boolean at the TypeScript boundary.
 * - jsonb (`receipts.ocr_raw`): TEXT via `text` mode `json` (parsed object
 *   in TypeScript).
 * - partial unique indexes are real SQLite partial indexes (`WHERE`).
 *
 * D1 has no interactive transactions. Places that need atomicity use
 * `db.batch()`; everything else is sequential statements.
 */

const ts = (name: string) => integer(name, { mode: "timestamp_ms" });
const tsNow = (name: string) =>
  ts(name)
    .notNull()
    .default(sql`(unixepoch() * 1000)`);
const flag = (name: string, defaultOn = false) =>
  integer(name, { mode: "boolean" }).notNull().default(defaultOn);
const money = (name: string) => numeric(name, { mode: "string" });

// App users — id matches the Better Auth user id, synced on each login.
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name"),
  email: text("email").unique(),
  image: text("image"),
  createdAt: tsNow("created_at"),
});

/** Emails autorizados a usar la app (además del admin fijo). */
export const allowedEmails = sqliteTable("allowed_emails", {
  email: text("email").primaryKey(),
  createdAt: tsNow("created_at"),
  createdBy: text("created_by"),
});

export const households = sqliteTable("households", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull().default("Mi espacio"),
  inviteCode: text("invite_code").notNull().unique(),
  createdAt: tsNow("created_at"),
});

export const householdMembers = sqliteTable(
  "household_members",
  {
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").$type<"owner" | "member">().notNull().default("member"),
    displayName: text("display_name"),
    joinedAt: tsNow("joined_at"),
  },
  (t) => [
    primaryKey({ columns: [t.householdId, t.userId] }),
    index("hm_user_idx").on(t.userId),
  ],
);

/**
 * Per-household Agent/MCP bearer tokens.
 * Store only the SHA-256 hex of the plaintext; plaintext is shown once on create/rotate.
 */
export const householdApiTokens = sqliteTable(
  "household_api_tokens",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: tsNow("created_at"),
    lastUsedAt: ts("last_used_at"),
    revokedAt: ts("revoked_at"),
  },
  (t) => [
    uniqueIndex("hat_hash_uidx").on(t.tokenHash),
    index("hat_household_idx").on(t.householdId),
  ],
);

export const categories = sqliteTable("categories", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  kind: text("kind").$type<"expense" | "payment" | "interest">().notNull(),
  defaultOwnership: text("default_ownership")
    .$type<"personal" | "shared">()
    .notNull()
    .default("personal"),
  isSystem: flag("is_system", true),
  /** null = categoría global del sistema; set = personalizada del hogar */
  householdId: text("household_id").references(() => households.id, {
    onDelete: "cascade",
  }),
});

/** Preferencias por hogar: ocultar categorías del sistema sin borrarlas. */
export const householdCategoryPrefs = sqliteTable(
  "household_category_prefs",
  {
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    categoryId: text("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    hidden: flag("hidden", true),
  },
  (t) => [
    primaryKey({ columns: [t.householdId, t.categoryId] }),
    index("hcp_household_idx").on(t.householdId),
  ],
);

export const merchantRules = sqliteTable("merchant_rules", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  householdId: text("household_id").references(() => households.id, {
    onDelete: "cascade",
  }),
  pattern: text("pattern").notNull(),
  categoryId: text("category_id")
    .notNull()
    .references(() => categories.id, { onDelete: "cascade" }),
  priority: integer("priority").notNull().default(50),
});

export const cardStatements = sqliteTable("card_statements", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  householdId: text("household_id")
    .notNull()
    .references(() => households.id, { onDelete: "cascade" }),
  source: text("source").notNull().default("bbva_xlsx"),
  fileName: text("file_name"),
  importedBy: text("imported_by").references(() => users.id),
  importedAt: tsNow("imported_at"),
  rowCount: integer("row_count").notNull().default(0),
  /** Null while the import can still feed active card debt. */
  closedAt: ts("closed_at"),
  /** open | closed. Closed rows stay as history. */
  status: text("status").notNull().default("open"),
});

export const transactions = sqliteTable(
  "transactions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    statementId: text("statement_id").references(() => cardStatements.id, {
      onDelete: "set null",
    }),
    date: text("date").notNull(),
    descriptionRaw: text("description_raw").notNull(),
    descriptionNormalized: text("description_normalized").notNull(),
    amountArs: money("amount_ars"),
    amountUsd: money("amount_usd"),
    installment: text("installment"),
    isPayment: flag("is_payment"),
    isCredit: flag("is_credit"),
    categoryId: text("category_id").references(() => categories.id),
    ownership: text("ownership")
      .$type<"personal" | "shared">()
      .notNull()
      .default("personal"),
    paidByUserId: text("paid_by_user_id").references(() => users.id),
    splitPct: integer("split_pct").notNull().default(50),
    externalFingerprint: text("external_fingerprint").notNull(),
    source: text("source").notNull().default("bbva_import"),
    bank: text("bank"),
    /** Last 4 of the BBVA card when the period xls lists titular + adicionales. */
    cardLast4: text("card_last4"),
    /**
     * Historic cross-hogar id. Unused by totals and listing; column kept as-is.
     */
    linkedTransactionId: text("linked_transaction_id"),
    /** 1 when this personal movement is synced to Serpix as a business expense. */
    isBusiness: flag("is_business"),
    /** Monotonic per row (updated_at ms). Serpix drops events with a lower version. */
    businessVersion: integer("business_version"),
    createdAt: tsNow("created_at"),
    updatedAt: tsNow("updated_at"),
  },
  (t) => [
    uniqueIndex("tx_household_fp_uidx").on(t.householdId, t.externalFingerprint),
    index("tx_household_date_idx").on(t.householdId, t.date),
    index("tx_household_cat_idx").on(t.householdId, t.categoryId),
    index("tx_household_bank_idx").on(t.householdId, t.bank),
    index("tx_household_desc_idx").on(t.householdId, t.descriptionNormalized),
    index("tx_linked_idx").on(t.linkedTransactionId),
  ],
);

/**
 * Outbox for Tarask -> Serpix. Written in the same D1 batch as the movement.
 * The request path does not use Drizzle; see worker/serpix-sync.ts.
 */
export const serpixOutbox = sqliteTable(
  "serpix_outbox",
  {
    id: text("id").primaryKey(),
    txId: text("tx_id").notNull(),
    eventId: text("event_id").notNull(),
    type: text("type").$type<"upsert" | "delete">().notNull(),
    payload: text("payload").notNull(),
    createdAt: ts("created_at").notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: ts("next_attempt_at"),
    lastError: text("last_error"),
    sentAt: ts("sent_at"),
    failedAt: ts("failed_at"),
  },
  (t) => [
    index("serpix_outbox_pending_idx").on(t.sentAt, t.failedAt, t.nextAttemptAt),
    index("serpix_outbox_tx_created_idx").on(t.txId, t.createdAt),
  ],
);

export const receipts = sqliteTable(
  "receipts",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    imageUrl: text("image_url").notNull(),
    merchantName: text("merchant_name"),
    receiptDate: text("receipt_date"),
    totalArs: money("total_ars"),
    currency: text("currency").default("ARS"),
    ocrRaw: text("ocr_raw", { mode: "json" }).$type<Record<string, unknown> | null>(),
    status: text("status")
      .$type<"pending" | "parsed" | "matched" | "failed">()
      .notNull()
      .default("pending"),
    transactionId: text("transaction_id").references(() => transactions.id, {
      onDelete: "set null",
    }),
    createdBy: text("created_by").references(() => users.id),
    createdAt: tsNow("created_at"),
  },
  (t) => [
    index("receipts_household_idx").on(t.householdId),
    index("receipts_tx_idx").on(t.transactionId),
  ],
);

export const receiptItems = sqliteTable("receipt_items", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  receiptId: text("receipt_id")
    .notNull()
    .references(() => receipts.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  quantity: money("quantity").default("1"),
  unitPrice: money("unit_price"),
  lineTotal: money("line_total"),
  productCategory: text("product_category"),
});

export const savingsAssets = sqliteTable(
  "savings_assets",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"evm" | "cardano" | "bank">().notNull(),
    label: text("label").notNull(),
    address: text("address"),
    amountArs: money("amount_ars"),
    amountUsd: money("amount_usd"),
    lastBalanceUsd: money("last_balance_usd"),
    lastSyncedAt: ts("last_synced_at"),
    syncError: text("sync_error"),
    createdAt: tsNow("created_at"),
    updatedAt: tsNow("updated_at"),
  },
  (t) => [
    index("savings_user_idx").on(t.userId),
    index("savings_household_idx").on(t.householdId),
  ],
);

export const debtSettings = sqliteTable("debt_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** Tasa nominal anual (TNA) en %. Ej: 90 = 90% TNA. */
  ratePct: money("rate_pct"),
  minPaymentArs: money("min_payment_ars"),
  /** Día de vencimiento del mes (1–31). */
  dueDay: integer("due_day"),
  notes: text("notes"),
  /** User marked the cancelled bank/card as settled — zeros Casita + /deuda. */
  forceSettled: flag("force_settled"),
  clearedAt: ts("cleared_at"),
  /** Last 4 of the card that belongs to this user (period xls may list two). */
  cardLast4: text("card_last4"),
  /**
   * Rainman: editable card debt source of truth (ARS). Without it → Sin snapshot.
   * Filled by card statement import (SALDO ACTUAL) or typed by the user.
   */
  saldoDeudaArs: money("saldo_deuda_ars"),
  /** Optional USD leg of the card saldo. */
  saldoDeudaUsd: money("saldo_deuda_usd"),
  updatedAt: tsNow("updated_at"),
});

export const patrimonioSnapshots = sqliteTable(
  "patrimonio_snapshots",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    assetsArs: money("assets_ars").notNull().default("0"),
    assetsUsd: money("assets_usd").notNull().default("0"),
    debtArs: money("debt_ars").notNull().default("0"),
    debtUsd: money("debt_usd").notNull().default("0"),
    netWorthArs: money("net_worth_ars").notNull().default("0"),
    fxRate: money("fx_rate"),
    source: text("source").notNull().default("snapshot"),
    note: text("note"),
    createdAt: tsNow("created_at"),
  },
  (t) => [
    uniqueIndex("patrimonio_snapshots_user_date_source_uidx").on(
      t.userId,
      t.date,
      t.source,
    ),
    uniqueIndex("patrimonio_snapshots_user_date_uidx").on(t.userId, t.date),
    index("patrimonio_snapshots_user_date_idx").on(t.userId, t.date),
  ],
);

/**
 * Point-in-time bank balances. One row per account, currency, and date.
 * ARS, USDT, and USD are separate rows. `amount` is a decimal string.
 */
export const balanceSnapshots = sqliteTable(
  "balance_snapshots",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    accountName: text("account_name").notNull(),
    date: text("date").notNull(),
    currency: text("currency").$type<"ARS" | "USDT" | "USD">().notNull(),
    amount: money("amount").notNull(),
    source: text("source").$type<"manual" | "routine">().notNull(),
    createdAt: tsNow("created_at"),
  },
  (t) => [
    uniqueIndex("balance_snapshots_slot_uidx").on(
      t.userId,
      t.householdId,
      t.accountName,
      t.currency,
      t.date,
    ),
    index("balance_snapshots_lookup_idx").on(t.userId, t.householdId, t.currency, t.date),
  ],
);

export const incomes = sqliteTable(
  "incomes",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    /** variable = ingreso puntual; recurring = sueldo/plantilla recurrente */
    kind: text("kind")
      .$type<"recurring" | "variable">()
      .notNull()
      .default("variable"),
    /** Solo para recurring: mensual | quincenal (14 días) | semanal */
    frequency: text("frequency").$type<"mensual" | "quincenal" | "semanal">(),
    /** Fecha del cobro (variable) o ancla / primer cobro (recurring). */
    date: text("date").notNull(),
    label: text("label").notNull(),
    amountArs: money("amount_ars"),
    amountUsd: money("amount_usd"),
    /** Stable import key (Casita CSV seed, etc.) for idempotent re-import. */
    externalFingerprint: text("external_fingerprint"),
    createdAt: tsNow("created_at"),
    updatedAt: tsNow("updated_at"),
  },
  (t) => [
    index("incomes_user_idx").on(t.userId),
    index("incomes_household_date_idx").on(t.householdId, t.date),
    index("incomes_user_kind_idx").on(t.userId, t.kind),
    uniqueIndex("incomes_household_fp_uidx")
      .on(t.householdId, t.externalFingerprint)
      .where(sql`${t.externalFingerprint} IS NOT NULL`),
  ],
);

export const subscriptions = sqliteTable(
  "subscriptions",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    polarSubscriptionId: text("polar_subscription_id").primaryKey(),
    status: text("status").notNull(),
    currentPeriodEnd: ts("current_period_end"),
    updatedAt: tsNow("updated_at"),
  },
  (t) => [index("subscriptions_user_idx").on(t.userId)],
);

/**
 * Better Auth tables. Namespaced so they do not clash with app `users`.
 * Property names are the Better Auth field names (camelCase). SQL columns
 * are snake_case. Timestamps are integer milliseconds, booleans 0/1.
 */
export const authUser = sqliteTable("auth_user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: flag("email_verified"),
  image: text("image"),
  createdAt: tsNow("created_at"),
  updatedAt: tsNow("updated_at"),
});

export const authSession = sqliteTable(
  "auth_session",
  {
    id: text("id").primaryKey(),
    expiresAt: ts("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: tsNow("created_at"),
    updatedAt: tsNow("updated_at"),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
  },
  (t) => [index("auth_session_user_idx").on(t.userId)],
);

export const authAccount = sqliteTable(
  "auth_account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: ts("access_token_expires_at"),
    refreshTokenExpiresAt: ts("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: tsNow("created_at"),
    updatedAt: tsNow("updated_at"),
  },
  (t) => [
    uniqueIndex("auth_account_provider_uidx").on(t.providerId, t.accountId),
    index("auth_account_user_idx").on(t.userId),
  ],
);

export const authVerification = sqliteTable(
  "auth_verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: ts("expires_at").notNull(),
    createdAt: tsNow("created_at"),
    updatedAt: tsNow("updated_at"),
  },
  (t) => [index("auth_verification_identifier_idx").on(t.identifier)],
);

export type User = typeof users.$inferSelect;
export type Household = typeof households.$inferSelect;
export type HouseholdApiToken = typeof householdApiTokens.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type SerpixOutbox = typeof serpixOutbox.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type Receipt = typeof receipts.$inferSelect;
export type ReceiptItem = typeof receiptItems.$inferSelect;
export type SavingsAsset = typeof savingsAssets.$inferSelect;
export type DebtSettings = typeof debtSettings.$inferSelect;
export type Income = typeof incomes.$inferSelect;
export type AppSubscription = typeof subscriptions.$inferSelect;
