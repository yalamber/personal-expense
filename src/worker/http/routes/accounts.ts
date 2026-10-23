/**
 * Accounts: where the money is and what is owed, from day one. Every account can start from the
 * balance the bank shows today, so balances and reports are right without months of history.
 *
 * Amounts owed (a credit card, a loan) are typed as positive "what we owe" and kept negative.
 */
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { addDays, isDate, todayIn } from "../../../shared/dates";
import { addMonths, parseRate, termMonths } from "../../../shared/deposit";
import { emi, splitPayment } from "../../../shared/loan";
import { parseAmountToMinor } from "../../../shared/money";
import { schema } from "../../db";
import { newId, nowIso } from "../../lib/ids";
import { accountBalances, bookBalance, loadAccountViews } from "../../ledger/overview";
import { createTransfer, transactionValues } from "../../ledger/transactions";
import type { AppContext, HonoEnv } from "../context";
import { readJson, requireWriter } from "../context";

export const accountRoutes = new Hono<HonoEnv>();

type AccountType = (typeof schema.accountTypes)[number];
type Payout = (typeof schema.depositPayouts)[number];
const OWED: AccountType[] = ["credit", "loan"];

function amount(c: AppContext, value: unknown): number | null {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  return parseAmountToMinor(String(value), c.get("household").currency);
}

async function ownAccount(c: AppContext, accountId: string) {
  return c.get("db").query.accounts.findFirst({ where: and(eq(schema.accounts.id, accountId), eq(schema.accounts.householdId, c.get("household").id)) });
}

async function ownGoal(c: AppContext, goalId: string) {
  return c.get("db").query.goals.findFirst({ where: and(eq(schema.goals.id, goalId), eq(schema.goals.householdId, c.get("household").id)), columns: { id: true } });
}

async function categoryNamed(c: AppContext, pattern: RegExp, kind?: string): Promise<string | null> {
  const rows = await c.get("db").query.categories.findMany({ where: eq(schema.categories.householdId, c.get("household").id) });
  return rows.find((r) => pattern.test(r.name) && (!kind || r.kind === kind))?.id ?? null;
}

type AccountBody = {
  name?: string;
  type?: string;
  institution?: string;
  isShared?: boolean;
  statementSenderPattern?: string;
  ownerMemberId?: string | null;
  /** What the bank shows today (or what is owed, for a card or loan). */
  balance?: string;
  balanceDate?: string;
  goalId?: string | null;
  principal?: string;
  rate?: string;
  startDate?: string;
  endDate?: string | null;
  termMonths?: number;
  payout?: string;
  settleAccountId?: string | null;
  installment?: string;
  installmentDay?: number;
  closed?: boolean;
};

/**
 * Validates the fields shared by create and edit and turns them into column values. `existing`
 * is the account being edited, so partial edits keep what is already there.
 */
