import { describe, expect, it } from "vitest";
import { simulatePlan, waysToReach, type PlanGoal } from "../src/shared/plan";
import { emi } from "../src/shared/loan";

const rs = (n: number) => n * 100;
const goal = (over: Partial<PlanGoal>): PlanGoal => ({ id: "g", name: "Goal", kind: "other", targetMinor: rs(100_000), savedMinor: 0, monthlyMinor: rs(10_000), wantedBy: null, parts: [], ...over });

describe("a goal bought partly with a loan", () => {
  it("only the down payment is saved, and the EMI starts the month after it is bought", () => {
    const land = goal({ id: "land", kind: "purchase", targetMinor: rs(1_000_000), monthlyMinor: rs(50_000), loan: { amountMinor: rs(600_000), rateBp: 1100, months: 120 } });
    const r = simulatePlan([land], { startMonth: "2027-01" });
    const o = r.outcomes[0]!;
    // Rs 4,00,000 down payment at Rs 50,000 a month: 8 months, January to August.
    expect(o.needMinor).toBe(rs(400_000));
    expect(o.doneMonth).toBe("2027-08");
    expect(o.loan).toMatchObject({ amountMinor: rs(600_000), emiMinor: emi(rs(600_000), 1100, 120), startMonth: "2027-09", endMonth: "2037-08" });
    expect(o.loan!.totalInterestMinor).toBe(emi(rs(600_000), 1100, 120) * 120 - rs(600_000));
    expect(o.loan!.shortMinor).toBe(0);
  });

  it("the EMI comes out of what the next goals get, until the loan is repaid", () => {
    const loan = { amountMinor: rs(120_000), rateBp: 0, months: 12 }; // Rs 10,000 a month, no interest
    const car = goal({ id: "car", targetMinor: rs(150_000), savedMinor: rs(30_000), monthlyMinor: rs(10_000), loan });
    const trip = goal({ id: "trip", targetMinor: rs(60_000), monthlyMinor: rs(5_000) });
    const r = simulatePlan([car, trip], { startMonth: "2027-01", trajectory: true });
    expect(r.outcomes[0]!.doneMonth).toBe("now");
    // With the car bought now, its Rs 10,000 rolls to the trip, but the Rs 10,000 EMI takes it back:
    // the trip gets only its own Rs 5,000 for 12 months, then Rs 15,000.
    const trip12 = r.trajectory!.saved[1]![12];
    expect(trip12).toBe(rs(60_000));
    expect(r.outcomes[1]!.doneMonth).toBe("2027-12");
  });

  it("an EMI bigger than the plan's money is noted as coming from everyday money", () => {
    const house = goal({ id: "h", targetMinor: rs(500_000), savedMinor: rs(100_000), monthlyMinor: rs(5_000), loan: { amountMinor: rs(400_000), rateBp: 0, months: 40 } });
    const later = goal({ id: "l", targetMinor: rs(50_000), monthlyMinor: rs(2_000) });
    const o = simulatePlan([house, later], { startMonth: "2027-01" }).outcomes[0]!;
    expect(o.doneMonth).toBe("now");
    expect(o.loan!.emiMinor).toBe(rs(10_000));
    // Rs 7,000 a month goes into the plan; the EMI is Rs 10,000, so Rs 3,000 comes from elsewhere.
    expect(o.loan!.shortMinor).toBe(rs(3_000));
  });
});

describe("money moments", () => {
  it("a bonus goes to the first unfinished goal (or the one named), a yearly one every year", () => {
    const a = goal({ id: "a", targetMinor: rs(100_000), monthlyMinor: rs(10_000) });
    const b = goal({ id: "b", targetMinor: rs(100_000), monthlyMinor: rs(10_000) });
    const plain = simulatePlan([a, b], { startMonth: "2027-01" });
    expect(plain.outcomes[0]!.doneMonth).toBe("2027-10");
    const bonus = simulatePlan([a, b], { startMonth: "2027-01", events: [{ name: "Dashain bonus", month: "2027-01", amountMinor: rs(40_000) }] });
    expect(bonus.outcomes[0]!.doneMonth).toBe("2027-06");
    const toB = simulatePlan([a, b], { startMonth: "2027-01", events: [{ name: "Gift", month: "2027-01", amountMinor: rs(40_000), goalId: "b" }] });
    // The gift finishes B in June; B's Rs 10,000 then rolls to A, which lands in August.
    expect(toB.outcomes[1]!.doneMonth).toBe("2027-06");
    expect(toB.outcomes[0]!.doneMonth).toBe("2027-08");
    const yearly = simulatePlan([goal({ targetMinor: rs(500_000), monthlyMinor: rs(10_000) })], { startMonth: "2027-01", events: [{ name: "Bonus", month: "2027-10", amountMinor: rs(100_000), yearly: true }] });
    // 10k a month plus 100k each October: Oct 2027 has 200k, Oct 2028 has 420k, then Jan 2029 is 450k... 500k in Apr 2029? 420 + 10*6 (Nov..Apr) = 480; May 490; Jun 500.
    expect(yearly.outcomes[0]!.doneMonth).toBe("2029-06");
  });

  it("money out comes out of the goals, carried over when one month cannot cover it", () => {
    const a = goal({ targetMinor: rs(100_000), monthlyMinor: rs(10_000) });
    const r = simulatePlan([a], { startMonth: "2027-01", events: [{ name: "Wedding", month: "2027-02", amountMinor: -rs(25_000) }] });
    // February's 10k goes to the wedding, then March's, then half of April's: 2.5 months later.
    expect(r.outcomes[0]!.doneMonth).toBe("2028-01");
  });

  it("past moments and ones after their last year are ignored", () => {
    const a = goal({ targetMinor: rs(100_000), monthlyMinor: rs(10_000) });
    const r = simulatePlan([a], { startMonth: "2027-01", events: [{ name: "Old", month: "2026-06", amountMinor: rs(50_000) }, { name: "Ended", month: "2026-01", amountMinor: rs(50_000), yearly: true, untilMonth: "2026-12" }] });
    expect(r.outcomes[0]!.doneMonth).toBe("2027-10");
  });
});

