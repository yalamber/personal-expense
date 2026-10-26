/**
 * Email Worker: runs when Cloudflare Email Routing delivers a message to the inbound address.
 *
 * It does the minimum so delivery is fast and nothing is lost:
 *   1. resolve the household from the token in the recipient address
 *   2. decide whether the sender is on an account's allowlist (else quarantine)
 *   3. stream the raw message to R2
 *   4. write a statement_emails row and dispatch a parse job
 *
 * Parsing runs after the handler returns (queue if bound, otherwise ctx.waitUntil).
 */
import { eq } from "drizzle-orm";
import PostalMime from "postal-mime";
import { getDb, schema } from "../db";
import type { AppEnv } from "../env";
import { newId } from "../lib/ids";
import { extractEmail, forwardingCheck, parseInboundAddress, rawMailKeys, senderCandidates, senderMatches } from "../lib/inbound";
import { plainText } from "./parsers/text";
import { dispatchParse } from "./dispatch";

const MAX_RAW_BYTES = 25 * 1024 * 1024;

export async function handleInboundEmail(message: ForwardableEmailMessage, env: AppEnv, ctx: ExecutionContext): Promise<void> {
  const inbound = parseInboundAddress(message.to);
  if (!inbound || inbound.localPart !== env.INBOUND_LOCAL_PART.toLowerCase()) {
    // Not shaped like our address: accept and drop so nothing is revealed to the sender.
    console.log(`[email] dropped: unrecognised recipient ${message.to}`);
    return;
  }

  const db = getDb(env.DB);
  const household = await db.query.households.findFirst({ where: eq(schema.households.inboundToken, inbound.token) });
  if (!household) {
    console.log(`[email] dropped: unknown token for ${message.to}`);
    return;
  }

  if (message.rawSize > MAX_RAW_BYTES) {
    message.setReject("Message too large");
    return;
  }

  // The sender people recognise is the From header; the envelope is often a forwarder's.
  const envelopeFrom = extractEmail(message.from);
  let candidates = senderCandidates(message.from, message.headers);
  const accounts = await db.query.accounts.findMany({ where: eq(schema.accounts.householdId, household.id) });
  const matchAccount = () => accounts.find((a) => candidates.some((c) => senderMatches(a.statementSenderPattern, c)));
  let matched = matchAccount();

  const statementEmailId = newId();
  const keys = rawMailKeys(household.id, statementEmailId);
  const messageId = message.headers.get("message-id");
  const subject = message.headers.get("subject");

  // R2 needs a known length for streamed uploads; Email Routing tells us the raw size.
  const rawBody = message.raw.pipeThrough(new FixedLengthStream(message.rawSize));
  await env.RAW_MAIL.put(keys.raw, rawBody, {
    httpMetadata: { contentType: "message/rfc822" },
    customMetadata: { householdId: household.id, statementEmailId, from: candidates[0] ?? envelopeFrom, receivedAt: new Date().toISOString() },
  });

  // Gmail asks the new forwarding address to confirm before it forwards anything. Keep the code
  // where the family can see it, instead of quarantining the message as an unknown sender.
  let check = candidates.map((c) => forwardingCheck(c, subject)).find(Boolean) ?? null;
  // A hand-forwarded message names the bank only in its quoted header block, and a forwarding
  // check may keep its code in the body: both need the body, which is read back from storage.
  if ((check && (!check.code || !check.link)) || (!check && !matched)) {
    try {
      const stored = await env.RAW_MAIL.get(keys.raw);
      if (stored) {
        const parsed = await new PostalMime().parse(await stored.arrayBuffer());
        const body = `${parsed.text ?? ""}\n${plainText(parsed.html ?? "")}`;
        if (check) check = forwardingCheck(envelopeFrom, subject, body) ?? check;
        else {
          candidates = senderCandidates(message.from, message.headers, body);
          matched = matchAccount();
        }
      }
    } catch (err) {
      console.log(`[email] could not read the message body: ${String(err)}`);
    }
  }
  // The address kept with the email is the one that matched (the bank behind a hand-forward), else the From header.
  const from = (matched && candidates.find((c) => senderMatches(matched!.statementSenderPattern, c))) || candidates[0] || envelopeFrom;
  const forwarded = from !== envelopeFrom ? ` (forwarded by ${envelopeFrom})` : "";

  const status = check ? "forwarding" : matched ? "received" : "quarantined";
  try {
    await db.insert(schema.statementEmails).values({
      id: statementEmailId,
      householdId: household.id,
      accountId: matched?.id ?? null,
      messageId,
      fromAddress: from,
      toAddress: message.to,
      subject,
      rawSize: message.rawSize,
      r2Key: keys.raw,
      status,
      error: check || matched ? null : `${from} is not on any account's list of senders${forwarded}`,
      verifyCode: check ? JSON.stringify(check) : null,
    });
  } catch (err) {
    // Most likely the same Message-ID delivered twice. Keep R2 tidy and move on.
    await env.RAW_MAIL.delete(keys.raw);
    console.log(`[email] duplicate or failed insert for ${messageId}: ${String(err)}`);
    return;
  }

  if (matched && !check) {
    await dispatchParse(env, ctx, { kind: "parse-statement-email", statementEmailId, householdId: household.id });
  }
  console.log(`[email] stored ${statementEmailId} status=${status} from=${from}${forwarded} household=${household.id}`);
}
