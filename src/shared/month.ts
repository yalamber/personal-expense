/**
 * The month's arithmetic behind Today's headline, in one place so the Worker and the page agree
 * and a test can pin it down.
 *
 *   income already in the book this month
 *   − spent so far
 *   − set aside for goals, loan installments and the bills still to come
 *   = for everyday things, ÷ days to payday = a day
 *
 * Only money that has arrived counts. Income listed under Every month and not yet in the book is
 * reported apart (so the page can say "Rs 90,000 expected, not counted until it is in"), and the
 * usual month from the starting point is used by the Plan, never here.
 */
export type MonthInput = {
  /** Income in the book this month. */
  loggedInMinor: number;
  /** Every-month income not yet in the book (the salary before payday). Reported, not counted. */
  expectedInMinor: number;
  spentMinor: number;
  goalsMinor: number;
  loansMinor: number;
  /** Every-month bills not yet in the book. */
  billsMinor: number;
  daysLeft: number;
  minorDigits: number;
};

/**
 * nothing: no income and no spending yet; waiting: nothing has come in yet, though money has gone
 * out or is set aside; unplanned: income is in but nothing is set aside, so the day figure is the
 * whole month; over: more is spent and set aside than came in; ok: the plain case.
 */
export type MonthMode = "nothing" | "waiting" | "unplanned" | "over" | "ok";

export type MonthMath = {
  incomeMinor: number;
  /** Every-month income still to come, not counted. */
  expectedLaterMinor: number;
  committedMinor: number;
  everydayLeftMinor: number;
  /** Whole currency units: "Rs 3,200 a day", never "Rs 3,245.55 a day". */
  perDayMinor: number;
  mode: MonthMode;
};

export function monthMath(i: MonthInput): MonthMath {
  const incomeMinor = Math.max(0, i.loggedInMinor);
  const committedMinor = i.goalsMinor + i.loansMinor + i.billsMinor;
  const everydayLeftMinor = incomeMinor - i.spentMinor - committedMinor;
  const unit = 10 ** i.minorDigits;
  const perDayMinor = Math.floor(Math.max(0, everydayLeftMinor) / Math.max(1, i.daysLeft) / unit) * unit;
  const mode: MonthMode =
    incomeMinor === 0
      ? i.spentMinor === 0 && committedMinor === 0
        ? "nothing"
        : "waiting"
      : everydayLeftMinor < 0
        ? "over"
        : committedMinor === 0
          ? "unplanned"
          : "ok";
  return { incomeMinor, expectedLaterMinor: Math.max(0, i.expectedInMinor), committedMinor, everydayLeftMinor, perDayMinor, mode };
}
