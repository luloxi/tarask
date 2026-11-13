/**
 * Browser side of statement imports.
 *
 * Reading a spreadsheet or a PDF's text is the CPU-heavy part of an import and
 * the Worker free plan allows ~10 ms per request, so the file is parsed here
 * (same parsers the server used to run) and only the parsed movements go to
 * `/api/import/statement`. PDFs need Workers AI for their text: that goes to
 * `/api/import/pdf-text`, which costs the Worker no CPU.
 */

import { matchCategory } from "@/lib/categorize/rules";
import { buildImportMessage, otherCardNote } from "@/lib/import/messages";
import { parseStatementFile, type StatementParseResult } from "@/lib/import/parse-statement";

/** Movements per request: keeps each Worker call small. */
export const IMPORT_CHUNK_ROWS = 400;

export type ImportOutcome = {
  total: number;
  inserted: number;
  alreadyExists: number;
  message: string;
  warning: string | null;
  fullyDuplicate: boolean;
  hint: string | null;
  bank: string | null;
};

export class ImportError extends Error {}

export type ParsedStatement = StatementParseResult & { fileName: string };

async function pdfMarkdownViaApi(data: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const fd = new FormData();
  fd.set("file", new File([bytes as BlobPart], "statement.pdf", { type: "application/pdf" }));
  const res = await fetch("/api/import/pdf-text", { method: "POST", body: fd, credentials: "include" });
  const text = await res.text();
  let body: { markdown?: string; error?: string } | null = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new ImportError(
      res.status === 413 ? "El PDF es demasiado grande (máximo 8 MB)." : "No se pudo leer el PDF.",
    );
  }
  if (!res.ok || !body?.markdown) {
    throw new ImportError(body?.error || "No se pudo leer el PDF. Subí el Excel o CSV del banco.");
  }
  return body.markdown;
}

export async function parseStatementInBrowser(file: File): Promise<ParsedStatement> {
  const buffer = Buffer.from(await file.arrayBuffer());
  const parsed = await parseStatementFile(buffer, file.name, {
    pdfMarkdown: pdfMarkdownViaApi,
    skipAi: true,
  });
  return { ...parsed, fileName: file.name };
}

/** Same-fingerprint rows inside one file count once; the browser tells the server how many it dropped. */
export function dedupeInFile(parsed: ParsedStatement) {
  const seen = new Set<string>();
  const unique: ParsedStatement["movements"] = [];
  for (const m of parsed.movements) {
    if (seen.has(m.fingerprint)) continue;
    seen.add(m.fingerprint);
    unique.push(m);
  }
  return { unique, duplicatesInFile: parsed.movements.length - unique.length };
}

export type ImportPayload = {
  fileName: string;
  bank: string | null;
  source: string;
  detectedBank: string | null;
  fileKind: string;
  cardSaldo: { ars: number; usd: number | null } | null;
  statementId: string | null;
  duplicatesInFile: number;
  totalRows: number;
  movements: Array<{
    date: string;
    descriptionRaw: string;
    descriptionNormalized: string;
    installment: string | null;
    amountArs: number | null;
    amountUsd: number | null;
    isPayment: boolean;
    isCredit: boolean;
    fingerprint: string;
    categoryHint: string | null;
    categorySlug: string | null;
    cardLast4: string | null;
  }>;
};

/** One payload per chunk of rows. Only the first carries the in-file duplicate count. */
export function buildImportPayloads(
  parsed: ParsedStatement,
  bank: string | null,
  chunkRows = IMPORT_CHUNK_ROWS,
): ImportPayload[] {
  const { unique, duplicatesInFile } = dedupeInFile(parsed);
  const rows = unique.map((m) => ({
    date: m.date,
    descriptionRaw: m.descriptionRaw,
    descriptionNormalized: m.descriptionNormalized,
    installment: m.installment,
    amountArs: m.amountArs,
    amountUsd: m.amountUsd,
    isPayment: m.isPayment,
    isCredit: m.isCredit,
    fingerprint: m.fingerprint,
    categoryHint: m.categoryHint ?? null,
    categorySlug: m.categoryHint ? null : matchCategory(m.descriptionNormalized).slug,
    cardLast4: m.cardLast4 ?? null,
  }));
  const cardSaldo = parsed.cardSaldo
    ? { ars: parsed.cardSaldo.ars, usd: parsed.cardSaldo.usd ?? null }
    : null;
  const payloads: ImportPayload[] = [];
  for (let i = 0; i < Math.max(rows.length, 1); i += chunkRows) {
    payloads.push({
      fileName: parsed.fileName,
      bank,
      source: parsed.source,
      detectedBank: parsed.detectedBank,
      fileKind: parsed.fileKind,
      cardSaldo: i === 0 ? cardSaldo : null,
      statementId: null,
      duplicatesInFile: i === 0 ? duplicatesInFile : 0,
      totalRows: i === 0 ? parsed.movements.length : 0,
      movements: rows.slice(i, i + chunkRows),
    });
  }
  return payloads;
}

