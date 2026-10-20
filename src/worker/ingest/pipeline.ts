/**
 * Turns parsed statement lines into import lines and, where the app is confident, transactions.
 *
 * For each line:
 *   1. normalise the description to a merchant (merchant memory supplies a category)
 *   2. look for an existing transaction on the same account with the same amount and direction
 *      within two days (an alert followed by the statement, or a manual entry)
 *   3. auto-post when there is no likely duplicate and the merchant already has a category;
 *      otherwise leave the line for a person in the review queue
 *
 * Query budget: merchants and duplicate candidates are loaded once, new merchants are created
 * one at a time, and all inserts go out in batches, which keeps large CSV imports well inside
 * the Workers request limits.
 */
import { and, between, count, eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { schema, type Db } from "../db";
import { newId, nowIso } from "../lib/ids";
import { loadMerchantIndex, resolveMerchant } from "../ledger/merchants";
import { findDuplicate, loadDedupeCandidates, transactionValues } from "../ledger/transactions";

export type IncomingLine = {
  rawText: string;
  date: string;
  /** Positive amount in minor units. */
  amountMinor: number;
  direction: "out" | "in";
  description: string;
  /** How sure the parser is about date, amount and direction, 0..100. */
  confidence: number;
};

/** alreadyQueued counts lines skipped because the exact same line is already waiting in the review queue. */
export type IngestResult = { total: number; autoPosted: number; needsReview: number; duplicates: number; alreadyQueued: number };

const AUTO_POST_MIN_CONFIDENCE = 80;
const BATCH_SIZE = 40;

export async function ingestLines(
  db: Db,
  ctx: { householdId: string; statementEmailId: string; accountId: string | null; source: "email" | "csv" },
  lines: IncomingLine[],
): Promise<IngestResult> {
  const result: IngestResult = { total: lines.length, autoPosted: 0, needsReview: 0, duplicates: 0, alreadyQueued: 0 };
  if (!lines.length) return result;

  const merchants = await loadMerchantIndex(db, ctx.householdId);
  const dates = lines.map((l) => l.date).sort();
  const candidates = ctx.accountId ? await loadDedupeCandidates(db, ctx.accountId, dates[0]!, dates[dates.length - 1]!) : [];
  const claimed = new Set<string>(); // one existing transaction can only explain one incoming line

  // Re-importing the same file must not queue the same pending lines twice.
  const queued = new Map<string, number>();
  if (ctx.accountId) {
    const pending = await db
      .select({ date: schema.importLines.parsedDate, amount: schema.importLines.parsedAmountMinor, description: schema.importLines.parsedDescription })
      .from(schema.importLines)
      .innerJoin(schema.statementEmails, eq(schema.statementEmails.id, schema.importLines.statementEmailId))
      .where(and(eq(schema.statementEmails.accountId, ctx.accountId), eq(schema.importLines.decision, "pending"), between(schema.importLines.parsedDate, dates[0]!, dates[dates.length - 1]!)));
    for (const p of pending) {
      const key = `${p.date}|${p.amount}|${p.description}`;
      queued.set(key, (queued.get(key) ?? 0) + 1);
    }
  }

  const statements: BatchItem<"sqlite">[] = [];
  for (const line of lines) {
    const queuedKey = `${line.date}|${line.direction === "out" ? -line.amountMinor : line.amountMinor}|${line.description.slice(0, 200)}`;
    const waiting = queued.get(queuedKey) ?? 0;
    if (waiting > 0) {
      queued.set(queuedKey, waiting - 1);
      result.alreadyQueued++;
      continue;
    }
    const merchant = await resolveMerchant(db, ctx.householdId, line.description, merchants);
    const duplicate = ctx.accountId ? findDuplicate(candidates, { accountId: ctx.accountId, date: line.date, amountMinor: line.amountMinor, direction: line.direction }, claimed) : null;
    if (duplicate) claimed.add(duplicate.id);

    const categoryId = merchant.defaultCategoryId;
    const canAutoPost = Boolean(ctx.accountId && !duplicate && categoryId && line.confidence >= AUTO_POST_MIN_CONFIDENCE);
    const lineId = newId();
    const confidence = duplicate ? Math.min(line.confidence, 50) : categoryId ? line.confidence : Math.min(line.confidence, 60);

    statements.push(
      db.insert(schema.importLines).values({
        id: lineId,
        householdId: ctx.householdId,
        statementEmailId: ctx.statementEmailId,
        rawText: line.rawText.slice(0, 500),
        parsedDate: line.date,
        parsedAmountMinor: line.direction === "out" ? -line.amountMinor : line.amountMinor,
        parsedDescription: line.description.slice(0, 200),
        confidence: Math.round(confidence),
        suggestedCategoryId: categoryId,
        matchTransactionId: duplicate?.id ?? null,
        decision: canAutoPost ? "auto" : "pending",
        decidedAt: canAutoPost ? nowIso() : null,
      }),
    );
    if (canAutoPost) {
      statements.push(
        db.insert(schema.transactions).values(
          transactionValues({
            householdId: ctx.householdId,
            accountId: ctx.accountId!,
            date: line.date,
            amountMinor: line.amountMinor,
            direction: line.direction,
            merchantId: merchant.id,
            categoryId,
            description: line.description,
            source: ctx.source,
            importLineId: lineId,
          }),
        ),
      );
      result.autoPosted++;
    } else {
      result.needsReview++;
      if (duplicate) result.duplicates++;
    }
  }

  for (let i = 0; i < statements.length; i += BATCH_SIZE) {
    const chunk = statements.slice(i, i + BATCH_SIZE);
    await db.batch(chunk as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  }
  return result;
}

/** Sets a statement's status from its import lines: review while any are pending, else done. */
export async function refreshStatementStatus(db: Db, statementEmailId: string, finished: "parsed" | "done" = "done"): Promise<void> {
  const [row] = await db
    .select({ pending: count() })
    .from(schema.importLines)
    .where(and(eq(schema.importLines.statementEmailId, statementEmailId), eq(schema.importLines.decision, "pending")));
  await db
    .update(schema.statementEmails)
    .set({ status: (row?.pending ?? 0) > 0 ? "review" : finished, processedAt: nowIso() })
    .where(eq(schema.statementEmails.id, statementEmailId));
}
