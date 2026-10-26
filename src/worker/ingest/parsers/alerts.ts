/**
 * Transaction alerts, the way most banks and wallets write them: "Your account XXXX1234 has been
 * debited by NPR 1,500.00 on 26/10/2026. Remarks: ESEWA LOAD. Available balance NPR 12,345.67."
 * Or as a table: "Transaction Type | Debit", "Amount (NPR) | 1,500.00", "Remarks | ESEWA LOAD".
 *
 * This parser reads those shapes without knowing the bank: one amount next to a debit or credit
 * word (or under an Amount label with a Type row), a date in the text (or the email's own date),
 * and the remarks as the description. It claims an email only when nothing bank-specific does,
 * and its lines carry a confidence below the auto-post line, so each one is shown to the family in
 * Decide before it counts. When it reads nothing it says why, and what it did find.
 */
import type { Email } from "postal-mime";
import type { ParsedLine, StatementParser, Unread } from "./index";
import { plainText, tableLines, tableRows } from "./text";

const OUT_WORDS = /\b(debited|debit(?:ed)?\s+(?:by|with|for|of)|withdrawn|withdrawal|deducted|paid|payment\s+of|purchase|spent|charged|transferred\s+(?:to|from your))\b/i;
const IN_WORDS = /\b(credited|credit(?:ed)?\s+(?:by|with|for|of)|deposited|deposit\s+of|received|refund(?:ed)?|reversed|cashback)\b/i;
const AMOUNT = /(?:\bNPR\.?|\bNRs\.?|\bRs\.?|रु\.?|\bINR|\bUSD|\$)\s*(\d[\d,]*(?:\.\d{1,2})?)|(\d[\d,]*(?:\.\d{1,2})?)\s*(?:NPR|INR|USD)\b/gi;
/** "Amount (NPR) 1,500.00": an amount under a label rather than after a currency. */
const LABELLED_AMOUNT = /\b(?:amount|amt)\b[^\d\n]{0,24}?(\d[\d,]*(?:\.\d{1,2})?)/gi;
const BALANCE_NEAR = /\b(?:avail(?:able)?|a\/c|account|ledger|closing|current|total|new)?\s*(?:bal(?:ance)?|limit)\b/i;
const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec";
const DESC_LABEL = /(?:remarks?|narration|particulars?|description|desc\.?|details?|purpose|txn\s*desc(?:ription)?|transaction\s*(?:details?|remarks?)|merchant|payee|beneficiary|to)\s*[:\-–]\s*([^\n\r]{2,140})/i;

