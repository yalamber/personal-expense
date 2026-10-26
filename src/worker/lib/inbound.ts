/**
 * Pure helpers for the inbound statement address and sender allowlists.
 * Kept free of bindings so they can be unit-tested.
 */

export type InboundAddress = { localPart: string; token: string; domain: string };

/**
 * Parses `stmt+abc123@example.com` into its parts.
 * Returns null when the address is not shaped like an inbound statement address.
 */
export function parseInboundAddress(address: string): InboundAddress | null {
  const cleaned = extractEmail(address).toLowerCase();
  const at = cleaned.lastIndexOf("@");
  if (at <= 0) return null;
  const local = cleaned.slice(0, at);
  const domain = cleaned.slice(at + 1);
  const plus = local.indexOf("+");
  if (plus <= 0) return null;
  const token = local.slice(plus + 1);
  if (!/^[a-z0-9]{8,64}$/.test(token)) return null;
  return { localPart: local.slice(0, plus), token, domain };
}

/** Pulls the bare address out of `Name <addr@x>` or returns the input trimmed. */
export function extractEmail(value: string): string {
  const m = value.match(/<([^>]+)>/);
  return (m?.[1] ?? value).trim();
}

/**
 * Sender allowlist match. Patterns are comma separated and either a full address
 * (`alerts@bank.example`) or a domain suffix (`@bank.example`, which also matches
 * subdomains such as `no-reply@mail.bank.example`).
 */
export function senderMatches(patterns: string | null | undefined, from: string): boolean {
  if (!patterns) return false;
  const sender = extractEmail(from).toLowerCase();
  const senderDomain = sender.slice(sender.lastIndexOf("@") + 1);
  return patterns
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean)
    .some((p) => {
      if (p.startsWith("@")) {
        const d = p.slice(1);
        return senderDomain === d || senderDomain.endsWith(`.${d}`);
      }
      return sender === p;
    });
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/**
 * Who really sent a message, in the order worth checking against the allowlist. Mail that reaches
 * us through a forwarder arrives with the forwarder's envelope sender (Gmail rewrites it to a
 * postmaster@…google.com address), so the From header comes first, then the headers forwarders
 * use to keep the original sender, then the envelope. A message forwarded by hand carries the
 * original "From:" in the quoted block at the top of the body, so that is read last.
 */
export function senderCandidates(envelopeFrom: string, headers: { get(name: string): string | null }, bodyText = ""): string[] {
  const out: string[] = [];
  const push = (value: string | null | undefined) => {
    if (!value) return;
    const addr = (extractEmail(value).match(EMAIL_RE)?.[0] ?? "").toLowerCase();
    if (addr && !out.includes(addr)) out.push(addr);
  };
  for (const name of ["from", "x-original-sender", "x-original-from", "resent-from", "sender"]) push(headers.get(name));
  push(envelopeFrom);
  const quoted = bodyText.match(/^[\s>*]*(?:From|De|Von)\s*:\s*\*?\s*(.+)$/im)?.[1];
  push(quoted);
  return out;
}

/** A forwarder's or mail system's envelope address, never a sender worth remembering. */
export function looksLikeForwarder(address: string): boolean {
  return /^(?:postmaster@|mailer-daemon@|srs[01][=+]|prvs=|bounces?[-+@.]|msprvs|[^@]*\+caf_=)/i.test(address.trim());
}

/**
 * The sender worth naming and remembering: the first candidate that is neither a mail system's
 * envelope address nor one of the household's own mailboxes (a message forwarded by hand comes
 * From the person who forwarded it; the bank is further down the list, in the quoted block).
 */
export function pickSender(candidates: string[], own: Set<string>): string | null {
  return candidates.find((c) => !looksLikeForwarder(c) && !own.has(c.toLowerCase())) ?? null;
}

/** example.com from alerts.mail.example.com; example.com.np keeps its three labels. */
export function baseDomain(domain: string): string {
  const parts = domain.toLowerCase().split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const tld = parts[parts.length - 1]!;
  const second = parts[parts.length - 2]!;
  const keep = tld.length === 2 && ["com", "org", "net", "edu", "gov", "co", "ac"].includes(second) ? 3 : 2;
  return parts.slice(-keep).join(".");
}

const NAME_STOP = new Set(["bank", "banks", "account", "accounts", "saving", "savings", "current", "joint", "card", "cards", "credit", "debit", "wallet", "cash", "salary", "main", "home", "family", "personal", "limited", "nepal", "the", "and", "from", "with", "deposit", "fixed"]);