async function accountFields(c: AppContext, body: AccountBody, type: AccountType, existing?: typeof schema.accounts.$inferSelect): Promise<{ error: string } | { values: Partial<typeof schema.accounts.$inferInsert> }> {
  const today = todayIn(c.get("household").timezone);
  const v: Partial<typeof schema.accounts.$inferInsert> = {};
  if (typeof body.name === "string") {
    if (!body.name.trim()) return { error: "give the account a name" };
    v.name = body.name.trim().slice(0, 80);
  }
  if (typeof body.institution === "string") v.institution = body.institution.trim().slice(0, 80) || null;
  if (typeof body.statementSenderPattern === "string") v.statementSenderPattern = body.statementSenderPattern.trim() || null;
  if (typeof body.isShared === "boolean") v.isShared = body.isShared;
  if (body.goalId !== undefined) {
    if (body.goalId && !(await ownGoal(c, body.goalId))) return { error: "goal not found" };
    v.goalId = body.goalId || null;
  }
  if (body.settleAccountId !== undefined) {
    if (body.settleAccountId && (body.settleAccountId === existing?.id || !(await ownAccount(c, body.settleAccountId)))) return { error: "choose another of your accounts" };
    v.settleAccountId = body.settleAccountId || null;
  }

  // Deposit and loan terms.
  if (body.principal !== undefined) {
    const p = amount(c, body.principal);
    if (p === null || p <= 0) return { error: "enter the amount" };
    v.principalMinor = p;
  }
  if (body.rate !== undefined) {
    if (String(body.rate).trim() === "" || Number(body.rate) === 0) v.rateBp = 0;
    else {
      const r = parseRate(String(body.rate));
      if (r === null) return { error: "enter the yearly interest rate, like 8.5" };
      v.rateBp = r;
    }
  }
  if (body.startDate !== undefined) {
    if (!isDate(body.startDate)) return { error: "start date must be YYYY-MM-DD" };
    v.startDate = body.startDate;
  }
  if (body.endDate !== undefined) {
    if (body.endDate && !isDate(body.endDate)) return { error: "end date must be YYYY-MM-DD" };
    v.endDate = body.endDate || null;
  }
  const start = v.startDate ?? existing?.startDate ?? null;
  if (typeof body.termMonths === "number" && body.termMonths > 0 && start && !body.endDate) v.endDate = addMonths(start, Math.round(body.termMonths));
  if (body.payout !== undefined) {
    if (!(schema.depositPayouts as readonly string[]).includes(body.payout)) return { error: "choose how the interest is paid" };
    v.depositPayout = body.payout as Payout;
  }
  if (body.installment !== undefined) {
    const i = amount(c, body.installment);
    if (i !== null && i < 0) return { error: "the installment must be positive" };
    v.installmentMinor = i || null;
  }
  if (body.installmentDay !== undefined) {
    if (!Number.isInteger(body.installmentDay) || body.installmentDay < 1 || body.installmentDay > 28) return { error: "the installment day must be between 1 and 28" };
    v.installmentDay = body.installmentDay;
  }
  if (typeof body.closed === "boolean") v.closedAt = body.closed ? nowIso() : null;

  // The starting balance: the book counts everything after the end of this date.
  if (type === "deposit") {
    const principal = v.principalMinor ?? existing?.principalMinor;
    const rate = v.rateBp ?? existing?.rateBp;
    const end = v.endDate ?? existing?.endDate;
    if (!existing || body.principal !== undefined || body.startDate !== undefined) {
      if (!principal) return { error: "how much is in the deposit?" };
      if (rate === null || rate === undefined) return { error: "what is the yearly interest rate?" };
      if (!start) return { error: "when did the deposit start?" };
      if (!end) return { error: "when does it mature? a date or a term in months" };
      if (end <= start) return { error: "the maturity date must be after the start" };
      v.openingBalanceMinor = principal;
      v.openingBalanceDate = start;
    }
    if (!existing && !v.depositPayout) v.depositPayout = "maturity";
  } else if (body.balance !== undefined) {
    const b = amount(c, body.balance);
    if (b === null) return { error: type === "loan" ? "how much is still owed?" : "enter the balance" };
    const date = body.balanceDate ?? today;
    if (!isDate(date)) return { error: "balance date must be YYYY-MM-DD" };
    v.openingBalanceMinor = OWED.includes(type) ? -Math.abs(b) : b;
    // Balances count what happens after the end of the starting date. A balance typed for today
    // means "right now", so it stands at the end of yesterday and today's entries still count.
    v.openingBalanceDate = date === today ? addDays(today, -1) : date;
    if (type === "loan" && !(v.principalMinor ?? existing?.principalMinor)) v.principalMinor = Math.abs(b);
  } else if (!existing && type === "loan") {
    return { error: "how much is still owed?" };
  }

  // A loan with a term but no installment gets the usual EMI.
  if (type === "loan" && !v.installmentMinor && !existing?.installmentMinor && typeof body.termMonths === "number" && body.termMonths > 0) {
    const owed = Math.abs(v.openingBalanceMinor ?? existing?.openingBalanceMinor ?? 0);
    v.installmentMinor = emi(owed, v.rateBp ?? existing?.rateBp ?? 0, Math.round(body.termMonths));
    if (!v.installmentDay && !existing?.installmentDay) v.installmentDay = Math.min(28, Number(today.slice(8, 10)));
  }
  return { values: v };
}

