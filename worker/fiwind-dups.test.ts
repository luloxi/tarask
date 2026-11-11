import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  FIWIND_ECHO_CANDIDATE_SQL,
  loadFiwindEchoIds,
  pairFiwindEchoes,
  type FiwindEchoRow,
} from "./fiwind-dups";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function row(partial: FiwindEchoRow): FiwindEchoRow {
  return partial;
}

function householdsOf(rows: readonly FiwindEchoRow[]): Set<string> {
  return new Set(rows.map((item) => item.householdId));
}

function dropped(rows: readonly FiwindEchoRow[], homes?: ReadonlySet<string>): Set<string> {
  return pairFiwindEchoes(rows, homes ?? householdsOf(rows));
}

describe("pairFiwindEchoes", () => {
  it("drops the same-day numeric and keeps the earlier one", () => {
    const drop = dropped([
      row({ id: "n-early", householdId: "hh", date: "2026-08-01", bank: "Fiwind", description: "100", amountArs: "100" }),
      row({ id: "n-later", householdId: "hh", date: "2026-08-02", bank: "Fiwind", description: "100", amountArs: "100" }),
      row({ id: "named", householdId: "hh", date: "2026-08-02", bank: "BBVA", description: "Cafe", amountArs: "100" }),
    ]);
    assert.equal(drop.has("n-later"), true);
    assert.equal(drop.has("n-early"), false);
    assert.equal(drop.size, 1);
  });

  it("pairs the numeric two days before a named row on 08-04 and leaves 08-01", () => {
    const drop = dropped([
      row({ id: "n-01", householdId: "hh", date: "2026-08-01", bank: "Fiwind", description: "100", amountArs: "100" }),
      row({ id: "n-02", householdId: "hh", date: "2026-08-02", bank: "Fiwind", description: "100", amountArs: "100" }),
      row({ id: "named", householdId: "hh", date: "2026-08-04", bank: "BBVA", description: "Cafe", amountArs: "100" }),
    ]);
    assert.deepEqual([...drop], ["n-02"]);
  });

  it("drops the closer numeric when a farther one also reaches the named row", () => {
    const drop = dropped([
      row({ id: "n-far", householdId: "hh", date: "2026-08-01", bank: "Fiwind", description: "100", amountArs: "100" }),
      row({ id: "n-near", householdId: "hh", date: "2026-08-03", bank: "Fiwind", description: "100", amountArs: "100" }),
      row({ id: "named", householdId: "hh", date: "2026-08-03", bank: "BBVA", description: "Cafe", amountArs: "100" }),
    ]);
    assert.deepEqual([...drop], ["n-near"]);
  });

  it("does not pair 100 with -100", () => {
    const drop = dropped([
      row({ id: "num", householdId: "hh", date: "2026-08-18", bank: "Fiwind", description: "100", amountArs: "100" }),
      row({ id: "named", householdId: "hh", date: "2026-08-18", bank: "BBVA", description: "Cafe", amountArs: "-100" }),
    ]);
    assert.equal(drop.size, 0);
    const sameSign = dropped([
      row({ id: "num", householdId: "hh", date: "2026-08-18", bank: "Fiwind", description: "100", amountArs: "-100" }),
      row({ id: "named", householdId: "hh", date: "2026-08-18", bank: "BBVA", description: "Cafe", amountArs: "-100" }),
    ]);
    assert.deepEqual([...sameSign], ["num"]);
  });

  it("does not pair a USD numeric with an ARS-only named row", () => {
    const usdOnly = dropped([
      row({ id: "num", householdId: "hh", date: "2026-08-18", bank: "Fiwind", description: "10", amountArs: null, amountUsd: "10" }),
      row({ id: "named", householdId: "hh", date: "2026-08-18", bank: "BBVA", description: "Cafe", amountArs: "10", amountUsd: null }),
    ]);
    assert.equal(usdOnly.size, 0);
    const bothNonZero = dropped([
      row({
        id: "num",
        householdId: "hh",
        date: "2026-08-18",
        bank: "Fiwind",
        description: "10",
        amountArs: "1500",
        amountUsd: "10",
      }),
      row({
        id: "named",
        householdId: "hh",
        date: "2026-08-18",
        bank: "BBVA",
        description: "Cafe",
        amountArs: "1500",
        amountUsd: null,
      }),
    ]);
    assert.equal(bothNonZero.size, 0);
  });

  it("does not pair an ARS numeric when the named row only matches in USD", () => {
    const drop = dropped([
      row({ id: "num", householdId: "hh", date: "2026-08-18", bank: "Fiwind", description: "250", amountArs: "250", amountUsd: null }),
      row({ id: "named", householdId: "hh", date: "2026-08-18", bank: "BBVA", description: "Cafe", amountArs: "999", amountUsd: "250" }),
    ]);
    assert.equal(drop.size, 0);
  });

  it("pairs a both-nonzero numeric on USD when USD matches and ARS does not", () => {
    const drop = dropped([
      row({
        id: "num",
        householdId: "hh",
        date: "2026-08-18",
        bank: "Fiwind",
        description: "10",
        amountArs: "1500",
        amountUsd: "10",
      }),
      row({
        id: "named",
        householdId: "hh",
        date: "2026-08-18",
        bank: "BBVA",
        description: "Cafe",
        amountArs: "999",
        amountUsd: "10",
      }),
    ]);
    assert.deepEqual([...drop], ["num"]);
  });

  it("tie-breaks by numeric date, then id", () => {
    const byDate = dropped([
      row({ id: "n-z", householdId: "hh", date: "2026-08-01", bank: "Fiwind", description: "100", amountArs: "100" }),
      row({ id: "n-a", householdId: "hh", date: "2026-08-03", bank: "Fiwind", description: "100", amountArs: "100" }),
      row({ id: "named", householdId: "hh", date: "2026-08-02", bank: "BBVA", description: "Cafe", amountArs: "100" }),
    ]);
    assert.deepEqual([...byDate], ["n-z"]);
    const byId = dropped([
      row({ id: "n-b", householdId: "hh", date: "2026-08-02", bank: "Fiwind", description: "100", amountArs: "100" }),
      row({ id: "n-a", householdId: "hh", date: "2026-08-02", bank: "Fiwind", description: "100", amountArs: "100" }),
      row({ id: "named", householdId: "hh", date: "2026-08-02", bank: "BBVA", description: "Cafe", amountArs: "100" }),
    ]);
    assert.deepEqual([...byId], ["n-a"]);
  });

  it("lets one named row cancel exactly one numeric", () => {
    const drop = dropped([
      row({ id: "n1", householdId: "hh", date: "2026-08-17", bank: "Fiwind", description: "100", amountArs: "100" }),
      row({ id: "n2", householdId: "hh", date: "2026-08-18", bank: "Fiwind", description: "100", amountArs: "100" }),
      row({ id: "n3", householdId: "hh", date: "2026-08-19", bank: "Fiwind", description: "100", amountArs: "100" }),
      row({ id: "named", householdId: "hh", date: "2026-08-18", bank: "BBVA", description: "Cafe", amountArs: "100" }),
    ]);
    assert.equal(drop.size, 1);
    assert.equal(drop.has("n2"), true);
  });

  it("pairs a same-day cross-household twin inside the user's households", () => {
    const drop = dropped([
      row({ id: "num", householdId: "hh-a", date: "2026-08-18", bank: "Fiwind", description: "80", amountArs: "80" }),
      row({ id: "named", householdId: "hh-b", date: "2026-08-18", bank: "BBVA", description: "Cafe", amountArs: "80" }),
    ]);
    assert.deepEqual([...drop], ["num"]);
  });

  it("ignores a named row in a household the user does not belong to", () => {
    const rows = [
      row({ id: "num", householdId: "hh-user", date: "2026-08-18", bank: "Fiwind", description: "80", amountArs: "80" }),
      row({ id: "foreign", householdId: "hh-other", date: "2026-08-18", bank: "BBVA", description: "Cafe", amountArs: "80" }),
    ];
    const drop = dropped(rows, new Set(["hh-user"]));
    assert.equal(drop.size, 0);
  });

  it("drops only household B when A's named row is one day from A's numeric", () => {
    const drop = dropped([
      row({ id: "a-num", householdId: "hh-a", date: "2026-08-17", bank: "Fiwind", description: "100", amountArs: "100" }),
      row({ id: "a-named", householdId: "hh-a", date: "2026-08-18", bank: "BBVA", description: "Cafe", amountArs: "100" }),
      row({ id: "b-num", householdId: "hh-b", date: "2026-08-18", bank: "Fiwind", description: "100", amountArs: "100" }),
    ]);
    assert.deepEqual([...drop].sort(), ["b-num"]);
  });

  it("treats a payment or credit named row as a twin", () => {
    const drop = dropped([
      row({ id: "num-pay", householdId: "hh", date: "2026-08-18", bank: "Fiwind", description: "40", amountArs: "40" }),
      row({
        id: "pay",
        householdId: "hh",
        date: "2026-08-18",
        bank: "BBVA",
        description: "Alquiler",
        amountArs: "40",
        isPayment: 1,
      }),
      row({ id: "num-cr", householdId: "hh", date: "2026-08-18", bank: "Fiwind", description: "41", amountArs: "41" }),
      row({
        id: "cr",
        householdId: "hh",
        date: "2026-08-18",
        bank: "BBVA",
        description: "Devolucion",
        amountArs: "41",
        isCredit: 1,
      }),
    ]);
    assert.equal(drop.has("num-pay"), true);
    assert.equal(drop.has("num-cr"), true);
    assert.equal(drop.size, 2);
  });

  it("does not hide a numeric echo against a transfer, even the next day", () => {
    const nextDay = dropped([
      row({
        id: "num",
        householdId: "hh",
        date: "2026-08-06",
        bank: "Fiwind",
        description: "20000",
        amountArs: "20000",
      }),
      row({
        id: "xfer",
        householdId: "hh",
        date: "2026-08-05",
        bank: "Fiwind",
        description: "TRANSFERENCIA ARS",
        amountArs: "20000",
      }),
    ]);
    assert.equal(nextDay.size, 0);
    const sameDay = dropped([
      row({
        id: "num",
        householdId: "hh",
        date: "2026-08-06",
        bank: "Fiwind",
        description: "20000",
        amountArs: "20000",
      }),
      row({
        id: "xfer",
        householdId: "hh",
        date: "2026-08-06",
        bank: "Fiwind",
        description: "TRANSFERENCIA ARS",
        amountArs: "20000",
      }),
    ]);
    assert.equal(sameDay.size, 0);
  });

  it("keeps ±2 days only for a named spend, not an empty merchant", () => {
    const named = dropped([
      row({ id: "num", householdId: "hh", date: "2026-08-20", bank: "Fiwind", description: "90", amountArs: "90" }),
      row({
        id: "shop",
        householdId: "hh",
        date: "2026-08-18",
        bank: "BBVA",
        description: "Cafe Martinez",
        amountArs: "90",
      }),
    ]);
    assert.deepEqual([...named], ["num"]);
    const emptyKey = dropped([
      row({
        id: "num",
        householdId: "hh",
        date: "2026-08-22",
        bank: "Fiwind",
        description: "91",
        amountArs: "91",
      }),
      row({
        id: "pago",
        householdId: "hh",
        date: "2026-08-20",
        bank: "BBVA",
        description: "Pago a 0002",
        amountArs: "91",
      }),
    ]);
    assert.equal(emptyKey.size, 0);
  });

  it("stays inside ±2 days at home and requires the same day across households", () => {
    const edge = dropped([
      row({ id: "num", householdId: "hh", date: "2026-08-10", bank: "Fiwind", description: "101", amountArs: "101" }),
      row({ id: "named", householdId: "hh", date: "2026-08-08", bank: "BBVA", description: "Kiosco", amountArs: "101" }),
    ]);
    assert.deepEqual([...edge], ["num"]);
    const far = dropped([
      row({ id: "num", householdId: "hh", date: "2026-08-10", bank: "Fiwind", description: "102", amountArs: "102" }),
      row({ id: "named", householdId: "hh", date: "2026-08-13", bank: "BBVA", description: "Kiosco", amountArs: "102" }),
    ]);
    assert.equal(far.size, 0);
    const cross = dropped([
      row({ id: "num", householdId: "hh-a", date: "2026-08-18", bank: "Fiwind", description: "81", amountArs: "81" }),
      row({ id: "named", householdId: "hh-b", date: "2026-08-19", bank: "BBVA", description: "Kiosco", amountArs: "81" }),
    ]);
    assert.equal(cross.size, 0);
  });

  it("accepts a trimmed digits-and-dots description and rejects another bank", () => {
    const padded = dropped([
      row({ id: "num", householdId: "hh", date: "2026-08-18", bank: "Fiwind", description: "  18.07 ", amountArs: "18.07" }),
      row({ id: "named", householdId: "hh", date: "2026-08-18", bank: "BBVA", description: "Kiosco", amountArs: "18.07" }),
    ]);
    assert.deepEqual([...padded], ["num"]);
    const otherBank = dropped([
      row({ id: "num", householdId: "hh", date: "2026-08-18", bank: "BBVA", description: "60", amountArs: "60" }),
      row({ id: "named", householdId: "hh", date: "2026-08-18", bank: "BBVA", description: "Cafe", amountArs: "60" }),
    ]);
    assert.equal(otherBank.size, 0);
  });

  it("matches ARS under 0.01 and USD under 0.005", () => {
    const arsNear = dropped([
      row({ id: "num", householdId: "hh", date: "2026-08-18", bank: "Fiwind", description: "200", amountArs: "200.00" }),
      row({ id: "named", householdId: "hh", date: "2026-08-18", bank: "BBVA", description: "Near", amountArs: "200.009" }),
    ]);
    assert.equal(arsNear.has("num"), true);
    const arsFar = dropped([
      row({ id: "num", householdId: "hh", date: "2026-08-18", bank: "Fiwind", description: "201", amountArs: "201.00" }),
      row({ id: "named", householdId: "hh", date: "2026-08-18", bank: "BBVA", description: "Far", amountArs: "201.01" }),
    ]);
    assert.equal(arsFar.size, 0);
    const usdNear = dropped([
      row({ id: "num", householdId: "hh", date: "2026-08-18", bank: "Fiwind", description: "8", amountUsd: "8.000" }),
      row({ id: "named", householdId: "hh", date: "2026-08-18", bank: "BBVA", description: "Shop", amountUsd: "8.004" }),
    ]);
    assert.equal(usdNear.has("num"), true);
    const usdFar = dropped([
      row({ id: "num", householdId: "hh", date: "2026-08-18", bank: "Fiwind", description: "8.5", amountUsd: "8.500" }),
      row({ id: "named", householdId: "hh", date: "2026-08-18", bank: "BBVA", description: "Shop", amountUsd: "8.505" }),
    ]);
    assert.equal(usdFar.size, 0);
  });

  it("pairs 2000 synthetic rows quickly", () => {
    const rows: FiwindEchoRow[] = [];
    for (let i = 0; i < 1000; i += 1) {
      const amount = String((i % 40) + 1);
      const day = String((i % 27) + 1).padStart(2, "0");
      const home = i % 2 === 0 ? "h1" : "h2";
      rows.push({
        id: `n-${i}`,
        householdId: home,
        date: `2026-08-${day}`,
        bank: "Fiwind",
        description: amount,
        amountArs: amount,
      });
      rows.push({
        id: `m-${i}`,
        householdId: home,
        date: `2026-08-${day}`,
        bank: "BBVA",
        description: `Shop ${i}`,
        amountArs: amount,
      });
    }
    const start = performance.now();
    const drop = pairFiwindEchoes(rows, new Set(["h1", "h2"]));
    const ms = performance.now() - start;
    assert.equal(drop.size, 1000);
    assert.ok(ms < 200, `2000 rows took ${ms.toFixed(1)} ms`);
  });
});

function openDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const file of ["0001_app.sql", "0002_auth.sql", "0003_serpix_sync.sql", "0004_card_closed.sql"]) {
    db.exec(readFileSync(join(root, "migrations", file), "utf8"));
  }
  return db;
}

function wrap(db: DatabaseSync) {
  return {
    prepare(sql: string) {
      let params: unknown[] = [];
      const stmt = {
        bind(...values: unknown[]) {
          params = values;
          return stmt;
        },
        async all<T>() {
          return { results: db.prepare(sql).all(...(params as never[])) as T[] };
        },
      };
      return stmt;
    },
  };
}

function seedPeople(db: DatabaseSync) {
  db.prepare("INSERT INTO users (id, email, name) VALUES ('user-u', 'u@example.com', 'User U')").run();
  db.prepare("INSERT INTO users (id, email, name) VALUES ('user-v', 'v@example.com', 'User V')").run();
  db.prepare("INSERT INTO households (id, name, invite_code) VALUES ('hh-home', 'Home', 'codehome1')").run();
  db.prepare("INSERT INTO households (id, name, invite_code) VALUES ('hh-shared', 'Shared', 'codeshared')").run();
  db.prepare("INSERT INTO households (id, name, invite_code) VALUES ('hh-foreign', 'Foreign', 'codeforeign')").run();
  db.prepare(
    "INSERT INTO household_members (household_id, user_id, role) VALUES ('hh-home', 'user-u', 'owner')",
  ).run();
  db.prepare(
    "INSERT INTO household_members (household_id, user_id, role) VALUES ('hh-shared', 'user-u', 'member')",
  ).run();
  db.prepare(
    "INSERT INTO household_members (household_id, user_id, role) VALUES ('hh-foreign', 'user-v', 'owner')",
  ).run();
}

