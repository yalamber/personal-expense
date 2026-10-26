import { describe, expect, it } from "vitest";
import { aiFor, askJson, type AiRunner } from "../src/worker/ai";
import { suggestCategories, suits } from "../src/worker/ai/categorize";
import { readWithAi } from "../src/worker/ai/read";
import type { AppEnv } from "../src/worker/env";

/** Stands in for Workers AI: answers with what the test says, and keeps what it was asked. */
const fake = (answer: unknown | ((input: { messages: { content: string }[] }) => unknown)) => {
  const asked: { messages: { content: string }[] }[] = [];
  const ai: AiRunner = {
    async run(_model, input) {
      const i = input as { messages: { content: string }[] };
      asked.push(i);
      return { response: typeof answer === "function" ? (answer as (x: typeof i) => unknown)(i) : answer };
    },
  };
  return { ai, asked };
};

const email = (text: string) => ({ text, subject: "Transaction Alert", from: "txn-alert@nabilbank.com", sentAt: new Date("2026-10-26T03:45:00Z") });
const ALERT = "Dear Customer, A/C 0101XXXXXXX89 Txn: NPR 1,500.00 DR on 26/10/2026 Remarks: ESEWA LOAD 9841. Available Balance: NPR 1,23,456.78. If you have received this email in error, delete it.";

describe("reading an email with AI", () => {
  it("keeps a transaction whose amount is written in the email", async () => {
    const { ai, asked } = fake({ transactions: [{ amount: "1,500.00", direction: "out", date: "2026-10-26", description: "ESEWA LOAD 9841", quote: "NPR 1,500.00 DR on 26/10/2026" }] });
    const lines = await readWithAi(ai, email(ALERT));
    expect(lines).toEqual([{ rawText: "NPR 1,500.00 DR on 26/10/2026", date: "2026-10-26", amountMinor: 150_000, kind: "out", description: "ESEWA LOAD 9841", confidence: 65 }]);
    expect(asked[0]!.messages[1]!.content).toContain("Subject: Transaction Alert");
  });

  it("drops an amount the email does not contain, and one written only as a balance", async () => {
    const { ai } = fake({
      transactions: [
        { amount: "2,000.00", direction: "out", date: "2026-10-26", description: "made up", quote: "" },
        { amount: "123456.78", direction: "in", date: "2026-10-26", description: "balance", quote: "" },
      ],
    });
    expect(await readWithAi(ai, email(ALERT))).toEqual([]);
  });

  it("uses the email's date for a Bikram Sambat or impossible date, with a lower confidence", async () => {
    const { ai } = fake({ transactions: [{ amount: "1500", direction: "out", date: "2083-07-09", description: "", quote: "not in the email" }] });
    const [line] = (await readWithAi(ai, email(ALERT)))!;
    expect(line).toMatchObject({ date: "2026-10-26", amountMinor: 150_000, confidence: 60, description: "Transaction Alert", rawText: "Transaction Alert · 1500" });
  });

  it("ignores a direction that is neither out nor in, repeats, and a broken answer", async () => {
    const { ai } = fake({ transactions: [{ amount: "1,500.00", direction: "sideways", date: "", description: "x", quote: "" }, { amount: "1500", direction: "in", date: "", description: "a", quote: "" }, { amount: "1,500.00", direction: "in", date: "", description: "b", quote: "" }] });
    expect(await readWithAi(ai, email(ALERT))).toHaveLength(1);
    expect(await readWithAi(fake("not json at all").ai, email(ALERT))).toBeNull();
    expect(await readWithAi(fake({ transactions: [] }).ai, email(ALERT))).toEqual([]);
    expect(await readWithAi(fake('{"transactions":[{"amount":"1,500.00","direction":"out","date":"2026-10-26","description":"S","quote":""}]}').ai, email(ALERT))).toHaveLength(1);
  });

  it("says it could not ask when the model fails, rather than that it found nothing", async () => {
    const ai: AiRunner = { run: async () => { throw new Error("3040: capacity"); } };
    expect(await readWithAi(ai, email(ALERT))).toBeNull();
    expect(await askJson(ai, "s", "u", {})).toBeNull();
  });
});

describe("categories from AI", () => {
  const cats = [
    { id: "food", name: "Groceries", kind: "need", parentName: "Food" },
    { id: "salary", name: "Salary", kind: "income", parentName: "Income" },
    { id: "wallet", name: "Between own accounts", kind: "transfer", parentName: "Transfers" },
  ];
  const lines = [
    { id: "a", description: "BHATBHATENI SUPERMARKET", direction: "out" as const, amountMinor: 324_050 },
    { id: "b", description: "SALARY OCT", direction: "in" as const, amountMinor: 9_000_000 },
    { id: "c", description: "ESEWA LOAD", direction: "out" as const, amountMinor: 50_000 },
    { id: "d", description: "", direction: "out" as const, amountMinor: 100 },
  ];

  it("maps the short keys back to the household's categories and asks with names, not ids", async () => {
    const { ai, asked } = fake({ picks: [{ line: "l1", category: "c1" }, { line: "l2", category: "c2" }, { line: "l3", category: "c3" }] });
    const picks = await suggestCategories(ai, lines, cats, "NPR");
    expect([...picks]).toEqual([["a", "food"], ["b", "salary"], ["c", "wallet"]]);
    const prompt = asked[0]!.messages[1]!.content;
    expect(prompt).toContain("c1: Food > Groceries (need)");
    expect(prompt).toContain("l2: money in");
    expect(prompt).not.toContain("salary\n");
    expect(prompt.split("\n").filter((l) => /^l\d+:/.test(l))).toHaveLength(3);
  });

  it("refuses an income category for money out, an unknown key and an unknown line", async () => {
    const { ai } = fake({ picks: [{ line: "l1", category: "c2" }, { line: "l2", category: "c9" }, { line: "l7", category: "c1" }, { line: "l3", category: "" }] });
    expect((await suggestCategories(ai, lines, cats, "NPR")).size).toBe(0);
    expect(suits("income", "out")).toBe(false);
    expect(suits("transfer", "in")).toBe(false);
    expect(suits("income", "in")).toBe(true);
  });

  it("asks in batches of forty", async () => {
    const many = Array.from({ length: 85 }, (_, i) => ({ id: `x${i}`, description: `SHOP ${i}`, direction: "out" as const, amountMinor: 1000 }));
    const { ai, asked } = fake({ picks: [{ line: "l1", category: "c1" }] });
    const picks = await suggestCategories(ai, many, cats, "NPR");
    expect(asked).toHaveLength(3);
    expect([...picks.keys()]).toEqual(["x0", "x40", "x80"]);
  });
});

describe("whether AI is used", () => {
  const env = (ai?: unknown) => ({ AI: ai }) as unknown as AppEnv;
  it("is off without the binding, and when the family turned it off", () => {
    const { ai } = fake({});
    expect(aiFor(env(undefined), null)).toBeNull();
    expect(aiFor(env(ai), { aiEnabled: false })).toBeNull();
    expect(aiFor(env(ai), { aiEnabled: true })).toBe(ai);
    expect(aiFor(env(ai), null)).toBe(ai);
  });
});
