/**
 * Repayment terms on money between people: a khata contact, or money we lent. A date the family
 * means to settle by, and either no interest (family and friends) or simple interest at a rate
 * given a year or a month, counted from a date.
 *
 * Balances follow the khata: positive means they owe us, negative means we owe them. Interest has
 * the same sign: positive is interest they owe us, negative is interest we owe.
 */
export type RatePer = "year" | "month";

export type TermsInput = {
  /** The brought-forward balance and the day it stands at the end of (null: none). */
  openingMinor: number;
  openingDate: string | null;
  /** Entries that count, as signed changes to the balance (+ they owe us more). */
  entries: { date: string; deltaMinor: number }[];
  /** Yearly rate in basis points (24% a year = 2400); 0 or null for no interest. */
  rateBp: number | null;
  /** Interest counted from (the day the money was lent or borrowed); defaults to when the balance began. */
  from: string | null;
};

const DAY = 86_400_000;
const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);

/** The day interest starts: the given date, else the brought-forward date, else the first entry. */
export function interestStart(t: TermsInput): string | null {
  if (t.from) return t.from;
  if (t.openingMinor !== 0 && t.openingDate) return t.openingDate;
  const first = [...t.entries].sort((a, b) => a.date.localeCompare(b.date))[0];
  return first?.date ?? null;
}

/**
 * Simple interest on the running balance from the start day up to `to`, day by day: each balance
 * earns for the days it stood. Rounded to whole minor units.
 */
export function interestUntil(t: TermsInput, to: string): number {
  const rate = t.rateBp ?? 0;
  const start = interestStart(t);
  if (!rate || !start || to <= start) return 0;
  const sorted = [...t.entries].sort((a, b) => a.date.localeCompare(b.date));
  let balance = t.openingMinor;
  let cursor = start;
  let balanceDays = 0;
  for (const e of sorted) {
    if (e.date <= cursor) {
      // Before (or on) the day interest starts, or the same day as the last step: it just moves the balance.
      balance += e.deltaMinor;
      continue;
    }
    if (e.date >= to) break;
    balanceDays += balance * days(cursor, e.date);
    cursor = e.date;
    balance += e.deltaMinor;
  }
  balanceDays += balance * days(cursor, to);
  return Math.round((balanceDays * rate) / 10_000 / 365);
}

/** "2% a month", "12% a year", "no interest". Rates are stored yearly. */
export function rateText(rateBp: number | null, per: RatePer | null): string {
  if (!rateBp) return "no interest";
  const tidy = (n: number) => (Math.round(n * 100) / 100).toString();
  return per === "month" ? `${tidy(rateBp / 12 / 100)}% a month` : `${tidy(rateBp / 100)}% a year`;
}

/** The rate as typed: 2 (a month) becomes 2400 basis points a year. */
export function rateToBp(percent: number, per: RatePer): number {
  return Math.round(percent * 100 * (per === "month" ? 12 : 1));
}

/** The number to put back in the rate field. */
export function rateInput(rateBp: number | null, per: RatePer | null): string {
  if (!rateBp) return "";
  const n = per === "month" ? rateBp / 12 / 100 : rateBp / 100;
  return (Math.round(n * 100) / 100).toString();
}

export type SettleStatus = { days: number; late: boolean; soon: boolean };

/** Days to the settle-by date (negative once past); "soon" is within a week. */
export function settleStatus(settleBy: string | null, today: string): SettleStatus | null {
  if (!settleBy) return null;
  const d = days(today, settleBy);
  return { days: d, late: d < 0, soon: d >= 0 && d <= 7 };
}
