/**
 * Read-side helpers shared by Today, Decide and the plan: what every account holds or owes,
 * goals with what is saved, loan installments, and the household's typical month.
 */
import { and, asc, between, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import { monthRange, shiftMonth } from "../../shared/dates";
import { accruedInterest, addMonths, daysBetween, maturityValue, termMonths, totalInterest, type Deposit } from "../../shared/deposit";
import { interestLeft, monthsLeft, splitPayment } from "../../shared/loan";
import type { PlanGoal } from "../../shared/plan";
import { schema, type Db } from "../db";
import { summarize } from "./summary";

// ---------------------------------------------------------------------------
// Accounts and balances
// ---------------------------------------------------------------------------

type AccountRow = typeof schema.accounts.$inferSelect;

/** Accounts whose balance is money owed rather than money held. */
export const OWED_TYPES = ["credit", "loan"] as const;

/** Accounts whose entries are not the month's income or spending: interest left in a deposit is not money to spend. */
export const KEPT_TYPES = ["deposit", "loan", "lent"] as const;

/** A condition for transactions on everyday accounts only (not deposits, loans or money lent). */
export function onEverydayAccounts() {
  return sql`${schema.transactions.accountId} not in (select ${schema.accounts.id} from ${schema.accounts} where ${schema.accounts.type} in ('deposit', 'loan', 'lent'))`;
}

/**
 * Every account's balance at the end of a date: the opening figure (0 if none) plus what came
 * in and went out after the opening date. Owed accounts come out negative.
 */
export async function accountBalances(db: Db, householdId: string, asOf: string): Promise<Map<string, number>> {
  const t = schema.transactions;
  const a = schema.accounts;
  const rows = await db
    .select({
      id: a.id,
      opening: a.openingBalanceMinor,
      net: sql<number>`coalesce(sum(case when ${t.id} is not null and ${t.voidedAt} is null and ${t.date} <= ${asOf} and (${a.openingBalanceDate} is null or ${t.date} > ${a.openingBalanceDate}) then (case when ${t.direction} = 'in' then ${t.amountMinor} else -${t.amountMinor} end) else 0 end), 0)`,
    })
    .from(a)
    .leftJoin(t, eq(t.accountId, a.id))
    .where(eq(a.householdId, householdId))
    .groupBy(a.id);
  return new Map(rows.map((r) => [r.id, (r.opening ?? 0) + Number(r.net)]));
}

export type DepositView = { accruedMinor: number; maturityValueMinor: number; totalInterestMinor: number; daysToMaturity: number; termMonths: number };
export type LoanView = {
  owedMinor: number;
  /** The next installment still to pay: this month's (even if past) until it is paid, then next month's. */
  nextDue: string | null;
  /** This month's installment is paid, or the starting balance was taken after it. */
  settledThisMonth: boolean;
  monthsLeft: number | null;
  payoffMonth: string | null;
  interestLeftMinor: number | null;
  nextInterestMinor: number;
  paidThisMonthMinor: number;
};

export type AccountView = AccountRow & { balanceMinor: number; deposit: DepositView | null; loan: LoanView | null; goalName: string | null };

function depositOf(a: AccountRow): Deposit | null {
  if (a.type !== "deposit" || !a.principalMinor || a.rateBp === null || !a.startDate || !a.endDate) return null;
  return { principalMinor: a.principalMinor, rateBp: a.rateBp, start: a.startDate, maturity: a.endDate, payout: a.depositPayout ?? "maturity" };
}

/** Accounts with balances, deposit interest estimates and loan schedules, open ones first. */
export async function loadAccountViews(db: Db, householdId: string, today: string): Promise<AccountView[]> {
  const month = today.slice(0, 7);
  const { from } = monthRange(month);
  const [rows, balances, goals, paid] = await Promise.all([
    db.query.accounts.findMany({ where: eq(schema.accounts.householdId, householdId), orderBy: [asc(schema.accounts.createdAt)] }),
    accountBalances(db, householdId, today),
    db.query.goals.findMany({ where: eq(schema.goals.householdId, householdId), columns: { id: true, name: true } }),
    // Principal paid into loan accounts this month (installments arrive as money in).
    db
      .select({ accountId: schema.transactions.accountId, total: sql<number>`coalesce(sum(${schema.transactions.amountMinor}), 0)` })
      .from(schema.transactions)
      .innerJoin(schema.accounts, eq(schema.accounts.id, schema.transactions.accountId))
      .where(and(eq(schema.accounts.householdId, householdId), eq(schema.accounts.type, "loan"), eq(schema.transactions.direction, "in"), between(schema.transactions.date, from, today), isNull(schema.transactions.voidedAt)))
      .groupBy(schema.transactions.accountId),
  ]);
  const goalName = new Map(goals.map((g) => [g.id, g.name]));
  const paidBy = new Map(paid.map((p) => [p.accountId, Number(p.total)]));
  return rows
    .map((a): AccountView => {
      const balance = balances.get(a.id) ?? 0;
      const d = depositOf(a);
      let loan: LoanView | null = null;
      if (a.type === "loan") {
        const owed = Math.max(0, -balance);
        const rate = a.rateBp ?? 0;
        const inst = a.installmentMinor ?? 0;
        const left = inst ? monthsLeft(owed, rate, inst) : null;
        const thisDue = `${month}-${String(Math.min(Math.max(1, a.installmentDay ?? 1), 28)).padStart(2, "0")}`;
        const settled = (paidBy.get(a.id) ?? 0) > 0 || (a.openingBalanceDate !== null && a.openingBalanceDate >= thisDue);
        const due = inst ? (settled ? addMonths(thisDue, 1) : thisDue) : null;
        loan = {
          owedMinor: owed,
          nextDue: due ?? a.endDate,
          settledThisMonth: settled,
          monthsLeft: left,
          payoffMonth: left !== null && due ? addMonths(due, Math.max(0, left - 1)).slice(0, 7) : a.endDate ? a.endDate.slice(0, 7) : null,
          interestLeftMinor: inst ? interestLeft(owed, rate, inst) : rate === 0 ? 0 : null,
          nextInterestMinor: splitPayment(owed, rate, inst || owed).interestMinor,
          paidThisMonthMinor: paidBy.get(a.id) ?? 0,
        };
      }
      return {
        ...a,
        balanceMinor: balance,
        goalName: a.goalId ? goalName.get(a.goalId) ?? null : null,
        deposit: d
          ? { accruedMinor: accruedInterest(d, today), maturityValueMinor: maturityValue(d), totalInterestMinor: totalInterest(d), daysToMaturity: daysBetween(today, d.maturity), termMonths: termMonths(d.start, d.maturity) }
          : null,
        loan,
      };
    })
    .sort((x, y) => Number(Boolean(x.closedAt)) - Number(Boolean(y.closedAt)));
}

export type LoanCommitments = {
  /** Installments of open loans each month. */
  monthlyMinor: number;
  /** The part of those that is interest this month (already counted as spending once paid). */
  monthlyInterestMinor: number;
  /** Still to set aside this month: the installment for loans not paid yet. */
  dueThisMonthMinor: number;
  /** Principal already paid this month (a transfer, so not in spending). */
  paidThisMonthMinor: number;
  /** When each loan's installment frees up for the plan. */
  releases: { accountId: string; name: string; fromMonth: string; amountMinor: number }[];
};

export function loanCommitments(accounts: AccountView[]): LoanCommitments {
  const out: LoanCommitments = { monthlyMinor: 0, monthlyInterestMinor: 0, dueThisMonthMinor: 0, paidThisMonthMinor: 0, releases: [] };
  for (const a of accounts) {
    if (a.closedAt || a.type !== "loan" || !a.loan || a.loan.owedMinor <= 0) continue;
    const inst = a.installmentMinor ?? 0;
    if (!inst) continue;
    out.monthlyMinor += inst;
    out.monthlyInterestMinor += a.loan.nextInterestMinor;
    out.paidThisMonthMinor += a.loan.paidThisMonthMinor;
    if (!a.loan.settledThisMonth) out.dueThisMonthMinor += inst;
    if (a.loan.payoffMonth) out.releases.push({ accountId: a.id, name: a.name, fromMonth: shiftMonth(a.loan.payoffMonth, 1), amountMinor: inst });
  }
  return out;
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

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

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
  /**
   * What is saved: the balances of the accounts that hold this goal's money when it has any (an
   * FD, a savings account), otherwise the money recorded toward it.
   */
  savedMinor: number;
  savedFrom: "accounts" | "records";
  accounts: { id: string; name: string; type: string; balanceMinor: number }[];
  parts: GoalPart[];
};

/** Active goals in priority order, with what has gone in so far and their parts. */
export async function loadGoals(db: Db, householdId: string, today: string, opts: { includeArchived?: boolean } = {}): Promise<GoalView[]> {
  const goals = await db.query.goals.findMany({
    where: opts.includeArchived ? eq(schema.goals.householdId, householdId) : and(eq(schema.goals.householdId, householdId), isNull(schema.goals.archivedAt)),
    orderBy: [asc(schema.goals.priority), asc(schema.goals.createdAt)],
  });
  if (!goals.length) return [];
  const ids = goals.map((g) => g.id);
  const [saved, parts, holders, balances] = await Promise.all([
    db
      .select({ goalId: schema.goalContributions.goalId, total: sql<number>`coalesce(sum(${schema.goalContributions.amountMinor}), 0)` })
      .from(schema.goalContributions)
      .where(inArray(schema.goalContributions.goalId, ids))
      .groupBy(schema.goalContributions.goalId),
    db.query.goalParts.findMany({ where: inArray(schema.goalParts.goalId, ids), orderBy: [asc(schema.goalParts.sort), asc(schema.goalParts.name)] }),
    db.query.accounts.findMany({ where: and(eq(schema.accounts.householdId, householdId), inArray(schema.accounts.goalId, ids), isNull(schema.accounts.closedAt)) }),
    accountBalances(db, householdId, today),
  ]);
  const savedBy = new Map(saved.map((s) => [s.goalId, Number(s.total)]));
  return goals.map((g) => {
    const accounts = holders.filter((a) => a.goalId === g.id).map((a) => ({ id: a.id, name: a.name, type: a.type, balanceMinor: balances.get(a.id) ?? 0 }));
    const fromAccounts = accounts.length > 0;
    return {
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
      savedMinor: fromAccounts ? accounts.reduce((s, a) => s + Math.max(0, a.balanceMinor), 0) : savedBy.get(g.id) ?? 0,
      savedFrom: fromAccounts ? "accounts" : "records",
      accounts,
      parts: parts.filter((p) => p.goalId === g.id).map((p) => ({ id: p.id, name: p.name, amountMinor: p.amountMinor, sort: p.sort, doneAt: p.doneAt })),
    };
  });
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

// ---------------------------------------------------------------------------
// The typical month
// ---------------------------------------------------------------------------

/**
 * source "book": averages of the last three full months that have transactions (at least two);
 * "typical": the figures the family typed in at the start; "none": nothing to go on yet.
 * Spending never includes loan principal or goal moves (they are transfers).
 */
export type MonthlyBasis = { source: "book" | "typical" | "none"; months: number; incomeMinor: number; spendMinor: number };

export async function monthlyBasis(db: Db, householdId: string, currentMonth: string): Promise<MonthlyBasis> {
  const first = monthRange(shiftMonth(currentMonth, -3)).from;
  const last = monthRange(shiftMonth(currentMonth, -1)).to;
  const [categories, txs, household] = await Promise.all([
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
      .where(and(eq(schema.transactions.householdId, householdId), between(schema.transactions.date, first, last), isNull(schema.transactions.voidedAt), onEverydayAccounts())),
    db.query.households.findFirst({ where: eq(schema.households.id, householdId), columns: { typicalIncomeMinor: true, typicalSpendMinor: true } }),
  ]);
  const byMonth = new Map<string, typeof txs>();
  for (const t of txs) byMonth.set(t.date.slice(0, 7), [...(byMonth.get(t.date.slice(0, 7)) ?? []), t]);
  const typed = household?.typicalIncomeMinor ? { income: household.typicalIncomeMinor, spend: household.typicalSpendMinor ?? 0 } : null;
  if (byMonth.size < 2 && typed) return { source: "typical", months: byMonth.size, incomeMinor: typed.income, spendMinor: typed.spend };
  if (!byMonth.size) return { source: "none", months: 0, incomeMinor: 0, spendMinor: 0 };
  let income = 0;
  let spend = 0;
  for (const rows of byMonth.values()) {
    const s = summarize(rows, categories);
    income += s.income;
    spend += s.spent;
  }
  return { source: "book", months: byMonth.size, incomeMinor: Math.round(income / byMonth.size), spendMinor: Math.round(spend / byMonth.size) };
}

/**
 * Spare money a month after spending, goals and loan installments. With the book as the source,
 * installment interest is already in spending, so only the principal part is taken off again.
 */
export function spareAfter(basis: MonthlyBasis, plannedMinor: number, loans: LoanCommitments): number | null {
  if (basis.source === "none") return null;
  const loanPart = basis.source === "book" ? loans.monthlyMinor - loans.monthlyInterestMinor : loans.monthlyMinor;
  return basis.incomeMinor - basis.spendMinor - plannedMinor - loanPart;
}
