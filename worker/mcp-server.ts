import type { SessionUser } from "./auth";
import { requireUser } from "./auth";
import { lookupHouseholdBearer } from "./agent-token";
import { listHouseholds } from "./household";
import { handleCargas } from "./cargas";
import type { Env } from "./env";
import { currentPeriodAr, HOUSEHOLD_COOKIE } from "./http";
import {
  bearerToken,
  handleMcpJsonRpc,
  isMcpWellKnown,
  jsonSchemaObject,
  mcpOptions,
  mcpProtectedResource,
  mcpUnauthorized,
  type McpToolDef,
} from "./mcp-http";
import {
  buildSvcDeudaAhorroPatrimonio,
  buildSvcResumenMensual,
  buildSvcUltimosMovimientos,
  resolveServiceOwner,
  serviceTokenMatches,
} from "./svc";

export const TARASK_MCP_URL = "https://tarask.lulox.com.ar/api/mcp";

type Actor = { user: SessionUser; householdId: string };

function householdRequest(householdId: string): Request {
  return new Request("https://tarask.lulox.com.ar/", {
    headers: { cookie: `${HOUSEHOLD_COOKIE}=${householdId}` },
  });
}

function toolsFor(env: Env, actor: Actor): McpToolDef[] {
  const req = householdRequest(actor.householdId);
  return [
    {
      name: "resumen_mensual",
      description: "Resumen mensual de ingresos y gastos (ARS, USD, neto, top categorías). from/to en YYYY-MM; si se omiten, los últimos 6 meses.",
      inputSchema: jsonSchemaObject({ from: { type: "string", description: "YYYY-MM" }, to: { type: "string", description: "YYYY-MM" } }),
      annotations: { readOnlyHint: true, title: "Resumen mensual" },
      run: async (args) => await asRpc(await buildSvcResumenMensual(env, { from: args.from, to: args.to }, actor.user, req)),
    },
    {
      name: "deuda_ahorro_patrimonio",
      description: "Deuda, ahorros y patrimonio del hogar, con el cambio en el tiempo.",
      inputSchema: jsonSchemaObject({}),
      annotations: { readOnlyHint: true, title: "Deuda, ahorro y patrimonio" },
      run: async (args) => ({ ok: true, data: await buildSvcDeudaAhorroPatrimonio(env, args, actor.user, req) }),
    },
    {
      name: "ultimos_movimientos",
      description: "Últimos movimientos del hogar. limit 1-50, period YYYY-MM, query opcional.",
      inputSchema: jsonSchemaObject({
        limit: { type: "integer", minimum: 1, maximum: 50 },
        period: { type: "string", description: "YYYY-MM" },
        query: { type: "string", maxLength: 200 },
      }),
      annotations: { readOnlyHint: true, title: "Últimos movimientos" },
      run: async (args) => await asRpc(await buildSvcUltimosMovimientos(env, { limit: args.limit, period: args.period, q: typeof args.query === 'string' ? args.query : undefined }, actor.user, req)),
    },
    {
      name: "gastos_del_mes",
      description: "Totales reales del mes (period: YYYY-MM, latest, o el mes actual en Argentina).",
      inputSchema: jsonSchemaObject({ period: { type: "string" } }),
      annotations: { readOnlyHint: true, title: "Gastos del mes" },
      run: async (args) => {
        const period = await resolvePeriod(env, actor, args.period);
        return await asRpc(await buildSvcResumenMensual(env, { from: period, to: period }, actor.user, req));
      },
    },
    {
      name: "listar_cargas",
      description: "Historial de cargas: resúmenes importados, tickets y cargas manuales.",
      inputSchema: jsonSchemaObject({ limit: { type: "integer", minimum: 1, maximum: 100 } }),
      annotations: { readOnlyHint: true, title: "Listar cargas" },
      run: async (args) => {
        const res = await handleCargas(req, env, actor.user);
        const data = await res.json().catch(() => ({ error: "No se pudieron leer las cargas" }));
        if (!res.ok) return { ok: false, error: { code: "invalid", message: (data as { error?: string }).error ?? "error" } };
        const limit = typeof args.limit === "number" && args.limit >= 1 && args.limit <= 100 ? args.limit : 40;
        return { ok: true, data: trimCargas(data, limit) };
      },
    },
  ];
}

