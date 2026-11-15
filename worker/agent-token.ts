/**
 * `/api/household/agent-token`
 * GET: whether this household has an MCP token (never the plaintext).
 * POST { action: "create" | "rotate" }: mint, plaintext returned once.
 * DELETE: revoke the active token.
 */
import type { SessionUser } from "./auth";
import type { Env } from "./env";
import { activeHousehold } from "./household";
import { json, sha256Hex } from "./http";

export const HOUSEHOLD_TOKEN_PREFIX = "lc_h_";
export const HOUSEHOLD_TOKEN_DISPLAY_LEN = 12;

export async function handleAgentToken(
  req: Request,
  env: Env,
  user: SessionUser,
): Promise<Response> {
  const { active } = await activeHousehold(req, env, user.id);
  if (req.method === "GET") return statusOf(active, env);
  if (!active) return json({ error: "Creá o uníte a un hogar primero", code: "no_household" }, 400);

  if (req.method === "DELETE") {
    await revokeActive(env, active.id);
    return statusOf(active, env);
  }
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  let action = "create";
  try {
    const body = (await req.json()) as { action?: string };
    if (body.action === "rotate" || body.action === "create") action = body.action;
  } catch {
    /* default create */
  }

  if (action === "create") {
    const existing = await tokenMeta(env, active.id);
    if (existing) {
      return json({ error: "Este hogar ya tiene un token. Usá rotar.", prefix: existing.prefix }, 409);
    }
  } else {
    await revokeActive(env, active.id);
  }

  const minted = await mintHouseholdToken(env, active.id, user.id);
  return json({
    household: { id: active.id, name: active.name },
    hasToken: true,
    prefix: minted.prefix,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    token: minted.token,
  });
}

export async function mintHouseholdToken(
  env: Env,
  householdId: string,
  createdBy: string,
): Promise<{ token: string; prefix: string; id: string }> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = HOUSEHOLD_TOKEN_PREFIX + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const tokenHash = await sha256Hex(token);
  const prefix = token.slice(0, HOUSEHOLD_TOKEN_DISPLAY_LEN);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO household_api_tokens (id, household_id, token_hash, token_prefix, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, householdId, tokenHash, prefix, createdBy, Date.now())
    .run();
  return { token, prefix, id };
}

export async function lookupHouseholdBearer(
  env: Env,
  presented: string,
): Promise<{ householdId: string; userId: string | null; tokenId: string } | { revoked: true } | null> {
  if (!presented.startsWith(HOUSEHOLD_TOKEN_PREFIX)) return null;
  const tokenHash = await sha256Hex(presented);
  const row = await env.DB.prepare(
    `SELECT id, household_id AS household_id, created_by AS created_by, revoked_at AS revoked_at
     FROM household_api_tokens WHERE token_hash = ? LIMIT 1`,
  )
    .bind(tokenHash)
    .first<{ id: string; household_id: string; created_by: string | null; revoked_at: number | string | null }>();
  if (!row) return null;
  if (row.revoked_at != null && row.revoked_at !== "") return { revoked: true };
  await env.DB.prepare(`UPDATE household_api_tokens SET last_used_at = ? WHERE id = ?`).bind(Date.now(), row.id).run();
  return { householdId: row.household_id, userId: row.created_by, tokenId: row.id };
}

async function revokeActive(env: Env, householdId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE household_api_tokens SET revoked_at = ? WHERE household_id = ? AND revoked_at IS NULL`,
  )
    .bind(Date.now(), householdId)
    .run();
}

async function tokenMeta(env: Env, householdId: string) {
  const row = await env.DB.prepare(
    `SELECT token_prefix AS token_prefix, created_at AS created_at, last_used_at AS last_used_at
     FROM household_api_tokens
     WHERE household_id = ? AND revoked_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(householdId)
    .first<{ token_prefix: string; created_at: number | string | null; last_used_at: number | string | null }>();
  if (!row?.token_prefix) return null;
  return { prefix: row.token_prefix, createdAt: isoFromMs(row.created_at), lastUsedAt: isoFromMs(row.last_used_at) };
}

async function statusOf(active: { id: string; name: string } | null, env: Env): Promise<Response> {
  if (!active) {
    return json({
      household: null,
      hasToken: false,
      prefix: null,
      createdAt: null,
      lastUsedAt: null,
      token: null,
    });
  }
  const meta = await tokenMeta(env, active.id);
  return json({
    household: { id: active.id, name: active.name },
    hasToken: Boolean(meta),
    prefix: meta?.prefix ?? null,
    createdAt: meta?.createdAt ?? null,
    lastUsedAt: meta?.lastUsedAt ?? null,
    token: null,
  });
}

function isoFromMs(value: unknown): string | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n).toISOString();
}
