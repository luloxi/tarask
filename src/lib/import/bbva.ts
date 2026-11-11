import { and, eq, inArray } from "drizzle-orm";
import { parseTransparenciaConsumos } from "@/lib/bbva/parse";
import {
  filterToPrimaryCard,
  pickPrimaryCardLast4,
} from "@/lib/bbva/card-account";
import { categoryNameToSlug } from "@/lib/categorize/rules";
import { matchCategoryWithLearning } from "@/lib/categorize/learn";
import { getDb, schema } from "@/lib/db";
import { chunkByBoundParams, mapInChunks } from "@/lib/db/chunk";
import { getCategoryMap } from "@/lib/household";
import { parseStatementFile } from "@/lib/import/parse-statement";
import { detectFileKind } from "@/lib/import/source";
import { putStatementPdf } from "@/lib/receipts/storage";
import {
  emptyParseMessage,
  isPeriodDebtSource,
  resolveImportBank,
  statementTxSource,
} from "@/lib/import/source";
import { logicalExpenseKey, logicalMerchantKey } from "@/lib/import/dedupe";

export { logicalExpenseKey };

export type ImportBbvaResult = {
  statementId: string | null;
  total: number;
  uniqueInFile: number;
  duplicatesInFile: number;
  alreadyExists: number;
  inserted: number;
  skipped: number;
  skippedOtherCard: number;
  primaryCardLast4: string | null;
  learnedHits: number;
  overlapPct: number;
  fullyDuplicate: boolean;
  warning: string | null;
  message: string;
  hint: string | null;
  source: string;
  bank: string;
};

function buildImportMessage(r: {
  total: number;
  uniqueInFile: number;
  duplicatesInFile: number;
  alreadyExists: number;
  inserted: number;
}): { message: string; warning: string | null; fullyDuplicate: boolean; overlapPct: number } {
  const overlapPct =
    r.uniqueInFile > 0
      ? Math.round((r.alreadyExists / r.uniqueInFile) * 100)
      : 0;
  const fullyDuplicate = r.uniqueInFile > 0 && r.inserted === 0;

  if (r.total === 0) {
    return {
      message: "No se leyeron movimientos del archivo.",
      warning: null,
      fullyDuplicate: false,
      overlapPct: 0,
    };
  }

  if (fullyDuplicate) {
    const warning =
      r.alreadyExists > 0
        ? `Este resumen parece ya estar cargado: ${r.alreadyExists} coincidencia${r.alreadyExists === 1 ? "" : "s"} con lo que ya tenés. No se importó nada nuevo.`
        : `El archivo no tenía movimientos nuevos para importar.`;
    return {
      message: warning,
      warning,
      fullyDuplicate: true,
      overlapPct,
    };
  }

  const parts: string[] = [];
  parts.push(
    `${r.inserted} movimiento${r.inserted === 1 ? "" : "s"} nuevo${r.inserted === 1 ? "" : "s"}`,
  );
  if (r.alreadyExists > 0) {
    parts.push(
      `${r.alreadyExists} ya existían (coincidencias con lo cargado)`,
    );
  }
  if (r.duplicatesInFile > 0) {
    parts.push(
      `${r.duplicatesInFile} fila${r.duplicatesInFile === 1 ? "" : "s"} repetida${r.duplicatesInFile === 1 ? "" : "s"} en el archivo`,
    );
  }
  parts.push(`${r.total} filas leídas`);

  let warning: string | null = null;
  if (overlapPct >= 80) {
    warning = `Alta superposición (${overlapPct}%): este archivo se parece mucho a un resumen ya importado. Solo se agregaron ${r.inserted} nuevos.`;
  } else if (r.alreadyExists > 0) {
    warning = `${r.alreadyExists} coincidencia${r.alreadyExists === 1 ? "" : "s"} con movimientos ya cargados (misma fecha, comercio e importe). Esos no se volvieron a importar.`;
  }

  return {
    message: parts.join(" · "),
    warning,
    fullyDuplicate: false,
    overlapPct,
  };
}

