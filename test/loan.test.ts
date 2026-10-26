import { describe, expect, it } from "vitest";
import { emi, interestLeft, monthsLeft, nextDue, payMore, payoffMonth, splitPayment } from "../src/shared/loan";
import { simulatePlan } from "../src/shared/plan";

const rs = (n: number) => n * 100;

describe("loans", () => {
  it("works out the usual EMI", () => {
    // 1,000,000 at 12% over 12 months: about 88,849 a month
    expect(Math.abs(emi(rs(1_000_000), 1200, 12) - rs(88_849))).toBeLessThan(rs(2));
    expect(emi(rs(120_000), 0, 12)).toBe(rs(10_000));
  });

  it("splits a payment into interest first, then principal", () => {
    expect(splitPayment(rs(1_000_000), 1200, rs(88_849))).toEqual({ interestMinor: rs(10_000), principalMinor: rs(78_849) });
    expect(splitPayment(rs(50_000), 0, rs(10_000))).toEqual({ interestMinor: 0, principalMinor: rs(10_000) });
  });

  it("counts installments left and the interest still to pay", () => {
    expect(monthsLeft(rs(1_000_000), 1200, emi(rs(1_000_000), 1200, 12))).toBe(12);
    expect(monthsLeft(rs(50_000), 0, rs(10_000))).toBe(5);
    expect(monthsLeft(rs(1_000_000), 1200, rs(9_000))).toBeNull();
    const left = interestLeft(rs(1_000_000), 1200, emi(rs(1_000_000), 1200, 12))!;
    expect(Math.abs(left - rs(66_190))).toBeLessThan(rs(20));
    expect(interestLeft(rs(50_000), 0, rs(10_000))).toBe(0);
  });

  it("finds the next due date and the last month", () => {
    expect(nextDue("2026-10-23", 5)).toBe("2026-11-05");
    expect(nextDue("2026-10-23", 23)).toBe("2026-10-23");
    expect(payoffMonth("2026-10-23", 5, 12)).toBe("2027-10");
  });
});

describe("plan with a loan ending", () => {
  it("puts the freed installment into the first unfinished goal from the month after", () => {
    const goals = [{ id: "g", name: "Land", kind: "purchase" as const, targetMinor: rs(500_000), savedMinor: 0, monthlyMinor: rs(10_000), wantedBy: null, parts: [] }];
    const without = simulatePlan(goals, { startMonth: "2026-11" }).outcomes[0]!;
    const withRelease = simulatePlan(goals, { startMonth: "2026-11", releases: [{ fromMonth: "2027-05", amountMinor: rs(10_000) }] }).outcomes[0]!;
    expect(without.doneMonth).toBe("2030-12");
    // 6 months at 10,000, then 20,000 a month: 60,000 + 22 × 20,000 = 500,000 in Feb 2029
    expect(withRelease.doneMonth).toBe("2029-02");
  });
});

describe("payMore", () => {
  it("a bigger installment repays sooner and with less interest", () => {
    const owed = 1_000_000 * 100;
    const inst = emi(owed, 1000, 60); // Rs 10 lakh at 10% over 5 years
    const r = payMore(owed, 1000, inst, { monthlyMinor: 5_000 * 100 });
    expect(r.before!.months).toBe(60);
    expect(r.after!.months).toBeLessThan(60);
    expect(r.after!.interestMinor).toBeLessThan(r.before!.interestMinor);
  });
  it("a one-off sum now shortens the loan", () => {
    const r = payMore(120_000 * 100, 0, 10_000 * 100, { lumpMinor: 30_000 * 100 });
    expect(r.before).toEqual({ months: 12, interestMinor: 0 });
    expect(r.after).toEqual({ months: 9, interestMinor: 0 });
  });
  it("says when an installment never repays the loan", () => {
    expect(payMore(1_000_000 * 100, 2400, 1_000 * 100).before).toBeNull();
  });
});
