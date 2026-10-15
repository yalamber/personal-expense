/**
 * Queue consumer: takes a stored statement email, extracts its metadata and attachments
 * into R2, and hands it to a matching parser. With no parser registered (Phase 0) the
 * email is marked `unparsed` and still visible in the inbox, which is the Phase 0 milestone.
 */
import { eq } from "drizzle-orm";
import PostalMime from "postal-mime";
import { getDb, schema } from "../db";
import type { AppEnv, ParseJob } from "../env";
import { nowIso } from "../lib/ids";
import { isBlockedAttachment, rawMailKeys } from "../lib/inbound";
import { findParser } from "./parsers";

type StoredAttachment = { filename: string; mimeType: string; size: number; r2Key: string };

export async function handleParseBatch(batch: MessageBatch<ParseJob>, env: AppEnv): Promise<void> {
  for (const msg of batch.messages) {
    try {
      await processStatementEmail(msg.body, env);
      msg.ack();
    } catch (err) {
      console.error(`[queue] failed ${msg.body.statementEmailId}`, err);
      msg.retry();
    }
  }
}

export async function processStatementEmail(job: ParseJob, env: AppEnv): Promise<void> {
  const db = getDb(env.DB);
  const row = await db.query.statementEmails.findFirst({ where: eq(schema.statementEmails.id, job.statementEmailId) });
  if (!row) return; // deleted meanwhile; nothing to retry
  if (row.status !== "received") return; // already handled, or quarantined

  const object = await env.RAW_MAIL.get(row.r2Key);
  if (!object) {
    await db
      .update(schema.statementEmails)
      .set({ status: "failed", error: "raw message missing from storage", processedAt: nowIso() })
      .where(eq(schema.statementEmails.id, row.id));
    return;
  }

  const email = await new PostalMime().parse(await object.arrayBuffer());
  const keys = rawMailKeys(row.householdId, row.id);
  const stored: StoredAttachment[] = [];
  const forParser: { filename: string; mimeType: string; bytes: Uint8Array }[] = [];

  for (const [i, att] of (email.attachments ?? []).entries()) {
    const filename = att.filename || `attachment-${i}`;
    const mimeType = att.mimeType || "application/octet-stream";
    if (isBlockedAttachment(filename, mimeType)) continue;
    const bytes = typeof att.content === "string" ? new TextEncoder().encode(att.content) : new Uint8Array(att.content);
    const r2Key = keys.attachment(i, filename);
    await env.RAW_MAIL.put(r2Key, bytes, { httpMetadata: { contentType: mimeType } });
    stored.push({ filename, mimeType, size: bytes.byteLength, r2Key });
    forParser.push({ filename, mimeType, bytes });
  }

  const subject = email.subject ?? row.subject ?? "";
  const parser = findParser({ from: row.fromAddress, subject });

  if (!parser) {
    await db
      .update(schema.statementEmails)
      .set({
        subject,
        messageId: row.messageId ?? email.messageId ?? null,
        attachments: JSON.stringify(stored),
        status: "unparsed",
        error: "no parser matches this sender and subject yet",
        processedAt: nowIso(),
      })
      .where(eq(schema.statementEmails.id, row.id));
    return;
  }

  try {
    const lines = await parser.parse(email, forParser);
    if (lines.length) {
      await db.insert(schema.importLines).values(
        lines.map((l) => ({
          id: crypto.randomUUID(),
          householdId: row.householdId,
          statementEmailId: row.id,
          rawText: l.rawText,
          parsedDate: l.date,
          parsedAmountMinor: l.kind === "out" ? -Math.abs(l.amountMinor) : Math.abs(l.amountMinor),
          parsedDescription: l.description,
          confidence: Math.round(l.confidence),
          decision: "pending" as const,
        })),
      );
    }
    // Matching, categorisation and auto-posting arrive in Phase 1; until then every line waits for review.
    await db
      .update(schema.statementEmails)
      .set({
        subject,
        attachments: JSON.stringify(stored),
        parserKey: parser.key,
        status: lines.length ? "review" : "done",
        error: null,
        processedAt: nowIso(),
      })
      .where(eq(schema.statementEmails.id, row.id));
  } catch (err) {
    await db
      .update(schema.statementEmails)
      .set({
        subject,
        attachments: JSON.stringify(stored),
        parserKey: parser.key,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        processedAt: nowIso(),
      })
      .where(eq(schema.statementEmails.id, row.id));
    throw err; // let the queue retry, then dead-letter
  }
}
