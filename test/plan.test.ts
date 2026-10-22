import { describe, expect, it } from "vitest";
import { lateLabel, monthName, simulatePlan, spanLabel, type PlanGoal } from "../src/shared/plan";

const rs = (n: number) => n * 100;

// The family from the design: emergency fund, then land, then the house, then college.
const goals: PlanGoal[] = [
  { id: "e", name: "Emergency fund", kind: "safety", targetMinor: rs(600_000), savedMinor: rs(465_000), monthlyMinor: rs(20_000), wantedBy: "2027-06", parts: [] },
  { id: "l", name: "Land purchase", kind: "purchase", targetMinor: rs(2_500_000), savedMinor: rs(1_120_000), monthlyMinor: rs(25_000), wantedBy: "2029-09", parts: [] },
  {
    id: "h",
    name: "House build",
    kind: "build",
    targetMinor: rs(6_000_000),
    savedMinor: rs(380_000),
    monthlyMinor: 0,
    wantedBy: "2031-12",
    parts: [
      { name: "Design and permits", amountMinor: rs(350_000) },
      { name: "Foundation and plinth", amountMinor: rs(1_100_000) },
      { name: "Structure", amountMinor: rs(2_000_000) },
      { name: "Walls, roof, plumbing, wiring", amountMinor: rs(1_350_000) },
      { name: "Finishing and moving in", amountMinor: rs(1_200_000) },
    ],
  },
  { id: "d", name: "College", kind: "education", targetMinor: rs(1_500_000), savedMinor: rs(210_000), monthlyMinor: 0, wantedBy: "2034-04", parts: [] },
];

const byId = (r: ReturnType<typeof simulatePlan>) => new Map(r.outcomes.map((o) => [o.id, o]));

describe("simulatePlan", () => {
  it("funds goals in order and rolls a finished goal's money to the next", () => {
    const r = byId(simulatePlan(goals, { startMonth: "2026-11" }));
    expect(r.get("e")!.doneMonth).toBe("2027-05");
    expect(r.get("l")!.doneMonth).toBe("2029-08");
    expect(r.get("l")!.lateMonths).toBe(-1);
    expect(r.get("h")!.partsReady[0]).toBe("now");
    expect(r.get("h")!.partsReady[1]).toBe("2031-08");
    expect(r.get("h")!.doneMonth).toBe("2040-01");
    expect(r.get("d")!.doneMonth).toBe("2042-06");
  });

  it("sends money above the plan to the goal waiting its turn", () => {
    const result = simulatePlan(goals, { startMonth: "2026-11", poolMinor: rs(64_500) });
    expect(result.extraMinor).toBe(rs(19_500));
    expect(result.extraGoalId).toBe("h");
    const r = byId(result);
    expect(r.get("l")!.doneMonth).toBe("2029-08");
    expect(r.get("h")!.partsReady[1]).toBe("2030-03");
    expect(r.get("h")!.doneMonth).toBe("2036-01");
    expect(r.get("d")!.doneMonth).toBe("2037-09");
  });

  it("makes far-off purchases dearer when prices rise", () => {
    const r = byId(simulatePlan(goals, { startMonth: "2026-11", priceRisePerYear: 0.06 }));
    expect(r.get("e")!.doneMonth).toBe("2027-05");
    expect(r.get("l")!.doneMonth).toBe("2030-11");
    expect(r.get("l")!.finalTargetMinor).toBeGreaterThan(rs(3_150_000));
  });

  it("takes a smaller pool from the lowest priorities first", () => {
    const result = simulatePlan(goals, { startMonth: "2026-11", poolMinor: rs(30_000) });
    const r = byId(result);
    expect(result.extraMinor).toBe(0);
    // Emergency keeps its Rs 20,000, land gets the remaining Rs 10,000.
    expect(r.get("e")!.doneMonth).toBe("2027-05");
    expect(r.get("l")!.doneMonth! > "2029-08").toBe(true);
  });

  it("reports goals already funded as now and leaves unreachable ones open", () => {
    const r = byId(
      simulatePlan(
        [
          { id: "a", name: "Done", kind: "other", targetMinor: 100, savedMinor: 100, monthlyMinor: 0, wantedBy: null, parts: [] },
          { id: "b", name: "Never", kind: "other", targetMinor: 100, savedMinor: 0, monthlyMinor: 0, wantedBy: "2030-01", parts: [] },
        ],
        { startMonth: "2026-11", horizonMonths: 24 },
      ),
    );
    expect(r.get("a")!.doneMonth).toBe("now");
    expect(r.get("b")!.doneMonth).toBeNull();
    expect(r.get("b")!.lateMonths).toBeNull();
  });
});

describe("plan labels", () => {
  it("reads naturally", () => {
    expect(spanLabel(97)).toBe("8 years 1 month");
    expect(spanLabel(3)).toBe("3 months");
    expect(lateLabel(-1)).toBe("1 month early");
    expect(lateLabel(0)).toBe("on time");
    expect(lateLabel(17)).toBe("1 year 5 months late");
    expect(monthName("2029-08")).toBe("Aug 2029");
  });
});
