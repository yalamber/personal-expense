/**
 * Read-side helpers shared by Today, Decide and the plan: what every account holds or owes,
 * goals with what is saved, loan installments, and the household's typical month.
 */
import { and, asc, between, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import { addDays, monthRange, shiftMonth } from "../../shared/dates";
import { accruedInterest, addMonths, daysBetween, maturityValue, termMonths, totalInterest, type Deposit } from "../../shared/deposit";
import { interestLeft, monthsLeft, splitPayment } from "../../shared/loan";
import type { PlanEvent, PlanGoal } from "../../shared/plan";
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
  /** Principal paid into the loan this calendar month (a transfer, so not in spending). */
  paidThisMonthMinor: number;
  /** What is still to pay on this month's installment (less any part already paid toward it). */
  dueThisMonthMinor: number;
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
    // Loan payments over the last seven weeks: principal arrives in the loan account as money in;
    // the interest part is an expense named "Interest: <loan>" on the account it was paid from.
    db
      .select({ accountId: schema.transactions.accountId, date: schema.transactions.date, amountMinor: schema.transactions.amountMinor, direction: schema.transactions.direction, description: schema.transactions.description, type: schema.accounts.type })
      .from(schema.transactions)
      .innerJoin(schema.accounts, eq(schema.accounts.id, schema.transactions.accountId))
      .where(
        and(
          eq(schema.accounts.householdId, householdId),
          between(schema.transactions.date, addDays(from, -50), today),
          isNull(schema.transactions.voidedAt),
          sql`((${schema.accounts.type} = 'loan' and ${schema.transactions.direction} = 'in') or (${schema.transactions.direction} = 'out' and ${schema.transactions.description} like 'Interest: %'))`,
        ),
      ),
  ]);
  const goalName = new Map(goals.map((g) => [g.id, g.name]));
  const principalIn = (id: string, after: string) => paid.filter((p) => p.type === "loan" && p.accountId === id && p.date > after).reduce((sum, p) => sum + p.amountMinor, 0);
  const interestOut = (name: string, after: string) => paid.filter((p) => p.type !== "loan" && p.description === `Interest: ${name}` && p.date > after).reduce((sum, p) => sum + p.amountMinor, 0);
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
        // A payment counts toward this month's installment unless it was the last one paid late:
        // anything from two weeks after the previous due date on. Principal and interest both count.
        const windowFrom = addDays(addMonths(thisDue, -1), 14);
        const toward = principalIn(a.id, windowFrom) + interestOut(a.name, windowFrom);
        const unit = 100;
        const settled = (inst > 0 && toward >= inst - unit) || (!inst && toward > 0) || (a.openingBalanceDate !== null && a.openingBalanceDate >= thisDue);
        const due = inst ? (settled ? addMonths(thisDue, 1) : thisDue) : null;
        loan = {
          owedMinor: owed,
          nextDue: due ?? a.endDate,
          settledThisMonth: settled,
          monthsLeft: left,
          payoffMonth: left !== null && due ? addMonths(due, Math.max(0, left - 1)).slice(0, 7) : a.endDate ? a.endDate.slice(0, 7) : null,
          interestLeftMinor: inst ? interestLeft(owed, rate, inst) : rate === 0 ? 0 : null,
          nextInterestMinor: splitPayment(owed, rate, inst || owed).interestMinor,
          paidThisMonthMinor: principalIn(a.id, addDays(from, -1)),
          dueThisMonthMinor: inst && !settled && owed > 0 ? Math.max(0, inst - toward) : 0,
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
    if (a.type !== "loan" || !a.loan) continue;
    // Principal repaid this month leaves the month's money whether or not the loan is now cleared
    // or has a fixed installment (a friendly loan paid back in a lump).
    out.paidThisMonthMinor += a.loan.paidThisMonthMinor;
    if (a.closedAt || a.loan.owedMinor <= 0) continue;
    const inst = a.installmentMinor ?? 0;
    if (!inst) continue;
    out.monthlyMinor += inst;
    out.monthlyInterestMinor += a.loan.nextInterestMinor;
    out.dueThisMonthMinor += a.loan.dueThisMonthMinor;
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
   * How far along it is: money held for it plus money already paid toward it. Held is the balance
   * of the accounts that keep its money when it has any (an FD, a savings account), otherwise the
   * money recorded as saved.
   */
  savedMinor: number;
  heldMinor: number;
  /** Already paid toward it: a baina or advance to the seller, a stage paid to the builder. */
  paidMinor: number;
  savedFrom: "accounts" | "records";
  accounts: { id: string; name: string; type: string; balanceMinor: number }[];
  /** Part of the price to borrow when it is bought. */
  loan: { amountMinor: number; rateBp: number; months: number } | null;
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
      .select({ goalId: schema.goalContributions.goalId, kind: schema.goalContributions.kind, total: sql<number>`coalesce(sum(${schema.goalContributions.amountMinor}), 0)` })
      .from(schema.goalContributions)
      .where(inArray(schema.goalContributions.goalId, ids))
      .groupBy(schema.goalContributions.goalId, schema.goalContributions.kind),
    db.query.goalParts.findMany({ where: inArray(schema.goalParts.goalId, ids), orderBy: [asc(schema.goalParts.sort), asc(schema.goalParts.name)] }),
    db.query.accounts.findMany({ where: and(eq(schema.accounts.householdId, householdId), inArray(schema.accounts.goalId, ids), isNull(schema.accounts.closedAt)) }),
    accountBalances(db, householdId, today),
  ]);
  const total = (goalId: string, kind: (typeof schema.contributionKinds)[number]) => Number(saved.find((s) => s.goalId === goalId && s.kind === kind)?.total ?? 0);
  return goals.map((g) => {
    const accounts = holders.filter((a) => a.goalId === g.id).map((a) => ({ id: a.id, name: a.name, type: a.type, balanceMinor: balances.get(a.id) ?? 0 }));
    const fromAccounts = accounts.length > 0;
    const paid = total(g.id, "paid") + total(g.id, "paid_from_saved");
    const held = fromAccounts ? accounts.reduce((s, a) => s + Math.max(0, a.balanceMinor), 0) : Math.max(0, total(g.id, "saved") - total(g.id, "paid_from_saved"));
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
      savedMinor: held + paid,
      heldMinor: held,
      paidMinor: paid,
      savedFrom: fromAccounts ? "accounts" : "records",
      accounts,
      loan: g.loanMinor && g.loanMonths ? { amountMinor: g.loanMinor, rateBp: g.loanRateBp ?? 0, months: g.loanMonths } : null,
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
      loan: g.loan,
    }));
}

