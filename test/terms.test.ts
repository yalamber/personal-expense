import { describe, expect, it } from "vitest";
import { interestStart, interestUntil, rateInput, rateText, rateToBp, settleStatus, type TermsInput } from "../src/shared/terms";

const rs = (n: number) => n * 100;
const base: TermsInput = { openingMinor: 0, openingDate: null, entries: [], rateBp: null, from: null };

describe("interest on money between people", () => {
  it("none when there is no rate: the family-and-friends loan", () => {
    expect(interestUntil({ ...base, openingMinor: -rs(100_000), openingDate: "2026-01-01" }, "2026-12-31")).toBe(0);
    expect(interestUntil({ ...base, openingMinor: -rs(100_000), openingDate: "2026-01-01", rateBp: 0 }, "2026-12-31")).toBe(0);
  });

  it("2% a month on Rs 1,00,000 borrowed for a year is Rs 24,000, owed by us", () => {
    const t = { ...base, openingMinor: -rs(100_000), openingDate: "2026-01-01", rateBp: rateToBp(2, "month") };
    expect(interestUntil(t, "2027-01-01")).toBe(-rs(24_000));
  });

  it("12% a year on Rs 50,000 lent for 73 days is Rs 1,200, owed to us", () => {
    const t = { ...base, entries: [{ date: "2026-03-01", deltaMinor: rs(50_000) }], rateBp: 1200 };
    expect(interestUntil(t, "2026-05-13")).toBe(rs(1_200));
  });

  it("counts each balance for the days it stood: a part repaid halfway earns less after", () => {
    // Rs 1,00,000 at 36.5% a year (1,000 basis points a day of a year → Rs 100 a day), half repaid after 10 days.
    const t = { ...base, entries: [{ date: "2026-01-01", deltaMinor: rs(100_000) }, { date: "2026-01-11", deltaMinor: -rs(50_000) }], rateBp: 3650 };
    expect(interestUntil(t, "2026-01-21")).toBe(rs(1_000) + rs(500));
  });

  it("starts from the date given, so a loan older than the book still earns from when it was lent", () => {
    const t = { ...base, openingMinor: -rs(100_000), openingDate: "2026-10-25", rateBp: 1200, from: "2026-04-25" };
    expect(interestStart(t)).toBe("2026-04-25");
    expect(interestUntil(t, "2026-10-25")).toBe(-Math.round((rs(100_000) * 183 * 1200) / 10_000 / 365));
  });

  it("entries before the start only move the balance", () => {
    const t = { ...base, entries: [{ date: "2026-01-01", deltaMinor: rs(10_000) }, { date: "2026-02-01", deltaMinor: rs(10_000) }], rateBp: 3650, from: "2026-03-01" };
    expect(interestUntil(t, "2026-03-11")).toBe(rs(200));
    expect(interestUntil(t, "2026-02-15")).toBe(0);
  });
});

describe("how terms read", () => {
  it("says the rate the way it was given", () => {
    expect(rateText(rateToBp(2, "month"), "month")).toBe("2% a month");
    expect(rateText(rateToBp(1.5, "month"), "month")).toBe("1.5% a month");
    expect(rateText(1200, "year")).toBe("12% a year");
    expect(rateText(1200, null)).toBe("12% a year");
    expect(rateText(0, "month")).toBe("no interest");
    expect(rateInput(rateToBp(1.5, "month"), "month")).toBe("1.5");
    expect(rateInput(850, "year")).toBe("8.5");
  });
  it("knows when a settle-by date is near or past", () => {
    expect(settleStatus(null, "2026-10-26")).toBeNull();
    expect(settleStatus("2026-11-02", "2026-10-26")).toEqual({ days: 7, late: false, soon: true });
    expect(settleStatus("2026-12-25", "2026-10-26")).toEqual({ days: 60, late: false, soon: false });
    expect(settleStatus("2026-10-20", "2026-10-26")).toEqual({ days: -6, late: true, soon: false });
  });
});