accountRoutes.get("/accounts", async (c) => {
  const views = await loadAccountViews(c.get("db"), c.get("household").id, todayIn(c.get("household").timezone));
  return c.json(views.map((r) => ({ ...r, csvMapping: r.csvMapping ? (JSON.parse(r.csvMapping) as unknown) : null })));
});

accountRoutes.post("/accounts", requireWriter, async (c) => {
  const body = await readJson<AccountBody>(c);
  if (!(body.name ?? "").trim()) return c.json({ error: "give the account a name" }, 400);
  if (!(schema.accountTypes as readonly string[]).includes(body.type ?? "")) return c.json({ error: "invalid account type" }, 400);
  const type = body.type as AccountType;
  const fields = await accountFields(c, body, type);
  if ("error" in fields) return c.json({ error: fields.error }, 400);
  const id = newId();
  await c
    .get("db")
    .insert(schema.accounts)
    .values({ isShared: true, ...fields.values, id, householdId: c.get("household").id, name: fields.values.name!, type, ownerMemberId: body.ownerMemberId ?? null });
  return c.json({ id }, 201);
});

accountRoutes.patch("/accounts/:accountId", requireWriter, async (c) => {
  const account = await ownAccount(c, c.req.param("accountId"));
  if (!account) return c.json({ error: "not found" }, 404);
  const body = await readJson<AccountBody>(c);
  const fields = await accountFields(c, body, account.type, account);
  if ("error" in fields) return c.json({ error: fields.error }, 400);
  if (!Object.keys(fields.values).length) return c.json({ error: "nothing to change" }, 400);
  await c.get("db").update(schema.accounts).set(fields.values).where(eq(schema.accounts.id, account.id));
  return c.json({ ok: true });
});

/**
 * A repayment on a loan we owe (money from one of our accounts; this month's interest is an
 * expense, the rest reduces the loan), or money coming back on a loan we gave (it moves from the
 * "lent" account into one of ours).
 */
accountRoutes.post("/accounts/:accountId/repayment", requireWriter, async (c) => {
  const account = await ownAccount(c, c.req.param("accountId"));
  if (!account || (account.type !== "loan" && account.type !== "lent")) return c.json({ error: "not a loan" }, 404);
  const household = c.get("household");
  const body = await readJson<{ amount?: string; date?: string; otherAccountId?: string; note?: string }>(c);
  const paid = amount(c, body.amount);
  if (!paid || paid <= 0) return c.json({ error: "enter the amount" }, 400);
  const date = body.date ?? todayIn(household.timezone);
  if (!isDate(date)) return c.json({ error: "date must be YYYY-MM-DD" }, 400);
  const other = body.otherAccountId ? await ownAccount(c, body.otherAccountId) : null;
  if (!other || other.id === account.id) return c.json({ error: account.type === "loan" ? "choose the account it was paid from" : "choose the account it came into" }, 400);
  const db = c.get("db");
  const note = body.note?.trim() || null;
  const memberId = c.get("member").id;

  if (account.type === "lent") {
    await createTransfer(db, { householdId: household.id, fromAccountId: account.id, toAccountId: other.id, amountMinor: paid, date, note, memberId, description: `Repaid: ${account.name}` });
    return c.json({ principalMinor: paid, interestMinor: 0 }, 201);
  }

  const owed = Math.max(0, -((await accountBalances(db, household.id, date)).get(account.id) ?? 0));
  const split = splitPayment(owed, account.rateBp ?? 0, paid);
  if (split.principalMinor > 0) {
    await createTransfer(db, { householdId: household.id, fromAccountId: other.id, toAccountId: account.id, amountMinor: split.principalMinor, date, note, memberId, description: `Repayment: ${account.name}` });
  }
  if (split.interestMinor > 0) {
    await db.insert(schema.transactions).values(
      transactionValues({
        householdId: household.id,
        accountId: other.id,
        date,
        amountMinor: split.interestMinor,
        direction: "out",
        categoryId: await categoryNamed(c, /^interest$/i),
        description: `Interest: ${account.name}`,
        note,
        paidByMemberId: memberId,
        source: "manual",
      }),
    );
  }
  return c.json(split, 201);
});

