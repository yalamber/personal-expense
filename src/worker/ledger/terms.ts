/**
 * Repayment terms for money between people (khata contacts and money lent): the interest so far
 * and by the settle-by date, from each account's entries. See src/shared/terms.ts for the rules.
 */
import { and, inArray, isNull } from "drizzle-orm";
import { minorDigits } from "../../shared/money";
import { interestStart, interestUntil, type RatePer } from "../../shared/terms";
import { schema, type Db } from "../db";

export type AccountTerms = {
  rateBp: number;
  ratePer: RatePer | null;
  /** The day interest is counted from (given, or when the balance began). */
  from: string | null;
  settleBy: string | null;
  /** Interest to today: positive they owe us, negative we owe. */
  interestMinor: number;
  /** Interest by the settle-by date if nothing else changes; null without a future date. */
  interestBySettleMinor: number | null;
};

type Row = typeof schema.accounts.$inferSelect;

/** Contacts and money lent with a rate or a settle-by date. */
export const hasTerms = (a: Pick<Row, "type" | "rateBp" | "endDate">) => (a.type === "person" || a.type === "lent") && ((a.rateBp ?? 0) > 0 || Boolean(a.endDate));

/** Interest between people is paid in whole rupees (or whole units of any currency). */
const whole = (minor: number, digits: number) => Math.round(minor / 10 ** digits) * 10 ** digits || 0;

export async function loadTerms(db: Db, accounts: Row[], today: string, currency: string): Promise<Map<string, AccountTerms>> {
  const digits = minorDigits(currency);
  const relevant = accounts.filter(hasTerms);
  const out = new Map<string, AccountTerms>();
  if (!relevant.length) return out;
  const t = schema.transactions;
  const withRate = relevant.filter((a) => (a.rateBp ?? 0) > 0).map((a) => a.id);
  const rows = withRate.length
    ? await db
        .select({ accountId: t.accountId, date: t.date, direction: t.direction, amountMinor: t.amountMinor })
        .from(t)
        .where(and(inArray(t.accountId, withRate), isNull(t.voidedAt)))
    : [];
  for (const a of relevant) {
    const entries = rows
      .filter((r) => r.accountId === a.id && (!a.openingBalanceDate || r.date > a.openingBalanceDate))
      .map((r) => ({ date: r.date, deltaMinor: r.direction === "in" ? r.amountMinor : -r.amountMinor }));
    const input = { openingMinor: a.openingBalanceMinor ?? 0, openingDate: a.openingBalanceDate, entries, rateBp: a.rateBp, from: a.startDate };
    out.set(a.id, {
      rateBp: a.rateBp ?? 0,
      ratePer: (a.ratePer as RatePer | null) ?? null,
      from: (a.rateBp ?? 0) > 0 ? interestStart(input) : null,
      settleBy: a.endDate,
      interestMinor: whole(interestUntil(input, today), digits),
      interestBySettleMinor: a.endDate && a.endDate > today ? whole(interestUntil(input, a.endDate), digits) : null,
    });
  }
  return out;
}
