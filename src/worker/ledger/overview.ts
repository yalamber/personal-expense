/**
 * Read-side helpers shared by Today, Decide and the plan: goals with what is saved, the
 * household's typical month, and account balances as the book sees them.
 */
import { and, asc, between, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import { monthRange, shiftMonth } from "../../shared/dates";
import type { PlanGoal } from "../../shared/plan";
import { schema, type Db } from "../db";
import { summarize } from "./summary";

export type GoalPart = { id: string; name: string; amountMinor: number; sort: number; doneAt: string | null };

export type GoalView = {
  id: string;
  name: string;
  kind: (typeof schema.goalKinds)[number];
  targetMinor: number;
  /** YYYY-MM the family wants it by. */
  wantedBy: string | null;
  priority: number;
  monthlyPlanMinor: number;
  linkedAccountId: string | null;
  note: string | null;
  completedAt: string | null;
  savedMinor: number;
  parts: GoalPart[];
};

/** Active goals in priority order, with what has gone in so far and their parts. */
export async function loadGoals(db: Db, householdId: string, opts: { includeArchived?: boolean } = {}): Promise<GoalView[]> {
  const goals = await db.query.goals.findMany({
    where: opts.includeArchived ? eq(schema.goals.householdId, householdId) : and(eq(schema.goals.householdId, householdId), isNull(schema.goals.archivedAt)),
    orderBy: [asc(schema.goals.priority), asc(schema.goals.createdAt)],
  });
  if (!goals.length) return [];
  const ids = goals.map((g) => g.id);
  const [saved, parts] = await Promise.all([
    db
      .select({ goalId: schema.goalContributions.goalId, total: sql<number>`coalesce(sum(${schema.goalContributions.amountMinor}), 0)` })
      .from(schema.goalContributions)
      .where(inArray(schema.goalContributions.goalId, ids))
      .groupBy(schema.goalContributions.goalId),
    db.query.goalParts.findMany({ where: inArray(schema.goalParts.goalId, ids), orderBy: [asc(schema.goalParts.sort), asc(schema.goalParts.name)] }),
  ]);
  const savedBy = new Map(saved.map((s) => [s.goalId, Number(s.total)]));
  return goals.map((g) => ({
    id: g.id,
    name: g.name,
    kind: g.kind,
    targetMinor: g.targetMinor,
    wantedBy: g.targetDate ? g.targetDate.slice(0, 7) : null,
    priority: g.priority,
    monthlyPlanMinor: g.monthlyPlanMinor ?? 0,
    linkedAccountId: g.linkedAccountId,
    note: g.note,
    completedAt: g.completedAt,
    savedMinor: savedBy.get(g.id) ?? 0,
    parts: parts.filter((p) => p.goalId === g.id).map((p) => ({ id: p.id, name: p.name, amountMinor: p.amountMinor, sort: p.sort, doneAt: p.doneAt })),
  }));
}

/** Goals still being saved for, in the simulator's shape. */
export function toPlanGoals(goals: GoalView[]): PlanGoal[] {
  return goals
    .filter((g) => !g.completedAt)
    .map((g) => ({
      id: g.id,
      name: g.name,
      kind: g.kind,
      targetMinor: g.targetMinor,
      savedMinor: g.savedMinor,
      monthlyMinor: g.monthlyPlanMinor,
      wantedBy: g.wantedBy,
      parts: g.parts.map((p) => ({ name: p.name, amountMinor: p.amountMinor })),
    }));
}

export type MonthlyBasis = { months: number; incomeMinor: number; spendMinor: number };

/**
 * The household's typical month: average income and spending over the last three full months that
 * have any transactions. months is 0 when there is nothing to go on yet.
 */
export async function monthlyBasis(db: Db, householdId: string, currentMonth: string): Promise<MonthlyBasis> {
  const first = monthRange(shiftMonth(currentMonth, -3)).from;
  const last = monthRange(shiftMonth(currentMonth, -1)).to;
  const [categories, txs] = await Promise.all([
    db.query.categories.findMany({ where: eq(schema.categories.householdId, householdId) }),
    db
      .select({
        date: schema.transactions.date,
        amountMinor: schema.transactions.amountMinor,
        direction: schema.transactions.direction,
        categoryId: schema.transactions.categoryId,
        transferPairId: schema.transactions.transferPairId,
      })
      .from(schema.transactions)
      .where(and(eq(schema.transactions.householdId, householdId), between(schema.transactions.date, first, last), isNull(schema.transactions.voidedAt))),
  ]);
  const byMonth = new Map<string, typeof txs>();
  for (const t of txs) byMonth.set(t.date.slice(0, 7), [...(byMonth.get(t.date.slice(0, 7)) ?? []), t]);
  if (!byMonth.size) return { months: 0, incomeMinor: 0, spendMinor: 0 };
  let income = 0;
  let spend = 0;
  for (const rows of byMonth.values()) {
    const s = summarize(rows, categories);
    income += s.income;
    spend += s.spent;
  }
  return { months: byMonth.size, incomeMinor: Math.round(income / byMonth.size), spendMinor: Math.round(spend / byMonth.size) };
}

/** The book's balance for an account at the end of a date: the opening figure plus everything after it. */
export async function bookBalance(db: Db, account: { id: string; openingBalanceMinor: number | null; openingBalanceDate: string | null }, asOf: string): Promise<number | null> {
  if (account.openingBalanceMinor === null || !account.openingBalanceDate || asOf < account.openingBalanceDate) return null;
  const [row] = await db
    .select({
      net: sql<number>`coalesce(sum(case when ${schema.transactions.direction} = 'in' then ${schema.transactions.amountMinor} else -${schema.transactions.amountMinor} end), 0)`,
    })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.accountId, account.id),
        gt(schema.transactions.date, account.openingBalanceDate),
        lte(schema.transactions.date, asOf),
        isNull(schema.transactions.voidedAt),
      ),
    );
  return account.openingBalanceMinor + Number(row?.net ?? 0);
}
