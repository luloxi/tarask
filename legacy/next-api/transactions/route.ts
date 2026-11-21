import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { and, eq, inArray } from "drizzle-orm";
import { requireApiUser } from "@/lib/api-auth";
import { getCategoryMap, listUserHouseholds, requireHousehold } from "@/lib/household";
import {
  isVisibleToUser,
  listTransactions,
  moveTransactionToHousehold,
  updateTransaction,
} from "@/lib/transactions";
import {
  forceSharedOnlyForHousehold,
  resolvePersonalHouseholdId,
} from "@/lib/personal-household";
import { getDb, schema } from "@/lib/db";
import { mapInChunks } from "@/lib/db/chunk";
import { normalizeBank } from "@/lib/banks";
import {
  isHogarReintegroDescription,
  looksLikeHogarReintegroPayee,
} from "@/lib/reintegro-hogar";
import { reintegroPayeeGroups } from "@/lib/reintegro-hogar-server";

export async function GET(req: Request) {
  const authResult = await requireApiUser();
  if ("error" in authResult) return authResult.error;
  const { user: sessionUser } = authResult;
  try {
    const ctx = await requireHousehold(sessionUser.id);
    // Rainman one-shot: self/FX → Transferencia interna + purge bad Ingresos Variables.
    // Idempotent; cleans live DB without manual wipe / re-import.
    if (authResult.authKind === "session") {
      try {
        const { reclassifyFiwindNoise } = await import(
          "@/lib/import/reclassify-fiwind"
        );
        await reclassifyFiwindNoise(ctx.household.id, {
          userId: sessionUser.id,
        });
      } catch {
        // Non-fatal — listing still works if reclassify hiccups.
      }
    }
    const { searchParams } = new URL(req.url);
    const period = searchParams.get("period") ?? undefined;
    const categoryId = searchParams.get("categoryId") ?? undefined;
    const q = searchParams.get("q") ?? undefined;
    const uncategorizedOnly =
      searchParams.get("uncategorized") === "1" ||
      searchParams.get("uncategorized") === "true";
    const sharedOnlyParam =
      searchParams.get("shared") === "1" ||
      searchParams.get("shared") === "true";
    // Casita / non-Personal: never list Asignar=Personal (ownership=personal) rows.
    const sharedOnly =
      sharedOnlyParam || forceSharedOnlyForHousehold(ctx.household.name);

    const [rows, mapAll, mapVisible] = await Promise.all([
      listTransactions(ctx.household.id, {
        period,
        categoryId,
        q,
        uncategorizedOnly,
        viewerUserId: sessionUser.id,
        sharedOnly,
      }),
      getCategoryMap({
        householdId: ctx.household.id,
        includeHidden: true,
      }),
      getCategoryMap({ householdId: ctx.household.id }),
    ]);

    const { byId } = mapAll;
    const cats = mapVisible.cats;

    const db = (await getDb());
    const txIds = rows.map((r) => r.id);
    const receiptByTx = new Map<
      string,
      {
        id: string;
        merchantName: string | null;
        receiptDate: string | null;
        totalArs: number | null;
        items: Array<{
          id: string;
          name: string;
          quantity: number | null;
          unitPrice: number | null;
          lineTotal: number | null;
          productCategory: string | null;
        }>;
      }
    >();

    if (txIds.length > 0) {
      const receipts = await db
        .select()
        .from(schema.receipts)
        .where(eq(schema.receipts.householdId, ctx.household.id));

      const linked = receipts.filter(
        (r) => r.transactionId && txIds.includes(r.transactionId),
      );
      const receiptIds = linked.map((r) => r.id);
      const items =
        receiptIds.length > 0
          ? await mapInChunks(receiptIds, 0, (chunk) =>
              db
                .select()
                .from(schema.receiptItems)
                .where(inArray(schema.receiptItems.receiptId, chunk)),
            )
          : [];

      for (const r of linked) {
        if (!r.transactionId) continue;
        receiptByTx.set(r.transactionId, {
          id: r.id,
          merchantName: r.merchantName,
          receiptDate: r.receiptDate,
          totalArs: r.totalArs != null ? Number(r.totalArs) : null,
          items: items
            .filter((i) => i.receiptId === r.id)
            .map((i) => ({
              id: i.id,
              name: i.name,
              quantity: i.quantity != null ? Number(i.quantity) : null,
              unitPrice: i.unitPrice != null ? Number(i.unitPrice) : null,
              lineTotal: i.lineTotal != null ? Number(i.lineTotal) : null,
              productCategory: i.productCategory,
            })),
        });
      }
    }

    const payeeGroups = reintegroPayeeGroups();
    const data = rows.map((r) => {
      const receipt = receiptByTx.get(r.id) ?? null;
      return {
        id: r.id,
        date: r.date,
        descriptionNormalized: r.descriptionNormalized,
        amountArs: r.amountArs != null ? Number(r.amountArs) : null,
        amountUsd: r.amountUsd != null ? Number(r.amountUsd) : null,
        installment: r.installment,
        isPayment: r.isPayment,
        ownership: (r.ownership === "shared" ? "shared" : "personal") as
          | "personal"
          | "shared",
        paidByUserId: r.paidByUserId,
        source: r.source,
        bank: r.bank ?? null,
        category: r.categoryId ? (byId.get(r.categoryId) ?? null) : null,
        hasTicket: Boolean(receipt) || r.source === "receipt",
        receipt,
        canEdit:
          r.ownership === "shared" || r.paidByUserId === sessionUser.id,
        reintegroHogar: isHogarReintegroDescription(
          r.descriptionNormalized,
          payeeGroups,
        ),
        reintegroPayee: looksLikeHogarReintegroPayee(
          r.descriptionNormalized,
          payeeGroups,
        ),
      };
    });

    const members = ctx.members.map((m) => ({
      userId: m.userId,
      name: m.displayName || m.name || m.email || m.userId,
    }));

    return NextResponse.json({
      transactions: data,
      categories: cats,
      members,
      viewerUserId: sessionUser.id,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error";
    if (msg === "NO_HOUSEHOLD") {
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/** Create a manual expense (simple or with line items / ticket detail). */
export async function POST(req: Request) {
  const authResult = await requireApiUser();
  if ("error" in authResult) return authResult.error;
  const { user: sessionUser } = authResult;
  try {
    const ctx = await requireHousehold(sessionUser.id);
    const body = (await req.json()) as {
      date?: string;
      description?: string;
      amountArs?: number | string | null;
      amountUsd?: number | string | null;
      categoryId?: string | null;
      paidByUserId?: string | null;
      ownership?: "personal" | "shared";
      bank?: string | null;
      items?: Array<{
        name: string;
        quantity?: number | null;
        unitPrice?: number | null;
        lineTotal?: number | null;
        productCategory?: string | null;
      }>;
    };

    const date = (body.date || "").trim();
    const description = (body.description || "").trim();
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json(
        { error: "Fecha inválida (YYYY-MM-DD)" },
        { status: 400 },
      );
    }
    if (!description) {
      return NextResponse.json({ error: "Falta la descripción" }, { status: 400 });
    }

    const items = Array.isArray(body.items)
      ? body.items.filter((i) => i?.name?.trim())
      : [];

    let amountArs: number | null =
      body.amountArs != null && body.amountArs !== ""
        ? Math.abs(Number(body.amountArs))
        : null;
    if (Number.isNaN(amountArs as number)) amountArs = null;

    if (items.length > 0 && (amountArs == null || amountArs === 0)) {
      const sum = items.reduce((s, i) => {
        const lt =
          i.lineTotal != null
            ? Number(i.lineTotal)
            : i.unitPrice != null && i.quantity != null
              ? Number(i.unitPrice) * Number(i.quantity)
              : 0;
        return s + (Number.isFinite(lt) ? Math.abs(lt) : 0);
      }, 0);
      if (sum > 0) amountArs = sum;
    }

    if (amountArs == null && body.amountUsd == null) {
      return NextResponse.json(
        { error: "Indicá un monto en $ o USD" },
        { status: 400 },
      );
    }

    const amountUsd =
      body.amountUsd != null && body.amountUsd !== ""
        ? Math.abs(Number(body.amountUsd))
        : null;

    const { byId, bySlug } = await getCategoryMap({
      householdId: ctx.household.id,
      includeHidden: true,
    });
    let categoryId =
      body.categoryId && byId.has(body.categoryId) ? body.categoryId : null;
    if (!categoryId && items.length > 0) {
      categoryId = bySlug.get("supermercado")?.id ?? null;
    }
    if (!categoryId) {
      categoryId = bySlug.get("uncategorized")?.id ?? null;
    }

    const paidBy =
      body.paidByUserId &&
      ctx.members.some((m) => m.userId === body.paidByUserId)
        ? body.paidByUserId
        : sessionUser.id;

    const ownership =
      body.ownership === "shared" ? "shared" : "personal";

    const bank = normalizeBank(body.bank);

    const fp = createHash("sha256")
      .update(
        `manual|${date}|${description}|${amountArs ?? ""}|${amountUsd ?? ""}|${Date.now()}|${Math.random()}`,
      )
      .digest("hex")
      .slice(0, 32);

    const db = (await getDb());
    const [tx] = await db
      .insert(schema.transactions)
      .values({
        householdId: ctx.household.id,
        date,
        descriptionRaw: description,
        descriptionNormalized: description,
        amountArs: amountArs != null ? String(amountArs) : null,
        amountUsd:
          amountUsd != null && !Number.isNaN(amountUsd)
            ? String(amountUsd)
            : null,
        categoryId,
        ownership,
        paidByUserId: paidBy,
        externalFingerprint: fp,
        source: items.length > 0 ? "receipt" : "manual",
        bank,
      })
      .returning();

    let receipt = null;
    if (items.length > 0) {
      const [rec] = await db
        .insert(schema.receipts)
        .values({
          householdId: ctx.household.id,
          imageUrl: "manual://expense",
          merchantName: description,
          receiptDate: date,
          totalArs: amountArs != null ? String(amountArs) : null,
          currency: "ARS",
          status: "matched",
          transactionId: tx.id,
          createdBy: sessionUser.id,
          ocrRaw: { source: "manual", items },
        })
        .returning();
      receipt = rec;

      for (const item of items) {
        const qty = item.quantity != null ? Number(item.quantity) : 1;
        const unit =
          item.unitPrice != null ? Number(item.unitPrice) : null;
        let line =
          item.lineTotal != null ? Number(item.lineTotal) : null;
        if (line == null && unit != null && Number.isFinite(qty)) {
          line = unit * qty;
        }
        await db.insert(schema.receiptItems).values({
          receiptId: rec.id,
          name: item.name.trim(),
          quantity: Number.isFinite(qty) ? String(qty) : "1",
          unitPrice: unit != null && Number.isFinite(unit) ? String(unit) : null,
          lineTotal: line != null && Number.isFinite(line) ? String(line) : null,
          productCategory: item.productCategory?.trim() || null,
        });
      }
    }

    return NextResponse.json({ transaction: tx, receipt }, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Error" },
      { status: 500 },
    );
  }
}

export async function PATCH(req: Request) {
  const authResult = await requireApiUser();
  if ("error" in authResult) return authResult.error;
  const { user: sessionUser } = authResult;
  try {
    const ctx = await requireHousehold(sessionUser.id);
    const body = await req.json();
    if (!body.id) {
      return NextResponse.json({ error: "Falta id" }, { status: 400 });
    }

    const db = (await getDb());
    const [before] = await db
      .select()
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.id, body.id),
          eq(schema.transactions.householdId, ctx.household.id),
        ),
      )
      .limit(1);

    if (!before) {
      return NextResponse.json({ error: "No encontrado" }, { status: 404 });
    }

    if (!isVisibleToUser(before, sessionUser.id)) {
      return NextResponse.json({ error: "Sin permiso" }, { status: 403 });
    }
    if (
      before.ownership === "personal" &&
      before.paidByUserId !== sessionUser.id
    ) {
      return NextResponse.json({ error: "Sin permiso" }, { status: 403 });
    }

    // Assign → Personal space (bank dump hogar), not merely ownership flip in-place.
    if (body.ownership === "personal" && !body.targetHouseholdId) {
      const personalId = await resolvePersonalHouseholdId(sessionUser.id);
      if (personalId && personalId !== ctx.household.id) {
        const moved = await moveTransactionToHousehold({
          fromHouseholdId: ctx.household.id,
          toHouseholdId: personalId,
          txId: body.id,
          userId: sessionUser.id,
          ownership: "personal",
        });
        return NextResponse.json({
          transaction: moved,
          moved: true,
          targetHouseholdId: personalId,
          learned: 0,
          similarUpdated: 0,
          similarCount: 0,
          appliedToSimilar: false,
        });
      }
    }

    const targetHouseholdId =
      typeof body.targetHouseholdId === "string"
        ? body.targetHouseholdId.trim()
        : "";
    if (targetHouseholdId && targetHouseholdId !== ctx.household.id) {
      const households = await listUserHouseholds(sessionUser.id);
      if (!households.some((h) => h.id === targetHouseholdId)) {
        return NextResponse.json(
          { error: "No pertenecés a ese hogar" },
          { status: 403 },
        );
      }
      const dest = households.find((h) => h.id === targetHouseholdId);
      const destOwnership =
        dest &&
        (dest.name === "Personal" ||
          dest.name === "Mi espacio")
          ? ("personal" as const)
          : ("shared" as const);
      const moved = await moveTransactionToHousehold({
        fromHouseholdId: ctx.household.id,
        toHouseholdId: targetHouseholdId,
        txId: body.id,
        userId: sessionUser.id,
        ownership: destOwnership,
      });
      return NextResponse.json({
        transaction: moved,
        moved: true,
        targetHouseholdId,
        learned: 0,
        similarUpdated: 0,
        similarCount: 0,
        appliedToSimilar: false,
      });
    }

    const nextOwnership = body.ownership as "personal" | "shared" | undefined;
    let nextPaidBy = body.paidByUserId as string | null | undefined;
    if (nextOwnership === "personal" && nextPaidBy == null) {
      nextPaidBy = sessionUser.id;
    }
    if (nextOwnership === "personal") {
      nextPaidBy = sessionUser.id;
    }

    const amountArs =
      "amountArs" in body
        ? body.amountArs == null || body.amountArs === ""
          ? null
          : Number(body.amountArs)
        : undefined;
    const amountUsd =
      "amountUsd" in body
        ? body.amountUsd == null || body.amountUsd === ""
          ? null
          : Number(body.amountUsd)
        : undefined;

    const wantsHouseholdReimbursement =
      body.householdReimbursement === true ||
      body.householdReimbursement === 1 ||
      body.householdReimbursement === "true";

    const wantsHouseholdBillCovered =
      body.householdBillCovered === true ||
      body.householdBillCovered === 1 ||
      body.householdBillCovered === "true";

    const nextIsPayment =
      body.isPayment === true
        ? true
        : body.isPayment === false
          ? false
          : body.internalTransfer === true ||
              wantsHouseholdReimbursement ||
              wantsHouseholdBillCovered
            ? true
            : undefined;

    const wantsInternalTransfer =
      body.internalTransfer === true ||
      body.internalTransfer === 1 ||
      body.internalTransfer === "true";

    // Only include fields the client sent. Passing amountArs: undefined still
    // puts the key on the patch object ("in" === true) and used to NULL montos
    // on Cubierto / Reintegro marks — Resumen Cubiertos then showed $0.
    const patch: Parameters<typeof updateTransaction>[2] = {
      isPayment: nextIsPayment,
    };
    if ("categoryId" in body) patch.categoryId = body.categoryId;
    // Rainman: Tipo Transferencia interna → category + isPayment (lists show them).
    if (wantsInternalTransfer && !("categoryId" in body)) {
      const { bySlug } = await getCategoryMap({
        householdId: ctx.household.id,
        includeHidden: true,
      });
      const internal =
        bySlug.get("transferencia-interna") ?? bySlug.get("conversiones");
      if (internal) patch.categoryId = internal.id;
      patch.isCredit = false;
    }
    if (nextOwnership !== undefined) patch.ownership = nextOwnership;
    if (nextPaidBy !== undefined) patch.paidByUserId = nextPaidBy;
    else if ("paidByUserId" in body) patch.paidByUserId = body.paidByUserId;
    if ("splitPct" in body) patch.splitPct = body.splitPct;
    if ("bank" in body) {
      patch.bank = normalizeBank(body.bank as string | null | undefined);
    }
    if ("date" in body && body.date != null && body.date !== "") {
      patch.date = String(body.date).trim();
    }
    if ("amountArs" in body) patch.amountArs = amountArs ?? null;
    if ("amountUsd" in body) patch.amountUsd = amountUsd ?? null;

    const row = await updateTransaction(ctx.household.id, body.id, patch);

    let learned = 0;
    let similarUpdated = 0;
    let similarCount = 0;
    let reintegroCount = 0;
    let cubiertoCount = 0;

    const categoryId =
      body.categoryId && typeof body.categoryId === "string"
        ? body.categoryId
        : null;
    const categoryChanged =
      Boolean(categoryId) && categoryId !== before.categoryId;
    const applyToSimilar =
      body.applyToSimilar === true ||
      body.applyToSimilar === 1 ||
      body.applyToSimilar === "true";

    // Learn/bulk-apply when user confirms "Aplicar", even if this PATCH
    // re-sends the same categoryId (first PATCH already saved Solo este).
    const shouldOfferOrApply =
      Boolean(categoryId) &&
      Boolean(before.descriptionNormalized) &&
      (categoryChanged || applyToSimilar) &&
      !wantsHouseholdReimbursement &&
      !wantsHouseholdBillCovered;

    if (shouldOfferOrApply && categoryId && before.descriptionNormalized) {
      const {
        learnFromCategorization,
        applyCategoryToSimilar,
        countSimilarByMerchant,
      } = await import("@/lib/categorize/learn");

      // N = total gastos on this account/merchant (including the one just edited)
      similarCount = await countSimilarByMerchant({
        householdId: ctx.household.id,
        description: before.descriptionNormalized,
      });

      if (applyToSimilar) {
        const { patterns } = await learnFromCategorization({
          householdId: ctx.household.id,
          description: before.descriptionNormalized,
          categoryId,
        });
        learned = patterns.length;
        similarUpdated = await applyCategoryToSimilar({
          householdId: ctx.household.id,
          description: before.descriptionNormalized,
          categoryId,
          excludeTxId: body.id,
        });
      }
    }

    // Reintegro hogar (servicios): isPayment, optional bulk to same payee.
    if (wantsHouseholdReimbursement && before.descriptionNormalized) {
      const {
        countHogarReintegroByMerchant,
        applyHogarReintegroToSimilar,
      } = await import("@/lib/reintegro-hogar-db");
      if (
        looksLikeHogarReintegroPayee(
          before.descriptionNormalized,
          reintegroPayeeGroups(),
        )
      ) {
        reintegroCount = await countHogarReintegroByMerchant({
          householdId: ctx.household.id,
          description: before.descriptionNormalized,
        });
        if (applyToSimilar) {
          similarUpdated = await applyHogarReintegroToSimilar({
            householdId: ctx.household.id,
            description: before.descriptionNormalized,
            excludeTxId: body.id,
          });
        }
        // Surface N for the toast even when only this row was marked.
        similarCount = reintegroCount;
      }
    } else if (
      before.descriptionNormalized &&
      !wantsHouseholdReimbursement &&
      !wantsHouseholdBillCovered &&
      body.skipReintegroOffer !== true &&
      (categoryChanged ||
        nextOwnership === "shared" ||
        body.offerReintegro === true)
    ) {
      // Offer count so Consumos can show the reintegro toast after an edit.
      const { countHogarReintegroByMerchant } = await import(
        "@/lib/reintegro-hogar-db"
      );
      if (
        looksLikeHogarReintegroPayee(
          before.descriptionNormalized,
          reintegroPayeeGroups(),
        )
      ) {
        reintegroCount = await countHogarReintegroByMerchant({
          householdId: ctx.household.id,
          description: before.descriptionNormalized,
          onlyUnset: true,
        });
      }
    }

    // Gasto hogar cubierto (luz/agua/…): isPayment, optional bulk same merchant.
    if (wantsHouseholdBillCovered && before.descriptionNormalized) {
      const {
        countGastoCubiertoByMerchant,
        applyGastoCubiertoToSimilar,
      } = await import("@/lib/gasto-cubierto-db");
      cubiertoCount = await countGastoCubiertoByMerchant({
        householdId: ctx.household.id,
        description: before.descriptionNormalized,
      });
      if (applyToSimilar) {
        similarUpdated = await applyGastoCubiertoToSimilar({
          householdId: ctx.household.id,
          description: before.descriptionNormalized,
          excludeTxId: body.id,
        });
      }
      similarCount = cubiertoCount;
    }

    return NextResponse.json({
      transaction: row,
      learned,
      similarUpdated,
      similarCount,
      reintegroCount,
      cubiertoCount,
      appliedToSimilar: Boolean(applyToSimilar),
      householdReimbursement: Boolean(wantsHouseholdReimbursement),
      householdBillCovered: Boolean(wantsHouseholdBillCovered),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Error" },
      { status: 500 },
    );
  }
}