const CUR = "(?:npr|nrs|rs|inr|usd|रु)\\.?";
const NUM = "(\\d[\\d,]*(?:\\.\\d{1,2})?)";
/** "Amount (NPR): 1,500.00", "Txn Amount: NPR 25,000.00 Cr", "Debit Amount - Rs. 500". */
const AMOUNT_LINE = new RegExp(
  `^\\W*(?:(txn|trans(?:action)?|tran|debit(?:ed)?|credit(?:ed)?|withdrawal|withdrawn|deposit(?:ed)?|dr|cr)\\.?\\s*)?(?:amount|amt)\\.?(?![a-z])\\s*(?:\\(?\\s*(?:in\\s+)?${CUR}\\s*\\)?)?\\s*[:\\-–]?\\s*(?:${CUR})?\\s*([-+])?\\s*${NUM}(?:\\s*(?:npr|nrs|inr)\\b)?(?:\\s*\\(?\\s*(dr|cr|debit|credit)\\b)?`,
  "i",
);
/** A debit or credit column of its own: "Debit: 1,500.00", "Withdrawal (NPR): 500". */
const SIDE_LINE = new RegExp(`^\\W*(debit|credit|withdrawal|withdrawn|deposit|dr|cr)\\.?\\s*(?:\\(?\\s*${CUR}\\s*\\)?)?\\s*[:\\-–]\\s*(?:${CUR})?\\s*${NUM}`, "i");
const TYPE_LINE = /^\W*(?:(?:transaction|txn|trans|tran)\.?\s*type|type|dr\s*\/\s*cr|cr\s*\/\s*dr|debit\s*\/\s*credit|nature(?:\s+of\s+(?:transaction|txn))?)\s*[:\-–]?\s*(.{1,80})$/i;
const DESC_LINE = /^\W*(?:(?:txn|transaction|trans)\.?\s*)?(remarks?|narration|particulars?|description|details?|purpose|merchant(?:\s+name)?|payee|beneficiary(?:\s+name)?|txn\s*desc(?:ription)?)\s*(?:[:\-–]\s*|\s+)(.{2,140})$/i;
/** A line that is only a label, its value on the next line (table cells split by the template). */
const LABEL_ONLY = /^\W*(?:(?:txn|trans(?:action)?|tran|debit(?:ed)?|credit(?:ed)?|withdrawal|deposit|value|posting)\.?\s*)?(?:amount|amt|type|remarks?|narration|particulars?|description|details?|purpose|merchant(?:\s+name)?|date|dr\s*\/\s*cr|debit\s*\/\s*credit)\b(?:\s*\(?\s*(?:in\s+)?(?:npr|nrs|rs|inr)\.?\s*\)?)?\s*[:\-–]?$/i;
const SIDE_ONLY = /^\W*(?:debit|credit|withdrawal|deposit|dr|cr)\.?\s*(?:\(?\s*(?:npr|nrs|rs|inr)\.?\s*\)?)?\s*:?$/i;
const NUMBER_ONLY = /^\W*(?:(?:npr|nrs|rs|inr)\.?\s*)?\d[\d,]*(?:\.\d{1,2})?\s*(?:npr|nrs|inr)?$/i;

const pad = (n: number) => String(n).padStart(2, "0");
const monthIndex = (m: string) => ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(m.slice(0, 3).toLowerCase());

/** The first date in the text that is a plausible Gregorian date; Bikram Sambat years are skipped. */
export function findDate(text: string, fallback?: Date | null): { date: string; fromText: boolean } | null {
  const plausible = (y: number, m: number, d: number) => y >= 2000 && y <= 2069 && m >= 1 && m <= 12 && d >= 1 && d <= 31;
  const iso = [...text.matchAll(/\b(\d{4})[-/](\d{2})[-/](\d{2})\b/g)].find((m) => plausible(+m[1]!, +m[2]!, +m[3]!));
  if (iso) return { date: `${iso[1]}-${iso[2]}-${iso[3]}`, fromText: true };
  // Day first, as written in Nepal and India: 26/10/2026, 26-10-2026, 26.10.2026.
  const dmy = [...text.matchAll(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})\b/g)].find((m) => plausible(+m[3]!, +m[2]!, +m[1]!));
  if (dmy) return { date: `${dmy[3]}-${pad(+dmy[2]!)}-${pad(+dmy[1]!)}`, fromText: true };
  const dMonY = text.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?[\\s-]+(${MONTHS})[a-z]*[\\s,-]+(\\d{4})\\b`, "i"));
  if (dMonY && plausible(+dMonY[3]!, monthIndex(dMonY[2]!) + 1, +dMonY[1]!)) return { date: `${dMonY[3]}-${pad(monthIndex(dMonY[2]!) + 1)}-${pad(+dMonY[1]!)}`, fromText: true };
  const monDY = text.match(new RegExp(`\\b(${MONTHS})[a-z]*\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "i"));
  if (monDY && plausible(+monDY[3]!, monthIndex(monDY[1]!) + 1, +monDY[2]!)) return { date: `${monDY[3]}-${pad(monthIndex(monDY[1]!) + 1)}-${pad(+monDY[2]!)}`, fromText: true };
  // 26-OCT-26, as core banking systems print it.
  const dMonYy = text.match(new RegExp(`\\b(\\d{1,2})[\\s-](${MONTHS})[a-z]*[\\s-](\\d{2})\\b(?![-/.]\\d)`, "i"));
  if (dMonYy && plausible(2000 + +dMonYy[3]!, monthIndex(dMonYy[2]!) + 1, +dMonYy[1]!)) return { date: `20${dMonYy[3]}-${pad(monthIndex(dMonYy[2]!) + 1)}-${pad(+dMonYy[1]!)}`, fromText: true };
  if (fallback && !Number.isNaN(fallback.getTime())) return { date: fallback.toISOString().slice(0, 10), fromText: false };
  return null;
}

