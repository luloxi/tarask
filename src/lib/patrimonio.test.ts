import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  TRUSTED_DEBT_MONTHS,
  applySettledDebtHistory,
  assetsEquivalent,
  filterPatrimonioSeries,
  historyNote,
  historyStartsAt,
  netWorthArs,
  netWorthDeltas,
  pricedNetWorth,
  readDebt,
  sparklineNetWorths,
  usableFxRate,
  type PatrimonioPoint,
} from "./patrimonio";

function point(date: string, assets: number, debt: number, source: PatrimonioPoint["source"] = "snapshot"): PatrimonioPoint {
  return {
    date,
    assetsArs: assets,
    assetsUsd: 0,
    debtArs: debt,
    debtUsd: 0,
    netWorthArs: assets - debt,
    fxRate: 1400,
    source,
  };
}

describe("patrimonio series", () => {
  it("converts bank ARS plus blue times bank USD and wallets once", () => {
    const got = assetsEquivalent({
      bankArs: 100000,
      bankUsd: 200,
      walletUsd: 100,
      fxRate: 1500,
    });
    assert.equal(got.assetsUsd, 300);
    assert.equal(got.assetsArs, 100000 + 300 * 1500);
    assert.equal(netWorthArs(got.assetsArs, 0), got.assetsArs);
    assert.equal(netWorthArs(got.assetsArs, 1000), got.assetsArs - 1000);
    assert.equal(
      netWorthArs(got.assetsArs, 1000, 50, 1500),
      got.assetsArs - 1000 - 50 * 1500,
    );
  });

  it("prices USD debt only with a real blue rate", () => {
    assert.equal(usableFxRate(null), null);
    assert.equal(usableFxRate(0), null);
    assert.equal(usableFxRate(Number.NaN), null);
    assert.equal(usableFxRate(Number.POSITIVE_INFINITY), null);
    assert.equal(usableFxRate(1400), 1400);
    const missing = pricedNetWorth({
      assetsArs: 100,
      assetsUsd: 5,
      debtArs: 10,
      debtUsd: 2,
      fxRate: null,
    });
    assert.equal(missing.fxAvailable, false);
    assert.equal(missing.netWorthArs, null);
    const priced = pricedNetWorth({
      assetsArs: 1000,
      assetsUsd: 0,
      debtArs: 100,
      debtUsd: 2,
      fxRate: 500,
    });
    assert.equal(priced.fxAvailable, true);
    assert.equal(priced.netWorthArs, 1000 - 100 - 2 * 500);
  });

  it("leaves USD unconverted when the rate is missing", () => {
    const got = assetsEquivalent({
      bankArs: 10,
      bankUsd: 2,
      walletUsd: 3,
      fxRate: null,
    });
    assert.equal(got.assetsArs, 10);
    assert.equal(got.assetsUsd, 5);
  });

  it("reads debt as zero when every card statement is closed", () => {
    const closed = readDebt({
      forceSettled: false,
      saldoArs: 120000,
      saldoUsd: 30,
      cardLast4: "1234",
      closedStatements: 3,
      openStatements: 0,
    });
    assert.equal(closed.balanceArs, 0);
    assert.equal(closed.balanceUsd, 0);
    assert.equal(closed.settled, true);
    assert.equal(closed.activeCard, false);
    const mixed = readDebt({
      forceSettled: false,
      saldoArs: 120000,
      saldoUsd: 30,
      cardLast4: "1234",
      closedStatements: 3,
      openStatements: 1,
    });
    assert.equal(mixed.balanceArs, 120000);
    assert.equal(mixed.settled, false);
  });

  it("reads a closed card as zero and sin tarjeta activa", () => {
    const forced = readDebt({
      forceSettled: true,
      saldoArs: 0,
      saldoUsd: 0,
      cardLast4: null,
    });
    assert.equal(forced.balanceArs, 0);
    assert.equal(forced.settled, true);
    assert.equal(forced.activeCard, false);
    assert.equal(forced.cardStatus, "sin_tarjeta_activa");

    const typedZero = readDebt({
      forceSettled: false,
      saldoArs: 0,
      saldoUsd: 0,
      cardLast4: null,
    });
    assert.equal(typedZero.cardStatus, "sin_tarjeta_activa");
    assert.equal(typedZero.balanceArs, 0);

    const open = readDebt({
      forceSettled: false,
      saldoArs: 12000,
      saldoUsd: 0,
      cardLast4: "8958",
    });
    assert.equal(open.balanceArs, 12000);
    assert.equal(open.activeCard, true);
    assert.equal(open.cardStatus, "activa");

    const empty = readDebt({
      forceSettled: false,
      saldoArs: null,
      saldoUsd: null,
      cardLast4: null,
    });
    assert.equal(empty.settled, false);
    assert.equal(empty.cardStatus, "sin_snapshot");
  });

  it("zeros debt only on and after the settle date", () => {
    const points = [
      point("2026-01-10", 100, 80),
      point("2026-03-01", 120, 20),
      point("2026-04-01", 130, 20),
    ];
    const settled = applySettledDebtHistory(points, { settled: true, clearedOn: "2026-03-15" });
    assert.equal(settled[0]?.debtArs, 80);
    assert.equal(settled[1]?.debtArs, 20);
    assert.equal(settled[2]?.debtArs, 0);
    assert.equal(settled[2]?.netWorthArs, 130);
    const untouched = applySettledDebtHistory(points, { settled: true, clearedOn: null });
    assert.equal(untouched[2]?.debtArs, 20);
  });

  it("filters 6m and 1y without inventing months", () => {
    const points = [
      point("2025-01-15", 1, 0),
      point("2026-06-01", 2, 0),
      point("2026-10-31", 3, 1),
    ];
    assert.deepEqual(TRUSTED_DEBT_MONTHS, []);
    assert.deepEqual(
      filterPatrimonioSeries(points, "6m", "2026-10-31").map((p) => p.date),
      ["2026-06-01", "2026-10-31"],
    );
    assert.deepEqual(
      filterPatrimonioSeries(points, "1y", "2026-10-31").map((p) => p.date),
      ["2026-06-01", "2026-10-31"],
    );
    assert.equal(filterPatrimonioSeries(points, "all", "2026-10-31").length, 3);
    assert.equal(historyStartsAt(points), "2025-01-15");
    assert.equal(
      historyNote("2026-10-31"),
      "El historial arranca el 31/10/2026. Un punto por día.",
    );
    assert.equal(historyNote("2026-10-31").includes("\u2014"), false);
  });

  it("keeps a single point and says history will build up", () => {
    const only = [point("2026-10-31", 100, 0)];
    assert.equal(filterPatrimonioSeries(only, "all", "2026-10-31").length, 1);
    assert.match(historyNote(historyStartsAt(only)), /31\/10\/2026/);
  });

  it("deltas use the latest previous month and the first point of the year", () => {
    const series = [
      point("2025-12-20", 100, 0),
      point("2026-01-01", 200, 0),
      point("2026-09-02", 300, 0),
      point("2026-09-28", 400, 0),
      point("2026-10-31", 900, 0),
    ];
    const got = netWorthDeltas("2026-10-31", 522500, series);
    assert.equal(got.vsPreviousMonth?.date, "2026-09-28");
    assert.equal(got.vsPreviousMonth?.netWorthArs, 400);
    assert.equal(got.vsPreviousMonth?.deltaArs, 522500 - 400);
    assert.equal(got.vsYearStart?.date, "2026-01-01");
    assert.equal(got.vsYearStart?.netWorthArs, 200);
    assert.equal(got.vsYearStart?.deltaArs, 522500 - 200);
    assert.deepEqual(netWorthDeltas("2026-10-31", null, series), {
      vsPreviousMonth: null,
      vsYearStart: null,
    });
    const onlyToday = [point("2026-01-01", 10, 0)];
    assert.equal(netWorthDeltas("2026-01-01", 10, onlyToday).vsYearStart, null);
    assert.equal(netWorthDeltas("2026-01-01", 10, onlyToday).vsPreviousMonth, null);
  });

  it("sparkline keeps one point per day and prefers live net worth", () => {
    const series = [point("2026-10-30", 100, 0), point("2026-10-31", 200, 0)];
    assert.deepEqual(sparklineNetWorths(series, "2026-10-31", 250), [100, 250]);
    assert.deepEqual(sparklineNetWorths(series, "2026-11-01", 250), [100, 200, 250]);
    assert.deepEqual(sparklineNetWorths(series, "2026-10-31", null), [100, 200]);
    assert.deepEqual(sparklineNetWorths([], "2026-10-31", 250), [250]);
  });
});
