/**
 * Merchant memory: every description is normalised to a merchant key, and the category last
 * chosen for that merchant becomes its default, so the second coffee at the same place is
 * categorised automatically.
 */
import { and, eq } from "drizzle-orm";
import { normalizeMerchant } from "../../shared/merchant";
import { schema, type Db } from "../db";
import { newId } from "../lib/ids";

export type MerchantInfo = { id: string; defaultCategoryId: string | null; displayName: string };
export type MerchantIndex = Map<string, MerchantInfo>;

/** Loads every merchant of a household once, keyed by normalised name. */
export async function loadMerchantIndex(db: Db, householdId: string): Promise<MerchantIndex> {
  const rows = await db.query.merchants.findMany({ where: eq(schema.merchants.householdId, householdId) });
  return new Map(rows.map((m) => [m.normalizedName, { id: m.id, defaultCategoryId: m.defaultCategoryId, displayName: m.displayName }]));
}

/** Finds the merchant for a description, creating it if needed, and keeps the index in sync. */
export async function resolveMerchant(db: Db, householdId: string, description: string, index?: MerchantIndex): Promise<MerchantInfo> {
  const { key, display } = normalizeMerchant(description);
  const cached = index?.get(key);
  if (cached) return cached;

  const found = await db.query.merchants.findFirst({ where: and(eq(schema.merchants.householdId, householdId), eq(schema.merchants.normalizedName, key)) });
  if (found) {
    const info = { id: found.id, defaultCategoryId: found.defaultCategoryId, displayName: found.displayName };
    index?.set(key, info);
    return info;
  }

  const id = newId();
  const inserted = await db
    .insert(schema.merchants)
    .values({ id, householdId, displayName: display, normalizedName: key, aliases: JSON.stringify([description.slice(0, 120)]) })
    .onConflictDoNothing()
    .returning();
  // A concurrent request may have created it between the read and the insert.
  const row = inserted[0] ?? (await db.query.merchants.findFirst({ where: and(eq(schema.merchants.householdId, householdId), eq(schema.merchants.normalizedName, key)) }));
  if (!row) throw new Error(`could not create merchant for "${key}"`);
  const info = { id: row.id, defaultCategoryId: row.defaultCategoryId, displayName: row.displayName };
  index?.set(key, info);
  return info;
}

/** Records the category a person chose so future transactions from this merchant get it. */
export async function rememberCategory(db: Db, merchantId: string, categoryId: string | null): Promise<void> {
  if (!categoryId) return;
  await db.update(schema.merchants).set({ defaultCategoryId: categoryId }).where(eq(schema.merchants.id, merchantId));
}