type Found = { amountMinor: number; kind: "out" | "in"; sentence: string; description: string | null; explicit?: boolean; loose?: boolean };

const toMinor = (raw: string) => Math.round(Number(raw.replace(/,/g, "")) * 100);
const kindWord = (w: string): "out" | "in" | null => (/^(debit|dr|withdrawal|withdrawn|paid|purchase)/i.test(w) ? "out" : /^(credit|cr|deposit|received|refund)/i.test(w) ? "in" : null);
/** The direction a type cell or a trailing marker names: "Debit", "DR", "Fund Transfer (Credit)". */
function kindIn(s: string): "out" | "in" | null {
  const t = s.replace(/\b(?:debit|credit)\s+cards?\b/gi, "");
  const out = /\b(debit(?:ed)?|dr|withdraw\w*|purchase|payment|paid|spent|charged)\b/i.test(t);
  const inn = /\b(credit(?:ed)?|cr|deposit(?:ed)?|received|refund(?:ed)?|salary)\b/i.test(t);
  return out && !inn ? "out" : inn && !out ? "in" : null;
}
/** Only the plain debit and credit words, for reading a whole email where "received" or "payment" turn up in the footer. */
function kindLoose(s: string): "out" | "in" | null {
  const t = s.replace(/\b(?:debit|credit)\s+cards?\b/gi, "");
  const out = /\b(debit(?:ed)?|withdraw(?:al|n)?|dr)\b/i.test(t);
  const inn = /\b(credit(?:ed)?|deposit(?:ed)?|cr)\b/i.test(t);
  return out && !inn ? "out" : inn && !out ? "in" : null;
}

const lineList = (text: string) => text.split(/\n+/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);

/** Joins a label-only line with the value on the next line: "Transaction Amount" + "NPR 1,500.00". */
function pairUp(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const n = lines[i + 1];
    if (n && ((LABEL_ONLY.test(l) && !LABEL_ONLY.test(n)) || (SIDE_ONLY.test(l) && NUMBER_ONLY.test(n)))) {
      out.push(`${l.replace(/[:\-–\s]+$/, "")}: ${n.replace(/^[:\-–\s]+/, "")}`);
      i++;
    } else out.push(l);
  }
  return out;
}

/**
 * Alerts laid out as a table or as label lines ("Transaction Type: Debit", "Amount (NPR): 1,500.00",
 * "Remarks: ESEWA LOAD"), which banks send as often as sentences. Read line by line. `explicit`
 * says the direction came from a Type row, a Dr/Cr marker or a Debit/Credit amount label.
 */