function trimCargas(data: unknown, limit: number): unknown {
  if (!data || typeof data !== "object") return data;
  const rec = data as Record<string, unknown>;
  const next: Record<string, unknown> = { ...rec };
  for (const key of ["statements", "receipts", "manuals", "items"]) {
    if (Array.isArray(next[key])) next[key] = (next[key] as unknown[]).slice(0, limit);
  }
  return next;
}

async function resolvePeriod(env: Env, actor: Actor, value: unknown): Promise<string> {
  if (typeof value === "string" && /^\d{4}-\d{2}$/.test(value)) return value;
  if (value === "latest") {
    const row = await env.DB.prepare(
      `SELECT MAX(date) AS d FROM transactions WHERE household_id = ?`,
    )
      .bind(actor.householdId)
      .first<{ d: string | null }>();
    if (row?.d && row.d.length >= 7) return row.d.slice(0, 7);
  }
  return currentPeriodAr();
}

async function asRpc(built: unknown): Promise<unknown> {
  if (built instanceof Response) {
    const body = (await built.json().catch(() => ({ error: "error" }))) as { error?: string };
    return { ok: false, error: { code: "invalid", message: body.error ?? "error" } };
  }
  return { ok: true, data: built };
}

async function memberUser(env: Env, householdId: string, preferredId: string | null): Promise<SessionUser | null> {
  if (preferredId) {
    const row = await env.DB.prepare(
      `SELECT id, email, name, image FROM users WHERE id = ? LIMIT 1`,
    )
      .bind(preferredId)
      .first<SessionUser>();
    if (row?.id && row.email) return { id: row.id, email: row.email, name: row.name ?? null, image: row.image ?? null };
  }
  const members = await listHouseholds(env, preferredId ?? "");
  // listHouseholds is by user; pick any member of this household instead:
  const row = await env.DB.prepare(
    `SELECT u.id AS id, u.email AS email, u.name AS name, u.image AS image
     FROM household_members m
     INNER JOIN users u ON u.id = m.user_id
     WHERE m.household_id = ?
     ORDER BY CASE WHEN m.role = 'owner' THEN 0 ELSE 1 END, m.joined_at
     LIMIT 1`,
  )
    .bind(householdId)
    .first<SessionUser>();
  if (!row?.id || !row.email) return null;
  return { id: row.id, email: row.email, name: row.name ?? null, image: row.image ?? null };
}

export async function resolveMcpActor(req: Request, env: Env): Promise<Actor | Response> {
  const token = bearerToken(req);
  if (token) {
    const household = await lookupHouseholdBearer(env, token);
    if (household && "revoked" in household) return mcpUnauthorized();
    if (household) {
      const user = await memberUser(env, household.householdId, household.userId);
      if (!user) return mcpUnauthorized();
      return { user, householdId: household.householdId };
    }
    const matchesSvc = await serviceTokenMatches(token, env.MCP_SERVICE_TOKEN);
    const matchesAgent = await serviceTokenMatches(token, env.AGENT_API_TOKEN);
    if (matchesSvc || matchesAgent) {
      const user = await resolveServiceOwner(env);
      if (!user) return mcpUnauthorized();
      const list = await listHouseholds(env, user.id);
      if (!list[0]) return mcpUnauthorized();
      return { user, householdId: list[0].id };
    }
    return mcpUnauthorized();
  }
  const user = await requireUser(req, env);
  if (user instanceof Response) return mcpUnauthorized();
  const list = await listHouseholds(env, user.id);
  const preferred = list.find((h) => req.headers.get("cookie")?.includes(h.id)) ?? list[0];
  if (!preferred) return mcpUnauthorized();
  return { user, householdId: preferred.id };
}

export async function handleTaraskMcp(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
  if (isMcpWellKnown(path)) {
    if (req.method === "OPTIONS") return mcpOptions();
    if (req.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
    return mcpProtectedResource(TARASK_MCP_URL, "Tarask MCP", "https://tarask.lulox.com.ar/mcp");
  }
  const isMcp = path === "/api/mcp" || (path === "/mcp" && req.method !== "GET");
  if (!isMcp) return null;
  if (req.method === "OPTIONS") return mcpOptions();
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const actor = await resolveMcpActor(req, env);
  if (actor instanceof Response) return actor;
  return handleMcpJsonRpc(req, { name: "tarask", version: "1.0.0", tools: toolsFor(env, actor) });
}
