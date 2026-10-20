import { describe, expect, it } from "vitest";
import { summarize } from "../src/worker/http/routes/ledger";
import { dedupeHash, findDuplicate, type DedupeCandidate } from "../src/worker/ledger/transactions";
import { DEFAULT_CATEGORIES } from "../src/worker/ledger/categories";

type Cat = Parameters<typeof summarize>[1][number];
const cat = (id: string, name: string, kind: Cat["kind"], parentId: string | null = null): Cat => ({ id, householdId: "h", parentId, name, kind, sort: 0 });

const categories: Cat[] = [
  cat("food", "Food", "need"),
  cat("groceries", "Groceries", "need", "food"),
  cat("eating", "Eating out", "want", "food"),
  cat("fun", "Entertainment", "want"),
  cat("income", "Income", "income"),
  cat("salary", "Salary", "income", "income"),
  cat("savings", "Savings", "saving"),
  cat("transfers", "Transfers", "transfer"),
];

describe("summarize", () => {
  it("rolls spending up to top-level categories", () => {
    const s = summarize(
      [
        { amountMinor: 5000, direction: "out", categoryId: "groceries" },
        { amountMinor: 2000, direction: "out", categoryId: "eating" },
        { amountMinor: 1500, direction: "out", categoryId: "fun" },
      ],
      categories,
    );
    expect(s.spent).toBe(8500);
    expect(s.perTop.get("food")).toBe(7000);
    expect(s.perTop.get("fun")).toBe(1500);
  });

  it("ignores transfers, treats refunds as negative spend and savings separately", () => {
    const s = summarize(
      [
        { amountMinor: 10000, direction: "transfer", categoryId: "transfers" },
        { amountMinor: 3000, direction: "out", categoryId: "transfers" },
        { amountMinor: 4000, direction: "out", categoryId: "groceries", transferPairId: "p1" },
        { amountMinor: 4000, direction: "in", categoryId: null, transferPairId: "p1" },
        { amountMinor: 5000, direction: "out", categoryId: "groceries" },
        { amountMinor: 1000, direction: "in", categoryId: "groceries" },
        { amountMinor: 20000, direction: "out", categoryId: "savings" },
        { amountMinor: 300000, direction: "in", categoryId: "salary" },
      ],
      categories,
    );
    expect(s.spent).toBe(4000);
    expect(s.saved).toBe(20000);
    expect(s.income).toBe(300000);
    expect(s.perTop.get("food")).toBe(4000);
  });

  it("counts uncategorised money in as income and out as uncategorised spend", () => {
    const s = summarize(
      [
        { amountMinor: 700, direction: "out", categoryId: null },
        { amountMinor: 900, direction: "in", categoryId: null },
      ],
      categories,
    );
    expect(s.spent).toBe(700);
    expect(s.income).toBe(900);
    expect(s.uncategorized).toBe(2);
    expect(s.perTop.get(null)).toBe(700);
  });
});

describe("findDuplicate", () => {
  const candidates: DedupeCandidate[] = [
    { id: "a", accountId: "acc", date: "2026-10-10", amountMinor: 4250, direction: "out" },
    { id: "b", accountId: "acc", date: "2026-10-12", amountMinor: 4250, direction: "out" },
    { id: "c", accountId: "other", date: "2026-10-11", amountMinor: 4250, direction: "out" },
  ];

  it("matches the same account, amount and direction within two days, closest first", () => {
    expect(findDuplicate(candidates, { accountId: "acc", date: "2026-10-11", amountMinor: 4250, direction: "out" })?.id).toBe("a");
    expect(findDuplicate(candidates, { accountId: "acc", date: "2026-10-13", amountMinor: 4250, direction: "out" })?.id).toBe("b");
  });

  it("does not match a different amount, direction, account or a gap over two days", () => {
    expect(findDuplicate(candidates, { accountId: "acc", date: "2026-10-11", amountMinor: 4251, direction: "out" })).toBeNull();
    expect(findDuplicate(candidates, { accountId: "acc", date: "2026-10-11", amountMinor: 4250, direction: "in" })).toBeNull();
    expect(findDuplicate(candidates, { accountId: "acc", date: "2026-10-20", amountMinor: 4250, direction: "out" })).toBeNull();
  });

  it("lets one existing transaction explain only one incoming line", () => {
    const claimed = new Set(["a"]);
    expect(findDuplicate(candidates, { accountId: "acc", date: "2026-10-10", amountMinor: 4250, direction: "out" }, claimed)?.id).toBe("b");
  });

  it("hashes consistently", () => {
    expect(dedupeHash("acc", "out", 4250, "2026-10-10")).toBe("acc|out|4250|2026-10-10");
  });
});

describe("default categories", () => {
  it("covers income, savings and transfers and has unique top-level names", () => {
    const names = DEFAULT_CATEGORIES.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const kind of ["income", "saving", "transfer"]) expect(DEFAULT_CATEGORIES.some((c) => c.kind === kind)).toBe(true);
  });
});
