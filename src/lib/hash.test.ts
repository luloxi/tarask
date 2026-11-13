import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { fingerprint32, sha256Hex } from "./hash";

describe("sha256Hex", () => {
  it("matches node:crypto for short, block-edge, long and non-ascii input", () => {
    const samples = [
      "",
      "abc",
      "2026-08-31|Pago a DIA|1234.50|",
      "ñandú café — ✓ Ñ",
      "a".repeat(55),
      "a".repeat(56),
      "a".repeat(63),
      "a".repeat(64),
      "a".repeat(65),
      "x".repeat(1000),
    ];
    for (const s of samples) {
      assert.equal(sha256Hex(s), createHash("sha256").update(s).digest("hex"), JSON.stringify(s.slice(0, 20)));
    }
  });

  it("fingerprint32 keeps the 32-char prefix used by already imported rows", () => {
    const base = "2026-08-31|PAGO A DIA|1234.50|";
    assert.equal(fingerprint32(base), createHash("sha256").update(base).digest("hex").slice(0, 32));
  });
});
