import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  buildValueRanges,
  classifyGoogleError,
  createSheet,
  findSheet,
  friendlyMessage,
  noticeLine,
  SheetsError,
  updateSheet,
  versionTitle,
  type SheetsExportData,
} from "./google-sheets";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Call = { url: string; method: string; body: unknown };

/** Fake Google: answers by URL, records every call. */
function mockGoogle(handler: (call: Call) => { status?: number; body?: unknown }) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = {
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
    };
    calls.push(call);
    const auth = new Headers(init?.headers).get("authorization");
    assert.equal(auth, "Bearer tok");
    const out = handler(call);
    return new Response(JSON.stringify(out.body ?? {}), { status: out.status ?? 200 });
  }) as typeof fetch;
  return calls;
}

const data: SheetsExportData = {
  clientId: "x.apps.googleusercontent.com",
  appName: "Tarask",
  fileTitle: "Tarask – Casita",
  exportKey: "abc123",
  tabs: [
    { title: "Movimientos", columns: ["Fecha", "Monto"], rows: [["2026-11-01", 10], ["2026-11-02", null]] },
    { title: "Ingresos", columns: ["Fecha"], rows: [] },
  ],
};

describe("sheet layout", () => {
  it("puts the notice on row 1, columns on row 2 and data from row 3", () => {
    const [batch] = buildValueRanges(data.tabs, "aviso");
    assert.deepEqual(batch[0], { range: "'Movimientos'!A1", values: [["aviso"], ["Fecha", "Monto"]] });
    assert.deepEqual(batch[1], { range: "'Movimientos'!A3", values: [["2026-11-01", 10], ["2026-11-02", null]] });
    assert.equal(batch[2].range, "'Ingresos'!A1");
  });

  it("splits big tabs into several small requests", () => {
    const rows = Array.from({ length: 50000 }, (_, i) => [`d${i}`, i, "x"]);
    const batches = buildValueRanges([{ title: "Mov's", columns: ["a", "b", "c"], rows }], "n");
    assert.ok(batches.length > 1);
    const total = batches.flat().slice(1).reduce((n, r) => n + r.values.length, 0);
    assert.equal(total, 50000);
    assert.equal(batches[0][0].range, "'Mov''s'!A1");
    for (const b of batches) assert.ok(b.reduce((n, r) => n + r.values.flat().length, 0) <= 60000);
  });

  it("says it is a copy and that edits do not go back", () => {
    const line = noticeLine("Tarask", new Date(2026, 10, 25, 18, 43));
    assert.match(line, /Copia de Tarask del 25\/11\/2026 18:43/);
    assert.match(line, /no vuelve a Tarask/);
    assert.equal(versionTitle("Tarask – Casita", new Date(2026, 10, 25, 9, 5)), "Tarask – Casita (25-11-2026 09.05)");
  });
});

describe("google errors", () => {
  it("recognises a disabled API and keeps the message friendly", () => {
    const kind = classifyGoogleError(403, {
      error: { code: 403, status: "PERMISSION_DENIED", message: "Google Sheets API has not been used in project 1 before or it is disabled.", details: [{ reason: "SERVICE_DISABLED" }] },
    });
    assert.equal(kind, "api_disabled");
    const msg = friendlyMessage(new SheetsError(kind), "Tarask");
    assert.doesNotMatch(msg, /API|project|403/);
  });

  it("maps the usual cases", () => {
    assert.equal(classifyGoogleError(401, null), "auth");
    assert.equal(classifyGoogleError(404, null), "not_found");
    assert.equal(classifyGoogleError(429, null), "quota");
    assert.equal(classifyGoogleError(403, { error: { errors: [{ reason: "insufficientPermissions" }] } }), "permission");
    assert.equal(classifyGoogleError(403, { error: { errors: [{ reason: "userRateLimitExceeded" }] } }), "quota");
  });
});

describe("drive and sheets calls (mocked)", () => {
  it("finds only this app's file, not trashed", async () => {
    const calls = mockGoogle(() => ({ body: { files: [{ id: "f1", name: "Tarask – Casita", webViewLink: "https://docs.google.com/x" }] } }));
    const file = await findSheet("tok", "Tarask", "abc123");
    assert.deepEqual(file, { id: "f1", name: "Tarask – Casita", url: "https://docs.google.com/x" });
    const q = new URL(calls[0].url).searchParams.get("q") ?? "";
    assert.match(q, /appProperties has \{ key='taraskExport' and value='abc123' \}/);
    assert.match(q, /trashed = false/);
  });

  it("returns null when the file was deleted or trashed", async () => {
    mockGoogle(() => ({ body: { files: [] } }));
    assert.equal(await findSheet("tok", "Tarask", "abc123"), null);
  });

  it("creates the sheet with one tab per topic, tags it and writes RAW values", async () => {
    const calls = mockGoogle((c) => {
      if (c.method === "POST" && c.url === "https://sheets.googleapis.com/v4/spreadsheets") {
        return {
          body: {
            spreadsheetId: "s1",
            spreadsheetUrl: "https://docs.google.com/spreadsheets/d/s1/edit",
            sheets: [{ properties: { sheetId: 1, title: "Movimientos" } }, { properties: { sheetId: 2, title: "Ingresos" } }],
          },
        };
      }
      return { body: {} };
    });
    const file = await createSheet("tok", data, "Tarask – Casita", new Date(2026, 10, 25, 18, 0));
    assert.equal(file.id, "s1");
    const create = calls[0].body as { properties: { title: string }; sheets: { properties: { title: string } }[] };
    assert.equal(create.properties.title, "Tarask – Casita");
    assert.deepEqual(create.sheets.map((s) => s.properties.title), ["Movimientos", "Ingresos"]);
    const tag = calls.find((c) => c.method === "PATCH");
    assert.deepEqual(tag?.body, { appProperties: { taraskExport: "abc123" } });
    const write = calls.find((c) => c.url.endsWith("/values:batchUpdate"));
    assert.equal((write?.body as { valueInputOption: string }).valueInputOption, "RAW");
  });

  it("update adds missing tabs, clears only this app's tabs and rewrites them", async () => {
    const calls = mockGoogle((c) => {
      if (c.method === "GET") return { body: { sheets: [{ properties: { sheetId: 1, title: "Movimientos" } }, { properties: { sheetId: 9, title: "Mis notas" } }] } };
      if (c.url.endsWith(":batchUpdate") && JSON.stringify(c.body).includes("addSheet")) {
        return { body: { replies: [{ addSheet: { properties: { sheetId: 2, title: "Ingresos" } } }] } };
      }
      return { body: {} };
    });
    await updateSheet("tok", { id: "s1", name: "Tarask – Casita", url: "u" }, data);
    const clear = calls.find((c) => c.url.endsWith("/values:batchClear"));
    assert.deepEqual(clear?.body, { ranges: ["'Movimientos'", "'Ingresos'"] });
    assert.doesNotMatch(JSON.stringify(calls), /Mis notas'/);
  });

  it("turns a missing file into not_found so the dialog can create a new one", async () => {
    mockGoogle(() => ({ status: 404, body: { error: { code: 404 } } }));
    await assert.rejects(updateSheet("tok", { id: "gone", name: "x", url: "u" }, data), (e: unknown) => e instanceof SheetsError && e.kind === "not_found");
  });
});
