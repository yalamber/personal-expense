/**
 * The month's arithmetic behind Today's headline, in one place so the Worker and the page agree
 * and a test can pin it down.
 *
 *   income (what came in; if nothing yet, what is expected)
 *   − spent so far
 *   − set aside for goals, loan installments and the bills still to come
 *   = for everyday things, ÷ days to payday = a day
 *
 * Income is the book's figure for the month. When nothing has come in yet, the every-month income
 * still to arrive stands in, and failing that the usual month's figure. The headline says which,
 * so a figure built on an expectation never reads like money in hand.
 */
export type MonthInput = {
  /** Income in the book this month. */
  loggedInMinor: number;
  /** Every-month income not yet in the book (the salary before payday). */
  expectedInMinor: number;
  /** A usual month, when the book has nothing yet: typed in, or the average of recent months. */
  usual: { source: "book" | "typical" | "none"; incomeMinor: number };
  spentMinor: number;
  goalsMinor: number;
  loansMinor: number;
  /** Every-month bills not yet in the book. */
  billsMinor: number;
  daysLeft: number;
  minorDigits: number;
};

/**
 * nothing: no income and no spending yet; unplanned: the income is only expected and nothing is
 * set aside, so the day figure is the whole month; expected: part of the income is still to come;
 * over: more is spent than the month has; ok: the plain case.
 */
export type MonthMode = "nothing" | "unplanned" | "expected" | "over" | "ok";

export type MonthMath = {
  incomeMinor: number;
  /** Part of the income has not arrived yet. */
  incomeExpected: boolean;
  /** The part still to come, when expected. */
  expectedPartMinor: number;
  incomeSource: "logged" | "recurring" | "usual" | "none";
  committedMinor: number;
  everydayLeftMinor: number;
  /** Whole currency units: "Rs 3,200 a day", never "Rs 3,245.55 a day". */
  perDayMinor: number;
  mode: MonthMode;
};

export function monthMath(i: MonthInput): MonthMath {
  let incomeMinor = i.loggedInMinor + i.expectedInMinor;
  let incomeSource: MonthMath["incomeSource"] = i.loggedInMinor > 0 ? "logged" : i.expectedInMinor > 0 ? "recurring" : "none";
  let expectedPartMinor = i.expectedInMinor;
  if (incomeMinor === 0 && i.usual.source !== "none" && i.usual.incomeMinor > 0) {
    incomeMinor = i.usual.incomeMinor;
    expectedPartMinor = i.usual.incomeMinor;
    incomeSource = "usual";
  }
  const incomeExpected = expectedPartMinor > 0;
  const committedMinor = i.goalsMinor + i.loansMinor + i.billsMinor;
  const everydayLeftMinor = incomeMinor - i.spentMinor - committedMinor;
  const unit = 10 ** i.minorDigits;
  const perDayMinor = Math.floor(Math.max(0, everydayLeftMinor) / Math.max(1, i.daysLeft) / unit) * unit;
  const mode: MonthMode =
    incomeMinor === 0 && i.spentMinor === 0
      ? "nothing"
      : everydayLeftMinor < 0
        ? "over"
        : incomeSource === "usual" && committedMinor === 0
          ? "unplanned"
          : incomeExpected
            ? "expected"
            : "ok";
  return { incomeMinor, incomeExpected, expectedPartMinor, incomeSource, committedMinor, everydayLeftMinor, perDayMinor, mode };
}
