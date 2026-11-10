import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatDateAr, periodFromDateString } from "./utils";

describe("periodFromDateString", () => {
  it("groups ISO and Argentine dates into the same YYYY-MM", () => {
    assert.equal(periodFromDateString("2026-08-31"), "2026-08");
    assert.equal(periodFromDateString("2026-08-31T19:56:54"), "2026-08");
    assert.equal(periodFromDateString("31/08/2026"), "2026-08");
    assert.equal(periodFromDateString("31-08-2026"), "2026-08");
    assert.equal(periodFromDateString("31.08.2026"), "2026-08");
    assert.equal(periodFromDateString("31-08-2026 19:56:54"), "2026-08");
    assert.equal(periodFromDateString("01-09-26"), "2026-09");
  });

  it("does not treat ISO as day-first (would become 31-08-2)", () => {
    assert.notEqual(periodFromDateString("2026-08-31"), "31-08-2");
    assert.notEqual(periodFromDateString("31-08-2026"), "31-08-2");
  });
});

describe("formatDateAr", () => {
  it("shows hyphen and dotted Argentine dates as DD/MM/YYYY", () => {
    assert.equal(formatDateAr("2026-08-31"), "31/08/2026");
    assert.equal(formatDateAr("31-08-2026"), "31/08/2026");
    assert.equal(formatDateAr("31.08.2026"), "31/08/2026");
    assert.equal(formatDateAr("31/08/2026"), "31/08/2026");
  });
});
