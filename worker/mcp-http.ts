/**
 * Minimal Streamable HTTP MCP (JSON-RPC 2.0). No SDK: safe to run in a Worker
 * in front of OpenNext, and easy to test under node:test.
 */
export const MCP_PROTOCOL_VERSION = "2025-03-26";

export type McpToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    openWorldHint?: boolean;
    idempotentHint?: boolean;
  };
  run: (args: Record<string, unknown>) => Promise<unknown>;
};

export type McpServerInfo = { name: string; version?: string; tools: McpToolDef[] };

const ALLOW_HEADERS = "Authorization, Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id";

export function mcpCors(init?: HeadersInit): Headers {
  const headers = new Headers(init);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", ALLOW_HEADERS);
  headers.set("Access-Control-Max-Age", "86400");
  headers.set("cache-control", "no-store");
  return headers;
}

export function mcpOptions(): Response {
  return new Response(null, { status: 204, headers: mcpCors() });
}

export function mcpUnauthorized(message = "Unauthorized"): Response {
  const headers = mcpCors({
    "content-type": "application/json; charset=utf-8",
    "WWW-Authenticate": 'Bearer realm="mcp", error="invalid_token"',
  });
  return new Response(JSON.stringify({ error: message }), { status: 401, headers });
}

export function mcpForbidden(message = "Forbidden"): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 403,
    headers: mcpCors({ "content-type": "application/json; charset=utf-8" }),
  });
}

export function mcpProtectedResource(resource: string, name: string, documentation?: string): Response {
  const body = {
    resource,
    resource_name: name,
    bearer_methods_supported: ["header"],
    resource_documentation: documentation ?? resource,
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: mcpCors({ "content-type": "application/json; charset=utf-8" }),
  });
}

export function isMcpWellKnown(pathname: string): boolean {
  return (
    pathname === "/.well-known/oauth-protected-resource" ||
    pathname === "/.well-known/oauth-protected-resource/mcp"
  );
}

export async function handleMcpJsonRpc(request: Request, server: McpServerInfo): Promise<Response> {
  if (request.method === "GET") {
    return new Response(JSON.stringify({ error: "Use POST for MCP" }), {
      status: 405,
      headers: mcpCors({ "content-type": "application/json; charset=utf-8", allow: "POST, OPTIONS" }),
    });
  }
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return mcpRpcReply(request, rpcError(null, -32700, "Parse error"));
  }
  const message = await dispatch(payload, server);
  if (message === null) {
    return new Response(null, { status: 202, headers: mcpCors() });
  }
  return mcpRpcReply(request, message);
}

function wantsSse(request: Request): boolean {
  return (request.headers.get("accept") ?? "").includes("text/event-stream");
}

function mcpRpcReply(request: Request, message: unknown): Response {
  const json = JSON.stringify(message);
  if (wantsSse(request)) {
    const headers = mcpCors({
      "content-type": "text/event-stream; charset=utf-8",
      "connection": "keep-alive",
    });
    return new Response(`event: message\ndata: ${json}\n\n`, { status: 200, headers });
  }
  return new Response(json, {
    status: 200,
    headers: mcpCors({ "content-type": "application/json; charset=utf-8" }),
  });
}

type RpcId = string | number | null;

function rpcResult(id: RpcId, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: RpcId, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } };
}

async function dispatch(payload: unknown, server: McpServerInfo): Promise<unknown | null> {
  if (Array.isArray(payload)) {
    const out: unknown[] = [];
    for (const item of payload) {
      const message = await dispatchOne(item, server);
      if (message !== null) out.push(message);
    }
    return out;
  }
  return dispatchOne(payload, server);
}

