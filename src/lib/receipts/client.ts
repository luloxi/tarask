/**
 * Browser side of ticket uploads. Two steps so a misread total never lands in the books:
 * `previewReceipt` reads the photo (nothing is saved), the user fixes what's wrong,
 * `saveReceipt` stores the photo and links or creates the expense.
 */

import { compressImageForUpload } from "@/lib/image-compress";
import type { ReceiptOcrResult } from "@/lib/receipts/ocr-core";

export type ReceiptMatch = {
  transactionId: string | null;
  score: number;
  reason: string;
  candidates: Array<{ id: string; score: number; reason: string }>;
};

export type ReceiptPreview = {
  file: File;
  ocr: ReceiptOcrResult;
  match: ReceiptMatch;
  willCreateExpense: boolean;
};

export type ReceiptSaved = {
  ocr: ReceiptOcrResult;
  match: ReceiptMatch;
  createdTransaction: boolean;
  imageUrl?: string;
  duplicate?: boolean;
};

export class ReceiptError extends Error {
  duplicate = false;
}

async function errorMessage(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const data = JSON.parse(text) as { error?: string };
    if (data.error) return data.error;
  } catch {
    if (res.status === 413 || /entity too large|payload too large/i.test(text)) {
      return "La foto es demasiado grande. Sacá otra más cerca o con menos resolución.";
    }
  }
  if (res.status === 401) return "Entrá a la app e intentá de nuevo.";
  return `Error ${res.status}`;
}

function toDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("No se pudo leer la foto"));
    reader.readAsDataURL(file);
  });
}

/** ≤1.5 MB keeps the upload fast on mobile data and the vision model happy. */
export async function prepareReceiptPhoto(raw: File): Promise<File> {
  try {
    return await compressImageForUpload(raw, { maxBytes: 1.5 * 1024 * 1024 });
  } catch {
    throw new ReceiptError("No pudimos abrir esa foto. Probá con una JPG o PNG.");
  }
}

export async function previewReceipt(raw: File): Promise<ReceiptPreview> {
  const file = await prepareReceiptPhoto(raw);
  const fd = new FormData();
  fd.set("dryRun", "1");
  fd.set("imageDataUrl", await toDataUrl(file));
  const res = await fetch("/api/receipts", { method: "POST", body: fd, credentials: "include" });
  if (!res.ok) throw new ReceiptError(await errorMessage(res));
  const data = (await res.json()) as Omit<ReceiptPreview, "file">;
  return { file, ocr: data.ocr, match: data.match, willCreateExpense: Boolean(data.willCreateExpense) };
}

export async function saveReceipt(file: File, ocr: ReceiptOcrResult, createExpense = true): Promise<ReceiptSaved> {
  const fd = new FormData();
  fd.set("file", file);
  fd.set("ocr", JSON.stringify(ocr));
  fd.set("createExpense", createExpense ? "1" : "0");
  const res = await fetch("/api/receipts", { method: "POST", body: fd, credentials: "include" });
  if (res.status === 409) {
    const err = new ReceiptError("Este ticket ya estaba cargado.");
    err.duplicate = true;
    throw err;
  }
  if (!res.ok) throw new ReceiptError(await errorMessage(res));
  return (await res.json()) as ReceiptSaved;
}