function insertTx(
  db: DatabaseSync,
  row: {
    id: string;
    householdId: string;
    date: string;
    description: string;
    bank?: string | null;
    amountArs?: string | null;
    amountUsd?: string | null;
    isPayment?: number;
    isCredit?: number;
  },
) {
  db.prepare(
    `INSERT INTO transactions (
       id, household_id, date, description_raw, description_normalized,
       amount_ars, amount_usd, is_payment, is_credit, external_fingerprint, source, bank
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'bbva_import', ?)`,
  ).run(
    row.id,
    row.householdId,
    row.date,
    row.description,
    row.description,
    row.amountArs ?? null,
    row.amountUsd ?? null,
    row.isPayment ?? 0,
    row.isCredit ?? 0,
    `fp-${row.id}`,
    row.bank ?? null,
  );
}

describe("loadFiwindEchoIds", () => {
  it("binds the user once and does not scan transactions", () => {
    assert.equal(FIWIND_ECHO_CANDIDATE_SQL.split("?").length - 1, 1);
    const db = openDb();
    seedPeople(db);
    insertTx(db, {
      id: "n1",
      householdId: "hh-home",
      date: "2026-08-18",
      description: "100",
      bank: "Fiwind",
      amountArs: "100",
    });
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${FIWIND_ECHO_CANDIDATE_SQL}`).all("user-u") as Array<{
      detail: string;
    }>;
    const detail = plan.map((line) => line.detail).join("\n");
    // Fiwind numerics are an equality on (household_id, bank). Named rows
    // use the date window on tx_household_date_idx. Neither scans the table.
    assert.match(detail, /SEARCH t USING INDEX tx_household_bank_idx \(household_id=\? AND bank=\?\)/);
    assert.match(detail, /SEARCH m USING INDEX tx_household_date_idx \(household_id=\? AND date>\? AND date<\?\)/);
    assert.match(detail, /SEARCH m USING INDEX tx_household_date_idx \(household_id=\? AND date=\?\)/);
    assert.match(detail, /hm_user_idx \(user_id=\?\)/);
    assert.doesNotMatch(detail, /\bSCAN\b/);
  });

  it("returns [] when D1 throws and does not include the user id in the log", async () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    };
    try {
      const db = {
        prepare() {
          return {
            bind() {
              return {
                async all() {
                  throw new Error("d1 down");
                },
              };
            },
          };
        },
      };
      const ids = await loadFiwindEchoIds(db, "user-secret-id");
      assert.deepEqual(ids, []);
      assert.equal(lines.length, 1);
      assert.match(lines[0] ?? "", /fiwind echo load failed/);
      assert.equal((lines[0] ?? "").includes("user-secret-id"), false);
      assert.equal((lines[0] ?? "").includes("d1 down"), true);
    } finally {
      console.error = original;
    }
  });

  it("does not let a foreign household cancel the user's numeric row", async () => {
    const db = openDb();
    seedPeople(db);
    insertTx(db, {
      id: "num-foreign",
      householdId: "hh-home",
      date: "2026-08-19",
      description: "7700",
      bank: "Fiwind",
      amountArs: "7700",
    });
    insertTx(db, {
      id: "named-foreign",
      householdId: "hh-foreign",
      date: "2026-08-19",
      description: "Cafe",
      bank: "BBVA",
      amountArs: "7700",
    });
    const loaded = db.prepare(FIWIND_ECHO_CANDIDATE_SQL).all("user-u") as Array<{
      kind: string;
      id: string;
      household_id: string;
    }>;
    assert.equal(loaded.some((item) => item.household_id === "hh-foreign"), false);
    assert.equal(loaded.some((item) => item.id === "named-foreign"), false);
    const ids = await loadFiwindEchoIds(wrap(db), "user-u");
    assert.deepEqual(ids, []);
  });

  it("loads a payment or credit named twin and drops one numeric", async () => {
    const db = openDb();
    seedPeople(db);
    insertTx(db, {
      id: "num-pay",
      householdId: "hh-home",
      date: "2026-08-18",
      description: "40",
      bank: "Fiwind",
      amountArs: "40",
    });
    insertTx(db, {
      id: "pay",
      householdId: "hh-home",
      date: "2026-08-18",
      description: "Alquiler",
      bank: "BBVA",
      amountArs: "40",
      isPayment: 1,
    });
    insertTx(db, {
      id: "num-cr",
      householdId: "hh-home",
      date: "2026-08-18",
      description: "41",
      bank: "Fiwind",
      amountArs: "41",
    });
    insertTx(db, {
      id: "cr",
      householdId: "hh-shared",
      date: "2026-08-18",
      description: "Devolucion",
      bank: "BBVA",
      amountArs: "41",
      isCredit: 1,
    });
    const ids = await loadFiwindEchoIds(wrap(db), "user-u");
    assert.deepEqual(ids, ["num-cr", "num-pay"]);
  });
});
