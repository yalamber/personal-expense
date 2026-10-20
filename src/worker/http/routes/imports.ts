import { Hono } from "hono";
import { and, asc, eq, inArray } from "drizzle-orm";
import { parseCsv } from "../../../shared/csv";
import { applyMapping, isCsvMapping, type CsvMapping } from "../../../shared/csv-mapping";
import { schema } from "../../db";
import { newId, nowIso } from "../../lib/ids";
import { ingestLines, refreshStatementStatus } from "../../ingest/pipeline";
import { normalizeMerchant } from "../../../shared/merchant";
import { loadMerchantIndex, rememberCategory, resolveMerchant } from "../../ledger/merchants";
import { transactionValues } from "../../ledger/transactions";
import type { AppContext, HonoEnv } from "../context";
import { readJson, requireWriter } from "../context";

export const importRoutes = new Hono<HonoEnv>();

const MAX_CSV_BYTES = 2 * 1024 * 1024;

async function getAccount(c: AppContext, accountId: string) {
  return c.get("db").query.accounts.findFirst({ where: and(eq(schema.accounts.id, accountId), eq(schema.accounts.householdId, c.get("household").id)) });
}

/** Saves the column mapping for an account's CSV format. */
importRoutes.put("/accounts/:accountId/csv-mapping", requireWriter, async (c) => {
  const account = await getAccount(c, c.req.param("accountId"));
  if (!account) return c.json({ error: "account not found" }, 404);
  const body = await readJson<{ mapping?: unknown }>(c);
  if (!isCsvMapping(body.mapping)) return c.json({ error: "invalid mapping" }, 400);
  await c.get("db").update(schema.accounts).set({ csvMapping: JSON.stringify(body.mapping) }).where(eq(schema.accounts.id, account.id));
  return c.json({ ok: true });
});

/**
 * Imports a CSV export for one account. The file is kept in R2 and recorded as a statement, so it
 * shows in the inbox next to emailed statements and its uncertain lines go to the review queue.
 */
importRoutes.post("/accounts/:accountId/import-csv", requireWriter, async (c) => {
  const db = c.get("db");
  const household = c.get("household");
  const account = await getAccount(c, c.req.param("accountId"));
  if (!account) return c.json({ error: "account not found" }, 404);

  const body = await readJson<{ csv?: string; filename?: string; mapping?: unknown; saveMapping?: boolean }>(c);
  const csv = typeof body.csv === "string" ? body.csv : "";
  if (!csv.trim()) return c.json({ error: "the file is empty" }, 400);
  if (csv.length > MAX_CSV_BYTES) return c.json({ error: "files up to 2 MB can be imported at once; split larger exports by date" }, 413);

  let mapping: CsvMapping | null = null;
  if (body.mapping !== undefined) {
    if (!isCsvMapping(body.mapping)) return c.json({ error: "invalid mapping" }, 400);
    mapping = body.mapping;
  } else if (account.csvMapping) {
    const saved = JSON.parse(account.csvMapping) as unknown;
    if (isCsvMapping(saved)) mapping = saved;
  }
  if (!mapping) return c.json({ error: "map the columns for this account first" }, 400);

  const { rows, errors } = applyMapping(parseCsv(csv), mapping, household.currency);
  if (!rows.length) return c.json({ error: "no transactions found with this mapping", errors: errors.slice(0, 20) }, 422);

  const statementId = newId();
  const filename = (body.filename ?? "upload.csv").replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "upload.csv";
  const r2Key = `households/${household.id}/uploads/${statementId}/${filename}`;
  await c.env.RAW_MAIL.put(r2Key, csv, { httpMetadata: { contentType: "text/csv" }, customMetadata: { householdId: household.id, uploadedBy: c.get("user").email } });
  await db.insert(schema.statementEmails).values({
    id: statementId,
    householdId: household.id,
    accountId: account.id,
    fromAddress: `upload:${c.get("user").email}`,
    toAddress: "upload",
    subject: filename,
    rawSize: csv.length,
    r2Key,
    parserKey: "csv-upload",
    status: "received",
  });
  if (body.saveMapping) await db.update(schema.accounts).set({ csvMapping: JSON.stringify(mapping) }).where(eq(schema.accounts.id, account.id));

  const result = await ingestLines(
    db,
    { householdId: household.id, statementEmailId: statementId, accountId: account.id, source: "csv" },
    rows.map((r) => ({ rawText: r.raw, date: r.date, amountMinor: r.amountMinor, direction: r.direction, description: r.description, confidence: 95 })),
  );
  await refreshStatementStatus(db, statementId, "parsed");
  return c.json({ statementId, ...result, skipped: errors.length, errors: errors.slice(0, 20) }, 201);
});

