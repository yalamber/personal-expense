/**
 * Nightly housekeeping. Later phases add: posting recurring rules, insights, forecast, digest.
 * Phase 0 only enforces raw-mail retention: raw .eml files older than the retention window are
 * deleted from R2 while the parsed rows and import lines stay.
 */
import { lt, and, isNotNull } from "drizzle-orm";
import { getDb, schema } from "./db";
import type { AppEnv } from "./env";

export async function handleScheduled(env: AppEnv): Promise<void> {
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
