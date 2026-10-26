/**
 * What a stored statement email is, for a person deciding what to do with it: who really sent it
 * and who forwarded it, what it says, what the app can read from it, and which account it is most
 * likely about. Read from the raw message in R2, so it works for emails stored before the app
 * learnt to look past a forwarder's envelope address.
 */
import { eq } from "drizzle-orm";
import PostalMime, { type Email } from "postal-mime";
import { schema, type Db } from "../db";
import type { AppEnv } from "../env";
import { looksLikeForwarder, pickSender, rankAccounts, senderCandidates, senderMatches } from "../lib/inbound";
import { findParser, type ParsedLine, type Unread } from "./parsers";
import { plainText } from "./parsers/text";

type Row = typeof schema.statementEmails.$inferSelect;

export type MailPreview = {
  id: string;
  status: Row["status"];
  receivedAt: string;
  subject: string | null;
  error: string | null;
  accountId: string | null;
  sizeBytes: number;
  /** The From header: a name and an address. */
  from: { name: string | null; address: string } | null;
  /** The sender the app goes by (the bank behind a forward), or null when only a forwarder is known. */
  sender: string | null;
  /** The mailbox that forwarded it (Gmail's X-Forwarded-For), or the forwarder's envelope address. */
  forwardedBy: string | null;
  forwardedVia: string | null;
  sentAt: string | null;
  attachments: { filename: string; mimeType: string; size: number }[];
  /** The email's text, trimmed to a readable length. */
  text: string | null;
  truncated: boolean;
  /** What the parser that would claim this email reads from it; when nothing, why, and what it did find. */
  reading: {
    parserKey: string | null;
    lines: { kind: "out" | "in"; amountMinor: number; date: string; description: string; rawText: string; confidence: number }[];
    why: string | null;
    guess: Unread["guess"] | null;
  };
  /** Accounts that can take statements, best guess first. */
  accounts: { id: string; name: string; type: string; senders: string[]; level: number; reason: string | null }[];
  /** Why it waits: its sender is on no account's list, or it is on one and only a forwarder hid it. */
  held: "new-sender" | "forwarded" | null;
  missing: boolean;
};

const STATEMENT_TYPES = new Set(["checking", "savings", "credit", "wallet"]);
const TEXT_LIMIT = 5000;

const header = (email: Email) => ({ get: (name: string) => email.headers.find((h) => h.key === name)?.value ?? null });

function readableText(email: Email): string {
  const raw = email.text?.trim() ? email.text : plainText(email.html ?? "");
  return raw
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t ]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The household's own mailboxes: its members, and whoever Gmail says forwarded the message. */
async function ownMailboxes(db: Db, householdId: string, email: Email | null): Promise<Set<string>> {
  const members = await db.query.members.findMany({ where: eq(schema.members.householdId, householdId), columns: { email: true } });
  const own = new Set(members.map((m) => m.email.toLowerCase()));
  const fwd = email ? header(email).get("x-forwarded-for")?.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)?.[0] : null;
  if (fwd) own.add(fwd.toLowerCase());
  return own;
}

export async function loadRaw(env: AppEnv, row: Row): Promise<Email | null> {
  const object = await env.RAW_MAIL.get(row.r2Key);
  if (!object) return null;
  return new PostalMime().parse(await object.arrayBuffer());
}

/** The address to name and remember for a stored email, looking past forwarders and the family's own mailboxes. */
export async function realSender(db: Db, row: Row, email: Email | null): Promise<string | null> {
  if (!email) return looksLikeForwarder(row.fromAddress) ? null : row.fromAddress.toLowerCase();
  const own = await ownMailboxes(db, row.householdId, email);
  return pickSender(senderCandidates(row.fromAddress, header(email), readableText(email)), own);
}

