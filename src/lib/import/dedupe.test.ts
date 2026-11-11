import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  foldMerchant,
  isNumericMerchant,
  logicalMerchantKey,
  merchantsMatch,
} from "./dedupe";

describe("foldMerchant", () => {
  it("drops COMPRA / PAGO noise and punctuation", () => {
    assert.equal(foldMerchant("COMPRA MERCADOLIBRE*MLA"), "MERCADOLIBRE MLA");
    assert.equal(foldMerchant("Mercado Libre"), "MERCADO LIBRE");
    assert.equal(foldMerchant("DIA TIENDA 536"), "DIA TIENDA");
    assert.equal(foldMerchant("COMPRA DIA"), "DIA");
  });
});

describe("logicalMerchantKey", () => {
  it("pairs email, statement and Fiwind of the same shop", () => {
    const email = logicalMerchantKey({
      date: "2026-08-18",
      descriptionNormalized: "COMPRA DIA TIENDA",
      amountArs: 1200,
      amountUsd: null,
    });
    const statement = logicalMerchantKey({
      date: "2026-08-18",
      descriptionNormalized: "DIA TIENDA 536",
      amountArs: 1200,
      amountUsd: null,
    });
    assert.equal(email, statement);
  });

  it("leaves a numeric Fiwind row with an empty merchant", () => {
    assert.equal(isNumericMerchant(" 18402 "), true);
    const numeric = logicalMerchantKey({
      date: "2026-08-18",
      descriptionNormalized: "18402",
      amountArs: 18402,
      amountUsd: null,
    });
    assert.equal(numeric, "2026-08-18|ARS:18402.00|");
  });

  it("does not pair different shops on the same amount", () => {
    const cafe = logicalMerchantKey({
      date: "2026-08-18",
      descriptionNormalized: "CAFE MARTINEZ",
      amountArs: 5000,
      amountUsd: null,
    });
    const superDia = logicalMerchantKey({
      date: "2026-08-18",
      descriptionNormalized: "DIA TIENDA",
      amountArs: 5000,
      amountUsd: null,
    });
    assert.notEqual(cafe, superDia);
  });
});

describe("merchantsMatch", () => {
  it("treats a prefix as the same shop", () => {
    assert.equal(merchantsMatch("MERCADOLIBRE MLA", "MERCADOLIBRE"), true);
    assert.equal(merchantsMatch("CAFE", "KIOSCO"), false);
  });
});
