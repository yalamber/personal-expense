import { describe, expect, it } from "vitest";
import { monthMath, type MonthInput } from "../src/shared/month";

const rs = (n: number) => n * 100;
const base: MonthInput = { loggedInMinor: 0, expectedInMinor: 0, usual: { source: "none", incomeMinor: 0 }, spentMinor: 0, goalsMinor: 0, loansMinor: 0, billsMinor: 0, daysLeft: 14, minorDigits: 2 };

describe("monthMath", () => {
  it("has nothing to say before any money moves", () => {
    const m = monthMath(base);
    expect(m.mode).toBe("nothing");
    expect(m.perDayMinor).toBe(0);
    expect(m.incomeSource).toBe("none");
  });

  it("the plain month: income in the book, less spending and what is set aside, by the days left", () => {
    const m = monthMath({ ...base, loggedInMinor: rs(90_000), spentMinor: rs(20_000), goalsMinor: rs(15_000), loansMinor: rs(10_000), daysLeft: 10 });
    expect(m).toMatchObject({ mode: "ok", incomeExpected: false, incomeSource: "logged", committedMinor: rs(25_000), everydayLeftMinor: rs(45_000), perDayMinor: rs(4_500) });
  });

  it("the family's question: a usual month typed in, nothing logged, nothing planned", () => {
    // Rs 19,00,000 a month, no entries, both goals at Rs 0 a month, 14 days to payday: Rs 1,35,714 a day.
    const m = monthMath({ ...base, usual: { source: "typical", incomeMinor: rs(1_900_000) }, daysLeft: 14 });
    expect(m.mode).toBe("unplanned");
    expect(m.incomeExpected).toBe(true);
    expect(m.incomeSource).toBe("usual");
    expect(m.perDayMinor).toBe(rs(135_714));
  });

  it("every-month income stands in for the usual figure, and bills are set aside before they are paid", () => {
    const m = monthMath({ ...base, expectedInMinor: rs(90_000), usual: { source: "typical", incomeMinor: rs(500_000) }, billsMinor: rs(25_000), goalsMinor: rs(20_000), daysLeft: 15 });
    expect(m.incomeMinor).toBe(rs(90_000));
    expect(m.incomeSource).toBe("recurring");
    expect(m.mode).toBe("expected");
    expect(m.expectedPartMinor).toBe(rs(90_000));
    expect(m.everydayLeftMinor).toBe(rs(45_000));
    expect(m.perDayMinor).toBe(rs(3_000));
  });

  it("income partly in and partly still to come is still 'expected'", () => {
    const m = monthMath({ ...base, loggedInMinor: rs(15_000), expectedInMinor: rs(90_000), goalsMinor: rs(10_000) });
    expect(m).toMatchObject({ mode: "expected", incomeSource: "logged", incomeMinor: rs(105_000), expectedPartMinor: rs(90_000) });
  });

  it("once the salary is in the book, the usual figure is not used again", () => {
    const m = monthMath({ ...base, loggedInMinor: rs(90_000), usual: { source: "typical", incomeMinor: rs(1_900_000) }, goalsMinor: rs(10_000) });
    expect(m.incomeMinor).toBe(rs(90_000));
    expect(m.mode).toBe("ok");
  });

  it("over: spending past the month's money", () => {
    const m = monthMath({ ...base, loggedInMinor: rs(50_000), spentMinor: rs(48_000), goalsMinor: rs(10_000) });
    expect(m.mode).toBe("over");
    expect(m.everydayLeftMinor).toBe(rs(-8_000));
    expect(m.perDayMinor).toBe(0);
  });

  it("rounds the day figure down to whole units and never divides by zero days", () => {
    const m = monthMath({ ...base, loggedInMinor: rs(10_000), daysLeft: 3 });
    expect(m.perDayMinor).toBe(rs(3_333));
    expect(monthMath({ ...base, loggedInMinor: rs(10_000), daysLeft: 0 }).perDayMinor).toBe(rs(10_000));
    expect(monthMath({ ...base, loggedInMinor: 1000, daysLeft: 3, minorDigits: 0 }).perDayMinor).toBe(333);
  });
});
