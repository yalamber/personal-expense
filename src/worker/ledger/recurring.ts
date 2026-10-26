/**
 * Every month, as the Worker sees it: the household's items with where each stands this month,
 * from the entries in the book that carry an item's id and the months the family skipped.
 */
import { and, between, eq, isNotNull, isNull } from "drizzle-orm";
import { monthRange } from "../../shared/dates";
import { statusOf, type Handled, type RecurringItem, type RecurringStatus } from "../../shared/recurring";
import { schema, type Db } from "../db";

export type RecurringRow = RecurringItem & {
  categoryId: string | null;
  accountId: string | null;
  note: string | null;
  status: RecurringStatus;
};

export async function loadRecurring(db: Db, householdId: string, month: string, today: string): Promise<RecurringRow[]> {
  const { from, to } = monthRange(month);
  const [items, posted, marks] = await Promise.all([
    db.query.recurring.findMany({ where: and(eq(schema.recurring.householdId, householdId), isNull(schema.recurring.archivedAt)) }),
    db
      .select({ recurringId: schema.transactions.recurringId, id: schema.transactions.id, date: schema.transactions.date })
      .from(schema.transactions)
      .where(and(eq(schema.transactions.householdId, householdId), between(schema.transactions.date, from, to), isNull(schema.transactions.voidedAt), isNotNull(schema.transactions.recurringId))),
    db.query.recurringMonths.findMany({ where: eq(schema.recurringMonths.month, month) }),
  ]);
  const handled = new Map<string, Handled>();
  for (const m of marks) handled.set(m.recurringId, { state: m.state });
  // An entry in the book wins over a skip: the family logged it after all.
  for (const p of posted) if (p.recurringId) handled.set(p.recurringId, { state: "posted", transactionId: p.id, date: p.date });
  return items
    .map((r) => ({
      id: r.id,
      name: r.name,
      direction: r.direction,
      amountMinor: r.amountMinor,
      dayOfMonth: r.dayOfMonth,
      active: r.active,
      categoryId: r.categoryId,
      accountId: r.accountId,
      note: r.note,
      status: statusOf(r, month, today, handled.get(r.id) ?? null),
    }))
    .sort((a, b) => a.dayOfMonth - b.dayOfMonth || a.name.localeCompare(b.name));
}

/**
 * The every-month items as they fall in a pay period (which can span two calendar months): each
 * item once, the instance whose day lands in the period.
 */
export async function loadRecurringPeriod(db: Db, householdId: string, from: string, to: string, today: string): Promise<RecurringRow[]> {
  const months = [...new Set([from.slice(0, 7), to.slice(0, 7)])];
  const byMonth = await Promise.all(months.map((m) => loadRecurring(db, householdId, m, today)));
  if (byMonth.length === 1) return byMonth[0]!;
  const out: RecurringRow[] = [];
  for (const r of byMonth[0]!) {
    const pick = [r, byMonth[1]!.find((x) => x.id === r.id)].find((x) => x && x.status.due >= from && x.status.due <= to);
    if (pick) out.push(pick);
  }
  return out.sort((a, b) => a.status.due.localeCompare(b.status.due) || a.name.localeCompare(b.name));
}
