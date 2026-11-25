/**
 * "Guardar en Google Sheets", browser side.
 *
 * The browser asks Google for a short-lived token with the drive.file scope
 * (only files this app creates) through Google Identity Services, then talks
 * to the Sheets and Drive APIs directly. Nothing about Google is stored on our
 * server; the token lives in memory and is gone when the tab closes.
 *
 * The app's own Sheet is found again through a private appProperty
 * (`<app>Export = exportKey`) that only this OAuth client can read.
 * A deleted or trashed file is simply not found, so a new one gets created.
 *
 * Kept free of app imports so the same file works in Tarask and Garpen.
 */

export type SheetCell = string | number | null;
export type SheetTab = { title: string; columns: string[]; rows: SheetCell[][] };
export type SheetsExportData = {
  clientId: string | null;
  appName: string;
  fileTitle: string;
  exportKey: string;
  loginHint?: string | null;
  tabs: SheetTab[];
};
export type SheetFile = { id: string; name: string; url: string };

export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const GIS_SRC = "https://accounts.google.com/gsi/client";
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
const DRIVE = "https://www.googleapis.com/drive/v3/files";
const SPREADSHEET_MIME = "application/vnd.google-apps.spreadsheet";
/** Cells per values.batchUpdate call: keeps each request small. */
const CELLS_PER_REQUEST = 60000;

export type SheetsErrorKind =
  | "not_configured"
  | "cancelled"
  | "popup_blocked"
  | "api_disabled"
  | "permission"
  | "auth"
  | "not_found"
  | "quota"
  | "network"
  | "unknown";

export class SheetsError extends Error {
  constructor(
    public kind: SheetsErrorKind,
    message = kind,
  ) {
    super(message);
    this.name = "SheetsError";
  }
}

/** Plain words for the person using the app. Never shows Google's raw text. */
export function friendlyMessage(err: unknown, appName: string): string {
  const kind = err instanceof SheetsError ? err.kind : "unknown";
  switch (kind) {
    case "not_configured":
    case "api_disabled":
      return `Guardar en Google Sheets todavía no está activado en ${appName}. Probá de nuevo más tarde.`;
    case "cancelled":
      return "Cerraste la ventana de Google antes de terminar. Cuando quieras, probá de nuevo.";
    case "popup_blocked":
      return "El navegador bloqueó la ventana de Google. Permití ventanas emergentes para este sitio y probá de nuevo.";
    case "permission":
      return "Para guardar la planilla hace falta tildar el permiso de Google Drive. Probá de nuevo y dejalo tildado.";
    case "auth":
      return "Se venció el permiso de Google. Tocá de nuevo para renovarlo.";
    case "quota":
      return "Google está recibiendo muchos pedidos. Esperá un minuto y probá de nuevo.";
    case "network":
      return "No hay conexión. Revisá internet y probá de nuevo.";
    default:
      return "No se pudo guardar en Google Sheets. Probá de nuevo en un rato.";
  }
}

type GoogleErrorBody = {
  error?: {
    code?: number;
    status?: string;
    message?: string;
    errors?: { reason?: string }[];
    details?: { reason?: string }[];
  };
};

/** Maps a Google API error response to a kind. Exported for tests. */
export function classifyGoogleError(status: number, body: GoogleErrorBody | null): SheetsErrorKind {
  const e = body?.error;
  const reasons = [
    ...(e?.errors ?? []).map((x) => x.reason ?? ""),
    ...(e?.details ?? []).map((x) => x.reason ?? ""),
    e?.status ?? "",
  ].map((r) => r.toLowerCase());
  const message = (e?.message ?? "").toLowerCase();
  if (
    reasons.some((r) => r === "accessnotconfigured" || r === "service_disabled") ||
    message.includes("has not been used in project") ||
    message.includes("is disabled")
  ) {
    return "api_disabled";
  }
  if (status === 401) return "auth";
  if (status === 404) return "not_found";
  if (status === 429 || reasons.some((r) => r.includes("ratelimit") || r === "resource_exhausted")) return "quota";
  if (status === 403) {
    if (reasons.some((r) => r.includes("ratelimit") || r.includes("quota"))) return "quota";
    return "permission";
  }
  return "unknown";
}