/**
 * A deposit reached maturity and was renewed: the interest it earned is added (when it stays in)
 * and a new term starts on the old maturity date.
 */
accountRoutes.post("/accounts/:accountId/renew", requireWriter, async (c) => {
  const account = await ownAccount(c, c.req.param("accountId"));
  if (!account || account.type !== "deposit" || !account.startDate || !account.endDate) return c.json({ error: "not a deposit" }, 404);
  const body = await readJson<{ interest?: string; termMonths?: number; endDate?: string; rate?: string }>(c);
  const interest = amount(c, body.interest) ?? 0;
  if (interest < 0) return c.json({ error: "interest must be positive" }, 400);
  const db = c.get("db");
  const start = account.endDate;
  const months = typeof body.termMonths === "number" && body.termMonths > 0 ? Math.round(body.termMonths) : null;
  const end = body.endDate && isDate(body.endDate) ? body.endDate : addMonths(start, months ?? Math.max(1, termMonths(account.startDate, account.endDate)));
  if (end <= start) return c.json({ error: "the new maturity must be after the old one" }, 400);
  const rate = body.rate ? parseRate(body.rate) : account.rateBp;
  if (rate === null) return c.json({ error: "enter the new yearly rate, like 8.5" }, 400);
  const keptIn = (account.depositPayout ?? "maturity") === "maturity";
  if (interest > 0 && keptIn) {
    await db.insert(schema.transactions).values(
      transactionValues({
        householdId: account.householdId,
        accountId: account.id,
        date: start,
        amountMinor: interest,
        direction: "in",
        categoryId: await categoryNamed(c, /interest/i, "income"),
        description: `Interest: ${account.name}`,
        paidByMemberId: c.get("member").id,
        source: "manual",
      }),
    );
  }
  const balance = (await accountBalances(db, account.householdId, start)).get(account.id) ?? account.principalMinor ?? 0;
  await db.update(schema.accounts).set({ startDate: start, endDate: end, rateBp: rate, principalMinor: balance, closedAt: null }).where(eq(schema.accounts.id, account.id));
  return c.json({ ok: true, startDate: start, endDate: end, principalMinor: balance });
});

/**
 * Closes an account: a matured deposit paid out (interest added, everything moved to another
 * account), a loan paid off, a card cancelled. History stays; it leaves the totals.
 */
accountRoutes.post("/accounts/:accountId/close", requireWriter, async (c) => {
  const account = await ownAccount(c, c.req.param("accountId"));
  if (!account || account.closedAt) return c.json({ error: "not found" }, 404);
  const household = c.get("household");
  const body = await readJson<{ interest?: string; toAccountId?: string | null; date?: string }>(c);
  const today = todayIn(household.timezone);
  // A deposit closes on its maturity date, or today if it is broken early.
  const date = body.date && isDate(body.date) ? body.date : account.type === "deposit" && account.endDate && account.endDate < today ? account.endDate : today;
  const interest = amount(c, body.interest) ?? 0;
  const db = c.get("db");
  const to = body.toAccountId ? await ownAccount(c, body.toAccountId) : null;
  if (body.toAccountId && (!to || to.id === account.id)) return c.json({ error: "choose another of your accounts" }, 400);
  if (interest > 0) {
    await db.insert(schema.transactions).values(
      transactionValues({
        householdId: household.id,
        accountId: account.id,
        date,
        amountMinor: interest,
        direction: "in",
        categoryId: await categoryNamed(c, /interest/i, "income"),
        description: `Interest: ${account.name}`,
        paidByMemberId: c.get("member").id,
        source: "manual",
      }),
    );
  }
  let movedMinor = 0;
  if (to) {
    const balance = (await accountBalances(db, household.id, date)).get(account.id) ?? 0;
    if (balance > 0) {
      await createTransfer(db, { householdId: household.id, fromAccountId: account.id, toAccountId: to.id, amountMinor: balance, date, note: null, memberId: c.get("member").id, description: `Closed: ${account.name}` });
      movedMinor = balance;
    }
  }
  await db.update(schema.accounts).set({ closedAt: nowIso() }).where(eq(schema.accounts.id, account.id));
  return c.json({ ok: true, movedMinor });
});