async function dispatchOne(payload: unknown, server: McpServerInfo): Promise<unknown | null> {
  if (!payload || typeof payload !== "object") return rpcError(null, -32600, "Invalid request");
  const rec = payload as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id: RpcId = rec.id === undefined ? null : (rec.id as RpcId);
  const isNotification = rec.id === undefined;
  if (rec.jsonrpc !== "2.0" || typeof rec.method !== "string") return rpcError(id, -32600, "Invalid request");

  if (rec.method === "notifications/initialized" || rec.method.startsWith("notifications/")) {
    return isNotification ? null : rpcResult(id, {});
  }
  if (rec.method === "ping") return rpcResult(id, {});
  if (rec.method === "initialize") {
    const requested =
      rec.params && typeof rec.params === "object" && !Array.isArray(rec.params)
        ? (rec.params as { protocolVersion?: unknown }).protocolVersion
        : undefined;
    const protocolVersion = typeof requested === "string" && requested.startsWith("2024") ? requested : MCP_PROTOCOL_VERSION;
    return rpcResult(id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: server.name, version: server.version ?? "1.0.0" },
      instructions: `${server.name}: tools are scoped to the authenticated user. Reads do not change data.`,
    });
  }
  if (rec.method === "tools/list") {
    return rpcResult(id, {
      tools: server.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      })),
    });
  }
  if (rec.method === "resources/list") return rpcResult(id, { resources: [] });
  if (rec.method === "prompts/list") return rpcResult(id, { prompts: [] });
  if (rec.method === "tools/call") {
    const params = rec.params && typeof rec.params === "object" && !Array.isArray(rec.params) ? (rec.params as { name?: unknown; arguments?: unknown }) : {};
    const name = typeof params.name === "string" ? params.name : "";
    const tool = server.tools.find((item) => item.name === name);
    if (!tool) return rpcError(id, -32601, `Unknown tool: ${name}`);
    const args =
      params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
        ? (params.arguments as Record<string, unknown>)
        : {};
    try {
      const data = await tool.run(args);
      const failed = isRpcFailure(data);
      const text = JSON.stringify(data);
      return rpcResult(id, {
        content: [{ type: "text", text }],
        isError: failed,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "internal";
      return rpcResult(id, {
        content: [{ type: "text", text: JSON.stringify({ ok: false, error: { code: "internal", message: message.slice(0, 300) } }) }],
        isError: true,
      });
    }
  }
  return rpcError(id, -32601, `Method not found: ${rec.method}`);
}

function isRpcFailure(data: unknown): boolean {
  return Boolean(data && typeof data === "object" && "ok" in data && (data as { ok?: unknown }).ok === false);
}

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

export const MCP_TOKEN_PREFIX = "mcp1.";
export const MCP_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export async function mintMcpToken(opts: {
  email: string;
  secret: string;
  iss: string;
  ttlMs?: number;
  now?: number;
}): Promise<string> {
  const now = opts.now ?? Date.now();
  const payload = b64url(
    enc.encode(
      JSON.stringify({
        v: 1,
        em: opts.email.trim().toLowerCase(),
        iss: opts.iss,
        iat: now,
        exp: now + (opts.ttlMs ?? MCP_TOKEN_TTL_MS),
      }),
    ),
  );
  return `${MCP_TOKEN_PREFIX}${payload}.${b64url(await hmac(opts.secret, payload))}`;
}

export async function verifyMcpToken(
  token: string,
  secret: string,
  iss: string,
  now = Date.now(),
): Promise<{ email: string } | null> {
  if (!secret || !token.startsWith(MCP_TOKEN_PREFIX)) return null;
  const raw = token.slice(MCP_TOKEN_PREFIX.length);
  const dot = raw.indexOf(".");
  if (dot <= 0) return null;
  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (!payload || !sig) return null;
  try {
    if (!sameBytes(await hmac(secret, payload), fromB64url(sig))) return null;
    const data = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as {
      v?: unknown;
      em?: unknown;
      iss?: unknown;
      iat?: unknown;
      exp?: unknown;
    };
    if (data.v !== 1 || data.iss !== iss || typeof data.em !== "string" || !data.em.includes("@")) return null;
    if (typeof data.exp !== "number" || data.exp <= now) return null;
    if (typeof data.iat === "number" && data.iat > now + 60_000) return null;
    return { email: data.em.trim().toLowerCase() };
  } catch {
    return null;
  }
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)/i.exec(header.trim());
  const token = match?.[1] ?? "";
  return token || null;
}

export function jsonSchemaObject(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: "object", properties, additionalProperties: false, ...(required.length ? { required } : {}) };
}