/* ---------- Google Identity Services (token client) ---------- */

type TokenResponse = { access_token?: string; expires_in?: number | string; error?: string; scope?: string };
type TokenClient = { requestAccessToken(opts?: { prompt?: string }): void };
type GoogleOauth2 = {
  initTokenClient(config: {
    client_id: string;
    scope: string;
    include_granted_scopes?: boolean;
    login_hint?: string;
    callback: (resp: TokenResponse) => void;
    error_callback?: (err: { type?: string }) => void;
  }): TokenClient;
  hasGrantedAllScopes(resp: TokenResponse, ...scopes: string[]): boolean;
};
type GoogleGlobal = { accounts?: { oauth2?: GoogleOauth2 } };

let gisPromise: Promise<GoogleOauth2> | null = null;

/** Loads the Google script once. Call it before the click so the popup opens inside the user's tap. */
export function loadGoogleIdentity(): Promise<GoogleOauth2> {
  if (typeof window === "undefined") return Promise.reject(new SheetsError("unknown"));
  const existing = (window as unknown as { google?: GoogleGlobal }).google?.accounts?.oauth2;
  if (existing) return Promise.resolve(existing);
  if (gisPromise) return gisPromise;
  gisPromise = new Promise<GoogleOauth2>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = GIS_SRC;
    script.async = true;
    script.onload = () => {
      const oauth2 = (window as unknown as { google?: GoogleGlobal }).google?.accounts?.oauth2;
      if (oauth2) resolve(oauth2);
      else reject(new SheetsError("network"));
    };
    script.onerror = () => {
      gisPromise = null;
      reject(new SheetsError("network"));
    };
    document.head.appendChild(script);
  });
  return gisPromise;
}

let cached: { token: string; expiresAt: number; clientId: string } | null = null;

export function forgetToken(): void {
  cached = null;
}

/**
 * Must run synchronously inside a click handler (no await before it),
 * otherwise the browser blocks Google's popup.
 */
export function requestToken(oauth2: GoogleOauth2, clientId: string, loginHint?: string | null): Promise<string> {
  if (cached && cached.clientId === clientId && cached.expiresAt > Date.now() + 60_000) {
    return Promise.resolve(cached.token);
  }
  return new Promise<string>((resolve, reject) => {
    let client: TokenClient;
    try {
      client = oauth2.initTokenClient({
        client_id: clientId,
        scope: DRIVE_FILE_SCOPE,
        include_granted_scopes: true,
        ...(loginHint ? { login_hint: loginHint } : {}),
        callback: (resp) => {
          if (resp.error || !resp.access_token) {
            reject(new SheetsError(resp.error === "access_denied" ? "permission" : "unknown"));
            return;
          }
          if (!oauth2.hasGrantedAllScopes(resp, DRIVE_FILE_SCOPE)) {
            reject(new SheetsError("permission"));
            return;
          }
          const seconds = Number(resp.expires_in ?? 3600);
          cached = {
            token: resp.access_token,
            expiresAt: Date.now() + (Number.isFinite(seconds) ? seconds : 3600) * 1000,
            clientId,
          };
          resolve(resp.access_token);
        },
        error_callback: (err) => {
          if (err?.type === "popup_failed_to_open") reject(new SheetsError("popup_blocked"));
          else if (err?.type === "popup_closed") reject(new SheetsError("cancelled"));
          else reject(new SheetsError("unknown"));
        },
      });
    } catch {
      reject(new SheetsError("not_configured"));
      return;
    }
    client.requestAccessToken({ prompt: "" });
  });
}

/* ---------- Sheets / Drive REST ---------- */