/** Money moments for the plan: one-off or yearly money in (+) or out (−). */
export async function loadPlanEvents(db: Db, householdId: string): Promise<(PlanEvent & { id: string; note: string | null })[]> {
  const rows = await db.query.planEvents.findMany({ where: eq(schema.planEvents.householdId, householdId), orderBy: [asc(schema.planEvents.month), asc(schema.planEvents.createdAt)] });
  return rows.map((e) => ({ id: e.id, name: e.name, month: e.month, amountMinor: e.amountMinor, yearly: e.yearly, untilMonth: e.untilMonth, goalId: e.goalId, note: e.note }));
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
  const [categories, txs, household, starts] = await Promise.all([
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
    // When the book began: the earliest starting balance on an everyday account.
    db
      .select({ first: sql<string | null>`min(${schema.accounts.openingBalanceDate})` })
      .from(schema.accounts)
      .where(and(eq(schema.accounts.householdId, householdId), inArray(schema.accounts.type, ["checking", "savings", "cash", "wallet", "credit"]))),
  ]);
  // Only whole months count: a month the book began partway through would read as a thin month.
  const opened = starts[0]?.first ?? null;
  const firstTx = txs.reduce<string | null>((m, t) => (m === null || t.date < m ? t.date : m), null);
  const bookStart = opened ? addDays(opened, 1) : firstTx;
  const byMonth = new Map<string, typeof txs>();
  for (const t of txs) {
    const m = t.date.slice(0, 7);
    if (bookStart && `${m}-01` < bookStart) continue;
    byMonth.set(m, [...(byMonth.get(m) ?? []), t]);
  }
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
