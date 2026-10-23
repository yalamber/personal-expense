/**
 * Fixed deposit maths, shared by the Worker (Decide reminders, account lists) and the web app.
 *
 * Two kinds of deposit, as banks offer them:
 *  - interest kept in the deposit ("maturity"): it compounds every quarter and is paid with the
 *    principal at maturity
 *  - interest paid out every quarter or month to another account: the deposit stays at its
 *    principal and the interest arrives as income
 *
 * These are estimates for planning; the bank's statement is the truth, and posted interest is
 * logged as income like anything else.
 */

export type DepositPayout = "maturity" | "quarterly" | "monthly";

export type Deposit = {
  principalMinor: number;
  /** Yearly rate in basis points: 8.5% is 850. */
  rateBp: number;
  /** YYYY-MM-DD */
  start: string;
  maturity: string;
  payout: DepositPayout;
};

const DAY = 86_400_000;

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
}

/** Adds whole months, keeping the day where the month allows (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

/** Whole months from start to maturity, for "a 12-month deposit". */
export function termMonths(start: string, maturity: string): number {
  const [sy, sm, sd] = start.split("-").map(Number) as [number, number, number];
  const [my, mm, md] = maturity.split("-").map(Number) as [number, number, number];
  return (my - sy) * 12 + (mm - sm) - (md < sd ? 1 : 0);
}

function grown(d: Deposit, days: number): number {
  const years = Math.max(0, days) / 365;
  return d.principalMinor * Math.pow(1 + d.rateBp / 10_000 / 4, 4 * years);
}

/** What the deposit pays back at maturity: principal plus interest kept in, or just the principal. */
export function maturityValue(d: Deposit): number {
  if (d.payout !== "maturity") return d.principalMinor;
  return Math.round(grown(d, daysBetween(d.start, d.maturity)));
}

/** All the interest over the term, whichever way it is paid. */
export function totalInterest(d: Deposit): number {
  if (d.payout === "maturity") return maturityValue(d) - d.principalMinor;
  return Math.round((d.principalMinor * d.rateBp) / 10_000 * (daysBetween(d.start, d.maturity) / 365));
}

/**
 * Interest earned but not yet in the book on a date: for interest kept in, everything since the
 * start (up to maturity); for interest paid out, what has built up since the last payout date.
 */
export function accruedInterest(d: Deposit, asOf: string): number {
  const until = asOf < d.maturity ? asOf : d.maturity;
  if (until <= d.start) return 0;
  if (d.payout === "maturity") return Math.round(grown(d, daysBetween(d.start, until)) - d.principalMinor);
  const step = d.payout === "quarterly" ? 3 : 1;
  let last = d.start;
  for (let n = step; ; n += step) {
    const next = addMonths(d.start, n);
    if (next > until) break;
    last = next;
  }
  return Math.round((d.principalMinor * d.rateBp) / 10_000 * (daysBetween(last, until) / 365));
}

/** "8.5%" from 850. */
export function rateLabel(rateBp: number): string {
  return `${(rateBp / 100).toFixed(rateBp % 100 === 0 ? 0 : rateBp % 10 === 0 ? 1 : 2)}%`;
}

/** 850 from "8.5" or "8.5%"; null when it is not a sensible yearly rate. */
export function parseRate(input: string): number | null {
  const n = Number(input.replace("%", "").trim());
  if (!Number.isFinite(n) || n <= 0 || n > 50) return null;
  return Math.round(n * 100);
}
