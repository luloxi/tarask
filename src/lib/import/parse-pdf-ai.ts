import { fingerprint32 } from "@/lib/hash";
import OpenAI from "openai";
import { z } from "zod";
import type { BbvaMovement } from "@/lib/bbva/parse";
import { extractPdfText } from "@/lib/bbva/parse-pdf";
import {
  amountFingerprintKey,
  fingerprintParts,
  normalizeMovementCurrency,
} from "@/lib/money";

const MovementSchema = z.object({
  date: z.string(),
  description: z.string(),
  amountArs: z.number().nullable().optional(),
  amountUsd: z.number().nullable().optional(),
  installment: z.string().nullable().optional(),
  isPayment: z.boolean().optional(),
  isCredit: z.boolean().optional(),
});

const StatementSchema = z.object({
  bank: z.string().nullable().optional(),
  movements: z.array(MovementSchema).default([]),
});

export function isAiPdfImportConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

function makeFingerprint(m: Omit<BbvaMovement, "fingerprint">): string {
  const base = fingerprintParts([
    m.date,
    m.descriptionNormalized,
    amountFingerprintKey(m.amountArs, m.amountUsd),
    m.installment ?? "",
  ]);
  return fingerprint32(base);
}

function normalizeIsoDate(raw: string): string | null {
  const s = raw.trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (!dmy) return null;
  let y = Number(dmy[3]);
  if (y < 100) y += 2000;
  const m = Number(dmy[2]);
  const d = Number(dmy[1]);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (
    Number.isNaN(dt.getTime()) ||
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  return dt.toISOString().slice(0, 10);
}

/**
 * Generic card/bank statement PDF → movements via OpenAI.
 * Gated on OPENAI_API_KEY. Used when the BBVA-specific parser finds nothing.
 */
export async function parseStatementPdfWithAi(
  buffer: Buffer,
  fileName?: string,
  extractedText?: string,
): Promise<BbvaMovement[]> {
  if (!isAiPdfImportConfigured()) {
    throw new Error(
      "Falta OPENAI_API_KEY para interpretar PDFs que no son BBVA.",
    );
  }

  const text = (extractedText ?? (await extractPdfText(buffer))).trim();
  if (!text || text.length < 40) {
    throw new Error(
      "No se pudo leer texto del PDF. Probá otro archivo o el Excel de movimientos.",
    );
  }

  // Cap prompt size — summaries can be long
  const clipped = text.length > 28000 ? `${text.slice(0, 28000)}\n…` : text;
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = process.env.OPENAI_STATEMENT_MODEL ?? "gpt-4o-mini";

  const response = await client.chat.completions.create({
    model,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `Sos un extractor de resúmenes de tarjeta/banco de Argentina.
Devolvé SOLO JSON válido (sin markdown) con esta forma:
{
  "bank": "nombre del banco o null",
  "movements": [
    {
      "date": "YYYY-MM-DD",
      "description": "comercio o concepto",
      "amountArs": número o null,
      "amountUsd": número o null,
      "installment": "1/3" o null,
      "isPayment": false,
      "isCredit": false
    }
  ]
}
Reglas:
- Fechas argentinas DD/MM/YYYY o DD-MMM-YY → YYYY-MM-DD.
- Montos con coma decimal argentina → número JS.
- amountArs / amountUsd son el importe del movimiento (absoluto positivo salvo créditos/pagos).
- Pagos a la tarjeta (SU PAGO, PAGO EN PESOS, etc.): isPayment true.
- Notas de crédito / devoluciones: isCredit true.
- Cuotas: "C. 01/03" → installment "1/3".
- Ignorá legales, publicidad y totales del resumen; solo líneas de detalle.
- Si no hay movimientos claros, devolvé movements: [].
- Archivo: ${fileName ?? "statement.pdf"}`,
      },
      {
        role: "user",
        content: `Extraé los movimientos de este resumen PDF:\n\n${clipped}`,
      },
    ],
  });

  const content = response.choices[0]?.message?.content ?? "";
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("La IA no devolvió un JSON usable del resumen.");
  }

  const parsed = StatementSchema.parse(JSON.parse(jsonMatch[0]));
  const out: BbvaMovement[] = [];
  const seen = new Set<string>();

  for (const row of parsed.movements) {
    const date = normalizeIsoDate(row.date);
    if (!date) continue;
    const descriptionRaw = row.description.replace(/\s+/g, " ").trim();
    if (!descriptionRaw) continue;

    let amountArs =
      row.amountArs != null && Number.isFinite(row.amountArs)
        ? row.amountArs
        : null;
    let amountUsd =
      row.amountUsd != null && Number.isFinite(row.amountUsd)
        ? row.amountUsd
        : null;
    if (amountArs == null && amountUsd == null) continue;

    const normalized = normalizeMovementCurrency({
      descriptionNormalized: descriptionRaw,
      amountArs,
      amountUsd,
    });
    amountArs = normalized.amountArs;
    amountUsd = normalized.amountUsd;

    const payment =
      Boolean(row.isPayment) ||
      /SU PAGO|PAGO EN PESOS|PAGO EN USD|PAGO RECIBIDO/i.test(descriptionRaw);
    const isCredit = Boolean(row.isCredit) && !payment;
    const installment =
      row.installment && /^\d{1,2}\/\d{1,2}$/.test(row.installment.trim())
        ? row.installment.trim()
        : null;

    const partial: Omit<BbvaMovement, "fingerprint"> = {
      date,
      descriptionRaw,
      descriptionNormalized: descriptionRaw,
      installment,
      amountArs,
      amountUsd,
      isPayment: payment,
      isCredit,
    };
    const fingerprint = makeFingerprint(partial);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    out.push({ ...partial, fingerprint });
  }

  return out;
}
