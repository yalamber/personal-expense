/**
 * Transaction alerts, the way most banks and wallets write them: "Your account XXXX1234 has been
 * debited by NPR 1,500.00 on 26/10/2026. Remarks: ESEWA LOAD. Available balance NPR 12,345.67."
 *
 * This parser reads that shape without knowing the bank: one amount next to a debit or credit
 * word, a date in the text (or the email's own date), and the remarks line as the description.
 * It claims an email only when nothing bank-specific does, and its lines carry a confidence
 * below the auto-post line, so each one is shown to the family in Decide before it counts.
 */
import type { Email } from "postal-mime";
import type { ParsedLine, StatementParser } from "./index";
import { plainText } from "./text";

const OUT_WORDS = /\b(debited|debit(?:ed)?\s+(?:by|with|for)|withdrawn|withdrawal|deducted|paid|payment\s+of|purchase|spent|charged|transferred\s+(?:to|from your))\b/i;
const IN_WORDS = /\b(credited|credit(?:ed)?\s+(?:by|with|for)|deposited|deposit\s+of|received|refund(?:ed)?|reversed|cashback)\b/i;
const AMOUNT = /(?:NPR|NRs\.?|Rs\.?|रु\.?|INR|USD|\$)\s*([\d,]+(?:\.\d{1,2})?)|([\d,]+(?:\.\d{1,2})?)\s*(?:NPR|INR|USD)\b/gi;
const BALANCE_NEAR = /\b(?:avail(?:able)?|a\/c|account|ledger|closing|current|total|new)?\s*(?:bal(?:ance)?|limit)\b/i;
const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec";
const DESC_LABEL = /(?:remarks?|narration|particulars?|description|desc\.?|details?|purpose|txn\s*desc(?:ription)?|transaction\s*(?:details?|remarks?)|merchant|payee|beneficiary|to)\s*[:\-–]\s*([^\n\r]{2,140})/i;

const pad = (n: number) => String(n).padStart(2, "0");
const monthIndex = (m: string) => ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(m.slice(0, 3).toLowerCase());

/** The first date in the text that is a plausible Gregorian date; Bikram Sambat years are skipped. */
export function findDate(text: string, fallback?: Date | null): { date: string; fromText: boolean } | null {
  const plausible = (y: number, m: number, d: number) => y >= 2000 && y <= 2069 && m >= 1 && m <= 12 && d >= 1 && d <= 31;
  const iso = [...text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)].find((m) => plausible(+m[1]!, +m[2]!, +m[3]!));
  if (iso) return { date: `${iso[1]}-${iso[2]}-${iso[3]}`, fromText: true };
  // Day first, as written in Nepal and India: 26/10/2026, 26-10-2026, 26.10.2026.
  const dmy = [...text.matchAll(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})\b/g)].find((m) => plausible(+m[3]!, +m[2]!, +m[1]!));
  if (dmy) return { date: `${dmy[3]}-${pad(+dmy[2]!)}-${pad(+dmy[1]!)}`, fromText: true };
  const dMonY = text.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?[\\s-]+(${MONTHS})[a-z]*[\\s,-]+(\\d{4})\\b`, "i"));
  if (dMonY && plausible(+dMonY[3]!, monthIndex(dMonY[2]!) + 1, +dMonY[1]!)) return { date: `${dMonY[3]}-${pad(monthIndex(dMonY[2]!) + 1)}-${pad(+dMonY[1]!)}`, fromText: true };
  const monDY = text.match(new RegExp(`\\b(${MONTHS})[a-z]*\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "i"));
  if (monDY && plausible(+monDY[3]!, monthIndex(monDY[1]!) + 1, +monDY[2]!)) return { date: `${monDY[3]}-${pad(monthIndex(monDY[1]!) + 1)}-${pad(+monDY[2]!)}`, fromText: true };
  if (fallback && !Number.isNaN(fallback.getTime())) return { date: fallback.toISOString().slice(0, 10), fromText: false };
  return null;
}

type Found = { amountMinor: number; kind: "out" | "in"; sentence: string; description: string | null };