export type AccountForMail = { id: string; name: string; type: string; institution: string | null; statementSenderPattern: string | null };
export type RankedAccount = { id: string; level: 0 | 1 | 2 | 3; reason: string | null };

/**
 * Which account an email is most likely about, best first. 3: the sender is already on the
 * account's list; 2: the list has other senders from the same domain; 1: a distinctive word of the
 * account's name or bank ("Nabil") is in the sender's address, name or the subject; 0: no clue.
 */
export function rankAccounts(accounts: AccountForMail[], sender: string | null, hints: string): RankedAccount[] {
  const addr = (sender ?? "").toLowerCase();
  const domain = addr.slice(addr.lastIndexOf("@") + 1);
  const base = domain ? baseDomain(domain) : "";
  const haystack = `${domain} ${hints}`.toLowerCase();
  const ranked = accounts.map((a, i): RankedAccount & { i: number } => {
    if (addr && senderMatches(a.statementSenderPattern, addr)) return { id: a.id, level: 3, reason: "already reads mail from this sender", i };
    const domains = (a.statementSenderPattern ?? "")
      .split(",")
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean)
      .map((p) => (p.startsWith("@") ? p.slice(1) : p.slice(p.lastIndexOf("@") + 1)));
    if (base && domains.some((d) => baseDomain(d) === base)) return { id: a.id, level: 2, reason: `it already reads mail from ${base}`, i };
    const words = `${a.name} ${a.institution ?? ""}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4 && !NAME_STOP.has(w));
    const hit = words.find((w) => haystack.includes(w));
    if (hit) return { id: a.id, level: 1, reason: `"${hit[0]!.toUpperCase()}${hit.slice(1)}" is in the sender's name`, i };
    return { id: a.id, level: 0, reason: null, i };
  });
  return ranked.sort((x, y) => y.level - x.level || x.i - y.i).map(({ i: _i, ...r }) => r);
}

/** Builds the address a household forwards statements to. */
export function inboundAddressFor(localPart: string, token: string, domain: string): string {
  return `${localPart}+${token}@${domain}`;
}

/** R2 keys for one statement email. Everything for a message lives under one prefix. */
export function rawMailKeys(householdId: string, statementEmailId: string) {
  const prefix = `households/${householdId}/mail/${statementEmailId}`;
  return {
    prefix,
    raw: `${prefix}/raw.eml`,
    attachment: (index: number, filename: string) => `${prefix}/attachments/${index}-${safeFilename(filename)}`,
  };
}

export function safeFilename(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.length ? cleaned.slice(0, 120) : "attachment";
}

/** Attachment types that are never stored. */
export function isBlockedAttachment(filename: string, mimeType: string): boolean {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  const blockedExt = new Set(["exe", "msi", "bat", "cmd", "com", "scr", "js", "vbs", "ps1", "sh", "jar", "apk", "dmg"]);
  if (blockedExt.has(ext)) return true;
  return /^application\/(x-msdownload|x-sh|java-archive|x-executable)$/i.test(mimeType);
}

export type ForwardingCheck = { provider: "gmail"; code: string | null; link: string | null; requester: string | null };

const GMAIL_FORWARDING_SENDER = "forwarding-noreply@google.com";

/**
 * Recognises the email Gmail sends to a new forwarding address before it starts forwarding:
 * "(#572612094) Gmail Forwarding Confirmation - Receive Mail from someone@gmail.com".
 * The code and the confirmation link are read from the subject and, when given, the body text.
 */
export function forwardingCheck(from: string, subject: string | null, bodyText = ""): ForwardingCheck | null {
  if (extractEmail(from).toLowerCase() !== GMAIL_FORWARDING_SENDER) return null;
  const s = subject ?? "";
  const code = s.match(/\(#\s*(\d{6,12})\)/)?.[1] ?? bodyText.match(/(?:code|código|code de confirmation)[^\d]{0,30}(\d{6,12})/i)?.[1] ?? bodyText.match(/\b(\d{9})\b/)?.[1] ?? null;
  const link = bodyText.match(/https:\/\/mail(?:-settings)?\.google\.com\/mail\/[^\s<>"')]+/)?.[0] ?? null;
  const requester = s.match(/([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\s*$/)?.[1] ?? bodyText.match(/([A-Za-z0-9._%+-]+@gmail\.com)/i)?.[1] ?? null;
  return { provider: "gmail", code, link, requester };
}
