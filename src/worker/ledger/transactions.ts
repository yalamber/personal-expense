import { and, between, eq, isNull } from "drizzle-orm";
import { addDays } from "../../shared/dates";
import { schema, type Db } from "../db";
import { newId } from "../lib/ids";
import { transferCategoryId } from "./categories";

export type Direction = "out" | "in" | "transfer";

export type DedupeCandidate = { id: string; accountId: string; date: string; amountMinor: number; direction: Direction };

/** Days either side of a date within which the same amount on the same account counts as a likely duplicate. */
export const DUPLICATE_WINDOW_DAYS = 2;

export function dedupeHash(accountId: string, direction: string, amountMinor: number, date: string): string {
  return `${accountId}|${direction}|${amountMinor}|${date}`;
}

/** Live (not voided) transactions on an account that could duplicate lines dated between from and to. */
export async function loadDedupeCandidates(db: Db, accountId: string, from: string, to: string): Promise<DedupeCandidate[]> {
  return db
    .select({
      id: schema.transactions.id,
      accountId: schema.transactions.accountId,
      date: schema.transactions.date,
      amountMinor: schema.transactions.amountMinor,
      direction: schema.transactions.direction,
    })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.accountId, accountId),
        between(schema.transactions.date, addDays(from, -DUPLICATE_WINDOW_DAYS), addDays(to, DUPLICATE_WINDOW_DAYS)),
        isNull(schema.transactions.voidedAt),
      ),
    );
}

/** Pure: the closest candidate with the same account, direction and amount within the window. */
export function findDuplicate(
  candidates: DedupeCandidate[],
  line: { accountId: string; date: string; amountMinor: number; direction: Direction },
  exclude: Set<string> = new Set(),
): DedupeCandidate | null {
  let best: { c: DedupeCandidate; gap: number } | null = null;
  const t = Date.parse(`${line.date}T00:00:00Z`);
  for (const c of candidates) {
    if (exclude.has(c.id) || c.accountId !== line.accountId || c.direction !== line.direction || c.amountMinor !== line.amountMinor) continue;
    const gap = Math.abs(Date.parse(`${c.date}T00:00:00Z`) - t) / 86_400_000;
    if (gap <= DUPLICATE_WINDOW_DAYS && (!best || gap < best.gap)) best = { c, gap };
  }
  return best?.c ?? null;
}

export type NewTransaction = {
  householdId: string;
  accountId: string;
  date: string;
  amountMinor: number;
  direction: Direction;
  merchantId?: string | null;
  categoryId?: string | null;
  paidByMemberId?: string | null;
  description?: string | null;
  isPersonal?: boolean;
  source: "manual" | "email" | "csv" | "recurring";
  importLineId?: string | null;
  transferPairId?: string | null;
  note?: string | null;
};

export function transactionValues(t: NewTransaction): typeof schema.transactions.$inferInsert {
  return {
    id: newId(),
    householdId: t.householdId,
    accountId: t.accountId,
    date: t.date,
    amountMinor: Math.abs(Math.round(t.amountMinor)),
    direction: t.direction,
    merchantId: t.merchantId ?? null,
    categoryId: t.categoryId ?? null,
    paidByMemberId: t.paidByMemberId ?? null,
    description: t.description ?? null,
    isPersonal: t.isPersonal ?? false,
    source: t.source,
    importLineId: t.importLineId ?? null,
    dedupeHash: dedupeHash(t.accountId, t.direction, Math.abs(Math.round(t.amountMinor)), t.date),
    transferPairId: t.transferPairId ?? null,
    note: t.note ?? null,
  };
}

/**
 * Money moved between two of the household's own accounts: money out of the source account and
 * money into the destination, sharing a pair id and the transfer category so neither counts as
 * spending or income. Recording real directions lets a bank statement's matching line be
 * recognised as a duplicate of the manual entry.
 */
export async function createTransfer(
  db: Db,
  input: { householdId: string; fromAccountId: string; toAccountId: string; amountMinor: number; date: string; note?: string | null; memberId: string },
): Promise<{ pairId: string }> {
  const pairId = newId();
  const categoryId = await transferCategoryId(db, input.householdId);
  const base = { householdId: input.householdId, amountMinor: input.amountMinor, date: input.date, categoryId, source: "manual" as const, transferPairId: pairId, note: input.note ?? null, paidByMemberId: input.memberId };
  await db.batch([
    db.insert(schema.transactions).values(transactionValues({ ...base, direction: "out", accountId: input.fromAccountId, description: "Transfer out" })),
    db.insert(schema.transactions).values(transactionValues({ ...base, direction: "in", accountId: input.toAccountId, description: "Transfer in" })),
  ]);
  return { pairId };
}
