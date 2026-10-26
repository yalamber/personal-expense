/**
 * Category suggestions from Workers AI for lines merchant memory knows nothing about. The model
 * picks from the household's own categories (by a short key, never an id it could garble), a
 * pick must suit the direction of the money, and the line keeps it only as a suggestion: the
 * family files it in Decide, and from then on merchant memory files that name by itself.
 */
import { and, eq, isNull, type SQL } from "drizzle-orm";
import { schema, type Db } from "../db";
import { formatMinor } from "../../shared/money";
import { askJson, type AiRunner } from "./index";

const SYSTEM = `You file a family's bank transactions in Nepal under the family's own categories.
For each payment pick the one category key that fits best, judging by the description (merchant, person, purpose).
Local names: eSewa, Khalti and IME Pay are wallets (a "load" moves money into the wallet); NTC, Ncell, Worldlink, Vianet are phone and internet; NEA is electricity; KUKL is water; Bhatbhateni, Big Mart, Salesberry are supermarkets; Daraz is online shopping; Pathao and inDrive are rides.
Money in suits income categories; money out suits need, want, saving or moving-money categories.
Use "" for the category when the description gives no real clue, such as only a reference number.`;

const SCHEMA = {
  type: "object",
  properties: {
    picks: {
      type: "array",
      items: { type: "object", properties: { line: { type: "string" }, category: { type: "string" } }, required: ["line", "category"] },
    },
  },
  required: ["picks"],
};

const KIND_WORD: Record<string, string> = { need: "need", want: "want", saving: "saving", transfer: "moving money between own accounts", income: "income" };

export type CategoryLine = { id: string; description: string; direction: "out" | "in"; amountMinor: number };
export type CategoryChoice = { id: string; name: string; kind: string; parentName: string | null };

/** Money in is income (or a refund of a need or want); money out is anything but income, as Decide offers. */
export const suits = (kind: string, direction: "out" | "in") => (direction === "in" ? ["income", "need", "want"].includes(kind) : kind !== "income");

/** Line id → category id, for the lines the model could place. */
export async function suggestCategories(ai: AiRunner, lines: CategoryLine[], categories: CategoryChoice[], currency: string): Promise<Map<string, string>> {
  const picks = new Map<string, string>();
  const usable = lines.filter((l) => l.description.trim());
  if (!usable.length || !categories.length) return picks;
  const keyed = categories.map((c, i) => ({ ...c, key: `c${i + 1}` }));
  const list = keyed.map((c) => `${c.key}: ${c.parentName ? `${c.parentName} > ` : ""}${c.name} (${KIND_WORD[c.kind] ?? c.kind})`).join("\n");
  for (let i = 0; i < usable.length; i += 40) {
    const chunk = usable.slice(i, i + 40);
    const payments = chunk.map((l, j) => `l${j + 1}: ${l.direction === "in" ? "money in" : "money out"}, ${formatMinor(l.amountMinor, currency, "en")}, ${l.description.slice(0, 120)}`).join("\n");
    const answer = await askJson<{ picks?: { line?: unknown; category?: unknown }[] }>(ai, SYSTEM, `Categories:\n${list}\n\nPayments:\n${payments}`, SCHEMA, 1500);
    for (const p of Array.isArray(answer?.picks) ? answer.picks : []) {
      const n = /^l(\d+)$/i.exec(String(p.line ?? "").trim());
      const line = n ? chunk[Number(n[1]) - 1] : undefined;
      const cat = keyed.find((c) => c.key === String(p.category ?? "").trim().toLowerCase());
      if (line && cat && suits(cat.kind, line.direction) && !picks.has(line.id)) picks.set(line.id, cat.id);
    }
  }
  return picks;
}

/** Suggests categories for waiting lines that have none (one email's, or the household's), and says how many it placed. */
export async function aiCategorizePending(db: Db, ai: AiRunner | null, household: { id: string; currency: string }, statementEmailId?: string): Promise<number> {
  if (!ai) return 0;
  const where: SQL[] = [eq(schema.importLines.householdId, household.id), eq(schema.importLines.decision, "pending"), isNull(schema.importLines.suggestedCategoryId)];
  if (statementEmailId) where.push(eq(schema.importLines.statementEmailId, statementEmailId));
  const rows = await db
    .select({ id: schema.importLines.id, description: schema.importLines.parsedDescription, amount: schema.importLines.parsedAmountMinor })
    .from(schema.importLines)
    .where(and(...where))
    .limit(120);
  if (!rows.length) return 0;
  const cats = await db.query.categories.findMany({ where: eq(schema.categories.householdId, household.id) });
  const names = new Map(cats.map((c) => [c.id, c.name]));
  const picks = await suggestCategories(
    ai,
    rows.map((r) => ({ id: r.id, description: r.description ?? "", direction: (r.amount ?? 0) < 0 ? "out" : "in", amountMinor: Math.abs(r.amount ?? 0) })),
    cats.map((c) => ({ id: c.id, name: c.name, kind: c.kind, parentName: c.parentId ? (names.get(c.parentId) ?? null) : null })),
    household.currency,
  );
  if (!picks.size) return 0;
  const updates = [...picks].map(([lineId, categoryId]) =>
    db
      .update(schema.importLines)
      .set({ suggestedCategoryId: categoryId, suggestedBy: "ai" })
      .where(and(eq(schema.importLines.id, lineId), isNull(schema.importLines.suggestedCategoryId))),
  );
  await db.batch(updates as [(typeof updates)[number], ...typeof updates]);
  return picks.size;
}
