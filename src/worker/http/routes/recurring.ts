/**
 * Every month: the bills and income the family expects. Items are set up once; each month the
 * family logs the instance (from Decide, the Log sheet or here), says it is already in the book,
 * or skips it.
 */
import { Hono } from "hono";
import { and, between, desc, eq, isNull } from "drizzle-orm";
import { isDate, isMonth, monthRange, todayIn } from "../../../shared/dates";
import { parseAmountToMinor } from "../../../shared/money";
import { schema } from "../../db";
import { newId, nowIso } from "../../lib/ids";
import { rememberCategory, resolveMerchant } from "../../ledger/merchants";
import { loadRecurring } from "../../ledger/recurring";
import { transactionValues } from "../../ledger/transactions";
import type { AppContext, HonoEnv } from "../context";
import { readJson, requireWriter } from "../context";

export const recurringRoutes = new Hono<HonoEnv>();

type Body = { name?: string; direction?: string; amount?: string; dayOfMonth?: number; categoryId?: string | null; accountId?: string | null; note?: string; active?: boolean };

async function ownAccount(c: AppContext, id: string | null | undefined): Promise<boolean> {
  if (!id) return true;
  const a = await c.get("db").query.accounts.findFirst({ where: and(eq(schema.accounts.id, id), eq(schema.accounts.householdId, c.get("household").id)), columns: { id: true, type: true } });
  return Boolean(a) && a!.type !== "person";
}

async function ownCategory(c: AppContext, id: string | null | undefined): Promise<boolean> {
  if (!id) return true;
  const row = await c.get("db").query.categories.findFirst({ where: and(eq(schema.categories.id, id), eq(schema.categories.householdId, c.get("household").id)), columns: { id: true } });
  return Boolean(row);
}

async function findItem(c: AppContext) {
  const id = c.req.param("id") ?? "";
  return c.get("db").query.recurring.findFirst({ where: and(eq(schema.recurring.id, id), eq(schema.recurring.householdId, c.get("household").id), isNull(schema.recurring.archivedAt)) });
}

function monthOf(c: AppContext): string | null {
  const q = c.req.query("month");
  if (q) return isMonth(q) ? q : null;
  return todayIn(c.get("household").timezone).slice(0, 7);
}

/** The items with where each stands in a month (this month unless ?month=). */
recurringRoutes.get("/recurring", async (c) => {
  const month = monthOf(c);
  if (!month) return c.json({ error: "month must be YYYY-MM" }, 400);
  const household = c.get("household");
  return c.json(await loadRecurring(c.get("db"), household.id, month, todayIn(household.timezone)));
});

recurringRoutes.post("/recurring", requireWriter, async (c) => {
  const db = c.get("db");
  const household = c.get("household");
  const body = await readJson<Body>(c);
  const name = (body.name ?? "").trim().slice(0, 80);
  if (!name) return c.json({ error: "give it a name, such as Rent or Salary" }, 400);
  const direction = body.direction === "in" ? "in" : "out";
  const amount = parseAmountToMinor(String(body.amount ?? ""), household.currency);
  if (amount === null || amount <= 0) return c.json({ error: "enter the usual amount" }, 400);
  const day = Number(body.dayOfMonth);
  if (!Number.isInteger(day) || day < 1 || day > 28) return c.json({ error: "the day must be between 1 and 28" }, 400);
  if (!(await ownAccount(c, body.accountId))) return c.json({ error: "account not found" }, 404);
  if (!(await ownCategory(c, body.categoryId))) return c.json({ error: "category not found" }, 404);
  const id = newId();
  await db.insert(schema.recurring).values({
    id,
    householdId: household.id,
    name,
    direction,
    amountMinor: amount,
    dayOfMonth: day,
    categoryId: body.categoryId ?? null,
    accountId: body.accountId ?? null,
    note: (body.note ?? "").trim().slice(0, 200) || null,
  });
  return c.json({ id }, 201);
});