// ---------------------------------------------------------------------------
// Checking the book against the bank
// ---------------------------------------------------------------------------

/**
 * What the bank says the balance was at the end of a date (from a statement or the banking app).
 * The first figure starts the book for this account; later ones are compared with the book, and
 * a difference becomes a balance question in Decide.
 */
accountRoutes.post("/accounts/:accountId/bank-balance", requireWriter, async (c) => {
  const account = await ownAccount(c, c.req.param("accountId"));
  if (!account) return c.json({ error: "not found" }, 404);
  const household = c.get("household");
  const body = await readJson<{ amount?: string; date?: string; startBook?: boolean }>(c);
  const date = body.date ?? todayIn(household.timezone);
  if (!isDate(date)) return c.json({ error: "date must be YYYY-MM-DD" }, 400);
  const typed = parseAmountToMinor(String(body.amount ?? ""), household.currency);
  if (typed === null) return c.json({ error: "enter the balance the bank shows" }, 400);
  const value = OWED.includes(account.type) ? -Math.abs(typed) : typed;
  const startBook = body.startBook || account.openingBalanceMinor === null || !account.openingBalanceDate;
  const patch: Partial<typeof schema.accounts.$inferInsert> = { lastStatementBalanceMinor: value, lastStatementAt: date, balanceSnoozedFor: null };
  if (startBook) Object.assign(patch, { openingBalanceMinor: value, openingBalanceDate: date });
  await c.get("db").update(schema.accounts).set(patch).where(eq(schema.accounts.id, account.id));
  const book = startBook ? value : await bookBalance(c.get("db"), { id: account.id, openingBalanceMinor: account.openingBalanceMinor, openingBalanceDate: account.openingBalanceDate }, date);
  return c.json({ bankMinor: value, bookMinor: book, matches: book === value, startedBook: startBook });
});

/** "Wait for the next statement": hides the current balance question for this account. */
accountRoutes.post("/accounts/:accountId/balance-snooze", requireWriter, async (c) => {
  const account = await ownAccount(c, c.req.param("accountId"));
  if (!account || !account.lastStatementAt) return c.json({ error: "not found" }, 404);
  await c.get("db").update(schema.accounts).set({ balanceSnoozedFor: account.lastStatementAt }).where(eq(schema.accounts.id, account.id));
  return c.json({ ok: true });
});

/** Adds one entry for the difference so the book matches the bank, dated on the bank's date. */
accountRoutes.post("/accounts/:accountId/balance-correction", requireWriter, async (c) => {
  const account = await ownAccount(c, c.req.param("accountId"));
  if (!account || account.lastStatementBalanceMinor === null || !account.lastStatementAt) return c.json({ error: "no bank balance to match" }, 404);
  const db = c.get("db");
  const book = await bookBalance(db, account, account.lastStatementAt);
  if (book === null) return c.json({ error: "this account has no starting balance" }, 409);
  const diff = account.lastStatementBalanceMinor - book;
  if (diff === 0) return c.json({ ok: true, diffMinor: 0 });
  const values = transactionValues({
    householdId: account.householdId,
    accountId: account.id,
    date: account.lastStatementAt,
    amountMinor: Math.abs(diff),
    direction: diff > 0 ? "in" : "out",
    description: "Correction to match the bank",
    paidByMemberId: c.get("member").id,
    source: "manual",
    confirmedAt: new Date().toISOString(),
  });
  await db.insert(schema.transactions).values(values);
  return c.json({ ok: true, diffMinor: diff, transactionId: values.id });
});