type ServerResult = {
  error?: string;
  statementId?: string | null;
  total?: number;
  uniqueInFile?: number;
  duplicatesInFile?: number;
  alreadyExists?: number;
  inserted?: number;
  skippedOtherCard?: number;
  primaryCardLast4?: string | null;
  message?: string;
  hint?: string | null;
  source?: string;
  bank?: string;
};

async function postPayload(payload: ImportPayload): Promise<ServerResult> {
  const res = await fetch("/api/import/statement", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    credentials: "include",
  });
  const text = await res.text();
  let data: ServerResult | null = null;
  try {
    data = text ? (JSON.parse(text) as ServerResult) : null;
  } catch {
    throw new ImportError(
      res.status === 413 ? "El archivo es demasiado grande." : text.slice(0, 160) || `Error ${res.status}`,
    );
  }
  if (!res.ok) throw new ImportError(data?.error || `Error al importar ${payload.fileName}`);
  return data ?? {};
}

/** Parse one file in the browser and import it. Throws ImportError with a message for the user. */
export async function importStatementFile(file: File, bank: string | null): Promise<ImportOutcome> {
  const parsed = await parseStatementInBrowser(file);
  if (parsed.movements.length === 0 && /no tiene movimientos/.test(parsed.hint ?? "")) {
    // A real statement for a quiet month: nothing to import, nothing wrong.
    return {
      total: 0,
      inserted: 0,
      alreadyExists: 0,
      message: parsed.hint ?? "El archivo no tiene movimientos.",
      warning: null,
      fullyDuplicate: false,
      hint: null,
      bank: parsed.detectedBank ?? bank,
    };
  }
  if (parsed.movements.length === 0) {
    throw new ImportError(
      [
        parsed.hint ?? `No se leyeron movimientos de “${file.name}”.`,
      ].join(" "),
    );
  }
  const payloads = buildImportPayloads(parsed, bank);
  let statementId: string | null = null;
  let inserted = 0;
  let alreadyExists = 0;
  let skippedOtherCard = 0;
  let primaryCardLast4: string | null = null;
  let resultBank: string | null = bank;
  let source = parsed.source;
  let uniqueInFile = 0;
  let duplicatesInFile = 0;
  for (const payload of payloads) {
    const r = await postPayload({ ...payload, statementId });
    statementId = r.statementId ?? statementId;
    inserted += r.inserted ?? 0;
    alreadyExists += r.alreadyExists ?? 0;
    skippedOtherCard += r.skippedOtherCard ?? 0;
    primaryCardLast4 = r.primaryCardLast4 ?? primaryCardLast4;
    resultBank = r.bank ?? resultBank;
    source = r.source ?? source;
    uniqueInFile += r.uniqueInFile ?? 0;
    duplicatesInFile += r.duplicatesInFile ?? 0;
  }
  const total = parsed.movements.length;
  const meta = buildImportMessage({
    total,
    uniqueInFile,
    duplicatesInFile,
    alreadyExists,
    inserted,
  });
  return {
    total,
    inserted,
    alreadyExists,
    message: meta.message + otherCardNote(skippedOtherCard, primaryCardLast4, source),
    warning: meta.warning ?? parsed.hint,
    fullyDuplicate: meta.fullyDuplicate,
    hint: parsed.hint,
    bank: resultBank,
  };
}