recurringRoutes.patch("/recurring/:id", requireWriter, async (c) => {
  const db = c.get("db");
  const household = c.get("household");
  const item = await findItem(c);
  if (!item) return c.json({ error: "not found" }, 404);
  const body = await readJson<Body>(c);
  const patch: Partial<typeof schema.recurring.$inferInsert> = {};
  if (typeof body.name === "string") {
    const name = body.name.trim().slice(0, 80);
    if (!name) return c.json({ error: "give it a name" }, 400);
    patch.name = name;
  }
  if (body.direction === "in" || body.direction === "out") patch.direction = body.direction;
  if (typeof body.amount === "string") {
    const amount = parseAmountToMinor(body.amount, household.currency);
    if (amount === null || amount <= 0) return c.json({ error: "enter the usual amount" }, 400);
    patch.amountMinor = amount;
  }
  if (body.dayOfMonth !== undefined) {
    const day = Number(body.dayOfMonth);
    if (!Number.isInteger(day) || day < 1 || day > 28) return c.json({ error: "the day must be between 1 and 28" }, 400);
    patch.dayOfMonth = day;
  }
  if (body.accountId !== undefined) {
    if (!(await ownAccount(c, body.accountId))) return c.json({ error: "account not found" }, 404);
    patch.accountId = body.accountId;
  }
  if (body.categoryId !== undefined) {
    if (!(await ownCategory(c, body.categoryId))) return c.json({ error: "category not found" }, 404);
    patch.categoryId = body.categoryId;
  }
  if (typeof body.note === "string") patch.note = body.note.trim().slice(0, 200) || null;
  if (typeof body.active === "boolean") patch.active = body.active;
  if (Object.keys(patch).length) await db.update(schema.recurring).set(patch).where(eq(schema.recurring.id, item.id));
  return c.json({ ok: true });
});

/** Removes an item from the list; entries it posted keep their link to it. */
recurringRoutes.delete("/recurring/:id", requireWriter, async (c) => {
  const item = await findItem(c);
  if (!item) return c.json({ error: "not found" }, 404);
  await c.get("db").update(schema.recurring).set({ archivedAt: nowIso(), active: false }).where(eq(schema.recurring.id, item.id));
  return c.json({ ok: true });
});

/**
 * Entries this month that could be the item already in the book: same direction, not already an
 * instance of anything, amount within a tenth or the same name.
 */
recurringRoutes.get("/recurring/:id/candidates", async (c) => {
  const item = await findItem(c);
  if (!item) return c.json({ error: "not found" }, 404);
  const month = monthOf(c);
  if (!month) return c.json({ error: "month must be YYYY-MM" }, 400);
  const { from, to } = monthRange(month);
  const db = c.get("db");
  const rows = await db
    .select({
      id: schema.transactions.id,
      date: schema.transactions.date,
      amountMinor: schema.transactions.amountMinor,
      direction: schema.transactions.direction,
      name: schema.merchants.displayName,
      description: schema.transactions.description,
      accountName: schema.accounts.name,
      source: schema.transactions.source,
    })
    .from(schema.transactions)
    .leftJoin(schema.merchants, eq(schema.merchants.id, schema.transactions.merchantId))
    .leftJoin(schema.accounts, eq(schema.accounts.id, schema.transactions.accountId))
    .where(
      and(
        eq(schema.transactions.householdId, item.householdId),
        between(schema.transactions.date, from, to),
        isNull(schema.transactions.voidedAt),
        isNull(schema.transactions.recurringId),
        isNull(schema.transactions.transferPairId),
        eq(schema.transactions.direction, item.direction),
      ),
    )
    .orderBy(desc(schema.transactions.date))
    .limit(300);
  const needle = item.name.trim().toLowerCase();
  const close = (a: number) => Math.abs(a - item.amountMinor) <= Math.max(item.amountMinor * 0.1, 1);
  const hits = rows.filter((r) => close(r.amountMinor) || (r.name ?? r.description ?? "").toLowerCase().includes(needle)).slice(0, 6);
  return c.json(hits.map((r) => ({ id: r.id, date: r.date, amountMinor: r.amountMinor, name: r.name ?? r.description, accountName: r.accountName, source: r.source })));
});

