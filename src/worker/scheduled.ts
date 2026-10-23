/**
 * Nightly housekeeping. Later phases add: posting recurring rules, insights, forecast, digest.
 *
 * Phase 0 does two things:
 *  1. retries statement emails stuck in `received` (inline parsing died, or the Worker was
 *     restarted mid-job); an email that fails again is marked `failed` so it is not retried forever
 *  2. enforces raw-mail retention: raw .eml files older than the window are deleted from R2,
 *     while the parsed rows and import lines stay
 */
import { and, eq, isNotNull, lt } from "drizzle-orm";
import { getDb, schema } from "./db";
import type { AppEnv } from "./env";
import { processStatementEmail } from "./ingest/consumer";
import { nowIso } from "./lib/ids";

const STUCK_AFTER_MINUTES = 10;

export async function handleScheduled(env: AppEnv): Promise<void> {
  await retryStuckStatements(env);
  await enforceRawMailRetention(env);
  await forgetOldIdempotencyKeys(env);
}

/** Replay answers for offline writes are only needed for days; a month is plenty. */
async function forgetOldIdempotencyKeys(env: AppEnv): Promise<void> {
  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
  await getDb(env.DB).delete(schema.idempotencyKeys).where(lt(schema.idempotencyKeys.createdAt, cutoff));
}

async function retryStuckStatements(env: AppEnv): Promise<void> {
  const db = getDb(env.DB);
  const cutoff = new Date(Date.now() - STUCK_AFTER_MINUTES * 60_000).toISOString();
  const stuck = await db
    .select({ id: schema.statementEmails.id, householdId: schema.statementEmails.householdId })
    .from(schema.statementEmails)
    .where(and(eq(schema.statementEmails.status, "received"), lt(schema.statementEmails.receivedAt, cutoff)))
    .limit(25);
  let failed = 0;
  for (const row of stuck) {
    try {
      await processStatementEmail({ kind: "parse-statement-email", statementEmailId: row.id, householdId: row.householdId }, env);
    } catch (err) {
      failed++;
      await db
        .update(schema.statementEmails)
        .set({ status: "failed", error: `retry failed: ${err instanceof Error ? err.message : String(err)}`, processedAt: nowIso() })
        .where(and(eq(schema.statementEmails.id, row.id), eq(schema.statementEmails.status, "received")));
    }
  }
  console.log(`[cron] stuck statements: ${stuck.length} retried, ${failed} failed`);
}

async function enforceRawMailRetention(env: AppEnv): Promise<void> {
  const days = Number(env.RAW_MAIL_RETENTION_DAYS) || 90;
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const db = getDb(env.DB);
  const old = await db
    .select({ id: schema.statementEmails.id, r2Key: schema.statementEmails.r2Key })
    .from(schema.statementEmails)
    .where(and(lt(schema.statementEmails.receivedAt, cutoff), isNotNull(schema.statementEmails.processedAt)))
    .limit(200);
  let deleted = 0;
  for (const row of old) {
    const head = await env.RAW_MAIL.head(row.r2Key);
    if (head) {
      await env.RAW_MAIL.delete(row.r2Key);
      deleted++;
    }
  }
  console.log(`[cron] raw-mail retention: ${deleted} raw messages older than ${days} days deleted`);
}