async function google<T>(token: string, url: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch {
    throw new SheetsError("network");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as GoogleErrorBody | null;
    const kind = classifyGoogleError(res.status, body);
    if (kind === "auth") forgetToken();
    throw new SheetsError(kind);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function propertyKey(appName: string): string {
  return `${appName.toLowerCase().replace(/[^a-z0-9]/g, "")}Export`;
}

/** Newest Sheet this app made for this exportKey, or null if none (or deleted / in the trash). */
export async function findSheet(token: string, appName: string, exportKey: string): Promise<SheetFile | null> {
  const safeKey = exportKey.replace(/[^a-zA-Z0-9]/g, "");
  const q = [
    `appProperties has { key='${propertyKey(appName)}' and value='${safeKey}' }`,
    "trashed = false",
    `mimeType = '${SPREADSHEET_MIME}'`,
  ].join(" and ");
  const params = new URLSearchParams({
    q,
    spaces: "drive",
    orderBy: "createdTime desc",
    pageSize: "1",
    fields: "files(id,name,webViewLink)",
  });
  const data = await google<{ files?: { id: string; name: string; webViewLink?: string }[] }>(
    token,
    `${DRIVE}?${params.toString()}`,
  );
  const file = data.files?.[0];
  if (!file) return null;
  return { id: file.id, name: file.name, url: file.webViewLink ?? sheetUrl(file.id) };
}

function sheetUrl(id: string): string {
  return `https://docs.google.com/spreadsheets/d/${id}/edit`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "25/11/2026 18:43" in the person's own clock. */
export function stamp(now: Date): string {
  return `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/** Title for "Crear una versión nueva": the base name plus the date and time. */
export function versionTitle(base: string, now: Date): string {
  return `${base} (${pad(now.getDate())}-${pad(now.getMonth() + 1)}-${now.getFullYear()} ${pad(now.getHours())}.${pad(now.getMinutes())})`;
}

export function noticeLine(appName: string, now: Date): string {
  return `Copia de ${appName} del ${stamp(now)}. Es solo para mirar: lo que cambies acá no vuelve a ${appName}.`;
}

function quoteTitle(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

export type ValueRange = { range: string; values: SheetCell[][] };

/**
 * Row 1 = notice, row 2 = column names, data from row 3.
 * Big tabs are split so no single request carries too many cells.
 */
export function buildValueRanges(tabs: SheetTab[], notice: string): ValueRange[][] {
  const ranges: ValueRange[] = [];
  for (const tab of tabs) {
    const width = Math.max(1, tab.columns.length);
    ranges.push({ range: `${quoteTitle(tab.title)}!A1`, values: [[notice], tab.columns] });
    const chunkRows = Math.max(1, Math.floor(CELLS_PER_REQUEST / width));
    for (let start = 0; start < tab.rows.length; start += chunkRows) {
      ranges.push({
        range: `${quoteTitle(tab.title)}!A${start + 3}`,
        values: tab.rows.slice(start, start + chunkRows).map((r) => r.map((c) => (c === undefined ? null : c))),
      });
    }
  }
  const batches: ValueRange[][] = [];
  let current: ValueRange[] = [];
  let cells = 0;
  for (const r of ranges) {
    const size = r.values.reduce((n, row) => n + row.length, 0);
    if (current.length && cells + size > CELLS_PER_REQUEST) {
      batches.push(current);
      current = [];
      cells = 0;
    }
    current.push(r);
    cells += size;
  }
  if (current.length) batches.push(current);
  return batches;
}

function gridSize(tab: SheetTab) {
  return { rowCount: Math.max(tab.rows.length + 2, 10), columnCount: Math.max(tab.columns.length, 1) };
}

type SheetProps = { sheetId: number; title: string };

function formatRequests(sheets: SheetProps[], tabs: SheetTab[]) {
  const requests: unknown[] = [];
  for (const tab of tabs) {
    const sheet = sheets.find((s) => s.title === tab.title);
    if (!sheet) continue;
    const size = gridSize(tab);
    requests.push(
      {
        updateSheetProperties: {
          properties: { sheetId: sheet.sheetId, gridProperties: { ...size, frozenRowCount: 2 } },
          fields: "gridProperties(rowCount,columnCount,frozenRowCount)",
        },
      },
      {
        repeatCell: {
          range: { sheetId: sheet.sheetId, startRowIndex: 0, endRowIndex: 1 },
          cell: { userEnteredFormat: { textFormat: { italic: true, bold: false } } },
          fields: "userEnteredFormat.textFormat",
        },
      },
      {
        repeatCell: {
          range: { sheetId: sheet.sheetId, startRowIndex: 1, endRowIndex: 2 },
          cell: { userEnteredFormat: { textFormat: { bold: true, italic: false } } },
          fields: "userEnteredFormat.textFormat",
        },
      },
    );
  }
  return requests;
}

async function writeValues(token: string, id: string, tabs: SheetTab[], notice: string) {
  for (const batch of buildValueRanges(tabs, notice)) {
    await google(token, `${SHEETS}/${id}/values:batchUpdate`, {
      method: "POST",
      // RAW: text is never read as a formula, so a description like "=..." stays text.
      body: JSON.stringify({ valueInputOption: "RAW", data: batch }),
    });
  }
}

/** Creates a new Sheet with one tab per topic, tags it for this app and fills it. */
export async function createSheet(token: string, data: SheetsExportData, title: string, now = new Date()): Promise<SheetFile> {
  const created = await google<{ spreadsheetId: string; spreadsheetUrl?: string; sheets?: { properties: SheetProps }[] }>(
    token,
    SHEETS,
    {
      method: "POST",
      body: JSON.stringify({
        properties: { title, locale: "es_AR" },
        sheets: data.tabs.map((tab, index) => ({
          properties: { title: tab.title, index, gridProperties: { ...gridSize(tab), frozenRowCount: 2 } },
        })),
      }),
    },
  );
  const id = created.spreadsheetId;
  await google(token, `${DRIVE}/${id}?fields=id`, {
    method: "PATCH",
    body: JSON.stringify({ appProperties: { [propertyKey(data.appName)]: data.exportKey.replace(/[^a-zA-Z0-9]/g, "") } }),
  });
  const sheets = (created.sheets ?? []).map((s) => s.properties);
  await google(token, `${SHEETS}/${id}:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({ requests: formatRequests(sheets, data.tabs) }),
  });
  await writeValues(token, id, data.tabs, noticeLine(data.appName, now));
  return { id, name: title, url: created.spreadsheetUrl ?? sheetUrl(id) };
}

/** Rewrites this app's tabs in an existing Sheet. Other tabs the person added are left alone. */
export async function updateSheet(token: string, file: SheetFile, data: SheetsExportData, now = new Date()): Promise<SheetFile> {
  const meta = await google<{ sheets?: { properties: SheetProps }[] }>(
    token,
    `${SHEETS}/${file.id}?fields=sheets.properties(sheetId,title)`,
  );
  let sheets = (meta.sheets ?? []).map((s) => s.properties);
  const missing = data.tabs.filter((tab) => !sheets.some((s) => s.title === tab.title));
  if (missing.length) {
    const added = await google<{ replies?: { addSheet?: { properties: SheetProps } }[] }>(
      token,
      `${SHEETS}/${file.id}:batchUpdate`,
      {
        method: "POST",
        body: JSON.stringify({ requests: missing.map((tab) => ({ addSheet: { properties: { title: tab.title } } })) }),
      },
    );
    sheets = sheets.concat((added.replies ?? []).flatMap((r) => (r.addSheet ? [r.addSheet.properties] : [])));
  }
  await google(token, `${SHEETS}/${file.id}/values:batchClear`, {
    method: "POST",
    body: JSON.stringify({ ranges: data.tabs.map((tab) => quoteTitle(tab.title)) }),
  });
  await google(token, `${SHEETS}/${file.id}:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({ requests: formatRequests(sheets, data.tabs) }),
  });
  await writeValues(token, file.id, data.tabs, noticeLine(data.appName, now));
  return file;
}
