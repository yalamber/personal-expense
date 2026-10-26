/**
 * Parse step for a stored statement email: extracts attachments into R2, then reads lines with a
 * bank-specific parser, or with the account's saved CSV mapping when the email carries a CSV
 * attachment. Lines go through the ingest pipeline (merchant memory, duplicate check, auto-post or
 * review). Emails nothing can read are marked `unparsed` and stay visible in the inbox.
 */
import { eq } from "drizzle-orm";
import PostalMime from "postal-mime";
import { getDb, schema } from "../db";
import type { AppEnv, ParseJob } from "../env";
import { nowIso } from "../lib/ids";
import { isBlockedAttachment, looksLikeForwarder, rawMailKeys } from "../lib/inbound";
import { parseCsv } from "../../shared/csv";
import { applyMapping, isCsvMapping } from "../../shared/csv-mapping";
import { findParser } from "./parsers";
import { ingestLines, refreshStatementStatus, type IncomingLine } from "./pipeline";

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
  // Rows stored with a forwarder's envelope address take the real sender from the From header.
  const headerFrom = email.from?.address?.trim().toLowerCase();
  const fromAddress = headerFrom && looksLikeForwarder(row.fromAddress) && !looksLikeForwarder(headerFrom) ? headerFrom : row.fromAddress;
  const base = { subject, messageId: row.messageId ?? email.messageId ?? null, attachments: JSON.stringify(stored), fromAddress };
  const parser = findParser({ from: fromAddress, subject });

  // Without a bank-specific parser, a CSV attachment can still be read with the account's saved mapping.
  const csvAttachments = forParser.filter((a) => /\.csv$/i.test(a.filename) || /csv/i.test(a.mimeType));
  const account = row.accountId ? await db.query.accounts.findFirst({ where: eq(schema.accounts.id, row.accountId) }) : undefined;
  const savedMapping = account?.csvMapping ? (JSON.parse(account.csvMapping) as unknown) : null;
  const mapping = isCsvMapping(savedMapping) ? savedMapping : null;

  if (!parser && !(csvAttachments.length && mapping)) {
    const reason = csvAttachments.length
      ? "this email has a CSV attachment; map the CSV columns for the account once and later emails import automatically"
      : "no parser matches this sender and subject yet";
    await db
      .update(schema.statementEmails)
      .set({ ...base, status: "unparsed", error: reason, processedAt: nowIso() })
      .where(eq(schema.statementEmails.id, row.id));
    return;
  }

  const parserKey = parser ? parser.key : "csv-mapping";
  try {
    let lines: IncomingLine[];
    if (parser) {
      lines = (await parser.parse(email, forParser)).map((l) => ({
        rawText: l.rawText,
        date: l.date,
        amountMinor: Math.abs(l.amountMinor),
        direction: l.kind,
        description: l.description,
        confidence: l.confidence,
      }));
    } else {
      const household = await db.query.households.findFirst({ where: eq(schema.households.id, row.householdId) });
      const currency = household?.currency ?? "USD";
      lines = csvAttachments.flatMap((a) =>
        applyMapping(parseCsv(new TextDecoder().decode(a.bytes)), mapping!, currency).rows.map((r) => ({
          rawText: r.raw,
          date: r.date,
          amountMinor: r.amountMinor,
          direction: r.direction,
          description: r.description,
          confidence: 95,
        })),
      );
    }

    if (!lines.length) {
      await db
        .update(schema.statementEmails)
        .set({ ...base, parserKey, status: "unparsed", error: "nothing in this email read like a transaction (an amount next to debited or credited, and a date)", processedAt: nowIso() })
        .where(eq(schema.statementEmails.id, row.id));
      return;
    }
    await db.update(schema.statementEmails).set({ ...base, parserKey, error: null }).where(eq(schema.statementEmails.id, row.id));
    await ingestLines(db, { householdId: row.householdId, statementEmailId: row.id, accountId: row.accountId, source: "email" }, lines);
    await refreshStatementStatus(db, row.id, "parsed");
  } catch (err) {
    await db
      .update(schema.statementEmails)
      .set({ ...base, parserKey, status: "failed", error: err instanceof Error ? err.message : String(err), processedAt: nowIso() })
      .where(eq(schema.statementEmails.id, row.id));
    throw err; // the queue retries (a no-op once failed); inline and cron callers log it
  }
}
