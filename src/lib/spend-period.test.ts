import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_SPEND_PERIOD,
  isSpendPeriodId,
  parseSpendPeriod,
  spendPeriodMeta,
  windowForPeriod,
} from "./spend-period";

describe("spend period", () => {
  it("defaults to 30 days and accepts only the known options", () => {
    assert.equal(DEFAULT_SPEND_PERIOD, "30d");
    assert.equal(parseSpendPeriod(null), "30d");
    assert.equal(parseSpendPeriod(""), "30d");
    assert.equal(parseSpendPeriod("90"), "30d");
    assert.equal(parseSpendPeriod("all"), "all");
    assert.equal(parseSpendPeriod("6m"), "6m");
    assert.equal(isSpendPeriodId("1y"), true);
    assert.equal(isSpendPeriodId("2y"), false);
  });

  it("labels the title, chips and empty state for the same period", () => {
    assert.equal(spendPeriodMeta("30d").title, "Últimos 30 días");
    assert.equal(spendPeriodMeta("90d").label, "90 días");
    assert.equal(spendPeriodMeta("6m").empty, "Todavía no hay gastos en 6 meses.");
    assert.equal(spendPeriodMeta("1y").title, "Último año");
    assert.equal(spendPeriodMeta("all").title, "Todo el historial");
  });

  it("maps each option to a date window", () => {
    assert.deepEqual(windowForPeriod("30d"), { kind: "days", days: 30 });
    assert.deepEqual(windowForPeriod("90d"), { kind: "days", days: 90 });
    assert.deepEqual(windowForPeriod("6m"), { kind: "months", months: 6 });
    assert.deepEqual(windowForPeriod("1y"), { kind: "years", years: 1 });
    assert.deepEqual(windowForPeriod("all"), { kind: "all" });
  });
});