describe("ways to reach a goal", () => {
  it("names the monthly amount that makes the date, the date with the spare, and the gap to borrow", () => {
    const land = goal({ id: "land", kind: "purchase", targetMinor: rs(1_400_000), savedMinor: rs(400_000), monthlyMinor: 0, wantedBy: "2027-04" });
    const w = waysToReach([land], "land", { startMonth: "2027-01", spareMinor: rs(150_000), stepMinor: rs(500) });
    // Rs 10,00,000 still to find over January to April: Rs 2,50,000 a month.
    expect(w.monthlyMinor).toBe(rs(250_000));
    // With Rs 1,50,000 a month spare it lands in July (7 months).
    expect(w.withSpare).toEqual({ poolMinor: rs(150_000), doneMonth: "2027-07" });
    // At the current plan (nothing going in) the whole Rs 10,00,000 is missing at the date.
    expect(w.gapAtDateMinor).toBe(rs(1_000_000));
    expect(w.currentMonth).toBeNull();
  });

  it("the gap shrinks with what goes in before the date", () => {
    const g = goal({ id: "x", targetMinor: rs(100_000), monthlyMinor: rs(10_000), wantedBy: "2027-04" });
    const w = waysToReach([g], "x", { startMonth: "2027-01", stepMinor: rs(500) });
    expect(w.gapAtDateMinor).toBe(rs(60_000));
    expect(w.monthlyMinor).toBe(rs(25_000));
    expect(w.currentMonth).toBe("2027-10");
  });
});

describe("fixes from the audit", () => {
  it("a goal takes only what it still needs; the rest rolls to the next one the same month", () => {
    const a = goal({ id: "a", targetMinor: rs(10_000), monthlyMinor: rs(100_000) });
    const b = goal({ id: "b", targetMinor: rs(190_000), monthlyMinor: 0 });
    const r = simulatePlan([a, b], { startMonth: "2026-11", trajectory: true });
    expect(r.outcomes[0]!.doneMonth).toBe("2026-11");
    expect(r.trajectory!.saved[0]![1]).toBe(rs(10_000));
    expect(r.outcomes[1]!.doneMonth).toBe("2026-12");
  });

  it("'now' is at today's price, even when prices rise", () => {
    const land = goal({ kind: "purchase", targetMinor: rs(1_000_000), savedMinor: rs(995_200), monthlyMinor: rs(10_000) });
    const r = simulatePlan([land], { startMonth: "2026-11", priceRisePerYear: 0.06 });
    // Not there now at Rs 10,00,000; a month on it costs about Rs 10,04,868 and Rs 10,05,200 is saved.
    expect(r.outcomes[0]!.doneMonth).toBe("2026-11");
    expect(r.outcomes[0]!.finalTargetMinor).toBe(Math.round(rs(1_000_000) * Math.pow(1.06, 1 / 12)));
  });

  it("the extra keeps going to the goal waiting its turn after the first one is reached", () => {
    const a = goal({ id: "a", targetMinor: rs(1_000_000), monthlyMinor: rs(10_000) });
    const b = goal({ id: "b", targetMinor: rs(40_000), monthlyMinor: 0 });
    const c = goal({ id: "c", targetMinor: rs(100_000), monthlyMinor: 0 });
    const r = simulatePlan([a, b, c], { startMonth: "2026-11", poolMinor: rs(30_000) });
    expect(r.outcomes[1]!.doneMonth).toBe("2026-12");
    expect(r.outcomes[2]!.doneMonth).toBe("2027-05");
  });
});