export function readLabelled(text: string): Found | null {
  const lines = pairUp(lineList(text));
  let amountMinor = 0;
  let kind: "out" | "in" | null = null;
  let explicit = false;
  let description: string | null = null;
  for (const line of lines) {
    if (/balance|limit/i.test(line)) continue;
    if (!amountMinor) {
      const amt = line.match(AMOUNT_LINE);
      const side = amt ? null : line.match(SIDE_LINE);
      const minor = amt ? toMinor(amt[3]!) : side ? toMinor(side[2]!) : 0;
      // A zero ("Credit Amount: 0.00" beside the debit) is not the transaction.
      if (minor > 0) {
        amountMinor = minor;
        const k = amt ? ((amt[1] ? kindWord(amt[1]) : null) ?? (amt[4] ? kindIn(amt[4]) : null) ?? (amt[2] === "-" ? "out" : amt[2] === "+" ? "in" : null)) : kindWord(side![1]!);
        if (k && !explicit) {
          kind = k;
          explicit = true;
        }
        continue;
      }
    }
    const type = line.match(TYPE_LINE);
    if (type && !explicit) {
      const k = kindIn(type[1]!);
      if (k) {
        kind = k;
        explicit = true;
      }
    }
    const desc = line.match(DESC_LINE);
    if (desc && !description) description = desc[2]!.replace(/[.;,\s]+$/, "").trim() || null;
  }
  if (!amountMinor || amountMinor <= 0) return null;
  if (!kind) {
    // No type line: the first debit or credit word anywhere decides.
    const flat = blank(text.replace(/\s+/g, " "));
    const out = flat.search(/\b(debited|debit(?!\s*card)|withdrawn|withdrawal)\b/i);
    const inn = flat.search(/\b(credited|credit(?!\s*card)|deposited)\b/i);
    kind = out >= 0 && (inn < 0 || out < inn) ? "out" : inn >= 0 ? "in" : null;
  }
  if (!kind) return null;
  return { amountMinor, kind, explicit, sentence: lines.filter((l) => !/balance/i.test(l)).slice(0, 8).join(" · ").slice(0, 300), description };
}

/** Boilerplate that names a direction without being about the money: blanked out (same length) before reading. */
const BOILERPLATE = /\b(?:if\s+you\s+)?(?:have\s+|has\s+)?received\s+this\s+(?:e-?mail|message|mail|communication|alert)\b|\b(?:debit|credit)\s+cards?\b|\bcredit\s+(?:facility|limit|score)\b/gi;
const blank = (s: string) => s.replace(BOILERPLATE, (m) => " ".repeat(m.length));

/** The transaction in a piece of alert text, or null when nothing reads like one. */
export function readAlert(text: string): Found | null {
  const flat = blank(text.replace(/\s+/g, " "));
  const amounts = [...flat.matchAll(AMOUNT)]
    .map((m) => ({ index: m.index ?? 0, raw: m[1] ?? m[2] ?? "", end: (m.index ?? 0) + m[0].length }))
    .map((a) => ({ ...a, minor: toMinor(a.raw) }))
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
  return { amountMinor: best.a.minor, kind: best.kind, sentence, description: describe(text, flat, best.a.end) };
}

