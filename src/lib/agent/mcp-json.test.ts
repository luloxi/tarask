import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mcpErrorResult, mcpJsonResult } from "./mcp-json";
import { MCP_TOOLS, MCP_PUBLIC_URL } from "./mcp-tools-meta";

describe("mcp helpers", () => {
  it("serializes tool payloads as JSON text content", () => {
    const r = mcpJsonResult({ totalArs: 1234.5, period: "2026-08" });
    assert.equal(r.content.length, 1);
    assert.equal(r.content[0].type, "text");
    const parsed = JSON.parse(r.content[0].text);
    assert.equal(parsed.totalArs, 1234.5);
    assert.equal(parsed.period, "2026-08");
  });

  it("maps service errors without inventing finance figures", () => {
    const r = mcpErrorResult({
      status: 400,
      error: "Creá o uníte a un hogar primero",
      code: "no_household",
    });
    assert.equal(r.isError, true);
    const parsed = JSON.parse(r.content[0].text);
    assert.equal(parsed.code, "no_household");
    assert.equal(parsed.status, 400);
    assert.ok(!("totalArs" in parsed));
  });

  it("exposes the public MCP catalogue", () => {
    assert.equal(MCP_PUBLIC_URL, "https://tarask.lulox.com.ar/api/mcp");
    const names = MCP_TOOLS.map((t) => t.name);
    assert.deepEqual(names, [
      "resumen_mensual",
      "deuda_ahorro_patrimonio",
      "ultimos_movimientos",
      "gastos_del_mes",
      "listar_cargas",
    ]);
  });
});
