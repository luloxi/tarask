import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bumpOccurrenceFingerprint,
  expenseAmountText,
  isCalendarDate,
  manualFingerprintMaterial,
  manualOccurrenceMaterial,
  nextOccurrenceFingerprint,
  occurrenceFingerprint,
  parseExpenseAmount,
} from "./manual-expense";

describe("manual expense validation", () => {
  it("accepts a real calendar date and rejects month overflow", () => {
    assert.equal(isCalendarDate("2026-02-28"), true);
    assert.equal(isCalendarDate("2024-02-29"), true);
    assert.equal(isCalendarDate("2026-02-29"), false);
    assert.equal(isCalendarDate("2026-13-01"), false);
    assert.equal(isCalendarDate("2026-09-07T00:00:00"), false);
  });

  it("rejects non-finite and blank-looking junk amounts", () => {
    assert.deepEqual(parseExpenseAmount(""), { ok: true, amount: null });
    assert.deepEqual(parseExpenseAmount(null), { ok: true, amount: null });
    assert.deepEqual(parseExpenseAmount(12.5), { ok: true, amount: 12.5 });
    assert.deepEqual(parseExpenseAmount(-3), { ok: true, amount: 3 });
    assert.deepEqual(parseExpenseAmount("10.50"), { ok: true, amount: 10.5 });
    assert.equal(parseExpenseAmount("Infinity").ok, false);
    assert.equal(parseExpenseAmount("1e6").ok, false);
    assert.equal(parseExpenseAmount(Number.NaN).ok, false);
  });

  it("reads Argentine decimals and thousands (form placeholder 0,00)", () => {
    assert.deepEqual(parseExpenseAmount("10,50"), { ok: true, amount: 10.5 });
    assert.deepEqual(parseExpenseAmount("1.234,56"), { ok: true, amount: 1234.56 });
    assert.deepEqual(parseExpenseAmount("$ 30.277,00"), { ok: true, amount: 30277 });
    assert.deepEqual(parseExpenseAmount("(10,50)"), { ok: true, amount: 10.5 });
    assert.deepEqual(parseExpenseAmount("-1.234,56"), { ok: true, amount: 1234.56 });
    assert.deepEqual(parseExpenseAmount("1,234.56"), { ok: true, amount: 1234.56 });
  });

  it("stores cents as text and fingerprints without a clock", () => {
    assert.equal(expenseAmountText(10), "10.00");
    assert.equal(expenseAmountText(10.5), "10.50");
    assert.equal(expenseAmountText(null), null);
    const a = manualFingerprintMaterial({
      householdId: "hh",
      date: "2026-09-01",
      description: "  Café   doble ",
      amountArs: "10.00",
      amountUsd: null,
    });
    const b = manualFingerprintMaterial({
      householdId: "hh",
      date: "2026-09-01",
      description: "Café doble",
      amountArs: "10.00",
      amountUsd: null,
    });
    assert.equal(a, b);
    assert.equal(a.includes("Date"), false);
  });

  it("suffixes later copies and leaves the first material unchanged", () => {
    const material = manualFingerprintMaterial({
      householdId: "hh",
      date: "2026-09-01",
      description: "Café",
      amountArs: "10.00",
      amountUsd: null,
    });
    assert.equal(manualOccurrenceMaterial(material, 1), material);
    assert.equal(manualOccurrenceMaterial(material, 2), `${material}#2`);
    assert.equal(manualOccurrenceMaterial(material, 3), `${material}#3`);
    assert.equal(occurrenceFingerprint("abc123", 1), "abc123");
    assert.equal(occurrenceFingerprint("abc123", 2), "abc123#2");

    const first = nextOccurrenceFingerprint("abc123", []);
    assert.equal(first.fingerprint, "abc123");
    assert.equal(first.possibleDuplicate, false);

    const second = nextOccurrenceFingerprint("abc123", ["abc123"]);
    assert.equal(second.fingerprint, "abc123#2");
    assert.equal(second.occurrence, 2);
    assert.equal(second.possibleDuplicate, true);

    const third = nextOccurrenceFingerprint("abc123", ["abc123", "abc123#2"]);
    assert.equal(third.fingerprint, "abc123#3");

    const gap = nextOccurrenceFingerprint("abc123", ["abc123", "abc123#2", "abc123#4"]);
    assert.equal(gap.fingerprint, "abc123#5");
    assert.equal(bumpOccurrenceFingerprint("abc123", "abc123"), "abc123#2");
    assert.equal(bumpOccurrenceFingerprint("abc123", "abc123#2"), "abc123#3");
  });
});
