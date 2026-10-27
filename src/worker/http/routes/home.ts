/**
 * The three questions the app answers first:
 *   Today  — how are we doing this month, and what can we spend per day and stay on plan?
 *   Decide — what needs a quick call from us (possible double entries, balance gaps, lines
 *            without a category, a goal that could be funded, a forwarding check)?
 *   Log    — hints that make logging two taps: repeats and remembered merchants.
 */
import { Hono } from "hono";
import { and, between, desc, eq, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { addDays, monthRange, payPeriod, shiftMonth, todayIn } from "../../../shared/dates";
import { minorDigits } from "../../../shared/money";
import { monthMath } from "../../../shared/month";
import { expectedInMinor, isOpen, reserveMinor } from "../../../shared/recurring";
import { loadRecurring, loadRecurringPeriod, type RecurringRow } from "../../ledger/recurring";
import { loadTerms } from "../../ledger/terms";
import { settleStatus } from "../../../shared/terms";
import { normalizeMerchant } from "../../../shared/merchant";
import { simulatePlan, type PlanGoal } from "../../../shared/plan";
import { schema, type Db } from "../../db";
import { newId } from "../../lib/ids";
import { loadMerchantIndex } from "../../ledger/merchants";
import { worth } from "../../../shared/worth";
import { bookBalance, goalInflows, loadAccountViews, loadGoals, loadPlanEvents, loanCommitments, monthlyBasis, onEverydayAccounts, spareAfter, toPlanGoals, type AccountView } from "../../ledger/overview";
import { summarize } from "../../ledger/summary";
import type { AppContext, HonoEnv } from "../context";
import { readJson, requireWriter } from "../context";
import { rereadStale } from "../../ingest/reread";

export const homeRoutes = new Hono<HonoEnv>();

/** The next payday after today, given the day of the month salary arrives. */
export function nextPayday(today: string, payDay: number): string {
  const day = Math.min(Math.max(1, payDay), 28);
  const month = today.slice(0, 7);
  const thisMonth = `${month}-${String(day).padStart(2, "0")}`;
  return thisMonth > today ? thisMonth : `${shiftMonth(month, 1)}-${String(day).padStart(2, "0")}`;
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Rounds up to a tidy amount (500 in the currency's major unit). */
function tidyUp(minor: number, currency: string): number {
  const step = 500 * 10 ** minorDigits(currency);
  return Math.ceil(minor / step) * step;
}

function tidyDown(minor: number, currency: string): number {
  const step = 500 * 10 ** minorDigits(currency);
  return Math.floor(minor / step) * step;
}

// ---------------------------------------------------------------------------
// Decide
// ---------------------------------------------------------------------------

export type DecideCard =
  | { kind: "forwarding"; key: string; statementId: string; code: string | null; link: string | null; requester: string | null; receivedAt: string }
  | { kind: "inbox"; key: string; statementId: string; from: string; subject: string | null; receivedAt: string; note: string | null }
  | {
      kind: "settle";
      key: string;
      accountId: string;
      name: string;
      type: "person" | "lent";
      /** Positive they owe us, negative we owe. */
      balanceMinor: number;
      /** Interest to today, same sign. */
      interestMinor: number;
      rateBp: number;
      ratePer: "year" | "month" | null;
      settleBy: string;
      days: number;
    }
  | {
      kind: "twin";
      key: string;
      lineId: string;
      line: { date: string | null; amountMinor: number | null; description: string | null; accountName: string | null; source: string | null };
      match: { id: string; date: string; amountMinor: number; direction: string; name: string | null; byName: string | null; source: string; confirmed: boolean; note: string | null };
    }
  | { kind: "balance"; key: string; accountId: string; accountName: string; bankMinor: number; bookMinor: number; asOf: string; suspects: { id: string; date: string; amountMinor: number; direction: string; name: string | null; byName: string | null }[] }
  | { kind: "recurring"; key: string; recurringId: string; name: string; direction: "out" | "in"; amountMinor: number; due: string; month: string; accountId: string | null; categoryId: string | null; note: string | null }
  | { kind: "category"; key: string; lineIds: string[]; description: string; count: number; totalMinor: number; firstDate: string | null; lastDate: string | null; accountName: string | null; suggestedCategoryId: string | null; suggestedBy: "memory" | "ai" | null }
  | { kind: "plan"; key: string; goalId: string; goalName: string; suggestMinor: number; fromMonth: string | null; toMonth: string | null; wantedBy: string | null; onTime: boolean; spareMinor: number }
  | {
      kind: "maturity";
      key: string;
      accountId: string;
      name: string;
      institution: string | null;
      maturity: string;
      balanceMinor: number;
      interestMinor: number;
      payout: string;
      termMonths: number;
      settleAccountId: string | null;
      goalName: string | null;
    }
  | { kind: "installment"; key: string; accountId: string; name: string; institution: string | null; due: string; installmentMinor: number; interestMinor: number; settleAccountId: string | null; owedMinor: number };

/** Deposits maturing within two weeks (or already matured) and installments due within five days. */
function deadlineCards(accounts: AccountView[], today: string): DecideCard[] {
  const cards: DecideCard[] = [];
  for (const a of accounts) {
    if (a.closedAt) continue;
    if (a.type === "deposit" && a.deposit && a.endDate && a.deposit.daysToMaturity <= 14) {
      cards.push({
        kind: "maturity",
        key: `mat:${a.id}:${a.endDate}`,
        accountId: a.id,
        name: a.name,
        institution: a.institution,
        maturity: a.endDate,
        balanceMinor: a.balanceMinor,
        interestMinor: a.depositPayout === "maturity" || !a.depositPayout ? a.deposit.maturityValueMinor - (a.principalMinor ?? a.balanceMinor) : a.deposit.accruedMinor,
        payout: a.depositPayout ?? "maturity",
        termMonths: a.deposit.termMonths,
        settleAccountId: a.settleAccountId,
        goalName: a.goalName,
      });
    }
    if (a.type === "loan" && a.loan && a.installmentMinor && a.loan.nextDue && a.loan.owedMinor > 0) {
      // Due within five days, or this month's still unpaid after its date.
      if (daysBetween(today, a.loan.nextDue) <= 5) {
        cards.push({
          kind: "installment",
          key: `emi:${a.id}:${a.loan.nextDue}`,
          accountId: a.id,
          name: a.name,
          institution: a.institution,
          due: a.loan.nextDue,
          installmentMinor: Math.min(a.installmentMinor, a.loan.owedMinor + a.loan.nextInterestMinor),
          interestMinor: a.loan.nextInterestMinor,
          settleAccountId: a.settleAccountId,
          owedMinor: a.loan.owedMinor,
        });
      }
    }
  }
  return cards;
}

async function forwardingCards(db: Db, householdId: string): Promise<DecideCard[]> {
  const rows = await db.query.statementEmails.findMany({ where: and(eq(schema.statementEmails.householdId, householdId), eq(schema.statementEmails.status, "forwarding")), orderBy: [desc(schema.statementEmails.receivedAt)], limit: 3 });
  return rows.map((r) => {
    const v = r.verifyCode ? (JSON.parse(r.verifyCode) as { code?: string | null; link?: string | null; requester?: string | null }) : {};
    return { kind: "forwarding", key: `fwd:${r.id}`, statementId: r.id, code: v.code ?? null, link: v.link ?? null, requester: v.requester ?? null, receivedAt: r.receivedAt };
  });
}

/** Mail from a sender no account lists yet: which account is it for, or is it not a statement? */
async function inboxCards(db: Db, householdId: string): Promise<DecideCard[]> {
  const rows = await db.query.statementEmails.findMany({ where: and(eq(schema.statementEmails.householdId, householdId), eq(schema.statementEmails.status, "quarantined")), orderBy: [desc(schema.statementEmails.receivedAt)], limit: 5 });
  return rows.map((r) => ({ kind: "inbox", key: `inbox:${r.id}`, statementId: r.id, from: r.fromAddress, subject: r.subject, receivedAt: r.receivedAt, note: r.error }));
}

async function lineCards(db: Db, householdId: string, memberId: string): Promise<DecideCard[]> {
  const lines = await db
    .select({
      id: schema.importLines.id,
      date: schema.importLines.parsedDate,
      amountMinor: schema.importLines.parsedAmountMinor,
      description: schema.importLines.parsedDescription,
      suggestedCategoryId: schema.importLines.suggestedCategoryId,
      suggestedBy: schema.importLines.suggestedBy,
      matchTransactionId: schema.importLines.matchTransactionId,
      source: schema.statementEmails.subject,
      accountName: schema.accounts.name,
    })
    .from(schema.importLines)
    .innerJoin(schema.statementEmails, eq(schema.statementEmails.id, schema.importLines.statementEmailId))
    .leftJoin(schema.accounts, eq(schema.accounts.id, schema.statementEmails.accountId))
    .where(and(eq(schema.importLines.householdId, householdId), eq(schema.importLines.decision, "pending")))
    .orderBy(schema.importLines.parsedDate)
    .limit(300);

  const matchIds = lines.map((l) => l.matchTransactionId).filter((x): x is string => Boolean(x));
  const matches = matchIds.length
    ? await db
        .select({
          id: schema.transactions.id,
          date: schema.transactions.date,
          amountMinor: schema.transactions.amountMinor,
          direction: schema.transactions.direction,
          merchant: schema.merchants.displayName,
          description: schema.transactions.description,
          byName: schema.members.name,
          source: schema.transactions.source,
          confirmedAt: schema.transactions.confirmedAt,
          note: schema.transactions.note,
          isPersonal: schema.transactions.isPersonal,
          paidByMemberId: schema.transactions.paidByMemberId,
        })
        .from(schema.transactions)
        .leftJoin(schema.merchants, eq(schema.merchants.id, schema.transactions.merchantId))
        .leftJoin(schema.members, eq(schema.members.id, schema.transactions.paidByMemberId))
        .where(inArray(schema.transactions.id, matchIds))
    : [];
  // Someone else's personal entry shows as "Personal", as everywhere else.
  const matchBy = new Map(matches.map((m) => [m.id, m.isPersonal && m.paidByMemberId !== memberId ? { ...m, merchant: "Personal", description: "Personal", note: null } : m]));
  const merchants = await loadMerchantIndex(db, householdId);

  const cards: DecideCard[] = [];
  const groups = new Map<string, Extract<DecideCard, { kind: "category" }>>();
  for (const l of lines) {
    const m = l.matchTransactionId ? matchBy.get(l.matchTransactionId) : undefined;
    if (m) {
      cards.push({
        kind: "twin",
        key: `twin:${l.id}`,
        lineId: l.id,
        line: { date: l.date, amountMinor: l.amountMinor, description: l.description, accountName: l.accountName, source: l.source },
        match: { id: m.id, date: m.date, amountMinor: m.amountMinor, direction: m.direction, name: m.merchant ?? m.description, byName: m.byName, source: m.source, confirmed: Boolean(m.confirmedAt), note: m.note },
      });
      continue;
    }
    const { key, display } = normalizeMerchant(l.description ?? "");
    const group = groups.get(key);
    const remembered = merchants.get(key)?.defaultCategoryId ?? null;
    const suggestion = remembered ?? l.suggestedCategoryId;
    const suggestedBy = remembered ? "memory" : l.suggestedCategoryId ? (l.suggestedBy === "ai" ? "ai" : "memory") : null;
    if (group) {
      if (!group.suggestedCategoryId && suggestion) Object.assign(group, { suggestedCategoryId: suggestion, suggestedBy });
      group.lineIds.push(l.id);
      group.count++;
      group.totalMinor += l.amountMinor ?? 0;
      group.lastDate = l.date;
    } else {
      groups.set(key, { kind: "category", key: `cat:${key}`, lineIds: [l.id], description: display || l.description || "(no description)", count: 1, totalMinor: l.amountMinor ?? 0, firstDate: l.date, lastDate: l.date, accountName: l.accountName, suggestedCategoryId: suggestion, suggestedBy });
    }
  }
  // Biggest groups first: one decision clears the most lines.
  return [...cards, ...[...groups.values()].sort((a, b) => b.count - a.count || Math.abs(b.totalMinor) - Math.abs(a.totalMinor))];
}

async function balanceCards(db: Db, householdId: string, memberId: string): Promise<DecideCard[]> {
  const accounts = await db.query.accounts.findMany({
    where: and(eq(schema.accounts.householdId, householdId), isNotNull(schema.accounts.lastStatementAt), isNotNull(schema.accounts.openingBalanceDate)),
  });
  const cards: DecideCard[] = [];
  for (const a of accounts) {
    if (a.lastStatementBalanceMinor === null || !a.lastStatementAt || a.balanceSnoozedFor === a.lastStatementAt) continue;
    const book = await bookBalance(db, a, a.lastStatementAt);
    if (book === null || book === a.lastStatementBalanceMinor) continue;
    const diff = Math.abs(book - a.lastStatementBalanceMinor);
    const suspects = await db
      .select({
        id: schema.transactions.id,
        date: schema.transactions.date,
        amountMinor: schema.transactions.amountMinor,
        direction: schema.transactions.direction,
        merchant: schema.merchants.displayName,
        description: schema.transactions.description,
        byName: schema.members.name,
        isPersonal: schema.transactions.isPersonal,
        paidByMemberId: schema.transactions.paidByMemberId,
      })
      .from(schema.transactions)
      .leftJoin(schema.merchants, eq(schema.merchants.id, schema.transactions.merchantId))
      .leftJoin(schema.members, eq(schema.members.id, schema.transactions.paidByMemberId))
      .where(
        and(
          eq(schema.transactions.accountId, a.id),
          eq(schema.transactions.source, "manual"),
          isNull(schema.transactions.confirmedAt),
          isNull(schema.transactions.voidedAt),
          between(schema.transactions.date, addDays(a.openingBalanceDate!, 1), a.lastStatementAt),
        ),
      )
      .orderBy(sql`abs(${schema.transactions.amountMinor} - ${diff})`)
      .limit(3);
    cards.push({
      kind: "balance",
      key: `bal:${a.id}:${a.lastStatementAt}`,
      accountId: a.id,
      accountName: a.name,
      bankMinor: a.lastStatementBalanceMinor,
      bookMinor: book,
      asOf: a.lastStatementAt,
      suspects: suspects.map((s) => ({
        id: s.id,
        date: s.date,
        amountMinor: s.amountMinor,
        direction: s.direction,
        name: s.isPersonal && s.paidByMemberId !== memberId ? "Personal" : s.merchant ?? s.description,
        byName: s.byName,
      })),
    });
  }
  return cards;
}

/** At most one suggestion: fund the first goal that is waiting its turn and would be late. */
async function planCards(db: Db, household: { id: string; currency: string; timezone: string }, accounts: AccountView[]): Promise<DecideCard[]> {
  const today = todayIn(household.timezone);
  const month = today.slice(0, 7);
  const [goals, basis] = await Promise.all([loadGoals(db, household.id, today), monthlyBasis(db, household.id, month)]);
  if (basis.source === "none" || !goals.length) return [];
  const plan = toPlanGoals(goals);
  const planned = plan.reduce((s, g) => s + g.monthlyMinor, 0);
  const loans = loanCommitments(accounts);
  const spare = spareAfter(basis, planned, loans) ?? 0;
  if (spare <= Math.max(0, basis.incomeMinor * 0.03)) return [];
  const startMonth = shiftMonth(month, 1);
  const releases = loans.releases;
  const events = await loadPlanEvents(db, household.id);
  const base = simulatePlan(plan, { startMonth, releases, events });
  const waiting = plan.find((g) => g.monthlyMinor === 0 && g.wantedBy && base.outcomes.find((o) => o.id === g.id)?.lateMonths !== null && (base.outcomes.find((o) => o.id === g.id)!.lateMonths ?? 0) > 0);
  if (!waiting) return [];
  const key = `fund:${waiting.id}`;
  const snoozed = await db.query.suggestions.findFirst({ where: and(eq(schema.suggestions.householdId, household.id), eq(schema.suggestions.ruleKey, key), gte(schema.suggestions.snoozedUntil, today)) });
  if (snoozed) return [];

  const outcomeWith = (extra: number) => simulatePlan(plan.map((g): PlanGoal => (g.id === waiting.id ? { ...g, monthlyMinor: extra } : g)), { startMonth, releases, events }).outcomes.find((o) => o.id === waiting.id)!;
  // Smallest tidy monthly amount that gets it there on time, if the spare money allows.
  let lo = 0;
  let hi = spare;
  if ((outcomeWith(hi).lateMonths ?? 1) > 0) {
    const half = tidyDown(spare / 2, household.currency);
    if (half <= 0) return [];
    const o = outcomeWith(half);
    const from = base.outcomes.find((x) => x.id === waiting.id)!;
    return [{ kind: "plan", key, goalId: waiting.id, goalName: waiting.name, suggestMinor: half, fromMonth: from.doneMonth, toMonth: o.doneMonth, wantedBy: waiting.wantedBy, onTime: false, spareMinor: spare }];
  }
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if ((outcomeWith(mid).lateMonths ?? 1) > 0) lo = mid;
    else hi = mid;
  }
  const suggest = Math.min(tidyUp(hi, household.currency), tidyDown(spare, household.currency) || tidyUp(hi, household.currency));
  const from = base.outcomes.find((x) => x.id === waiting.id)!;
  const to = outcomeWith(suggest);
  return [{ kind: "plan", key, goalId: waiting.id, goalName: waiting.name, suggestMinor: suggest, fromMonth: from.doneMonth, toMonth: to.doneMonth, wantedBy: waiting.wantedBy, onTime: (to.lateMonths ?? 1) <= 0, spareMinor: spare }];
}

/** "Did the rent go out?": every-month items past their day and not yet in the book. */
function recurringCards(rows: RecurringRow[], month: string): DecideCard[] {
  return rows
    .filter((r) => r.status.state === "due")
    .map((r) => ({ kind: "recurring" as const, key: `recurring:${r.id}:${month}`, recurringId: r.id, name: r.name, direction: r.direction, amountMinor: r.amountMinor, due: r.status.due, month, accountId: r.accountId, categoryId: r.categoryId, note: r.note }));
}

/** Money between people with a settle-by date a week away or past: pay it, collect it, or move the date. */
async function settleCards(db: Db, accounts: AccountView[], today: string, currency: string): Promise<DecideCard[]> {
  const open = accounts.filter((a) => !a.closedAt && (a.type === "person" || a.type === "lent") && a.endDate && a.balanceMinor !== 0);
  if (!open.length) return [];
  const terms = await loadTerms(db, open, today, currency);
  const cards: DecideCard[] = [];
  for (const a of open) {
    const s = settleStatus(a.endDate, today);
    if (!s || (!s.late && !s.soon)) continue;
    const t = terms.get(a.id);
    cards.push({
      kind: "settle",
      key: `settle:${a.id}:${a.endDate}`,
      accountId: a.id,
      name: a.name,
      type: a.type as "person" | "lent",
      balanceMinor: a.balanceMinor,
      interestMinor: t?.interestMinor ?? 0,
      rateBp: a.rateBp ?? 0,
      ratePer: (a.ratePer as "year" | "month" | null) ?? null,
      settleBy: a.endDate!,
      days: s.days,
    });
  }
  return cards.sort((x, y) => (x.kind === "settle" && y.kind === "settle" ? x.days - y.days : 0));
}

export async function loadDecideCards(c: AppContext, recurring?: RecurringRow[]): Promise<DecideCard[]> {
  const db = c.get("db");
  const household = c.get("household");
  const memberId = c.get("member").id;
  const today = todayIn(household.timezone);
  const month = today.slice(0, 7);
  const accounts = await loadAccountViews(db, household.id, today);
  const [fwd, inbox, lines, balances, plan, every, settle] = await Promise.all([
    forwardingCards(db, household.id),
    inboxCards(db, household.id),
    lineCards(db, household.id, memberId),
    balanceCards(db, household.id, memberId),
    planCards(db, household, accounts),
    recurring ?? loadRecurring(db, household.id, month, today),
    settleCards(db, accounts, today, household.currency),
  ]);
  const twins = lines.filter((x) => x.kind === "twin");
  const categories = lines.filter((x) => x.kind === "category");
  // Forwarding checks and deadlines first, then anything that could count money twice, then the month's bills.
  return [...fwd, ...inbox, ...deadlineCards(accounts, today), ...settle, ...twins, ...balances, ...recurringCards(every, month), ...plan, ...categories];
}

homeRoutes.get("/decide", async (c) => c.json(await loadDecideCards(c)));

/** "Ask me next month" for a plan suggestion. */
homeRoutes.post("/decide/snooze", requireWriter, async (c) => {
  const body = await readJson<{ key?: string; title?: string }>(c);
  const key = (body.key ?? "").slice(0, 120);
  if (!/^fund:[\w-]+$/.test(key)) return c.json({ error: "unknown suggestion" }, 400);
  const household = c.get("household");
  const until = `${shiftMonth(todayIn(household.timezone).slice(0, 7), 1)}-01`;
  const db = c.get("db");
  const existing = await db.query.suggestions.findFirst({ where: and(eq(schema.suggestions.householdId, household.id), eq(schema.suggestions.ruleKey, key)) });
  if (existing) await db.update(schema.suggestions).set({ status: "snoozed", snoozedUntil: until }).where(eq(schema.suggestions.id, existing.id));
  else await db.insert(schema.suggestions).values({ id: newId(), householdId: household.id, ruleKey: key, title: (body.title ?? key).slice(0, 200), status: "snoozed", snoozedUntil: until });
  return c.json({ ok: true, until });
});

// ---------------------------------------------------------------------------
// Today
// ---------------------------------------------------------------------------

homeRoutes.get("/today", async (c) => {
  const db = c.get("db");
  const household = c.get("household");
  // Emails older readers gave up on are read again in the background; their lines reach Decide.
  await rereadStale(db, c.env, c.executionCtx, household.id).catch((err) => console.warn("[reread]", err));
  const today = todayIn(household.timezone);
  const month = today.slice(0, 7);
  // The figures run from the last payday to the next one (the calendar month when payday is the 1st).
  const { from, to } = payPeriod(today, household.monthStartDay);

  // Decide asks about this calendar month's items; Today sets aside the ones in this pay period.
  const recurring = await loadRecurring(db, household.id, month, today);
  const periodItems = from === monthRange(month).from ? recurring : await loadRecurringPeriod(db, household.id, from, to, today);
  const [categories, txs, budgets, goals, moved, cards, mailCounts, lastLines] = await Promise.all([
    db.query.categories.findMany({ where: eq(schema.categories.householdId, household.id) }),
    db
      .select({ amountMinor: schema.transactions.amountMinor, direction: schema.transactions.direction, categoryId: schema.transactions.categoryId, transferPairId: schema.transactions.transferPairId, goalId: schema.transactions.goalId })
      .from(schema.transactions)
      .where(and(eq(schema.transactions.householdId, household.id), between(schema.transactions.date, from, to), isNull(schema.transactions.voidedAt), onEverydayAccounts())),
    db.query.budgets.findMany({ where: and(eq(schema.budgets.householdId, household.id), eq(schema.budgets.month, month)) }),
    loadGoals(db, household.id, today),
    goalInflows(db, household.id, from, to),
    loadDecideCards(c, recurring),
    db
      .select({ status: schema.statementEmails.status, n: sql<number>`count(*)` })
      .from(schema.statementEmails)
      .where(and(eq(schema.statementEmails.householdId, household.id), inArray(schema.statementEmails.status, ["quarantined", "unparsed", "failed", "received"])))
      .groupBy(schema.statementEmails.status),
    db
      .select({ accountId: schema.statementEmails.accountId, last: sql<string>`max(${schema.importLines.parsedDate})` })
      .from(schema.importLines)
      .innerJoin(schema.statementEmails, eq(schema.statementEmails.id, schema.importLines.statementEmailId))
      .where(and(eq(schema.importLines.householdId, household.id), inArray(schema.importLines.decision, ["auto", "accepted", "merged"])))
      .groupBy(schema.statementEmails.accountId),
  ]);

  const s = summarize(txs, categories);
  // Saving outside the goals (shares, a new deposit): goal moves are counted under the goals already.
  const savedOtherMinor = Math.max(0, summarize(txs.filter((t) => !t.goalId), categories).saved);
  const active = goals.filter((g) => !g.completedAt);
  const plannedMinor = active.reduce((sum, g) => sum + g.monthlyPlanMinor, 0);
  const movedMinor = moved.reduce((sum, r) => sum + r.amountMinor, 0);
  const goalsMinor = Math.max(plannedMinor, movedMinor);
  const views = await loadAccountViews(db, household.id, today);
  const loans = loanCommitments(views);
  // Installments: principal already paid this month is a transfer, so it is taken off here; an
  // installment still due is set aside whole (its interest is not spending yet).
  const loansMinor = loans.paidThisMonthMinor + loans.dueThisMonthMinor;
  const payday = nextPayday(today, household.monthStartDay);
  const daysLeft = Math.max(1, daysBetween(today, payday));
  // Every-month bills not yet in the book are set aside; income not yet in stands in for the usual figure.
  const rows = periodItems.map((r) => ({ item: r, status: r.status }));
  const billsMinor = reserveMinor(rows);
  const math = monthMath({
    loggedInMinor: s.income,
    expectedInMinor: expectedInMinor(rows),
    spentMinor: s.spent,
    goalsMinor,
    loansMinor,
    billsMinor,
    savedOtherMinor,
    daysLeft,
    minorDigits: minorDigits(household.currency),
  });
  const { incomeMinor, everydayLeftMinor } = math;

  // Envelopes: this month's budgets against spending in their top-level category.
  const tops = new Map(categories.filter((x) => !x.parentId).map((x) => [x.id, x]));
  const envelopes = budgets
    .filter((b) => tops.has(b.categoryId))
    .map((b) => ({ categoryId: b.categoryId, name: tops.get(b.categoryId)!.name, budgetMinor: b.amountMinor, spentMinor: s.perTop.get(b.categoryId) ?? 0 }))
    .sort((a, b) => b.spentMinor / b.budgetMinor - a.spentMinor / a.budgetMinor);

  const accounts = views.filter((a) => !a.closedAt);
  const lastBy = new Map(lastLines.map((l) => [l.accountId, l.last]));
  const questions = new Map<string, number>();
  for (const card of cards) {
    if (card.kind === "balance") questions.set(card.accountId, (questions.get(card.accountId) ?? 0) + 1);
  }
  const twins = cards.filter((x) => x.kind === "twin").length;
  const bank = accounts.filter((a) => a.type !== "person").map((a) => ({ accountId: a.id, name: a.name, type: a.type, balanceMinor: a.balanceMinor, lastLineDate: lastBy.get(a.id) ?? null, questions: questions.get(a.id) ?? 0 }));
  // What we have: everything held, less everything owed. Deposit interest earned so far is shown apart.
  const { haveMinor, oweMinor } = worth(accounts);
  const accruedMinor = accounts.reduce((sum, a) => sum + (a.deposit?.accruedMinor ?? 0), 0);
  const seen = bank.map((b) => b.lastLineDate).filter((d): d is string => Boolean(d)).sort();

  // The next goal on the road and when it lands at the current plan.
  const startMonth = shiftMonth(month, 1);
  const plan = toPlanGoals(goals);
  const sim = plan.length ? simulatePlan(plan, { startMonth, releases: loans.releases, events: await loadPlanEvents(db, household.id) }) : null;
  const next = active[0] ? { ...active[0], outcome: sim?.outcomes.find((o) => o.id === active[0]!.id) ?? null } : null;

  return c.json({
    today,
    month,
    currency: household.currency,
    payday,
    daysLeft,
    incomeMinor,
    // Income listed under Every month and not yet in the book: shown, never counted.
    expectedLaterMinor: math.expectedLaterMinor,
    mode: math.mode,
    spentMinor: s.spent,
    goalsMinor,
    plannedMinor,
    movedMinor,
    loansMinor,
    billsMinor,
    worth: { haveMinor, oweMinor, netMinor: haveMinor - oweMinor, accruedMinor },
    needsStart: accounts.filter((a) => a.type !== "person").every((a) => a.openingBalanceDate === null),
    everydayLeftMinor,
    perDayMinor: math.perDayMinor,
    // This month's every-month items, for the Coming up card.
    // The pay period the figures cover.
    period: { from, to },
    savedOtherMinor,
    comingUp: periodItems.map((r) => ({ id: r.id, name: r.name, direction: r.direction, amountMinor: r.amountMinor, due: r.status.due, state: r.status.state, daysUntil: r.status.daysUntil, accountId: r.accountId, transactionId: r.status.transactionId })),
    uncategorizedCount: s.uncategorized,
    envelopes,
    bank,
    bookMatchesThrough: twins === 0 && questions.size === 0 && seen.length ? seen[seen.length - 1] : null,
    decideCount: cards.length,
    // Statement emails that arrived but did not become lines: new senders, unreadable ones, failures, still queued.
    mail: { newSender: Number(mailCounts.find((m) => m.status === "quarantined")?.n ?? 0), unread: mailCounts.filter((m) => m.status !== "quarantined").reduce((sum, m) => sum + Number(m.n), 0) },
    nextGoal: next,
  });
});

// ---------------------------------------------------------------------------
// Log hints
// ---------------------------------------------------------------------------

/**
 * Repeats: the entries this household logs again and again (same merchant, amount and account),
 * for one-tap logging. Merchants: recent ones with the category, account and amount used last time.
 */
homeRoutes.get("/log-hints", async (c) => {
  const db = c.get("db");
  const household = c.get("household");
  const today = todayIn(household.timezone);
  const since = addDays(today, -120);
  const every = (await loadRecurring(db, household.id, today.slice(0, 7), today)).filter((r) => isOpen(r.status));
  const rows = await db
    .select({
      merchantId: schema.transactions.merchantId,
      name: schema.merchants.displayName,
      description: schema.transactions.description,
      amountMinor: schema.transactions.amountMinor,
      direction: schema.transactions.direction,
      accountId: schema.transactions.accountId,
      categoryId: schema.transactions.categoryId,
      merchantCategoryId: schema.merchants.defaultCategoryId,
      date: schema.transactions.date,
      source: schema.transactions.source,
      isPersonal: schema.transactions.isPersonal,
      paidByMemberId: schema.transactions.paidByMemberId,
    })
    .from(schema.transactions)
    .leftJoin(schema.merchants, eq(schema.merchants.id, schema.transactions.merchantId))
    .where(and(eq(schema.transactions.householdId, household.id), gte(schema.transactions.date, since), isNull(schema.transactions.voidedAt), isNull(schema.transactions.transferPairId), isNull(schema.transactions.goalId)))
    .orderBy(desc(schema.transactions.date), desc(schema.transactions.createdAt))
    .limit(600);

  const repeats = new Map<string, { name: string; amountMinor: number; direction: "out" | "in"; accountId: string; categoryId: string | null; count: number; last: string }>();
  const merchants = new Map<string, { name: string; amountMinor: number; direction: "out" | "in"; accountId: string; categoryId: string | null; last: string }>();
  const me = c.get("member").id;
  for (const r of rows) {
    if (r.direction === "transfer" || !r.merchantId || (r.isPersonal && r.paidByMemberId !== me)) continue;
    const name = r.name ?? r.description ?? "";
    const categoryId = r.merchantCategoryId ?? r.categoryId;
    if (!merchants.has(r.merchantId)) merchants.set(r.merchantId, { name, amountMinor: r.amountMinor, direction: r.direction, accountId: r.accountId, categoryId, last: r.date });
    if (r.source !== "manual") continue;
    const key = `${r.merchantId}|${r.amountMinor}|${r.accountId}|${r.direction}`;
    const hit = repeats.get(key);
    if (hit) hit.count++;
    else repeats.set(key, { name, amountMinor: r.amountMinor, direction: r.direction, accountId: r.accountId, categoryId, count: 1, last: r.date });
  }
  return c.json({
    // This month's bills and income not yet in the book, due ones first.
    recurring: every.map((r) => ({ id: r.id, name: r.name, direction: r.direction, amountMinor: r.amountMinor, categoryId: r.categoryId, accountId: r.accountId, due: r.status.due, state: r.status.state })),
    repeats: [...repeats.values()].filter((r) => r.count >= 2).sort((a, b) => b.count - a.count || b.last.localeCompare(a.last)).slice(0, 6),
    merchants: [...merchants.values()].slice(0, 80),
  });
});