export async function buildPreview(env: AppEnv, db: Db, row: Row): Promise<MailPreview> {
  const email = await loadRaw(env, row).catch(() => null);
  const accountsAll = await db.query.accounts.findMany({ where: eq(schema.accounts.householdId, row.householdId) });
  const accounts = accountsAll.filter((a) => STATEMENT_TYPES.has(a.type) && !a.closedAt);
  const stored = JSON.parse(row.attachments || "[]") as { filename: string; mimeType: string; size: number }[];

  const base = {
    id: row.id,
    status: row.status,
    receivedAt: row.receivedAt,
    subject: row.subject,
    error: row.error,
    accountId: row.accountId,
    sizeBytes: row.rawSize,
  };

  if (!email) {
    const sender = looksLikeForwarder(row.fromAddress) ? null : row.fromAddress;
    const ranked = rankAccounts(accounts, sender, row.subject ?? "");
    return {
      ...base,
      from: sender ? { name: null, address: sender } : null,
      sender,
      forwardedBy: sender ? null : row.fromAddress,
      forwardedVia: null,
      sentAt: null,
      attachments: stored,
      text: null,
      truncated: false,
      reading: { parserKey: null, lines: [], why: null, guess: null },
      accounts: ranked.map((r) => toAccount(accounts.find((a) => a.id === r.id)!, r)),
      held: row.status === "quarantined" ? "new-sender" : null,
      missing: true,
    };
  }

  const own = await ownMailboxes(db, row.householdId, email);
  const text = readableText(email);
  const sender = pickSender(senderCandidates(row.fromAddress, header(email), text), own);
  const fromHeader = email.from?.address ? { name: email.from.name?.trim() || null, address: email.from.address.toLowerCase() } : null;
  const xff = header(email).get("x-forwarded-for")?.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)?.[0]?.toLowerCase() ?? null;
  const forwardedBy = xff ?? (looksLikeForwarder(row.fromAddress) ? row.fromAddress : fromHeader && own.has(fromHeader.address) ? fromHeader.address : null);
  const forwardedVia = looksLikeForwarder(row.fromAddress) ? providerOf(row.fromAddress.slice(row.fromAddress.indexOf("@") + 1)) : xff ? "automatic forwarding" : null;

  // What the parser that would claim it reads (bank-specific first, then the generic alert reader).
  let reading: MailPreview["reading"] = { parserKey: null, lines: [], why: null, guess: null };
  const parser = findParser({ from: sender ?? row.fromAddress, subject: email.subject ?? row.subject ?? "" });
  if (parser) {
    try {
      const lines: ParsedLine[] = await parser.parse(email, []);
      const unread = lines.length ? null : (parser.explain?.(email) ?? null);
      reading = {
        parserKey: parser.key,
        lines: lines.slice(0, 5).map((l) => ({ kind: l.kind, amountMinor: Math.abs(l.amountMinor), date: l.date, description: l.description, rawText: l.rawText, confidence: l.confidence })),
        why: unread?.why ?? null,
        guess: unread?.guess ?? null,
      };
    } catch {
      reading = { parserKey: parser.key, lines: [], why: null, guess: null };
    }
  }

  // Read by the AI or filled in by hand: what was read is the lines stored for it.
  if (!reading.lines.length && (row.parserKey === "ai" || row.parserKey === "by-hand")) {
    const stored = await db.query.importLines.findMany({ where: eq(schema.importLines.statementEmailId, row.id), limit: 5 });
    reading = {
      parserKey: row.parserKey,
      lines: stored.map((l) => ({ kind: (l.parsedAmountMinor ?? 0) < 0 ? "out" : "in", amountMinor: Math.abs(l.parsedAmountMinor ?? 0), date: l.parsedDate ?? "", description: l.parsedDescription ?? "", rawText: l.rawText, confidence: l.confidence })),
      why: null,
      guess: null,
    };
  }

  const hints = `${fromHeader?.name ?? ""} ${email.subject ?? ""}`;
  const ranked = rankAccounts(accounts, sender, hints);
  const listed = sender ? accounts.some((a) => senderMatches(a.statementSenderPattern, sender)) : false;
  const attachments = stored.length
    ? stored
    : (email.attachments ?? []).map((a, i) => ({ filename: a.filename || `attachment-${i + 1}`, mimeType: a.mimeType, size: typeof a.content === "string" ? a.content.length : a.content.byteLength }));

  return {
    ...base,
    from: fromHeader,
    sender,
    forwardedBy: forwardedBy && forwardedBy !== sender ? forwardedBy : null,
    forwardedVia,
    sentAt: email.date && !Number.isNaN(Date.parse(email.date)) ? new Date(email.date).toISOString() : null,
    attachments,
    text: text ? text.slice(0, TEXT_LIMIT) : null,
    truncated: text.length > TEXT_LIMIT,
    reading,
    accounts: ranked.map((r) => toAccount(accounts.find((a) => a.id === r.id)!, r)),
    held: row.status === "quarantined" ? (listed ? "forwarded" : "new-sender") : null,
    missing: false,
  };
}

/** "Gmail" for mail-wr1-x436.google.com: the service people know, not its mail server. */
function providerOf(domain: string): string {
  const d = domain.toLowerCase();
  if (/(^|\.)(google|gmail|googlemail)\.com$/.test(d)) return "Gmail";
  if (/(^|\.)(outlook|hotmail|live)\.com$|protection\.outlook\.com$/.test(d)) return "Outlook";
  if (/(^|\.)yahoo(mail)?\.com$/.test(d)) return "Yahoo Mail";
  if (/(^|\.)(icloud|me)\.com$/.test(d)) return "iCloud Mail";
  if (/(^|\.)zoho\.(com|in)$/.test(d)) return "Zoho Mail";
  return d;
}

function toAccount(a: { id: string; name: string; type: string; statementSenderPattern: string | null }, r: { level: number; reason: string | null }) {
  return {
    id: a.id,
    name: a.name,
    type: a.type,
    senders: (a.statementSenderPattern ?? "").split(",").map((p) => p.trim()).filter(Boolean),
    level: r.level,
    reason: r.reason,
  };
}
