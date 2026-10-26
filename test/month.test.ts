import { describe, expect, it } from "vitest";
import { monthMath, type MonthInput } from "../src/shared/month";

const rs = (n: number) => n * 100;
const base: MonthInput = { loggedInMinor: 0, expectedInMinor: 0, spentMinor: 0, goalsMinor: 0, loansMinor: 0, billsMinor: 0, daysLeft: 14, minorDigits: 2 };

describe("monthMath", () => {
  it("has nothing to say before any money moves", () => {
    const m = monthMath(base);
    expect(m.mode).toBe("nothing");
    expect(m.perDayMinor).toBe(0);
  });

  it("the plain month: income in the book, less spending and what is set aside, by the days left", () => {
    const m = monthMath({ ...base, loggedInMinor: rs(90_000), spentMinor: rs(20_000), goalsMinor: rs(15_000), loansMinor: rs(10_000), daysLeft: 10 });
    expect(m).toMatchObject({ mode: "ok", incomeMinor: rs(90_000), committedMinor: rs(25_000), everydayLeftMinor: rs(45_000), perDayMinor: rs(4_500) });
  });

  it("counts only income already in: the salary still to come is reported, not added", () => {
    const m = monthMath({ ...base, expectedInMinor: rs(90_000), billsMinor: rs(25_000), goalsMinor: rs(20_000), daysLeft: 15 });
    expect(m.incomeMinor).toBe(0);
    expect(m.expectedLaterMinor).toBe(rs(90_000));
    expect(m.mode).toBe("waiting");
    expect(m.perDayMinor).toBe(0);
  });

  it("the family's question: nothing logged, nothing planned, a usual month typed in, is no longer Rs 1,35,714 a day", () => {
    const m = monthMath({ ...base, daysLeft: 14 });
    expect(m.mode).toBe("nothing");
    expect(m.perDayMinor).toBe(0);
  });

  it("waiting: money went out before any came in", () => {
    const m = monthMath({ ...base, spentMinor: rs(4_000) });
    expect(m).toMatchObject({ mode: "waiting", everydayLeftMinor: rs(-4_000), perDayMinor: 0 });
  });

  it("income partly in: only the part in the book counts", () => {
    const m = monthMath({ ...base, loggedInMinor: rs(15_000), expectedInMinor: rs(90_000), goalsMinor: rs(10_000) });
    expect(m).toMatchObject({ mode: "ok", incomeMinor: rs(15_000), expectedLaterMinor: rs(90_000), everydayLeftMinor: rs(5_000) });
  });

  it("unplanned: income in and nothing set aside", () => {
    const m = monthMath({ ...base, loggedInMinor: rs(90_000), spentMinor: rs(6_000), daysLeft: 12 });
    expect(m).toMatchObject({ mode: "unplanned", perDayMinor: rs(7_000) });
  });

  it("over: spending and what is set aside past what came in", () => {
    const m = monthMath({ ...base, loggedInMinor: rs(50_000), spentMinor: rs(48_000), goalsMinor: rs(10_000) });
    expect(m.mode).toBe("over");
    expect(m.everydayLeftMinor).toBe(rs(-8_000));
    expect(m.perDayMinor).toBe(0);
  });

  it("rounds the day figure down to whole units and never divides by zero days", () => {
    const m = monthMath({ ...base, loggedInMinor: rs(10_000), goalsMinor: 1, daysLeft: 3 });
    expect(m.perDayMinor).toBe(rs(3_333));
    expect(monthMath({ ...base, loggedInMinor: rs(10_000), daysLeft: 0 }).perDayMinor).toBe(rs(10_000));
    expect(monthMath({ ...base, loggedInMinor: 1000, daysLeft: 3, minorDigits: 0 }).perDayMinor).toBe(333);
  });
});