/** The transaction in a piece of alert text, or null when nothing reads like one. */
export function readAlert(text: string): Found | null {
  const flat = text.replace(/\s+/g, " ");
  const amounts = [...flat.matchAll(AMOUNT)]
    .map((m) => ({ index: m.index ?? 0, raw: m[1] ?? m[2] ?? "", end: (m.index ?? 0) + m[0].length }))
    .filter((a) => a.raw && !/^[\d,]*0{1,2}$/.test(a.raw.replace(/\D/g, "")) === false || true)
    .map((a) => ({ ...a, minor: Math.round(Number(a.raw.replace(/,/g, "")) * 100) }))
    .filter((a) => Number.isFinite(a.minor) && a.minor > 0);
  if (!amounts.length) return null;

  // Score each amount: a debit/credit word close by is the transaction; "balance" close by is not.
  let best: { score: number; a: (typeof amounts)[number]; kind: "out" | "in" } | null = null;
  for (const a of amounts) {
    const before = flat.slice(Math.max(0, a.index - 90), a.index);
    const after = flat.slice(a.end, a.end + 90);
    const around = before + " " + after;
    const isBalance = BALANCE_NEAR.test(flat.slice(Math.max(0, a.index - 40), a.index)) || /^\s*(?:is|was)?\s*(?:your\s+)?(?:avail|bal)/i.test(after);
    const out = OUT_WORDS.test(around);
    const inn = IN_WORDS.test(around);
    const kind: "out" | "in" | null = out && !inn ? "out" : inn && !out ? "in" : out && inn ? (before.search(OUT_WORDS) >= 0 ? "out" : "in") : null;
    const score = (kind ? 2 : 0) - (isBalance ? 3 : 0) - a.index / 100_000;
    if (!best || score > best.score) best = { score, a, kind: kind ?? (flat.search(OUT_WORDS) >= 0 && (flat.search(IN_WORDS) < 0 || flat.search(OUT_WORDS) < flat.search(IN_WORDS)) ? "out" : "in") };
  }
  if (!best || best.score < 0 || (!OUT_WORDS.test(flat) && !IN_WORDS.test(flat))) return null;

  const start = Math.max(0, flat.lastIndexOf(". ", best.a.index) + 1);
  const stop = flat.indexOf(". ", best.a.end);
  const sentence = flat.slice(start, stop < 0 ? Math.min(flat.length, best.a.end + 160) : stop + 1).trim().slice(0, 300);
  const label = text.match(DESC_LABEL);
  let description = label?.[1]?.replace(/\s+/g, " ").trim() ?? null;
  if (description) description = description.replace(/\s*(?:avail(?:able)?\s+bal(?:ance)?|balance|thank you|regards)\b.*$/i, "").replace(/[.;,\s]+$/, "").trim() || null;
  if (!description) {
    // "… debited by NPR 1,500.00 at BHATBHATENI …" or "… paid to NTC …"
    const after = flat.slice(best.a.end, best.a.end + 120).match(/^\s*(?:\w*\s+)?(?:at|to|from|for|towards)\s+([A-Za-z0-9&'().\-\/ ]{2,60}?)(?=\s+(?:on|dated|date|at\s+\d|via|through|ref|txn|transaction|\.|,|$))/i);
    description = after?.[1]?.trim() ?? null;
  }
  return { amountMinor: best.a.minor, kind: best.kind, sentence, description };
}

const SUBJECT = /alert|transaction|txn|debit|credit|payment|statement|notification|has been (?:debited|credited)|a\/c|account/i;

export const alertParser: StatementParser = {
  key: "alert-text",
  matches: ({ subject, from }) => SUBJECT.test(subject) && !/forwarding-noreply@google\.com/i.test(from),
  async parse(email: Email): Promise<ParsedLine[]> {
    const text = `${email.text ?? ""}\n${plainText(email.html ?? "")}`;
    const found = readAlert(text);
    if (!found) return [];
    const when = findDate(text, email.date ? new Date(email.date) : null);
    if (!when) return [];
    const description = found.description ?? (email.subject ?? "").replace(/^(?:fwd?|fw|re)\s*:\s*/i, "").trim() ?? "Bank alert";
    return [
      {
        rawText: found.sentence,
        date: when.date,
        amountMinor: found.amountMinor,
        kind: found.kind,
        description: description || "Bank alert",
        // Below the auto-post line on purpose: the family sees each alert once in Decide.
        confidence: when.fromText ? 70 : 60,
      },
    ];
  },
};
