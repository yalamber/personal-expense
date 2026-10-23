import { describe, expect, it } from "vitest";
import { worth } from "../src/shared/worth";

describe("worth", () => {
  it("puts cards and loans on the owed side and contacts on whichever side they fall", () => {
    const w = worth([
      { type: "checking", balanceMinor: 100_000 },
      { type: "deposit", balanceMinor: 500_000 },
      { type: "credit", balanceMinor: -20_000 },
      { type: "loan", balanceMinor: -300_000 },
      { type: "person", balanceMinor: -5_000 },
      { type: "person", balanceMinor: 2_000 },
      { type: "savings", balanceMinor: 900_000, closedAt: "2026-01-01" },
    ]);
    expect(w).toEqual({ haveMinor: 602_000, oweMinor: 325_000, netMinor: 277_000 });
  });
});
