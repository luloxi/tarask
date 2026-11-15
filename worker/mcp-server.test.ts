import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mintHouseholdToken } from "./agent-token";
import type { Env } from "./env";
import { sha256Hex } from "./http";
import { handleTaraskMcp } from "./mcp-server";
import { envFor, openDb, owner } from "./test-helpers";

async function post(env: Env, path: string, body: unknown, headers: Record<string, string> = {}) {
  return handleTaraskMcp(
    new Request("https://tarask.lulox.com.ar" + path, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    env,
  );
}

describe("Tarask HTTP MCP", () => {
  it("returns 401 without a token and publishes well-known metadata", async () => {
    const { env } = envFor(openDb());
    const unauthorized = await post(env, "/api/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.equal(unauthorized?.status, 401);
    const well = await handleTaraskMcp(
      new Request("https://tarask.lulox.com.ar/.well-known/oauth-protected-resource"),
      env,
    );
    assert.equal(well?.status, 200);
    const body = (await well!.json()) as { resource: string };
    assert.equal(body.resource, "https://tarask.lulox.com.ar/api/mcp");
  });

  it("lists tools and runs a read call scoped to the household token", async () => {
    const db = openDb();
    const { env } = envFor(db);
    const minted = await mintHouseholdToken(env, "hp", owner.id);
    const listed = await post(
      env,
      "/api/mcp",
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { authorization: `Bearer ${minted.token}` },
    );
    assert.equal(listed?.status, 200);
    const json = (await listed!.json()) as { result: { tools: { name: string }[] } };
    const names = json.result.tools.map((t) => t.name);
    assert.ok(names.includes("resumen_mensual"));
    assert.ok(names.includes("listar_cargas"));
    assert.equal(names.includes("importar_resumen"), false);

    const call = await post(
      env,
      "/api/mcp",
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "listar_cargas", arguments: { limit: 5 } } },
      { authorization: `Bearer ${minted.token}` },
    );
    const body = (await call!.json()) as { result: { isError?: boolean; content: { text: string }[] } };
    const payload = JSON.parse(body.result.content[0]!.text) as { ok: boolean };
    assert.equal(payload.ok, true);
    assert.equal(body.result.isError, false);

    const other = "lc_h_" + "ff".repeat(32);
    // confirm hash of a random unused token does not authenticate
    const hash = await sha256Hex(other);
    assert.notEqual(hash, minted.token);
    const miss = await post(
      env,
      "/api/mcp",
      { jsonrpc: "2.0", id: 3, method: "tools/list" },
      { authorization: `Bearer ${other}` },
    );
    assert.equal(miss?.status, 401);
  });
});
