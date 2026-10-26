import { describe, expect, it } from "vitest";
import { accruedInterest, addMonths, maturityValue, parseRate, rateLabel, termMonths, totalInterest, type Deposit } from "../src/shared/deposit";

const rs = (n: number) => n * 100;
const kept: Deposit = { principalMinor: rs(900_000), rateBp: 850, start: "2026-01-01", maturity: "2027-01-01", payout: "maturity" };
const paidOut: Deposit = { ...kept, payout: "quarterly" };

describe("fixed deposits", () => {
  it("compounds kept-in interest quarterly up to maturity", () => {
    // 900,000 at 8.5% for a year, quarterly: 900,000 × 1.02125^4 ≈ 978,970
    expect(Math.abs(maturityValue(kept) - rs(978_970))).toBeLessThan(rs(5));
    expect(totalInterest(kept)).toBe(maturityValue(kept) - kept.principalMinor);
  });

  it("pays back only the principal when interest is paid out", () => {
    expect(maturityValue(paidOut)).toBe(rs(900_000));
    expect(totalInterest(paidOut)).toBe(rs(76_500));
  });

  it("accrues kept-in interest from the start, and stops at maturity", () => {
    expect(accruedInterest(kept, "2026-01-01")).toBe(0);
    expect(accruedInterest(kept, "2026-07-02")).toBeGreaterThan(rs(38_000));
    expect(accruedInterest(kept, "2030-01-01")).toBe(totalInterest(kept));
  });

  it("accrues paid-out interest only since the last payout", () => {
    // Last quarterly payout 1 Apr; 1 Apr to 1 May is 30 days: 900,000 × 8.5% × 30/365 ≈ 6,288
    expect(Math.abs(accruedInterest(paidOut, "2026-05-01") - rs(6_288))).toBeLessThan(rs(2));
    expect(accruedInterest({ ...paidOut, payout: "monthly" }, "2026-05-01")).toBe(0);
  });

  it("works with months and rates the way people say them", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-10-23", 12)).toBe("2027-10-23");
    expect(termMonths("2026-01-01", "2027-01-01")).toBe(12);
    expect(termMonths("2026-01-15", "2026-07-14")).toBe(5);
    expect(parseRate("8.5%")).toBe(850);
    expect(parseRate("abc")).toBeNull();
    expect(rateLabel(850)).toBe("8.5%");
    expect(rateLabel(1000)).toBe("10%");
    expect(rateLabel(1025)).toBe("10.25%");
  });
});

describe("fixes from the audit", () => {
  it("a deposit starting at a month's end keeps its whole term", () => {
    expect(termMonths("2025-11-30", addMonths("2025-11-30", 3))).toBe(3);
    expect(termMonths("2026-08-31", addMonths("2026-08-31", 6))).toBe(6);
    expect(termMonths("2028-02-29", addMonths("2028-02-29", 12))).toBe(12);
    expect(termMonths("2026-01-15", "2026-04-14")).toBe(2);
  });
  it("a deposit paying out quarterly still shows the last quarter's interest on and after maturity", () => {
    const d = { principalMinor: 50_000_000, rateBp: 850, start: "2026-01-15", maturity: "2027-01-15", payout: "quarterly" as const };
    const atMaturity = accruedInterest(d, "2027-01-15");
    expect(atMaturity).toBe(Math.round((50_000_000 * 850) / 10_000 * (92 / 365)));
    expect(accruedInterest(d, "2027-02-01")).toBe(atMaturity);
  });
});