function otherCardNote(
  skippedOtherCard: number,
  primaryCardLast4: string | null,
  source: string,
): string {
  if (skippedOtherCard <= 0 || !primaryCardLast4) return "";
  const period = isPeriodDebtSource(source)
    ? " El período entra en Deuda, no en la neta."
    : "";
  return ` Se omitió la otra tarjeta (${skippedOtherCard} filas; tu cuenta es ****${primaryCardLast4}).${period}`;
}

export async function importBbvaFile(opts: {
  householdId: string;
  userId: string;
  fileName: string;
  buffer: Buffer;
  bank?: string | null;
}): Promise<ImportBbvaResult> {
  if (detectFileKind(opts.buffer, opts.fileName) === "pdf") {
    try {
      await putStatementPdf({
        householdId: opts.householdId,
        body: opts.buffer,
      });
    } catch {
      console.warn("[import] statement PDF was not stored");
    }
  }

  const parsed = await parseStatementFile(opts.buffer, opts.fileName);
  const bank = resolveImportBank({
    selected: opts.bank,
    detected: parsed.detectedBank,
    fileName: opts.fileName,
  });
  const { source } = parsed;
  const db = (await getDb());

  const [settingsRow] = await db
    .select({
      cardLast4: schema.debtSettings.cardLast4,
    })
    .from(schema.debtSettings)
    .where(eq(schema.debtSettings.userId, opts.userId))
    .limit(1);

  const existingMine =
    parsed.movements.length > 0
      ? await db
          .select({
            descriptionNormalized: schema.transactions.descriptionNormalized,
          })
          .from(schema.transactions)
          .where(
            and(
              eq(schema.transactions.householdId, opts.householdId),
              eq(schema.transactions.paidByUserId, opts.userId),
            ),
          )
          .limit(4000)
      : [];

  const primaryCardLast4 = pickPrimaryCardLast4(parsed.movements, {
    preferredLast4: settingsRow?.cardLast4,
    knownDescriptions: existingMine.map((r) => r.descriptionNormalized),
  });
  const scoped = filterToPrimaryCard(parsed.movements, primaryCardLast4);
  const skippedOtherCard = parsed.movements.length - scoped.length;
  const movements = scoped;
  const total = parsed.movements.length;

  if (primaryCardLast4 && !settingsRow?.cardLast4) {
    await db
      .insert(schema.debtSettings)
      .values({
        userId: opts.userId,
        cardLast4: primaryCardLast4,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: schema.debtSettings.userId,
        set: { cardLast4: primaryCardLast4, updatedAt: new Date() },
      });
  }

  // Rainman: card statement SALDO ACTUAL → saldo_deuda (CA$ checking is ignored by parser).
  const cardSaldo = parsed.cardSaldo ?? null;
  if (cardSaldo && cardSaldo.ars > 0) {
    await db
      .insert(schema.debtSettings)
      .values({
        userId: opts.userId,
        cardLast4: primaryCardLast4 ?? settingsRow?.cardLast4 ?? null,
        saldoDeudaArs: cardSaldo.ars.toFixed(2),
        saldoDeudaUsd:
          cardSaldo.usd != null && cardSaldo.usd > 0
            ? cardSaldo.usd.toFixed(2)
            : null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: schema.debtSettings.userId,
        set: {
          saldoDeudaArs: cardSaldo.ars.toFixed(2),
          saldoDeudaUsd:
            cardSaldo.usd != null && cardSaldo.usd > 0
              ? cardSaldo.usd.toFixed(2)
              : null,
          updatedAt: new Date(),
          ...(primaryCardLast4 && !settingsRow?.cardLast4
            ? { cardLast4: primaryCardLast4 }
            : {}),
        },
      });
  }

  if (movements.length === 0) {
    const empty = emptyParseMessage({
      fileName: opts.fileName,
      fileKind: parsed.fileKind,
      pdfTextLength: parsed.pdfTextLength,
    });
    const pdfEngineDown =
      parsed.fileKind === "pdf" &&
      parsed.pdfTextLength == null &&
      Boolean(parsed.hint);
    const meta = buildImportMessage({
      total: 0,
      uniqueInFile: 0,
      duplicatesInFile: 0,
      alreadyExists: 0,
      inserted: 0,
    });
    const otherCardNote =
      skippedOtherCard > 0 && primaryCardLast4
        ? ` Se omitió la otra tarjeta (no es ****${primaryCardLast4}).`
        : "";
    return {
      statementId: null,
      total,
      uniqueInFile: 0,
      duplicatesInFile: 0,
      alreadyExists: 0,
      inserted: 0,
      skipped: skippedOtherCard,
      skippedOtherCard,
      primaryCardLast4,
      learnedHits: 0,
      ...meta,
      message: (pdfEngineDown ? parsed.hint! : empty.message) + otherCardNote,
      hint: parsed.hint ?? empty.hint,
      source,
      bank,
    };
  }

  const seenInFile = new Set<string>();
  const uniqueMovements = [];
  let duplicatesInFile = 0;
  for (const m of movements) {
    if (seenInFile.has(m.fingerprint)) {
      duplicatesInFile++;
      continue;
    }
    seenInFile.add(m.fingerprint);
    uniqueMovements.push(m);
  }

  const fingerprints = uniqueMovements.map((m) => m.fingerprint);

  // Sequential chunks: D1 allows 100 bound params. household_id uses one.
  const existingRows = await mapInChunks(fingerprints, 1, (chunk) =>
    db
      .select({ fp: schema.transactions.externalFingerprint })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.householdId, opts.householdId),
          inArray(schema.transactions.externalFingerprint, chunk),
        ),
      ),
  );

  const existingFp = new Set(existingRows.map((r) => r.fp));

  const dates = [...new Set(uniqueMovements.map((m) => m.date))];
  const existingLogical = await mapInChunks(dates, 1, (chunk) =>
    db
      .select({
        date: schema.transactions.date,
        descriptionNormalized: schema.transactions.descriptionNormalized,
        amountArs: schema.transactions.amountArs,
        amountUsd: schema.transactions.amountUsd,
        installment: schema.transactions.installment,
        isPayment: schema.transactions.isPayment,
      })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.householdId, opts.householdId),
          inArray(schema.transactions.date, chunk),
        ),
      ),
  );

  const existingLogicalKeys = new Set(
    existingLogical.map((r) =>
      logicalExpenseKey({
        date: r.date,
        descriptionNormalized: r.descriptionNormalized,
        amountArs: r.amountArs != null ? Number(r.amountArs) : null,
        amountUsd: r.amountUsd != null ? Number(r.amountUsd) : null,
        installment: r.installment,
        isPayment: r.isPayment,
      }),
    ),
  );
  const existingMerchantKeys = new Set(
    existingLogical.flatMap((r) => {
      const key = logicalMerchantKey({
        date: r.date,
        descriptionNormalized: r.descriptionNormalized,
        amountArs: r.amountArs != null ? Number(r.amountArs) : null,
        amountUsd: r.amountUsd != null ? Number(r.amountUsd) : null,
      });
      return key ? [key] : [];
    }),
  );

  const insertedLogical = new Set<string>();
  const insertedMerchant = new Set<string>();

  const toInsert = uniqueMovements.filter((m) => {
    if (existingFp.has(m.fingerprint)) return false;
    const key = logicalExpenseKey(m);
    if (existingLogicalKeys.has(key)) return false;
    if (insertedLogical.has(key)) return false;
    const merchantKey = logicalMerchantKey(m);
    if (merchantKey && (existingMerchantKeys.has(merchantKey) || insertedMerchant.has(merchantKey))) {
      return false;
    }
    insertedLogical.add(key);
    if (merchantKey) insertedMerchant.add(merchantKey);
    return true;
  });
  const alreadyExists = uniqueMovements.length - toInsert.length;

  if (toInsert.length === 0) {
    const meta = buildImportMessage({
      total,
      uniqueInFile: uniqueMovements.length,
      duplicatesInFile,
      alreadyExists,
      inserted: 0,
    });
    return {
      statementId: null,
      total,
      uniqueInFile: uniqueMovements.length,
      duplicatesInFile,
      alreadyExists,
      inserted: 0,
      skipped: alreadyExists + duplicatesInFile + skippedOtherCard,
      skippedOtherCard,
      primaryCardLast4,
      learnedHits: 0,
      ...meta,
      message:
        meta.message + otherCardNote(skippedOtherCard, primaryCardLast4, source),
      hint: null,
      source,
      bank,
    };
  }

  const { bySlug } = await getCategoryMap();

  const [statement] = await db
    .insert(schema.cardStatements)
    .values({
      householdId: opts.householdId,
      source,
      fileName: opts.fileName,
      importedBy: opts.userId,
      rowCount: toInsert.length,
    })
    .returning();

  let inserted = 0;
  let learnedHits = 0;
  let insertFailed = 0;
  const txSource = statementTxSource(source);
  const pendingRows: Array<typeof schema.transactions.$inferInsert> = [];

  for (const m of toInsert) {
    let catMatch;
    if (m.categoryHint) {
      const hinted = bySlug.get(m.categoryHint);
      catMatch = {
        slug: m.categoryHint,
        categoryId: hinted?.id,
        learned: false as const,
      };
    } else {
      catMatch = await matchCategoryWithLearning(
        opts.householdId,
        m.descriptionNormalized,
      );
    }
    if (catMatch.learned) learnedHits++;
    const category =
      (catMatch.categoryId ? { id: catMatch.categoryId } : null) ??
      bySlug.get(catMatch.slug) ??
      bySlug.get("uncategorized");

    const ownership = "personal" as const;

    pendingRows.push({
      householdId: opts.householdId,
      statementId: statement.id,
      date: m.date,
      descriptionRaw: m.descriptionRaw,
      descriptionNormalized: m.descriptionNormalized,
      amountArs: m.amountArs != null ? String(m.amountArs) : null,
      amountUsd: m.amountUsd != null ? String(m.amountUsd) : null,
      installment: m.installment,
      isPayment: m.isPayment,
      isCredit: m.isCredit,
      categoryId: category?.id,
      ownership,
      paidByUserId: opts.userId,
      externalFingerprint: m.fingerprint,
      source: txSource,
      bank,
      cardLast4: m.cardLast4 ?? primaryCardLast4,
    });
  }

  // 17 bound values per row. Chunks stay under D1's 100-param cap.
  // Sequential, not one transaction: D1 has no interactive transactions.
  for (const chunk of chunkByBoundParams(pendingRows, 17)) {
    try {
      const insertedRows = await db
        .insert(schema.transactions)
        .values(chunk)
        .onConflictDoNothing()
        .returning({ id: schema.transactions.id });
      inserted += insertedRows.length;
      insertFailed += chunk.length - insertedRows.length;
    } catch {
      for (const row of chunk) {
        try {
          await db.insert(schema.transactions).values(row);
          inserted++;
        } catch {
          insertFailed++;
        }
      }
    }
  }

  const finalAlreadyExists = alreadyExists + insertFailed;
  const meta = buildImportMessage({
    total,
    uniqueInFile: uniqueMovements.length,
    duplicatesInFile,
    alreadyExists: finalAlreadyExists,
    inserted,
  });

  return {
    statementId: statement.id,
    total,
    uniqueInFile: uniqueMovements.length,
    duplicatesInFile,
    alreadyExists: finalAlreadyExists,
    inserted,
    skipped: finalAlreadyExists + duplicatesInFile + skippedOtherCard,
    skippedOtherCard,
    primaryCardLast4,
    learnedHits,
    ...meta,
    message:
      meta.message + otherCardNote(skippedOtherCard, primaryCardLast4, source),
    hint: isPeriodDebtSource(source)
      ? "Este Excel es el período de la tarjeta: va a Deuda (cuotas), no a la neta de gastos."
      : null,
    source,
    bank,
  };
}

