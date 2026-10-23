import { Hono } from "hono";
import { and, asc, between, desc, eq, inArray, isNull } from "drizzle-orm";
import { toCsv } from "../../../shared/csv";
import { isDate, isMonth, monthRange, shiftMonth, todayIn } from "../../../shared/dates";
import { minorToDecimal, parseAmountToMinor } from "../../../shared/money";
import { schema } from "../../db";
import { newId, nowIso } from "../../lib/ids";
import { ensureCategories } from "../../ledger/categories";
import { rememberCategory, resolveMerchant } from "../../ledger/merchants";
import { KEPT_TYPES } from "../../ledger/overview";
import { summarize } from "../../ledger/summary";
import { createTransfer, findMatches, loadDedupeCandidates, transactionValues, DUPLICATE_WINDOW_DAYS } from "../../ledger/transactions";
import { addDays } from "../../../shared/dates";
import type { AppContext, HonoEnv } from "../context";
import { readJson, requireWriter } from "../context";

export const ledgerRoutes = new Hono<HonoEnv>();

type Category = typeof schema.categories.$inferSelect;

async function loadCategories(c: AppContext): Promise<Category[]> {
  const db = c.get("db");
  const householdId = c.get("household").id;
  await ensureCategories(db, householdId);
  return db.query.categories.findMany({ where: eq(schema.categories.householdId, householdId), orderBy: [asc(schema.categories.sort), asc(schema.categories.name)] });
}

async function accountBelongs(c: AppContext, accountId: string | undefined): Promise<boolean> {
  if (!accountId) return false;
  const a = await c.get("db").query.accounts.findFirst({ where: and(eq(schema.accounts.id, accountId), eq(schema.accounts.householdId, c.get("household").id)), columns: { id: true } });
  return Boolean(a);
}

