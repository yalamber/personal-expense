/**
 * Reading a statement email with Workers AI when no built-in reader finds a transaction in it.
 * The model lists what it sees; each item is kept only when its amount is written in the email
 * (and not only as a balance), its direction is out or in, and its date is plausible. Lines carry
 * a confidence below the auto-post line, so a person confirms each one in Decide.
 */
import type { ParsedLine } from "../ingest/parsers";
import { askJson, type AiRunner } from "./index";

const SYSTEM = `You read bank, card and wallet emails sent to a family in Nepal and list the money movements they report.
Rules:
- List only transactions the email says happened on the customer's account: money taken out (debit, DR, withdrawal, purchase, payment, transfer out, fee, charge) or put in (credit, CR, deposit, salary, refund, transfer in).
- amount: the transaction amount as written in the email, digits only with its decimal point. Never a balance, a limit or a reference number.
- direction: "out" for money that left the account, "in" for money that came in.
- date: the transaction date as YYYY-MM-DD when the email gives one (Nepali banks write the day first: 26/10/2026 is 26 October 2026), else "".
- description: the remarks, narration, merchant or person as written, short.
- quote: the exact words of the email that show the amount and its direction.
- A one-time password, a statement notice, an offer, a reminder, a balance alone or a failed transaction is not a transaction: return an empty list.`;

const SCHEMA = {
  type: "object",
  properties: {
    transactions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          amount: { type: "string" },
          direction: { type: "string", enum: ["out", "in"] },
          date: { type: "string" },
          description: { type: "string" },
          quote: { type: "string" },
        },
        required: ["amount", "direction", "date", "description", "quote"],
      },
    },
  },
  required: ["transactions"],
};

type Answer = { transactions?: { amount?: unknown; direction?: unknown; date?: unknown; description?: unknown; quote?: unknown }[] };

const NUMBER = /\d[\d,]*(?:\.\d{1,2})?/g;
const toMinor = (raw: string) => Math.round(Number(raw.replace(/,/g, "")) * 100);
const clean = (v: unknown, max = 120) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** True when every place the amount is written reads as a balance or a limit. */
function onlyAsBalance(flat: string, minor: number): boolean {
  const spots = [...flat.matchAll(NUMBER)].filter((m) => toMinor(m[0]) === minor);
  return spots.length > 0 && spots.every((m) => /\b(?:bal(?:ance)?|limit)\b[^\d]{0,30}$/i.test(flat.slice(Math.max(0, (m.index ?? 0) - 40), m.index)));
}

/** A real calendar date near the email's own date (not a Bikram Sambat year read as Gregorian). */
function plausibleDate(v: unknown, sent: Date | null): string | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const t = Date.parse(`${v}T00:00:00Z`);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== v) return null;
  const ref = sent && !Number.isNaN(sent.getTime()) ? sent.getTime() : Date.now();
  return t <= ref + 2 * 86_400_000 && t >= ref - 400 * 86_400_000 ? v : null;
}

/** The lines the AI found and the checks kept, or null when the AI could not be asked (or answered nonsense). */
export async function readWithAi(ai: AiRunner, email: { text: string; subject: string; from: string; sentAt: Date | null }): Promise<ParsedLine[] | null> {
  const flat = email.text.replace(/\s+/g, " ").trim();
  if (!flat) return [];
  const answer = await askJson<Answer>(ai, SYSTEM, `From: ${email.from}\nSubject: ${email.subject}\n\n${email.text.slice(0, 6000)}`, SCHEMA);
  if (!answer || !Array.isArray(answer.transactions)) return null;
  const items = answer.transactions.slice(0, 20);
  const written = new Set([...flat.matchAll(NUMBER)].map((m) => toMinor(m[0])));
  const fallback = email.sentAt && !Number.isNaN(email.sentAt.getTime()) ? email.sentAt.toISOString().slice(0, 10) : null;
  const subject = email.subject.replace(/^(?:fwd?|fw|re)\s*:\s*/i, "").trim();
  const seen = new Set<string>();
  const lines: ParsedLine[] = [];
  for (const t of items) {
    const raw = String(t.amount ?? "").replace(/[^\d.,]/g, "");
    const minor = /\d/.test(raw) ? toMinor(raw) : 0;
    if (!(minor > 0) || !written.has(minor) || onlyAsBalance(flat, minor)) continue;
    if (t.direction !== "out" && t.direction !== "in") continue;
    const stated = plausibleDate(t.date, email.sentAt);
    const date = stated ?? fallback;
    if (!date) continue;
    const key = `${date}|${t.direction}|${minor}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const description = clean(t.description) || subject || "Bank email";
    const quote = clean(t.quote, 300);
    lines.push({
      rawText: quote && flat.toLowerCase().includes(quote.toLowerCase()) ? quote : `${description} · ${raw}`,
      date,
      amountMinor: minor,
      kind: t.direction,
      description,
      confidence: stated ? 65 : 60,
    });
  }
  return lines;
}