export async function importTransparenciaConsumos(opts: {
  householdId: string;
  userId: string;
  fileName: string;
  buffer: Buffer;
  bank?: string | null;
}) {
  const bank = opts.bank?.trim() || null;
  const rows = parseTransparenciaConsumos(opts.buffer);
  const db = (await getDb());
  const { bySlug } = await getCategoryMap();

  const seen = new Set<string>();
  const unique = [];
  let duplicatesInFile = 0;
  for (const r of rows) {
    if (seen.has(r.fingerprint)) {
      duplicatesInFile++;
      continue;
    }
    seen.add(r.fingerprint);
    unique.push(r);
  }

  const fps = unique.map((r) => r.fingerprint);
  const existingRows = await mapInChunks(fps, 1, (chunk) =>
    db
      .select({ fp: schema.transactions.externalFingerprint })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.householdId, opts.householdId),
          inArray(schema.transactions.externalFingerprint, chunk),
        ),
      ),
  );
  const existingFp = new Set(existingRows.map((r) => r.fp));
  const toInsert = unique.filter((r) => !existingFp.has(r.fingerprint));
  const alreadyExists = unique.length - toInsert.length;

  if (toInsert.length === 0) {
    return {
      statementId: null as string | null,
      total: rows.length,
      uniqueInFile: unique.length,
      duplicatesInFile,
      alreadyExists,
      inserted: 0,
      skipped: alreadyExists + duplicatesInFile,
      message:
        alreadyExists > 0
          ? `Ya estaba cargado: ${alreadyExists} coincidencias. No se importó nada nuevo.`
          : "No hay filas nuevas para importar.",
      warning:
        alreadyExists > 0
          ? `Este archivo tiene ${alreadyExists} coincidencias con lo ya cargado.`
          : null,
      fullyDuplicate: true,
    };
  }

  const [statement] = await db
    .insert(schema.cardStatements)
    .values({
      householdId: opts.householdId,
      source: "transparencia_xlsx",
      fileName: opts.fileName,
      importedBy: opts.userId,
      rowCount: toInsert.length,
    })
    .returning();

  let inserted = 0;
  let skipped = alreadyExists + duplicatesInFile;

  const pendingRows = toInsert.map((r) => {
    const slug = categoryNameToSlug(r.categoryName);
    const category = bySlug.get(slug) ?? bySlug.get("uncategorized");
    return {
      householdId: opts.householdId,
      statementId: statement.id,
      date: r.date,
      descriptionRaw: r.description,
      descriptionNormalized: r.description,
      amountArs: r.amountArs != null ? String(r.amountArs) : null,
      amountUsd: r.amountUsd != null ? String(r.amountUsd) : null,
      isPayment: false,
      isCredit: false,
      categoryId: category?.id,
      ownership: "personal" as const,
      paidByUserId: opts.userId,
      externalFingerprint: r.fingerprint,
      source: "transparencia",
      bank,
    };
  });

  // 15 bound values per row. Sequential chunks, not one D1 transaction.
  for (const chunk of chunkByBoundParams(pendingRows, 15)) {
    try {
      const insertedRows = await db
        .insert(schema.transactions)
        .values(chunk)
        .onConflictDoNothing()
        .returning({ id: schema.transactions.id });
      inserted += insertedRows.length;
      skipped += chunk.length - insertedRows.length;
    } catch {
      for (const row of chunk) {
        try {
          await db.insert(schema.transactions).values(row);
          inserted++;
        } catch {
          skipped++;
        }
      }
    }
  }

  return {
    statementId: statement.id,
    total: rows.length,
    uniqueInFile: unique.length,
    duplicatesInFile,
    alreadyExists,
    inserted,
    skipped,
    message: `${inserted} nuevos · ${alreadyExists} ya existían · ${rows.length} filas leídas`,
    warning:
      alreadyExists > 0
        ? `${alreadyExists} coincidencias con lo ya cargado (no se reimportaron).`
        : null,
    fullyDuplicate: false,
  };
}
