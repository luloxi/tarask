/**
 * Bindings for the lite Worker. Secrets stay in `wrangler secret` and are
 * never written into config. GOOGLE_* and BETTER_AUTH_SECRET already exist
 * on the live `cuentix` worker; staging `cuentix-lite` does not receive them
 * automatically.
 */
export interface D1Prepared {
  bind(...values: unknown[]): D1Prepared;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<{ meta?: { changes?: number } }>;
}

export interface D1Database {
  prepare(query: string): D1Prepared;
  batch(statements: D1Prepared[]): Promise<unknown[]>;
}

export interface Env {
  DB: D1Database;
  RECEIPTS: {
    put(
      key: string,
      value: ArrayBuffer | ArrayBufferView | string | ReadableStream | Blob,
      options?: { httpMetadata?: { contentType?: string } },
    ): Promise<unknown>;
    get(key: string): Promise<{
      body: ReadableStream;
      httpMetadata?: { contentType?: string };
    } | null>;
  };
  AI: {
    toMarkdown(documents: unknown, options?: unknown): Promise<unknown>;
  };
  ASSETS: { fetch(input: Request): Promise<Response> };
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Reused only as an HMAC key for the OAuth state cookie. Never log it. */
  BETTER_AUTH_SECRET?: string;
  /** Shared with Genkilulox: verifies the parent-domain lulox_sso cookie (single sign-on). */
  LULOX_SSO_SECRET?: string;
  ALLOWED_EMAILS?: string;
  /** Roommate payee tokens ("ANA+PEREZ,ANITA"). Set as a Worker secret/var, never commit. */
  REINTEGRO_PAYEES?: string;
  /**
   * Own-account CUITs, CBUs/CVUs, and aliases, comma-separated.
   * Worker runtime variable only. Never commit real values. Empty = none from config.
   * Data-derived ids (rows marked cuenta propia / cuenta tuya / own account) are added at request time.
   */
  OWN_ACCOUNT_IDS?: string;
  AUTH_URL?: string;
  OPENAI_API_KEY?: string;
  /** wrangler secret. Never put this in wrangler.jsonc or logs. */
  CUENTIX_SYNC_SECRET?: string;
  /**
   * wrangler secret for the read-only `/api/svc/*` API.
   * Never put the value in wrangler.jsonc, git, or logs.
   */
  MCP_SERVICE_TOKEN?: string;
  /**
   * `auth_user.email` the service acts as. When unset, the admin email is used.
   * Not a secret. Never changes who a cookie session is.
   */
  MCP_SERVICE_USER_EMAIL?: string;
  /** Override in tests. Prod sets it in wrangler vars. */
  SERPIX_SYNC_URL?: string;
  /** Polar billing. Optional. Never log. */
  POLAR_ACCESS_TOKEN?: string;
  POLAR_PRODUCT_ID?: string;
  /**
   * Bearer for `POST /api/balances` (operator routine). wrangler secret.
   * Never put the value in wrangler.jsonc, git, or logs.
   */
  BALANCES_TOKEN?: string;
  /**
   * `users.email` the routine writes for. When unset, the admin email is used.
   * Not a secret.
   */
  BALANCES_USER_EMAIL?: string;
}

/** Subset of the Workers execution context. Tests pass a fake. */
export interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void;
}
