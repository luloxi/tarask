import OpenAI from "openai";
import { z } from "zod";

export const ReceiptOcrSchema = z.object({
  merchant: z.string().nullable(),
  date: z.string().nullable(), // ISO YYYY-MM-DD
  total: z.number().nullable(),
  currency: z.enum(["ARS", "USD"]).default("ARS"),
  items: z
    .array(
      z.object({
        name: z.string(),
        quantity: z.number().nullable().default(1),
        unit_price: z.number().nullable(),
        line_total: z.number().nullable(),
      }),
    )
    .default([]),
});

export type ReceiptOcrResult = z.infer<typeof ReceiptOcrSchema>;

import {
  buildSystemPrompt,
  mockReceiptOcr,
  normalizeReceiptDate,
  todayIso,
} from "@/lib/receipts/ocr-core";

export { mockReceiptOcr, normalizeReceiptDate };

/** True when any vision provider key is configured. */
export function isOcrConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY || process.env.XAI_API_KEY);
}

function createVisionClient(): {
  client: OpenAI;
  model: string;
} {
  // Prefer OpenAI (user credits). Fallback to xAI if only that is set.
  if (process.env.OPENAI_API_KEY) {
    return {
      client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
      model: process.env.OPENAI_VISION_MODEL ?? "gpt-4o-mini",
    };
  }

  if (process.env.XAI_API_KEY) {
    return {
      client: new OpenAI({
        apiKey: process.env.XAI_API_KEY,
        baseURL: "https://api.x.ai/v1",
      }),
      model: process.env.XAI_VISION_MODEL ?? "grok-2-vision-1212",
    };
  }

  throw new Error(
    "Falta OPENAI_API_KEY (o XAI_API_KEY). Configurala en Vercel → Settings → Environment Variables.",
  );
}

export async function parseReceiptImage(
  imageUrlOrDataUrl: string,
): Promise<ReceiptOcrResult> {
  const { client, model } = createVisionClient();
  const now = new Date();

  const response = await client.chat.completions.create({
    model,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: buildSystemPrompt(now) },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Extraé los datos del ticket de supermercado. Hoy es ${todayIso(now)}. La fecha del ticket debe ser coherente con el año actual si el ticket es reciente.`,
          },
          {
            type: "image_url",
            image_url: { url: imageUrlOrDataUrl, detail: "high" },
          },
        ],
      },
    ],
  });

  const text = response.choices[0]?.message?.content ?? "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("No se pudo parsear la respuesta del OCR");
  }

  const parsed = JSON.parse(jsonMatch[0]);
  const result = ReceiptOcrSchema.parse(parsed);
  return {
    ...result,
    date: normalizeReceiptDate(result.date, now),
  };
}

