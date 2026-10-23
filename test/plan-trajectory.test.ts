import { describe, expect, it } from "vitest";
import { simulatePlan, type PlanGoal } from "../src/shared/plan";

const goal = (id: string, targetMinor: number, savedMinor: number, monthlyMinor: number): PlanGoal => ({ id, name: id.toUpperCase(), kind: "other", targetMinor, savedMinor, monthlyMinor, wantedBy: null, parts: [] });

describe("plan trajectory", () => {
  it("records each goal month by month, from the month before money starts to the last landing", () => {
    const r = simulatePlan([goal("a", 1000, 200, 100), goal("b", 500, 0, 100)], { startMonth: "2026-11", trajectory: true });
    const t = r.trajectory!;
    expect(t.months[0]).toBe("2026-10");
    expect(t.saved[0]![0]).toBe(200);
    expect(t.saved[1]![0]).toBe(0);
    expect(r.outcomes.find((o) => o.id === "b")!.doneMonth).toBe("2027-03");
    // B's hundred rolls to A once B is funded, so A lands in May rather than June.
    expect(r.outcomes.find((o) => o.id === "a")!.doneMonth).toBe("2027-05");
    expect(t.months.at(-1)).toBe("2027-05");
    expect(t.saved[0]!.at(-1)).toBeGreaterThanOrEqual(1000);
    for (const row of t.saved) for (let i = 1; i < row.length; i++) expect(row[i]).toBeGreaterThanOrEqual(row[i - 1]!);
    expect(t.saved.every((row) => row.length === t.months.length)).toBe(true);
  });

  it("is not computed unless asked for", () => {
    expect(simulatePlan([goal("a", 100, 0, 10)], { startMonth: "2026-11" }).trajectory).toBeUndefined();
  });
});