async function categoryBelongs(c: AppContext, categoryId: string | null | undefined): Promise<boolean> {
  if (!categoryId) return true;
  const row = await c.get("db").query.categories.findFirst({ where: and(eq(schema.categories.id, categoryId), eq(schema.categories.householdId, c.get("household").id)), columns: { id: true } });
  return Boolean(row);
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

ledgerRoutes.get("/categories", async (c) => c.json(await loadCategories(c)));

ledgerRoutes.post("/categories", requireWriter, async (c) => {
  const body = await readJson<{ name?: string; parentId?: string | null; kind?: string }>(c);
  const name = (body.name ?? "").trim();
  if (!name) return c.json({ error: "name is required" }, 400);
  const kinds = ["need", "want", "saving", "transfer", "income"] as const;
  const kind = (kinds as readonly string[]).includes(body.kind ?? "") ? (body.kind as (typeof kinds)[number]) : "want";
  if (body.parentId && !(await categoryBelongs(c, body.parentId))) return c.json({ error: "parent not found" }, 404);
  const [row] = await c
    .get("db")
    .insert(schema.categories)
    .values({ id: newId(), householdId: c.get("household").id, parentId: body.parentId ?? null, name, kind, sort: 10_000 })
    .returning();
  return c.json(row, 201);
});

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

type TxRow = {
  id: string;
  date: string;
  amountMinor: number;
  direction: "out" | "in" | "transfer";
  accountId: string;
  accountName: string | null;
  categoryId: string | null;
  merchantId: string | null;
  merchantName: string | null;
  description: string | null;
  note: string | null;
  isPersonal: boolean;
  paidByMemberId: string | null;
  paidByName: string | null;
  source: string;
  transferPairId: string | null;
  confirmedAt: string | null;
  goalId: string | null;
};

async function queryTransactions(c: AppContext, from: string, to: string, opts: { accountId?: string; categoryId?: string } = {}): Promise<TxRow[]> {
  const db = c.get("db");
  const householdId = c.get("household").id;
  const conditions = [eq(schema.transactions.householdId, householdId), between(schema.transactions.date, from, to), isNull(schema.transactions.voidedAt)];
  if (opts.accountId) conditions.push(eq(schema.transactions.accountId, opts.accountId));
  if (opts.categoryId) conditions.push(eq(schema.transactions.categoryId, opts.categoryId));
  const rows = await db
    .select({
      id: schema.transactions.id,
      date: schema.transactions.date,
      amountMinor: schema.transactions.amountMinor,
      direction: schema.transactions.direction,
      accountId: schema.transactions.accountId,
      accountName: schema.accounts.name,
      categoryId: schema.transactions.categoryId,
      merchantId: schema.transactions.merchantId,
      merchantName: schema.merchants.displayName,
      description: schema.transactions.description,
      note: schema.transactions.note,
      isPersonal: schema.transactions.isPersonal,
      paidByMemberId: schema.transactions.paidByMemberId,
      paidByName: schema.members.name,
      source: schema.transactions.source,
      transferPairId: schema.transactions.transferPairId,
      confirmedAt: schema.transactions.confirmedAt,
      goalId: schema.transactions.goalId,
    })
    .from(schema.transactions)
    .leftJoin(schema.accounts, eq(schema.accounts.id, schema.transactions.accountId))
    .leftJoin(schema.merchants, eq(schema.merchants.id, schema.transactions.merchantId))
    .leftJoin(schema.members, eq(schema.members.id, schema.transactions.paidByMemberId))
    .where(and(...conditions))
    .orderBy(desc(schema.transactions.date), desc(schema.transactions.createdAt))
    .limit(2000);

  // Personal transactions stay private to the member who paid; everyone else sees the amount only.
  const me = c.get("member").id;
  return rows.map((r) =>
    r.isPersonal && r.paidByMemberId !== me ? { ...r, merchantId: null, merchantName: "Personal", description: "Personal", note: null, categoryId: r.categoryId } : r,
  );
}

ledgerRoutes.get("/transactions", async (c) => {
  const month = c.req.query("month") ?? "";
  if (!isMonth(month)) return c.json({ error: "month must be YYYY-MM" }, 400);
  const { from, to } = monthRange(month);
  return c.json(await queryTransactions(c, from, to, { accountId: c.req.query("accountId") || undefined, categoryId: c.req.query("categoryId") || undefined }));
});

export type Twin = {
  kind: "transaction" | "line";
  id: string;
  date: string;
  amountMinor: number;
  name: string | null;
  accountName: string | null;
  byName: string | null;
  source: string;
  confirmed: boolean;
  note: string | null;
};

/**
 * Entries already in the book (or waiting in Decide) that look like the one being logged: same
 * account, direction and amount within the duplicate window.
 */
async function findTwins(c: AppContext, accountId: string, direction: "out" | "in", amountMinor: number, date: string): Promise<Twin[]> {
  const db = c.get("db");
  const householdId = c.get("household").id;
  const candidates = await loadDedupeCandidates(db, accountId, date, date);
  const hits = findMatches(candidates, { accountId, direction, amountMinor, date }).slice(0, 3);
  const twins: Twin[] = [];
  if (hits.length) {
    const rows = await db
      .select({
        id: schema.transactions.id,
        date: schema.transactions.date,
        amountMinor: schema.transactions.amountMinor,
        merchant: schema.merchants.displayName,
        description: schema.transactions.description,
        accountName: schema.accounts.name,
        byName: schema.members.name,
        source: schema.transactions.source,
        confirmedAt: schema.transactions.confirmedAt,
        note: schema.transactions.note,
        isPersonal: schema.transactions.isPersonal,
        paidByMemberId: schema.transactions.paidByMemberId,
      })
      .from(schema.transactions)
      .leftJoin(schema.merchants, eq(schema.merchants.id, schema.transactions.merchantId))
      .leftJoin(schema.accounts, eq(schema.accounts.id, schema.transactions.accountId))
      .leftJoin(schema.members, eq(schema.members.id, schema.transactions.paidByMemberId))
      .where(inArray(schema.transactions.id, hits.map((h) => h.id)));
    const me = c.get("member").id;
    for (const h of hits) {
      const r = rows.find((x) => x.id === h.id);
      if (!r) continue;
      const hidden = r.isPersonal && r.paidByMemberId !== me;
      twins.push({ kind: "transaction", id: r.id, date: r.date, amountMinor: r.amountMinor, name: hidden ? "Personal" : r.merchant ?? r.description, accountName: r.accountName, byName: r.byName, source: r.source, confirmed: Boolean(r.confirmedAt), note: hidden ? null : r.note });
    }
  }
  const signed = direction === "out" ? -amountMinor : amountMinor;
  const lines = await db
    .select({ id: schema.importLines.id, date: schema.importLines.parsedDate, description: schema.importLines.parsedDescription, accountName: schema.accounts.name })
    .from(schema.importLines)
    .innerJoin(schema.statementEmails, eq(schema.statementEmails.id, schema.importLines.statementEmailId))
    .leftJoin(schema.accounts, eq(schema.accounts.id, schema.statementEmails.accountId))
    .where(
      and(
        eq(schema.importLines.householdId, householdId),
        eq(schema.statementEmails.accountId, accountId),
        eq(schema.importLines.decision, "pending"),
        eq(schema.importLines.parsedAmountMinor, signed),
        between(schema.importLines.parsedDate, addDays(date, -DUPLICATE_WINDOW_DAYS), addDays(date, DUPLICATE_WINDOW_DAYS)),
      ),
    )
    .limit(3);
  for (const l of lines) twins.push({ kind: "line", id: l.id, date: l.date ?? date, amountMinor, name: l.description, accountName: l.accountName, byName: null, source: "statement", confirmed: true, note: null });
  return twins;
}

/**
 * Quick add: amount, category, who paid, shared or personal. The merchant's category is remembered.
 * Before saving, entries that look like this one are returned with 409 so the person can say
 * whether it is the same payment; `force` saves it as a separate payment.
 */
ledgerRoutes.post("/transactions", requireWriter, async (c) => {
  const db = c.get("db");
  const household = c.get("household");
  const body = await readJson<{
    date?: string;
    amount?: string;
    direction?: string;
    accountId?: string;
    categoryId?: string | null;
    description?: string;
    note?: string;
    isPersonal?: boolean;
    paidByMemberId?: string | null;
    force?: boolean;
  }>(c);

  const date = body.date ?? "";
  if (!isDate(date)) return c.json({ error: "date must be YYYY-MM-DD" }, 400);
  const amount = parseAmountToMinor(String(body.amount ?? ""), household.currency);
  if (amount === null || amount === 0) return c.json({ error: "enter an amount" }, 400);
  const direction = body.direction === "in" ? "in" : "out";
  if (!(await accountBelongs(c, body.accountId))) return c.json({ error: "choose an account" }, 400);
  if (!(await categoryBelongs(c, body.categoryId))) return c.json({ error: "category not found" }, 404);
  const description = (body.description ?? "").trim().slice(0, 200);
  if (!description) return c.json({ error: "add a short description, such as the shop name" }, 400);

  if (!body.force) {
    const twins = await findTwins(c, body.accountId!, direction, Math.abs(amount), date);
    if (twins.length) return c.json({ error: "this looks like it is already in the book", twins }, 409);
  }

  const merchant = await resolveMerchant(db, household.id, description);
  const categoryId = body.categoryId ?? merchant.defaultCategoryId;
  if (body.categoryId) await rememberCategory(db, merchant.id, body.categoryId);

  const values = transactionValues({
    householdId: household.id,
    accountId: body.accountId!,
    date,
    amountMinor: Math.abs(amount),
    direction,
    merchantId: merchant.id,
    categoryId,
    description,
    note: (body.note ?? "").trim() || null,
    isPersonal: Boolean(body.isPersonal),
    paidByMemberId: body.paidByMemberId ?? c.get("member").id,
    source: "manual",
  });
  await db.insert(schema.transactions).values(values);
  return c.json({ id: values.id, categoryId }, 201);
});

ledgerRoutes.patch("/transactions/:id", requireWriter, async (c) => {
  const db = c.get("db");
  const household = c.get("household");
  const tx = await db.query.transactions.findFirst({ where: and(eq(schema.transactions.id, c.req.param("id")), eq(schema.transactions.householdId, household.id)) });
  if (!tx || tx.voidedAt) return c.json({ error: "not found" }, 404);
  if (tx.isPersonal && tx.paidByMemberId !== c.get("member").id) return c.json({ error: "only the person who paid can edit a personal transaction" }, 403);

  const body = await readJson<{ categoryId?: string | null; note?: string; isPersonal?: boolean; date?: string; amount?: string; description?: string }>(c);
  const patch: Partial<typeof schema.transactions.$inferInsert> = {};
  if (body.categoryId !== undefined) {
    if (!(await categoryBelongs(c, body.categoryId))) return c.json({ error: "category not found" }, 404);
    patch.categoryId = body.categoryId;
  }
  if (typeof body.note === "string") patch.note = body.note.trim() || null;
  if (typeof body.isPersonal === "boolean") patch.isPersonal = body.isPersonal;
  if (typeof body.date === "string") {
    if (!isDate(body.date)) return c.json({ error: "date must be YYYY-MM-DD" }, 400);
    patch.date = body.date;
  }
  if (typeof body.amount === "string") {
    const amount = parseAmountToMinor(body.amount, household.currency);
    if (amount === null || amount === 0) return c.json({ error: "enter an amount" }, 400);
    patch.amountMinor = Math.abs(amount);
  }
  if (typeof body.description === "string" && body.description.trim()) patch.description = body.description.trim().slice(0, 200);
  if (!Object.keys(patch).length) return c.json({ ok: true });

  await db.update(schema.transactions).set(patch).where(eq(schema.transactions.id, tx.id));
  // Teach merchant memory whenever a person picks a category.
  if (body.categoryId && tx.merchantId) await rememberCategory(db, tx.merchantId, body.categoryId);
  return c.json({ ok: true });
});

/** Voids a transaction (and its other half, for a transfer). Nothing is deleted. */
ledgerRoutes.delete("/transactions/:id", requireWriter, async (c) => {
  const db = c.get("db");
  const tx = await db.query.transactions.findFirst({ where: and(eq(schema.transactions.id, c.req.param("id")), eq(schema.transactions.householdId, c.get("household").id)) });
  if (!tx || tx.voidedAt) return c.json({ error: "not found" }, 404);
  if (tx.isPersonal && tx.paidByMemberId !== c.get("member").id) return c.json({ error: "only the person who paid can remove a personal transaction" }, 403);
  const where = tx.transferPairId ? eq(schema.transactions.transferPairId, tx.transferPairId) : eq(schema.transactions.id, tx.id);
  await db.update(schema.transactions).set({ voidedAt: nowIso() }).where(and(where, eq(schema.transactions.householdId, tx.householdId)));
  return c.json({ ok: true });
});

ledgerRoutes.post("/transfers", requireWriter, async (c) => {
  const household = c.get("household");
  const body = await readJson<{ fromAccountId?: string; toAccountId?: string; amount?: string; date?: string; note?: string }>(c);
  if (!body.date || !isDate(body.date)) return c.json({ error: "date must be YYYY-MM-DD" }, 400);
  const amount = parseAmountToMinor(String(body.amount ?? ""), household.currency);
  if (amount === null || amount === 0) return c.json({ error: "enter an amount" }, 400);
  if (!body.fromAccountId || body.fromAccountId === body.toAccountId) return c.json({ error: "choose two different accounts" }, 400);
  if (!(await accountBelongs(c, body.fromAccountId)) || !(await accountBelongs(c, body.toAccountId))) return c.json({ error: "account not found" }, 404);
  const { pairId } = await createTransfer(c.get("db"), {
    householdId: household.id,
    fromAccountId: body.fromAccountId,
    toAccountId: body.toAccountId!,
    amountMinor: Math.abs(amount),
    date: body.date,
    note: body.note?.trim() || null,
    memberId: c.get("member").id,
  });
  return c.json({ pairId }, 201);
});

// ---------------------------------------------------------------------------
// Month summary and budgets
// ---------------------------------------------------------------------------

export type CategoryTotal = { categoryId: string | null; name: string; kind: string; spentMinor: number; budgetMinor: number | null };

export { summarize };

/** The last few months at a glance: what came in, what was spent, what was saved. */
ledgerRoutes.get("/months", async (c) => {
  const count = Math.min(24, Math.max(1, Math.round(Number(c.req.query("count") ?? 6)) || 6));
  const db = c.get("db");
  const household = c.get("household");
  const thisMonth = todayIn(household.timezone).slice(0, 7);
  const months = Array.from({ length: count }, (_, i) => shiftMonth(thisMonth, i - (count - 1)));
  const [categories, all, kept] = await Promise.all([
    loadCategories(c),
    queryTransactions(c, monthRange(months[0]!).from, monthRange(thisMonth).to),
    db.select({ id: schema.accounts.id }).from(schema.accounts).where(and(eq(schema.accounts.householdId, household.id), inArray(schema.accounts.type, [...KEPT_TYPES]))),
  ]);
  const keptIds = new Set(kept.map((k) => k.id));
  const txs = all.filter((t) => !keptIds.has(t.accountId));
  return c.json(
    months.map((month) => {
      const { from, to } = monthRange(month);
      const s = summarize(txs.filter((t) => t.date >= from && t.date <= to), categories);
      return { month, incomeMinor: s.income, spentMinor: s.spent, savedMinor: s.saved };
    }),
  );
});

ledgerRoutes.get("/summary", async (c) => {
  const month = c.req.query("month") ?? "";
  if (!isMonth(month)) return c.json({ error: "month must be YYYY-MM" }, 400);
  const db = c.get("db");
  const household = c.get("household");
  const { from, to } = monthRange(month);
  const [categories, all, budgets, pending, kept] = await Promise.all([
    loadCategories(c),
    queryTransactions(c, from, to),
    db.query.budgets.findMany({ where: and(eq(schema.budgets.householdId, household.id), eq(schema.budgets.month, month)) }),
    db.select({ id: schema.importLines.id }).from(schema.importLines).where(and(eq(schema.importLines.householdId, household.id), eq(schema.importLines.decision, "pending"))),
    db.select({ id: schema.accounts.id }).from(schema.accounts).where(and(eq(schema.accounts.householdId, household.id), inArray(schema.accounts.type, [...KEPT_TYPES]))),
  ]);
  // Deposits, loans and money lent are not the month's income or spending.
  const keptIds = new Set(kept.map((k) => k.id));
  const txs = all.filter((t) => !keptIds.has(t.accountId));
  const s = summarize(txs, categories);
  const budgetByCat = new Map(budgets.map((b) => [b.categoryId, b.amountMinor]));
  const tops = categories.filter((cat) => !cat.parentId && (cat.kind === "need" || cat.kind === "want"));
  const byCategory: CategoryTotal[] = tops
    .map((cat) => ({ categoryId: cat.id, name: cat.name, kind: cat.kind, spentMinor: s.perTop.get(cat.id) ?? 0, budgetMinor: budgetByCat.get(cat.id) ?? null }))
    .filter((r) => r.spentMinor !== 0 || r.budgetMinor !== null);
  const uncategorizedSpend = s.perTop.get(null) ?? 0;
  if (uncategorizedSpend) byCategory.push({ categoryId: null, name: "Uncategorised", kind: "want", spentMinor: uncategorizedSpend, budgetMinor: null });
  byCategory.sort((a, b) => b.spentMinor - a.spentMinor);

  return c.json({
    month,
    currency: household.currency,
    spentMinor: s.spent,
    incomeMinor: s.income,
    savedMinor: s.saved,
    netMinor: s.income - s.spent - s.saved,
    budgetTotalMinor: budgets.reduce((sum, b) => sum + b.amountMinor, 0),
    uncategorizedCount: s.uncategorized,
    pendingReview: pending.length,
    transactionCount: txs.length,
    byCategory,
  });
});

ledgerRoutes.get("/budgets", async (c) => {
  const month = c.req.query("month") ?? "";
  if (!isMonth(month)) return c.json({ error: "month must be YYYY-MM" }, 400);
  const rows = await c.get("db").query.budgets.findMany({ where: and(eq(schema.budgets.householdId, c.get("household").id), eq(schema.budgets.month, month)) });
  return c.json(rows);
});

/** Sets one category's budget for a month; an empty or zero amount removes it. */
ledgerRoutes.put("/budgets", requireWriter, async (c) => {
  const db = c.get("db");
  const household = c.get("household");
  const body = await readJson<{ month?: string; categoryId?: string; amount?: string }>(c);
  if (!body.month || !isMonth(body.month)) return c.json({ error: "month must be YYYY-MM" }, 400);
  if (!body.categoryId || !(await categoryBelongs(c, body.categoryId))) return c.json({ error: "category not found" }, 404);
  const amount = body.amount?.trim() ? parseAmountToMinor(body.amount, household.currency) : 0;
  if (amount === null || amount < 0) return c.json({ error: "enter a positive amount" }, 400);
  const where = and(eq(schema.budgets.householdId, household.id), eq(schema.budgets.categoryId, body.categoryId), eq(schema.budgets.month, body.month));
  if (amount === 0) {
    await db.delete(schema.budgets).where(where);
    return c.json({ ok: true });
  }
  await db
    .insert(schema.budgets)
    .values({ id: newId(), householdId: household.id, categoryId: body.categoryId, month: body.month, amountMinor: amount })
    .onConflictDoUpdate({ target: [schema.budgets.householdId, schema.budgets.categoryId, schema.budgets.month], set: { amountMinor: amount } });
  return c.json({ ok: true });
});

/** Copies last month's budgets into a month that has none yet. */
ledgerRoutes.post("/budgets/copy-previous", requireWriter, async (c) => {
  const db = c.get("db");
  const household = c.get("household");
  const body = await readJson<{ month?: string; fromMonth?: string }>(c);
  if (!body.month || !isMonth(body.month) || !body.fromMonth || !isMonth(body.fromMonth)) return c.json({ error: "month and fromMonth must be YYYY-MM" }, 400);
  const previous = await db.query.budgets.findMany({ where: and(eq(schema.budgets.householdId, household.id), eq(schema.budgets.month, body.fromMonth)) });
  if (!previous.length) return c.json({ copied: 0 });
  const statements = previous.map((b) =>
    db.insert(schema.budgets).values({ id: newId(), householdId: household.id, categoryId: b.categoryId, month: body.month!, amountMinor: b.amountMinor, rollover: b.rollover }).onConflictDoNothing(),
  );
  await db.batch(statements as [typeof statements[number], ...typeof statements]);
  return c.json({ copied: previous.length });
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

ledgerRoutes.get("/export.csv", async (c) => {
  const from = c.req.query("from") ?? "";
  const to = c.req.query("to") ?? "";
  if (!isDate(from) || !isDate(to) || from > to) return c.json({ error: "from and to must be YYYY-MM-DD" }, 400);
  const household = c.get("household");
  const [txs, categories] = await Promise.all([queryTransactions(c, from, to), loadCategories(c)]);
  const byId = new Map(categories.map((cat) => [cat.id, cat]));
  const rows: (string | number | null)[][] = [["Date", "Account", "Type", "Amount", "Currency", "Category", "Parent category", "Merchant", "Description", "Note", "Paid by", "Personal", "Source"]];
  for (const t of [...txs].reverse()) {
    const cat = t.categoryId ? byId.get(t.categoryId) : undefined;
    const parent = cat?.parentId ? byId.get(cat.parentId) : undefined;
    const signed = t.direction === "in" ? t.amountMinor : -t.amountMinor;
    rows.push([t.date, t.accountName, t.direction, minorToDecimal(signed, household.currency), household.currency, cat?.name ?? "", parent?.name ?? "", t.merchantName ?? "", t.description ?? "", t.note ?? "", t.paidByName ?? "", t.isPersonal ? "yes" : "", t.source]);
  }
  return new Response(toCsv(rows), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="transactions-${from}-to-${to}.csv"`,
    },
  });
});
