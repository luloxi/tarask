import type { BbvaMovement } from "@/lib/bbva/parse";
import { parseStatementWorkbook } from "@/lib/bbva/parse";
import {
  parseCardStatementSaldoFromRows,
  parseCardStatementSaldoFromText,
  type CardStatementSaldo,
} from "@/lib/stats/saldo-deuda";
import {
  looksLikeFiwindCtaCte,
  parseFiwindCtaCteText,
} from "@/lib/import/fiwind-ctacte";
import type { PdfMarkdownSource } from "@/lib/bbva/parse-pdf";
import {
  detectBankFromFileName,
  detectBankFromText,
  detectFileKind,
  emptyParseMessage,
  type StatementFileKind,
} from "@/lib/import/source";

export type StatementParseResult = {
  movements: BbvaMovement[];
  source: string;
  detectedBank: string | null;
  fileKind: StatementFileKind;
  pdfTextLength?: number;
  hint: string | null;
  /** Rainman: card SALDO ACTUAL / total a pagar (not CA$ checking). */
  cardSaldo?: CardStatementSaldo | null;
};

function workbookSource(
  fileKind: StatementFileKind,
  classicBbva: boolean,
  detectedBank: string | null,
  layout?: string,
): string {
  if (layout === "period") return "bbva_period";
  if (fileKind === "csv") return "csv";
  if (
    (classicBbva || layout === "ultimos") &&
    (!detectedBank || detectedBank === "BBVA")
  ) {
    return "bbva_xlsx";
  }
  if (fileKind === "xls") return "xls";
  return "xlsx";
}

/**
 * Single pipeline for PWA import, agent import, and MCP.
 * BBVA PDF first, then generic PDF, then AI; tables via the workbook parser.
 */
export type ParseStatementOptions = {
  /** Gets the PDF's markdown. The browser flow posts the file to the Worker. */
  pdfMarkdown?: PdfMarkdownSource;
  /** Skip the OpenAI fallback (browser: there is no key and no server round trip). */
  skipAi?: boolean;
};

export async function parseStatementFile(
  buffer: Buffer,
  fileName: string,
  options: ParseStatementOptions = {},
): Promise<StatementParseResult> {
  let fileKind = detectFileKind(buffer, fileName);
  const fromName = detectBankFromFileName(fileName);

  const pastedText = fileName.toLowerCase().endsWith(".statement.txt");
  if (pastedText) fileKind = "pdf";
  if (fileKind === "pdf") {
    const {
      extractPdfText,
      markdownToStatementText,
      parseBbvaPdfText,
      parseGenericPdfText,
      PdfImportUnavailableError,
    } = await import("@/lib/bbva/parse-pdf");
    let text: string;
    if (pastedText) {
      text = markdownToStatementText(buffer.toString("utf8"));
    } else {
      try {
        text = await extractPdfText(buffer, options.pdfMarkdown);
      } catch (e) {
        if (e instanceof PdfImportUnavailableError) {
          return {
            movements: [],
            source: "pdf",
            detectedBank: fromName,
            fileKind,
            hint: e.message,
            cardSaldo: null,
          };
        }
        throw e;
      }
    }
    const detectedBank = detectBankFromText(text) ?? fromName;
    const pdfTextLength = text.length;
    const cardSaldo = parseCardStatementSaldoFromText(text);

    if (looksLikeFiwindCtaCte(text)) {
      const cta = parseFiwindCtaCteText(text);
      const empty = cta.movements.length === 0;
      const unreadable = cta.unreadable.length > 0;
      return {
        movements: cta.movements,
        source: "pdf",
        detectedBank: "Fiwind",
        fileKind,
        pdfTextLength,
        hint: empty
          ? cta.emptyPeriod && !unreadable
            ? "Este estado de cuenta de Fiwind no tiene movimientos en el período: no hay nada para importar."
            : unreadable
              ? `No pudimos leer ${cta.unreadable.length} fila(s) del estado de cuenta de Fiwind. Subí el Excel de Actividad.`
              : null
          : unreadable
            ? `Se importaron ${cta.movements.length} fila(s); ${cta.unreadable.length} no se pudieron leer y quedaron afuera.`
            : null,
        cardSaldo: null,
      };
    }

    const bbvaMovements = parseBbvaPdfText(text);
    if (bbvaMovements.length > 0) {
      const source =
        detectedBank && detectedBank !== "BBVA" ? "pdf" : "bbva_pdf";
      return {
        movements: bbvaMovements,
        source,
        detectedBank: detectedBank ?? "BBVA",
        fileKind,
        pdfTextLength,
        hint: null,
        cardSaldo,
      };
    }

    const generic = parseGenericPdfText(text);
    if (generic.length > 0) {
      return {
        movements: generic,
        source: "pdf",
        detectedBank,
        fileKind,
        pdfTextLength,
        hint: null,
        cardSaldo,
      };
    }

    const { isAiPdfImportConfigured, parseStatementPdfWithAi } = await import(
      "@/lib/import/parse-pdf-ai"
    );
    if (!options.skipAi && isAiPdfImportConfigured()) {
      try {
        const aiMovements = await parseStatementPdfWithAi(
          buffer,
          fileName,
          text,
        );
        if (aiMovements.length > 0) {
          return {
            movements: aiMovements,
            source: "pdf_ai",
            detectedBank,
            fileKind,
            pdfTextLength,
            hint: null,
            cardSaldo,
          };
        }
      } catch (e) {
        const hint = e instanceof Error ? e.message : null;
        const empty = emptyParseMessage({
          fileName,
          fileKind,
          pdfTextLength,
        });
        return {
          movements: [],
          source: "pdf_ai",
          detectedBank,
          fileKind,
          pdfTextLength,
          hint: hint ?? empty.hint,
        };
      }
    }

    const empty = emptyParseMessage({ fileName, fileKind, pdfTextLength });
    return {
      movements: [],
      source: detectedBank && detectedBank !== "BBVA" ? "pdf" : "bbva_pdf",
      detectedBank,
      fileKind,
      pdfTextLength,
      hint: empty.hint,
      cardSaldo,
    };
  }

  const parsed = parseStatementWorkbook(buffer, fileName);
  const detectedBank = parsed.detectedBank ?? fromName;
  const kind: StatementFileKind =
    fileKind === "unknown" ? parsed.fileKind : fileKind;
  const source = workbookSource(
    kind,
    parsed.classicBbva,
    detectedBank,
    parsed.layout,
  );
  const hint =
    parsed.movements.length === 0
      ? emptyParseMessage({ fileName, fileKind: kind }).hint
      : null;

  let cardSaldo = null as CardStatementSaldo | null;
  try {
    const XLSX = await import("xlsx");
    const wb = XLSX.read(buffer, { type: "buffer" });
    const rows: unknown[][] = [];
    for (const sn of wb.SheetNames) {
      const sheet = wb.Sheets[sn];
      if (!sheet) continue;
      const matrix = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        defval: "",
      }) as unknown[][];
      rows.push(...matrix);
    }
    cardSaldo = parseCardStatementSaldoFromRows(rows);
  } catch {
    cardSaldo = null;
  }

  return {
    movements: parsed.movements,
    source,
    detectedBank,
    fileKind: kind,
    hint,
    cardSaldo,
  };
}
