import { and, between, eq, isNull } from "drizzle-orm";
import { addDays } from "../../shared/dates";
import { schema, type Db } from "../db";
import { newId } from "../lib/ids";
import { transferCategoryId } from "./categories";

export type Direction = "out" | "in" | "transfer";

export type DedupeCandidate = {
  id: string;
  accountId: string;
  date: string;
  amountMinor: number;
  direction: Direction;
  source: "manual" | "email" | "csv" | "recurring";
  confirmedAt: string | null;
};

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
      source: schema.transactions.source,
      confirmedAt: schema.transactions.confirmedAt,
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

type LineShape = { accountId: string; date: string; amountMinor: number; direction: Direction };

/** Pure: every candidate with the same account, direction and amount within the window, nearest first. */
export function findMatches<C extends Omit<DedupeCandidate, "source" | "confirmedAt">>(candidates: C[], line: LineShape, exclude: Set<string> = new Set()): C[] {
  const t = Date.parse(`${line.date}T00:00:00Z`);
  return candidates
    .filter((c) => !exclude.has(c.id) && c.accountId === line.accountId && c.direction === line.direction && c.amountMinor === line.amountMinor)
    .map((c) => ({ c, gap: Math.abs(Date.parse(`${c.date}T00:00:00Z`) - t) / 86_400_000 }))
    .filter((x) => x.gap <= DUPLICATE_WINDOW_DAYS)
    .sort((a, b) => a.gap - b.gap)
    .map((x) => x.c);
}

/** Pure: the closest candidate with the same account, direction and amount within the window. */
export function findDuplicate<C extends Omit<DedupeCandidate, "source" | "confirmedAt">>(candidates: C[], line: LineShape, exclude: Set<string> = new Set()): C | null {
  return findMatches(candidates, line, exclude)[0] ?? null;
}

export type LineMatch<C> = { kind: "confirm"; match: C } | { kind: "question"; match: C; others: number } | { kind: "none" };

/**
 * Pure: what a bank line means for the book.
 *  - exactly one candidate, and it is a manual entry the bank has not confirmed yet: the bank is
 *    confirming it, so the line is merged into it (one transaction, now double-checked)
 *  - any other candidates (a bank line already there, several manual entries): ask the family
 *  - none: a new transaction
 */
export function classifyLine<C extends DedupeCandidate>(candidates: C[], line: LineShape, exclude: Set<string> = new Set()): LineMatch<C> {
  const matches = findMatches(candidates, line, exclude);
  if (!matches.length) return { kind: "none" };
  const [first] = matches as [C, ...C[]];
  if (matches.length === 1 && first.source === "manual" && !first.confirmedAt) return { kind: "confirm", match: first };
  return { kind: "question", match: first, others: matches.length - 1 };
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
  goalId?: string | null;
  /** Bank lines are confirmed when posted; leave unset for manual entries. */
  confirmedAt?: string | null;
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
    goalId: t.goalId ?? null,
    confirmedAt: t.confirmedAt ?? (t.source === "email" || t.source === "csv" ? new Date().toISOString() : null),
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
  input: { householdId: string; fromAccountId: string; toAccountId: string; amountMinor: number; date: string; note?: string | null; memberId: string; goalId?: string | null; description?: string },
): Promise<{ pairId: string; outId: string; inId: string }> {
  const pairId = newId();
  const categoryId = await transferCategoryId(db, input.householdId);
  const base = { householdId: input.householdId, amountMinor: input.amountMinor, date: input.date, categoryId, source: "manual" as const, transferPairId: pairId, note: input.note ?? null, paidByMemberId: input.memberId, goalId: input.goalId ?? null };
  const out = transactionValues({ ...base, direction: "out", accountId: input.fromAccountId, description: input.description ?? "Transfer out" });
  const inn = transactionValues({ ...base, direction: "in", accountId: input.toAccountId, description: input.description ?? "Transfer in" });
  await db.batch([db.insert(schema.transactions).values(out), db.insert(schema.transactions).values(inn)]);
  return { pairId, outId: out.id!, inId: inn.id! };
}
