import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseStatementWorkbook } from "./parse";

describe("statement date parse", () => {
  it("reads DD-MM-YYYY and DD.MM.YYYY into August 2026, not a junk period", () => {
    const csv = [
      "Fecha,Descripción,Monto,Moneda",
      "31-08-2026,YPF,8900,ARS",
      "01.09.2026,DIA TIENDA,1200,ARS",
      "2026-08-15,CAFE,500,ARS",
    ].join("\n");
    const parsed = parseStatementWorkbook(Buffer.from(csv, "utf8"), "extracto.csv");
    assert.equal(parsed.movements.length, 3);
    const ypf = parsed.movements.find((m) => m.descriptionNormalized.includes("YPF"));
    const dia = parsed.movements.find((m) => /DIA/i.test(m.descriptionNormalized));
    const cafe = parsed.movements.find((m) => /CAFE/i.test(m.descriptionNormalized));
    assert.equal(ypf?.date, "2026-08-31");
    assert.equal(dia?.date, "2026-09-01");
    assert.equal(cafe?.date, "2026-08-15");
  });
});
