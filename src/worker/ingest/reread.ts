/**
 * Reading emails again after the readers improve. An email the app could not read is read again
 * once, by itself, the next time the family opens the app after an update; "Read it again" in the
 * Inbox does the same on request.
 */
import { and, eq, inArray, isNotNull, lt, or, isNull } from "drizzle-orm";
import { schema, type Db } from "../db";
import type { AppEnv } from "../env";
import { dispatchParse } from "./dispatch";

/** When the readers last learned something. Unread emails processed before this are read again. */
export const READERS_UPDATED_AT = "2026-10-26T18:40:00.000Z";

/** Puts an email back in line to be read; true when this call did it (not one running alongside). */
export async function markForReread(db: Db, statementEmailId: string): Promise<boolean> {
  // A failed read may have left lines waiting; they are read afresh.
  await db.delete(schema.importLines).where(and(eq(schema.importLines.statementEmailId, statementEmailId), eq(schema.importLines.decision, "pending")));
  const moved = await db
    .update(schema.statementEmails)
    .set({ status: "received", error: null, parserKey: null, processedAt: null })
    .where(and(eq(schema.statementEmails.id, statementEmailId), inArray(schema.statementEmails.status, ["unparsed", "failed"])))
    .returning({ id: schema.statementEmails.id });
  return moved.length > 0;
}

/** Reads again, in the background, the household's unread emails that older readers gave up on. */
export async function rereadStale(db: Db, env: AppEnv, ctx: Pick<ExecutionContext, "waitUntil">, householdId: string): Promise<number> {
  const stale = await db
    .select({ id: schema.statementEmails.id })
    .from(schema.statementEmails)
    .where(
      and(
        eq(schema.statementEmails.householdId, householdId),
        inArray(schema.statementEmails.status, ["unparsed", "failed"]),
        isNotNull(schema.statementEmails.accountId),
        or(isNull(schema.statementEmails.processedAt), lt(schema.statementEmails.processedAt, READERS_UPDATED_AT)),
      ),
    )
    .limit(5);
  let n = 0;
  for (const s of stale) {
    if (!(await markForReread(db, s.id))) continue;
    await dispatchParse(env, ctx, { kind: "parse-statement-email", statementEmailId: s.id, householdId });
    n++;
  }
  return n;
}