function describe(text: string, flat: string, amountEnd: number): string | null {
  const label = text.match(DESC_LABEL);
  let description = label?.[1]?.replace(/\s+/g, " ").trim() ?? null;
  if (description) description = description.replace(/\s*(?:avail(?:able)?\s+bal(?:ance)?|balance|thank you|regards)\b.*$/i, "").replace(/[.;,\s]+$/, "").trim() || null;
  if (!description && amountEnd >= 0) {
    // "… debited by NPR 1,500.00 at BHATBHATENI …" or "… paid to NTC …"
    const after = flat.slice(amountEnd, amountEnd + 120).match(/^\s*(?:\w*\s+)?(?:at|to|from|for|towards)\s+([A-Za-z0-9&'().\-\/ ]{2,60}?)(?=\s+(?:on|dated|date|at\s+\d|via|through|ref|txn|transaction|\.|,|$))/i);
    description = after?.[1]?.trim() ?? null;
  }
  return description;
}

type Mention = { index: number; raw: string; minor: number; balance: boolean };

/** Every amount in the text, after a currency or under an Amount label, marked when it reads as a balance. */
function mentions(flat: string): Mention[] {
  const found = new Map<number, Mention>();
  for (const re of [AMOUNT, LABELLED_AMOUNT]) {
    for (const m of flat.matchAll(re)) {
      const raw = m[1] ?? m[2] ?? "";
      const minor = toMinor(raw);
      const index = m.index ?? 0;
      if (!(minor > 0) || found.has(index)) continue;
      found.set(index, { index, raw, minor, balance: BALANCE_NEAR.test(flat.slice(Math.max(0, index - 40), index)) || /\bbal(?:ance)?\b/i.test(m[0]) });
    }
  }
  return [...found.values()].sort((a, b) => a.index - b.index);
}

/** Last resort: one amount in the whole email that is not a balance, and only one direction named anywhere. */
export function readLoose(text: string): Found | null {
  const flat = blank(text.replace(/\s+/g, " "));
  const tx = mentions(flat).filter((a) => !a.balance);
  if (new Set(tx.map((a) => a.minor)).size !== 1) return null;
  const a = tx[0]!;
  const near = flat.slice(Math.max(0, a.index - 120), a.index + a.raw.length + 120);
  const kind = kindLoose(near) ?? kindLoose(flat);
  if (!kind) return null;
  return { amountMinor: a.minor, kind, loose: true, sentence: near.trim().slice(0, 300), description: describe(text, flat, -1) };
}

/** Why nothing was read, said so a person can act, with whatever was found to start them off. */
export function whyUnread(text: string, fallback: Date | null): Unread {
  const flat = text.replace(/\s+/g, " ");
  const all = mentions(flat);
  const tx = all.filter((a) => !a.balance);
  const values = [...new Set(tx.map((a) => a.minor))];
  // A weak hint for the form (payment, purchase, salary, refund…), for a person to confirm.
  const guess = { amountMinor: values.length === 1 ? values[0]! : null, kind: kindIn(blank(flat)), date: findDate(text, fallback)?.date ?? null, description: describe(text, flat, -1) };
  if (!all.length) return { why: "No amount in it: nothing after NPR or Rs, or next to the word Amount.", guess };
  if (!tx.length) return { why: `The only amount in it looks like a balance (${all[0]!.raw}).`, guess };
  if (values.length > 1) return { why: `It has ${values.length} amounts (${tx.slice(0, 3).map((a) => a.raw).join(", ")}) and nothing saying which one moved.`, guess };
  return { why: `It has an amount, ${tx[0]!.raw}, but nothing saying whether that went out or came in.`, guess };
}

/** The email as text, and its tables as "label: value" lines. */
function readEmail(email: Email): { text: string; labelled: string } {
  const html = email.html ?? "";
  return { text: `${email.text ?? ""}\n${plainText(html)}`, labelled: tableLines(tableRows(html)).join("\n") };
}

/** Labels that name the direction first, then sentences, then labels without a Type row, then the last resort. */
export function readAll(text: string, labelled = ""): Found | null {
  const table = labelled ? readLabelled(labelled) : null;
  const lines = readLabelled(text);
  return [table, lines].find((f) => f?.explicit) ?? readAlert(text) ?? table ?? lines ?? readLoose(text);
}

/** The date on a Date row first ("Transaction Date: 26-Oct-2026"), else the first date anywhere, else the email's. */
function dateOf(text: string, labelled: string, fallback: Date | null) {
  const row = lineList(`${labelled}\n${text}`).find((l) => /^\W*(?:(?:txn|trans(?:action)?|tran|value|posting)\.?\s*)?date\b/i.test(l));
  return (row ? findDate(row) : null) ?? findDate(text, fallback);
}

const SUBJECT = /alert|transaction|txn|debit|credit|payment|statement|notification|has been (?:debited|credited)|a\/c|account/i;

export const alertParser: StatementParser = {
  key: "alert-text",
  matches: ({ subject, from }) => SUBJECT.test(subject) && !/forwarding-noreply@google\.com/i.test(from),
  async parse(email: Email): Promise<ParsedLine[]> {
    const { text, labelled } = readEmail(email);
    const found = readAll(text, labelled);
    if (!found) return [];
    const when = dateOf(text, labelled, email.date ? new Date(email.date) : null);
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
        confidence: found.loose ? 55 : when.fromText ? 70 : 60,
      },
    ];
  },
  explain(email: Email): Unread {
    const { text } = readEmail(email);
    return whyUnread(text, email.date ? new Date(email.date) : null);
  },
};