// ---------------------------------------------------------------------------
// Review queue
// ---------------------------------------------------------------------------

importRoutes.get("/review", async (c) => {
  const db = c.get("db");
  const householdId = c.get("household").id;
  const lines = await db
    .select({
      id: schema.importLines.id,
      statementEmailId: schema.importLines.statementEmailId,
      rawText: schema.importLines.rawText,
      date: schema.importLines.parsedDate,
      amountMinor: schema.importLines.parsedAmountMinor,
      description: schema.importLines.parsedDescription,
      confidence: schema.importLines.confidence,
      suggestedCategoryId: schema.importLines.suggestedCategoryId,
      matchTransactionId: schema.importLines.matchTransactionId,
      source: schema.statementEmails.subject,
      sourceFrom: schema.statementEmails.fromAddress,
      accountId: schema.statementEmails.accountId,
      accountName: schema.accounts.name,
    })
    .from(schema.importLines)
    .innerJoin(schema.statementEmails, eq(schema.statementEmails.id, schema.importLines.statementEmailId))
    .leftJoin(schema.accounts, eq(schema.accounts.id, schema.statementEmails.accountId))
    .where(and(eq(schema.importLines.householdId, householdId), eq(schema.importLines.decision, "pending")))
    .orderBy(asc(schema.importLines.parsedDate))
    .limit(300);

  const matchIds = lines.map((l) => l.matchTransactionId).filter((id): id is string => Boolean(id));
  const matches = matchIds.length
    ? await db
        .select({ id: schema.transactions.id, date: schema.transactions.date, amountMinor: schema.transactions.amountMinor, description: schema.transactions.description, source: schema.transactions.source })
        .from(schema.transactions)
        .where(inArray(schema.transactions.id, matchIds))
    : [];
  const byId = new Map(matches.map((m) => [m.id, m]));
  // Suggestions come from current merchant memory, so filing one line updates every similar line.
  const merchants = await loadMerchantIndex(db, householdId);
  return c.json(
    lines.map((l) => ({
      ...l,
      suggestedCategoryId: merchants.get(normalizeMerchant(l.description ?? "").key)?.defaultCategoryId ?? l.suggestedCategoryId,
      possibleDuplicate: l.matchTransactionId ? byId.get(l.matchTransactionId) ?? null : null,
    })),
  );
});

type PendingLine = typeof schema.importLines.$inferSelect & { accountId: string | null; fromAddress: string };

async function loadPending(c: AppContext, ids: string[]): Promise<PendingLine[]> {
  if (!ids.length) return [];
  const rows = await c
    .get("db")
    .select({ line: schema.importLines, accountId: schema.statementEmails.accountId, fromAddress: schema.statementEmails.fromAddress })
    .from(schema.importLines)
    .innerJoin(schema.statementEmails, eq(schema.statementEmails.id, schema.importLines.statementEmailId))
    .where(and(inArray(schema.importLines.id, ids), eq(schema.importLines.householdId, c.get("household").id), eq(schema.importLines.decision, "pending")));
  return rows.map((r) => ({ ...r.line, accountId: r.accountId, fromAddress: r.fromAddress }));
}

