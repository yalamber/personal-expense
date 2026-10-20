import { eq } from "drizzle-orm";
import { schema, type Db } from "../db";
import { newId } from "../lib/ids";

type Kind = "need" | "want" | "saving" | "transfer" | "income";
type Seed = { name: string; kind: Kind; children: (string | { name: string; kind: Kind })[] };

/** A two-level starting set the family trims to what they actually spend on. */
export const DEFAULT_CATEGORIES: Seed[] = [
  { name: "Housing", kind: "need", children: ["Rent or mortgage", "Utilities", "Internet and phone", "Home maintenance", "Home insurance"] },
  { name: "Food", kind: "need", children: ["Groceries", { name: "Eating out", kind: "want" }, { name: "Coffee and snacks", kind: "want" }] },
  { name: "Transport", kind: "need", children: ["Fuel", "Public transport", "Car maintenance", "Parking and tolls", "Car insurance"] },
  { name: "Health", kind: "need", children: ["Medical", "Pharmacy", "Health insurance", { name: "Fitness", kind: "want" }] },
  { name: "Kids and education", kind: "need", children: ["School fees", "Childcare", "Activities", "Books and supplies"] },
  { name: "Shopping", kind: "want", children: ["Clothing", "Electronics", "Household items"] },
  { name: "Entertainment", kind: "want", children: ["Subscriptions", "Outings", "Hobbies"] },
  { name: "Travel", kind: "want", children: ["Flights", "Accommodation", "Holiday spending"] },
  { name: "Personal care", kind: "want", children: [] },
  { name: "Gifts and donations", kind: "want", children: [] },
  { name: "Fees and charges", kind: "need", children: ["Bank fees", "Interest", "Taxes"] },
  { name: "Income", kind: "income", children: ["Salary", "Freelance", "Rental income", "Dividends and interest", "Refunds", "Other income"] },
  { name: "Savings", kind: "saving", children: ["Emergency fund", "Investments", "Goal contributions"] },
  { name: "Transfers", kind: "transfer", children: ["Between own accounts", "Credit card payment"] },
];

/** Seeds the default categories once; does nothing if the household already has any. */
export async function ensureCategories(db: Db, householdId: string): Promise<void> {
  const existing = await db.query.categories.findFirst({ where: eq(schema.categories.householdId, householdId), columns: { id: true } });
  if (existing) return;
  const rows: (typeof schema.categories.$inferInsert)[] = [];
  DEFAULT_CATEGORIES.forEach((parent, i) => {
    const parentId = newId();
    rows.push({ id: parentId, householdId, name: parent.name, kind: parent.kind, sort: i * 100 });
    parent.children.forEach((child, j) => {
      const c = typeof child === "string" ? { name: child, kind: parent.kind } : child;
      rows.push({ id: newId(), householdId, parentId, name: c.name, kind: c.kind, sort: i * 100 + j + 1 });
    });
  });
  const statements = rows.map((r) => db.insert(schema.categories).values(r));
  await db.batch(statements as [typeof statements[number], ...typeof statements]);
}

/** The category used for both legs of a transfer between the household's own accounts. */
export async function transferCategoryId(db: Db, householdId: string): Promise<string | null> {
  const rows = await db.query.categories.findMany({ where: eq(schema.categories.householdId, householdId) });
  const own = rows.find((r) => r.kind === "transfer" && r.parentId && /own accounts/i.test(r.name));
  return (own ?? rows.find((r) => r.kind === "transfer"))?.id ?? null;
}