/** Logs this month's instance into the book. */
recurringRoutes.post("/recurring/:id/post", requireWriter, async (c) => {
  const db = c.get("db");
  const household = c.get("household");
  const item = await findItem(c);
  if (!item) return c.json({ error: "not found" }, 404);
  const body = await readJson<{ date?: string; accountId?: string; amount?: string; note?: string }>(c);
  const today = todayIn(household.timezone);
  const date = body.date ?? today;
  if (!isDate(date)) return c.json({ error: "date must be YYYY-MM-DD" }, 400);
  const accountId = body.accountId ?? item.accountId;
  if (!accountId || !(await ownAccount(c, accountId))) return c.json({ error: "choose the account it goes through" }, 400);
  const amount = body.amount !== undefined ? parseAmountToMinor(String(body.amount), household.currency) : item.amountMinor;
  if (amount === null || amount <= 0) return c.json({ error: "enter an amount" }, 400);
  const month = date.slice(0, 7);
  const { from, to } = monthRange(month);
  const already = await db.query.transactions.findFirst({
    where: and(eq(schema.transactions.recurringId, item.id), between(schema.transactions.date, from, to), isNull(schema.transactions.voidedAt)),
    columns: { id: true },
  });
  if (already) return c.json({ error: `${item.name} is already in the book for this month`, transactionId: already.id }, 409);

  const merchant = await resolveMerchant(db, household.id, item.name);
  const categoryId = item.categoryId ?? merchant.defaultCategoryId;
  if (item.categoryId) await rememberCategory(db, merchant.id, item.categoryId);
  const values = transactionValues({
    householdId: household.id,
    accountId,
    date,
    amountMinor: amount,
    direction: item.direction,
    merchantId: merchant.id,
    categoryId,
    description: item.name,
    note: (body.note ?? "").trim() || null,
    paidByMemberId: c.get("member").id,
    source: "recurring",
    recurringId: item.id,
  });
  await db.insert(schema.transactions).values(values);
  // A skip for the month gives way to the entry.
  await db.delete(schema.recurringMonths).where(and(eq(schema.recurringMonths.recurringId, item.id), eq(schema.recurringMonths.month, month)));
  return c.json({ id: values.id, categoryId }, 201);
});

async function mark(c: AppContext, state: "skipped" | "done") {
  const db = c.get("db");
  const item = await findItem(c);
  if (!item) return c.json({ error: "not found" }, 404);
  const body = await readJson<{ month?: string; transactionId?: string }>(c);
  const month = body.month ?? todayIn(c.get("household").timezone).slice(0, 7);
  if (!isMonth(month)) return c.json({ error: "month must be YYYY-MM" }, 400);
  if (state === "done" && body.transactionId) {
    // The entry is already in the book: link it, so it counts as this month's instance.
    const { from, to } = monthRange(month);
    const tx = await db.query.transactions.findFirst({
      where: and(eq(schema.transactions.id, body.transactionId), eq(schema.transactions.householdId, item.householdId), between(schema.transactions.date, from, to), isNull(schema.transactions.voidedAt)),
      columns: { id: true, recurringId: true },
    });
    if (!tx) return c.json({ error: "that entry is not in this month's book" }, 404);
    if (tx.recurringId && tx.recurringId !== item.id) return c.json({ error: "that entry already stands for another every-month item" }, 409);
    await db.update(schema.transactions).set({ recurringId: item.id }).where(eq(schema.transactions.id, tx.id));
    await db.delete(schema.recurringMonths).where(and(eq(schema.recurringMonths.recurringId, item.id), eq(schema.recurringMonths.month, month)));
    return c.json({ ok: true, transactionId: tx.id });
  }
  await db.delete(schema.recurringMonths).where(and(eq(schema.recurringMonths.recurringId, item.id), eq(schema.recurringMonths.month, month)));
  await db.insert(schema.recurringMonths).values({ recurringId: item.id, month, state, memberId: c.get("member").id });
  return c.json({ ok: true });
}

recurringRoutes.post("/recurring/:id/skip", requireWriter, (c) => mark(c, "skipped"));
recurringRoutes.post("/recurring/:id/done", requireWriter, (c) => mark(c, "done"));

/** Takes back a skip or a "handled" for a month; a posted entry is removed from the book instead. */
recurringRoutes.post("/recurring/:id/undo", requireWriter, async (c) => {
  const item = await findItem(c);
  if (!item) return c.json({ error: "not found" }, 404);
  const body = await readJson<{ month?: string }>(c);
  const month = body.month ?? todayIn(c.get("household").timezone).slice(0, 7);
  if (!isMonth(month)) return c.json({ error: "month must be YYYY-MM" }, 400);
  await c.get("db").delete(schema.recurringMonths).where(and(eq(schema.recurringMonths.recurringId, item.id), eq(schema.recurringMonths.month, month)));
  return c.json({ ok: true });
});
