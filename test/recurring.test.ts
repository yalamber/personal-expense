import { describe, expect, it } from "vitest";
import { dayLabel, dueDate, expectedInMinor, isOpen, reserveMinor, statusOf, type RecurringItem } from "../src/shared/recurring";

const rs = (n: number) => n * 100;
const item = (over: Partial<RecurringItem> = {}): RecurringItem => ({ id: "rent", name: "Rent", direction: "out", amountMinor: rs(25_000), dayOfMonth: 1, active: true, ...over });

describe("dueDate", () => {
  it("lands on the item's day of the month", () => {
    expect(dueDate({ dayOfMonth: 1 }, "2026-11")).toBe("2026-11-01");
    expect(dueDate({ dayOfMonth: 22 }, "2026-02")).toBe("2026-02-22");
  });
  it("never asks for a day a month may not have", () => {
    expect(dueDate({ dayOfMonth: 31 }, "2026-02")).toBe("2026-02-28");
    expect(dueDate({ dayOfMonth: 0 }, "2026-02")).toBe("2026-02-01");
  });
});

describe("statusOf", () => {
  it("is upcoming before its day and due from its day on", () => {
    expect(statusOf(item({ dayOfMonth: 20 }), "2026-10", "2026-10-15", null)).toMatchObject({ state: "upcoming", due: "2026-10-20", daysUntil: 5 });
    expect(statusOf(item({ dayOfMonth: 20 }), "2026-10", "2026-10-20", null)).toMatchObject({ state: "due", daysUntil: 0 });
    expect(statusOf(item({ dayOfMonth: 20 }), "2026-10", "2026-10-24", null)).toMatchObject({ state: "due", daysUntil: -4 });
  });
  it("is posted, skipped or done once the family handled it, whatever the date", () => {
    expect(statusOf(item(), "2026-10", "2026-10-24", { state: "posted", transactionId: "t1", date: "2026-10-02" })).toMatchObject({ state: "posted", transactionId: "t1" });
    expect(statusOf(item(), "2026-10", "2026-10-24", { state: "skipped" })).toMatchObject({ state: "skipped", transactionId: null });
    expect(statusOf(item({ dayOfMonth: 28 }), "2026-10", "2026-10-01", { state: "done" })).toMatchObject({ state: "done" });
  });
  it("a paused item is neither due nor upcoming", () => {
    const s = statusOf(item({ active: false }), "2026-10", "2026-10-24", null);
    expect(s.state).toBe("paused");
    expect(isOpen(s)).toBe(false);
  });
});

describe("reserve and expected income", () => {
  const rows = [
    { item: item(), status: { state: "upcoming" as const } },
    { item: item({ id: "fees", name: "School fees", amountMinor: rs(12_000), dayOfMonth: 10 }), status: { state: "due" as const } },
    { item: item({ id: "net", name: "Internet", amountMinor: rs(1_500) }), status: { state: "posted" as const } },
    { item: item({ id: "gym", name: "Gym", amountMinor: rs(3_000) }), status: { state: "skipped" as const } },
    { item: item({ id: "salary", name: "Salary", direction: "in", amountMinor: rs(90_000), dayOfMonth: 7 }), status: { state: "upcoming" as const } },
    { item: item({ id: "tenant", name: "Tenant", direction: "in", amountMinor: rs(15_000) }), status: { state: "posted" as const } },
    { item: item({ id: "old", name: "Old bill", amountMinor: rs(999), active: false }), status: { state: "paused" as const } },
  ];
  it("sets aside only the bills still to go out", () => {
    expect(reserveMinor(rows)).toBe(rs(37_000));
  });
  it("counts only the income still to arrive", () => {
    expect(expectedInMinor(rows)).toBe(rs(90_000));
  });
});

describe("dayLabel", () => {
  it("says the day the way people do", () => {
    expect(dayLabel(1)).toBe("on the 1st");
    expect(dayLabel(2)).toBe("on the 2nd");
    expect(dayLabel(3)).toBe("on the 3rd");
    expect(dayLabel(11)).toBe("on the 11th");
    expect(dayLabel(12)).toBe("on the 12th");
    expect(dayLabel(13)).toBe("on the 13th");
    expect(dayLabel(21)).toBe("on the 21st");
    expect(dayLabel(22)).toBe("on the 22nd");
    expect(dayLabel(28)).toBe("on the 28th");
  });
});
