import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { annotateIncomeRows, sumIncomeArs, type IncomeRow } from "./income";
import { pairIncomeInternalIds, type TransferClassRow } from "./transfer-class";

const CUIT = "1".repeat(11);
const PERIOD = "2026-08";

function income(partial: Partial<IncomeRow> & Pick<IncomeRow, "label">): IncomeRow {
  return {
    id: partial.id ?? "inc-1",
    household_id: "h1",
    date: "2026-08-10",
    kind: "variable",
    frequency: null,
    amount_ars: "100",
    amount_usd: null,
    ...partial,
  };
}

function outgoing(partial: Partial<TransferClassRow> & Pick<TransferClassRow, "id">): TransferClassRow {
  return {
    householdId: "h1",
    date: "2026-08-10",
    bank: "BBVA",
    description: "TRANSFERENCIA",
    amountArs: "100",
    amountUsd: null,
    isPayment: 0,
    isCredit: 0,
    ...partial,
  };
}

const homes = new Set(["h1", "h2"]);

describe("income data rule", () => {
  it("does not count own-account transfers as income (dashboard matches Ingresos)", () => {
    const rows = [
      income({ id: "int", label: "Transferencia interna" }),
      income({ id: "entre", label: "TRANSFERENCIA ENTRE CUENTAS" }),
      income({ id: "bbnk", label: "TRANSFERENCIA BBNK 306333.80" }),
      income({ id: "cred", label: "TRANSF CREDITO Nro:215857" }),
      income({ id: "cliente", label: "BBVA CA$ TRANSF. CLIENTE CTA. CAP093 380138 5 Nro:00010008" }),
      income({ id: "me", label: "COMPRA ME USD" }),
      income({ id: "pay", label: "Mauro" }),
    ];
    assert.equal(sumIncomeArs(rows, PERIOD, 0), 100);
    const notes = annotateIncomeRows(rows);
    const byId = new Map(notes.map((row) => [row.id, row]));
    assert.equal(byId.get("int")?.internal, true);
    assert.equal(byId.get("entre")?.internal, true);
    assert.equal(byId.get("bbnk")?.internal, true);
    assert.equal(byId.get("cred")?.internal, true);
    assert.equal(byId.get("cliente")?.internal, true);
    assert.equal(byId.get("me")?.internal, true);
    assert.equal(byId.get("pay")?.internal, false);
    assert.equal(byId.get("int")?.revisar, false);
    assert.equal(byId.get("pay")?.revisar, false);
  });

  it("keeps the phrase list and does not skip a generic transfer", () => {
    const rows = [
      income({ id: "tuya", label: "De una cuenta tuya" }),
      income({ id: "cambio", label: "Cambio de moneda" }),
      income({ id: "debin", label: "DEBIN servicio" }),
      income({ id: "cr", label: "CR TBE INM COE" }),
      income({ id: "bare", label: "TRANSFERENCIA" }),
      income({ id: "imm", label: "TRANSFERENCIA INMEDIATA" }),
      income({ id: "pay", label: "Mauro" }),
    ];
    assert.equal(sumIncomeArs(rows, PERIOD, 0), 300);
    const notes = annotateIncomeRows(rows);
    const byId = new Map(notes.map((row) => [row.id, row]));
    assert.equal(byId.get("tuya")?.internal, true);
    assert.equal(byId.get("cambio")?.internal, true);
    assert.equal(byId.get("debin")?.internal, true);
    assert.equal(byId.get("cr")?.internal, true);
    assert.equal(byId.get("bare")?.internal, false);
    assert.equal(byId.get("bare")?.revisar, true);
    assert.equal(byId.get("imm")?.revisar, true);
    assert.equal(byId.get("pay")?.revisar, false);
    assert.equal(byId.get("pay")?.internal, false);
  });

  it("skips an own-account id and an own-account marker", () => {
    const own = new Set([CUIT]);
    const rows = [
      income({ id: "id", label: `TRANSFERENCIA 11-${"1".repeat(8)}-1` }),
      income({ id: "mark", label: "OWN ACCOUNT top up" }),
      income({ id: "cuit", label: `OWN CUIT ${CUIT}` }),
    ];
    assert.equal(sumIncomeArs(rows, PERIOD, 0, { ownIds: own }), 0);
    const notes = annotateIncomeRows(rows, { ownIds: own });
    assert.equal(notes.every((row) => row.internal && !row.revisar), true);
  });

  it("skips a variable row when an outgoing twin is within 1 day in another account", () => {
    const row = income({ id: "inc", label: "TRANSFERENCIA", amount_ars: "100" });
    const ctx = {
      ownIds: new Set<string>(),
      userHouseholdIds: homes,
      outgoing: [outgoing({ id: "tx", date: "2026-08-11", bank: "GALICIA", householdId: "h1" })],
    };
    assert.equal(sumIncomeArs([row], PERIOD, 0, ctx), 0);
    const [noted] = annotateIncomeRows([row], ctx);
    assert.equal(noted?.internal, true);
    assert.equal(noted?.revisar, false);

    const otherHome = {
      ...ctx,
      outgoing: [outgoing({ id: "tx2", householdId: "h2", bank: "BBVA" })],
    };
    assert.equal(sumIncomeArs([row], PERIOD, 0, otherHome), 0);
  });

  it("does not skip a twin from another user, two days apart, or the wrong sign", () => {
    const row = income({ id: "inc", label: "TRANSFERENCIA INMEDIATA" });
    const foreign = {
      userHouseholdIds: new Set(["h1"]),
      outgoing: [
        outgoing({ id: "fx", householdId: "h-foreign", bank: "GALICIA", amountArs: "100" }),
      ],
    };
    assert.equal(sumIncomeArs([row], PERIOD, 0, foreign), 100);
    assert.equal(annotateIncomeRows([row], foreign)[0]?.revisar, true);

    const far = {
      userHouseholdIds: homes,
      outgoing: [outgoing({ id: "far", date: "2026-08-12", bank: "GALICIA" })],
    };
    assert.equal(sumIncomeArs([row], PERIOD, 0, far), 100);

    const flipped = {
      userHouseholdIds: homes,
      outgoing: [outgoing({ id: "neg", bank: "GALICIA", amountArs: "-100", isCredit: 0 })],
    };
    assert.equal(sumIncomeArs([row], PERIOD, 0, flipped), 100);
    assert.equal(annotateIncomeRows([row], flipped)[0]?.revisar, true);
  });

  it("counts a named transfer and does not flag it revisar", () => {
    const row = income({ id: "named", label: "PERSONA DEMO | TRANSFERENCIA" });
    assert.equal(sumIncomeArs([row], PERIOD, 0), 100);
    const [noted] = annotateIncomeRows([row]);
    assert.equal(noted?.internal, false);
    assert.equal(noted?.revisar, false);
  });

  it("lets one outgoing transaction cancel only the closest income", () => {
    const rows = [
      income({ id: "far", date: "2026-08-01", label: "TRANSFERENCIA" }),
      income({ id: "near", date: "2026-08-02", label: "TRANSFERENCIA" }),
    ];
    const ctx = {
      userHouseholdIds: homes,
      outgoing: [outgoing({ id: "tx", date: "2026-08-02", bank: "GALICIA" })],
    };
    assert.equal(sumIncomeArs(rows, PERIOD, 0, ctx), 100);
    const notes = annotateIncomeRows(rows, ctx);
    const near = notes.find((row) => row.id === "near");
    const far = notes.find((row) => row.id === "far");
    assert.equal(near?.internal, true);
    assert.equal(near?.revisar, false);
    assert.equal(far?.internal, false);
    assert.equal(far?.revisar, true);
  });

  it("still counts a recurring row whose label is a generic transfer", () => {
    const row = income({
      id: "sal",
      kind: "recurring",
      frequency: "mensual",
      label: "TRANSFERENCIA",
      amount_ars: "80",
    });
    assert.equal(sumIncomeArs([row], PERIOD, 0), 80);
  });

  it("keeps Sueldo next to Alquiler of the same amount", () => {
    const row = income({ id: "sueldo", label: "Sueldo", amount_ars: "500000" });
    const ctx = {
      userHouseholdIds: homes,
      outgoing: [
        outgoing({ id: "rent", description: "Alquiler", amountArs: "500000", bank: "BBVA" }),
      ],
    };
    assert.equal(sumIncomeArs([row], PERIOD, 0, ctx), 500000);
    assert.equal(annotateIncomeRows([row], ctx)[0]?.internal, false);
  });

  it("keeps Sueldo next to SU PAGO EN PESOS the following day", () => {
    const row = income({ id: "sueldo", label: "Sueldo", date: "2026-08-31", amount_ars: "500000" });
    const ctx = {
      userHouseholdIds: homes,
      outgoing: [
        outgoing({
          id: "pago",
          description: "SU PAGO EN PESOS",
          amountArs: "500000",
          date: "2026-09-01",
          isPayment: 1,
          bank: "BBVA",
        }),
      ],
    };
    assert.equal(sumIncomeArs([row], PERIOD, 0, ctx), 500000);
    assert.equal(annotateIncomeRows([row], ctx)[0]?.internal, false);
  });

  it("drops TRANSFERENCIA when TRANSFERENCIA INMEDIATA is another account within 1 day", () => {
    const row = income({ id: "inc", label: "TRANSFERENCIA", amount_ars: "100" });
    const ctx = {
      userHouseholdIds: homes,
      outgoing: [
        outgoing({
          id: "out",
          description: "TRANSFERENCIA INMEDIATA",
          amountArs: "100",
          date: "2026-08-11",
          bank: "GALICIA",
        }),
      ],
    };
    assert.equal(sumIncomeArs([row], PERIOD, 0, ctx), 0);
    const [noted] = annotateIncomeRows([row], ctx);
    assert.equal(noted?.internal, true);
    assert.equal(noted?.revisar, false);
  });

  it("lets one outgoing transfer cancel only one income, and rejects foreign, 2-day, and 2-cent gaps", () => {
    const rows = [
      income({ id: "n10", label: "TRANSFERENCIA", amount_ars: "100" }),
      income({ id: "n2", label: "TRANSFERENCIA INMEDIATA", amount_ars: "100" }),
    ];
    const ctx = {
      userHouseholdIds: homes,
      outgoing: [
        outgoing({ id: "out", description: "TRANSFERENCIA", amountArs: "100", bank: "GALICIA" }),
      ],
    };
    const notes = annotateIncomeRows(rows, ctx);
    const dropped = notes.filter((row) => row.internal);
    assert.equal(dropped.length, 1);
    assert.equal(sumIncomeArs(rows, PERIOD, 0, ctx), 100);

    const foreign = income({ id: "inc", label: "TRANSFERENCIA", amount_ars: "100" });
    assert.equal(
      sumIncomeArs([foreign], PERIOD, 0, {
        userHouseholdIds: new Set(["h1"]),
        outgoing: [
          outgoing({
            id: "fx",
            householdId: "h-foreign",
            bank: "GALICIA",
            description: "TRANSFERENCIA INMEDIATA",
            amountArs: "100",
          }),
        ],
      }),
      100,
    );
    assert.equal(
      sumIncomeArs([foreign], PERIOD, 0, {
        userHouseholdIds: homes,
        outgoing: [
          outgoing({
            id: "far",
            date: "2026-08-12",
            bank: "GALICIA",
            description: "TRANSFERENCIA INMEDIATA",
            amountArs: "100",
          }),
        ],
      }),
      100,
    );
    assert.equal(
      sumIncomeArs([foreign], PERIOD, 0, {
        userHouseholdIds: homes,
        outgoing: [
          outgoing({
            id: "cents",
            bank: "GALICIA",
            description: "TRANSFERENCIA INMEDIATA",
            amountArs: "100.02",
          }),
        ],
      }),
      100,
    );
  });

  it("does not treat an empty bank as another account", () => {
    const row = income({ id: "inc", label: "TRANSFERENCIA", amount_ars: "100" });
    assert.equal(
      sumIncomeArs([row], PERIOD, 0, {
        userHouseholdIds: homes,
        outgoing: [outgoing({ id: "blank", bank: "", description: "TRANSFERENCIA INMEDIATA" })],
      }),
      100,
    );
    assert.equal(
      sumIncomeArs([row], PERIOD, 0, {
        userHouseholdIds: homes,
        outgoing: [outgoing({ id: "none", bank: null, description: "TRANSFERENCIA" })],
      }),
      100,
    );
    const explicitEmpty = pairIncomeInternalIds(
      [
        {
          id: "inc",
          householdId: "h1",
          date: "2026-08-10",
          amountArs: "100",
          description: "TRANSFERENCIA",
          bank: "",
        },
      ],
      [outgoing({ id: "bbva", bank: "BBVA", description: "TRANSFERENCIA INMEDIATA" })],
      homes,
    );
    assert.equal(explicitEmpty.has("inc"), false);
    const sameBank = pairIncomeInternalIds(
      [
        {
          id: "inc",
          householdId: "h1",
          date: "2026-08-10",
          amountArs: "100",
          description: "TRANSFERENCIA",
          bank: "BBVA",
        },
      ],
      [outgoing({ id: "same", bank: "BBVA", description: "TRANSFERENCIA INMEDIATA" })],
      homes,
    );
    assert.equal(sameBank.has("inc"), false);
    const otherBank = pairIncomeInternalIds(
      [
        {
          id: "inc",
          householdId: "h1",
          date: "2026-08-10",
          amountArs: "100",
          description: "TRANSFERENCIA",
          bank: "BBVA",
        },
      ],
      [outgoing({ id: "other", bank: "GALICIA", description: "TRANSFERENCIA INMEDIATA" })],
      homes,
    );
    assert.equal(otherBank.has("inc"), true);
    assert.equal(
      sumIncomeArs([row], PERIOD, 0, {
        userHouseholdIds: homes,
        outgoing: [
          outgoing({
            id: "cross",
            householdId: "h2",
            bank: "",
            description: "TRANSFERENCIA INMEDIATA",
          }),
        ],
      }),
      0,
    );
  });
});