/** Posts a pending line as a transaction (teaching merchant memory) and marks it accepted. */
async function acceptLine(c: AppContext, line: PendingLine, categoryId: string | null): Promise<void> {
  const db = c.get("db");
  const householdId = c.get("household").id;
  if (!line.accountId) throw new Error("this line's statement has no account");
  const description = line.parsedDescription ?? "(no description)";
  const merchant = await resolveMerchant(db, householdId, description);
  const chosen = categoryId ?? line.suggestedCategoryId ?? merchant.defaultCategoryId;
  if (categoryId) await rememberCategory(db, merchant.id, categoryId);
  const amount = line.parsedAmountMinor ?? 0;
  await db.batch([
    db.insert(schema.transactions).values(
      transactionValues({
        householdId,
        accountId: line.accountId,
        date: line.parsedDate ?? nowIso().slice(0, 10),
        amountMinor: Math.abs(amount),
        direction: amount < 0 ? "out" : "in",
        merchantId: merchant.id,
        categoryId: chosen,
        description,
        source: line.fromAddress.startsWith("upload:") ? "csv" : "email",
        importLineId: line.id,
      }),
    ),
    db
      .update(schema.importLines)
      .set({ decision: "accepted", suggestedCategoryId: chosen, decidedByMemberId: c.get("member").id, decidedAt: nowIso() })
      .where(eq(schema.importLines.id, line.id)),
  ]);
}

/** Accepts every pending line that has a suggested category and no likely duplicate. */
importRoutes.post("/review/accept-suggested", requireWriter, async (c) => {
  const db = c.get("db");
  const candidates = await db
    .select({ id: schema.importLines.id, matchTransactionId: schema.importLines.matchTransactionId, suggestedCategoryId: schema.importLines.suggestedCategoryId })
    .from(schema.importLines)
    .where(and(eq(schema.importLines.householdId, c.get("household").id), eq(schema.importLines.decision, "pending")))
    .limit(200);
  const lines = await loadPending(
    c,
    candidates.filter((l) => !l.matchTransactionId).map((l) => l.id),
  );
  const merchants = await loadMerchantIndex(db, c.get("household").id);
  const statements = new Set<string>();
  let accepted = 0;
  for (const line of lines) {
    const suggestion = merchants.get(normalizeMerchant(line.parsedDescription ?? "").key)?.defaultCategoryId ?? line.suggestedCategoryId;
    if (!line.accountId || !suggestion) continue;
    await acceptLine(c, line, suggestion);
    statements.add(line.statementEmailId);
    accepted++;
  }
  for (const id of statements) await refreshStatementStatus(db, id);
  return c.json({ accepted });
});

/** Accept (optionally with a category) or reject one line. Rejecting a likely duplicate keeps the existing transaction. */
importRoutes.post("/review/:lineId", requireWriter, async (c) => {
  const body = await readJson<{ action?: string; categoryId?: string | null }>(c);
  const [line] = await loadPending(c, [c.req.param("lineId")]);
  if (!line) return c.json({ error: "not found or already decided" }, 404);
  if (body.categoryId) {
    const cat = await c.get("db").query.categories.findFirst({ where: and(eq(schema.categories.id, body.categoryId), eq(schema.categories.householdId, c.get("household").id)), columns: { id: true } });
    if (!cat) return c.json({ error: "category not found" }, 404);
  }
  if (body.action === "accept") {
    try {
      await acceptLine(c, line, body.categoryId ?? null);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "could not post this line" }, 409);
    }
  } else if (body.action === "reject") {
    await c.get("db").update(schema.importLines).set({ decision: "rejected", decidedByMemberId: c.get("member").id, decidedAt: nowIso() }).where(eq(schema.importLines.id, line.id));
  } else {
    return c.json({ error: "action must be accept or reject" }, 400);
  }
  await refreshStatementStatus(c.get("db"), line.statementEmailId);
  return c.json({ ok: true });
});
