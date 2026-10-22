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
