import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { isDate, todayIn } from "../../../shared/dates";
import { parseAmountToMinor } from "../../../shared/money";
import { schema } from "../../db";
import { dispatchParse } from "../../ingest/dispatch";
import { ensureCategories } from "../../ledger/categories";
import { inboundAddressFor } from "../../lib/inbound";
import { newId, nowIso, randomToken } from "../../lib/ids";
import type { AppContext, HonoEnv } from "../context";
import { readJson, requireAdmin, requireHousehold, requireUser, requireWriter } from "../context";
import { bookBalance } from "../../ledger/overview";
import { transactionValues } from "../../ledger/transactions";
import { goalRoutes } from "./goals";
import { homeRoutes } from "./home";
import { importRoutes } from "./imports";
import { ledgerRoutes } from "./ledger";

export const householdRoutes = new Hono<HonoEnv>();

householdRoutes.use("*", requireUser);

/** The signed-in user and every household they belong to. */
householdRoutes.get("/me", async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  const memberships = await db
    .select({
      householdId: schema.households.id,
      name: schema.households.name,
      currency: schema.households.currency,
      role: schema.members.role,
      memberId: schema.members.id,
    })
    .from(schema.members)
    .innerJoin(schema.households, eq(schema.households.id, schema.members.householdId))
    .where(eq(schema.members.userId, user.id));
  return c.json({ user: { id: user.id, email: user.email }, households: memberships });
});

/** Creates a household; the creator becomes its first admin. */
householdRoutes.post("/households", async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  const body = await readJson<{ name?: string; currency?: string; timezone?: string; memberName?: string }>(c);
  const name = (body.name ?? "").trim();
  if (!name) return c.json({ error: "name is required" }, 400);
  const currency = (body.currency ?? "USD").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return c.json({ error: "currency must be a 3-letter code" }, 400);
  const timezone = (body.timezone ?? "UTC").trim() || "UTC";

  const householdId = newId();
  await db.insert(schema.households).values({ id: householdId, name, currency, timezone, inboundToken: randomToken(20) });
  await db.insert(schema.members).values({
    id: newId(),
    householdId,
    userId: user.id,
    name: (body.memberName ?? "").trim() || user.email.split("@")[0]!,
    email: user.email,
    role: "admin",
    joinedAt: nowIso(),
  });
  await ensureCategories(db, householdId);
  return c.json({ id: householdId }, 201);
});

const scoped = new Hono<HonoEnv>();
scoped.use("*", requireHousehold);

scoped.get("/", async (c) => {
  const h = c.get("household");
  return c.json({
    id: h.id,
    name: h.name,
    currency: h.currency,
    timezone: h.timezone,
    monthStartDay: h.monthStartDay,
    inboundAddress: inboundAddressFor(c.env.INBOUND_LOCAL_PART, h.inboundToken, c.env.INBOUND_DOMAIN),
    me: c.get("member"),
  });
});

/** Household settings: name and the day of the month salary arrives (it sets "days to payday"). */
scoped.patch("/", requireAdmin, async (c) => {
  const body = await readJson<{ name?: string; payDay?: number }>(c);
  const patch: Partial<typeof schema.households.$inferInsert> = {};
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim().slice(0, 80);
  if (typeof body.payDay === "number" && body.payDay >= 1 && body.payDay <= 28) patch.monthStartDay = Math.round(body.payDay);
  if (!Object.keys(patch).length) return c.json({ error: "nothing to change" }, 400);
  await c.get("db").update(schema.households).set(patch).where(eq(schema.households.id, c.get("household").id));
  return c.json({ ok: true });
});

scoped.get("/members", async (c) => {
  const rows = await c.get("db").query.members.findMany({
    where: eq(schema.members.householdId, c.get("household").id),
    columns: { id: true, name: true, email: true, role: true, color: true, joinedAt: true, invitedAt: true },
  });
  return c.json(rows);
});

scoped.post("/members", requireAdmin, async (c) => {
  const body = await readJson<{ email?: string; name?: string; role?: string }>(c);
  const email = (body.email ?? "").trim().toLowerCase();
  const name = (body.name ?? "").trim();
  const role = body.role ?? "member";
  if (!email.includes("@")) return c.json({ error: "email is required" }, 400);
  if (!name) return c.json({ error: "name is required" }, 400);
  if (!["admin", "member", "viewer"].includes(role)) return c.json({ error: "invalid role" }, 400);
  const db = c.get("db");
  const existingUser = await db.query.users.findFirst({ where: eq(schema.users.email, email) });
  try {
    const [row] = await db
      .insert(schema.members)
      .values({
        id: newId(),
        householdId: c.get("household").id,
        email,
        name,
        role: role as "admin" | "member" | "viewer",
        userId: existingUser?.id ?? null,
        joinedAt: existingUser ? nowIso() : null,
      })
      .returning();
    return c.json(row, 201);
  } catch {
    return c.json({ error: "that email is already a member" }, 409);
  }
});

scoped.get("/accounts", async (c) => {
  const rows = await c.get("db").query.accounts.findMany({ where: eq(schema.accounts.householdId, c.get("household").id) });
  return c.json(rows.map((r) => ({ ...r, csvMapping: r.csvMapping ? (JSON.parse(r.csvMapping) as unknown) : null })));
});

scoped.post("/accounts", requireWriter, async (c) => {
  const body = await readJson<{ name?: string; type?: string; isShared?: boolean; statementSenderPattern?: string; ownerMemberId?: string }>(c);
  const name = (body.name ?? "").trim();
  const type = body.type ?? "";
  if (!name) return c.json({ error: "name is required" }, 400);
  if (!["checking", "credit", "cash", "savings"].includes(type)) return c.json({ error: "invalid account type" }, 400);
  const [row] = await c
    .get("db")
    .insert(schema.accounts)
    .values({
      id: newId(),
      householdId: c.get("household").id,
      name,
      type: type as "checking" | "credit" | "cash" | "savings",
      isShared: body.isShared ?? true,
      statementSenderPattern: (body.statementSenderPattern ?? "").trim() || null,
      ownerMemberId: body.ownerMemberId ?? null,
    })
    .returning();
  return c.json(row, 201);
});

scoped.patch("/accounts/:accountId", requireWriter, async (c) => {
  const body = await readJson<{ name?: string; statementSenderPattern?: string; isShared?: boolean }>(c);
  const patch: Partial<typeof schema.accounts.$inferInsert> = {};
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
  if (typeof body.statementSenderPattern === "string") patch.statementSenderPattern = body.statementSenderPattern.trim() || null;
  if (typeof body.isShared === "boolean") patch.isShared = body.isShared;
  if (!Object.keys(patch).length) return c.json({ error: "nothing to change" }, 400);
  const [row] = await c
    .get("db")
    .update(schema.accounts)
    .set(patch)
    .where(and(eq(schema.accounts.id, c.req.param("accountId")), eq(schema.accounts.householdId, c.get("household").id)))
    .returning();
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(row);
});

async function ownAccount(c: AppContext, accountId: string) {
  return c.get("db").query.accounts.findFirst({ where: and(eq(schema.accounts.id, accountId), eq(schema.accounts.householdId, c.get("household").id)) });
}

/**
 * What the bank says the balance was at the end of a date (from a statement or the banking app).
 * The first figure starts the book for this account; later ones are compared with the book, and
 * a difference becomes a balance question in Decide.
 */
scoped.post("/accounts/:accountId/bank-balance", requireWriter, async (c) => {
  const account = await ownAccount(c, c.req.param("accountId"));
  if (!account) return c.json({ error: "not found" }, 404);
  const household = c.get("household");
  const body = await readJson<{ amount?: string; date?: string; startBook?: boolean }>(c);
  const date = body.date ?? todayIn(household.timezone);
  if (!isDate(date)) return c.json({ error: "date must be YYYY-MM-DD" }, 400);
  const amount = parseAmountToMinor(String(body.amount ?? ""), household.currency);
  if (amount === null) return c.json({ error: "enter the balance the bank shows" }, 400);
  const startBook = body.startBook || account.openingBalanceMinor === null || !account.openingBalanceDate;
  const patch: Partial<typeof schema.accounts.$inferInsert> = { lastStatementBalanceMinor: amount, lastStatementAt: date, balanceSnoozedFor: null };
  if (startBook) Object.assign(patch, { openingBalanceMinor: amount, openingBalanceDate: date });
  await c.get("db").update(schema.accounts).set(patch).where(eq(schema.accounts.id, account.id));
  const book = startBook ? amount : await bookBalance(c.get("db"), { id: account.id, openingBalanceMinor: account.openingBalanceMinor, openingBalanceDate: account.openingBalanceDate }, date);
  return c.json({ bankMinor: amount, bookMinor: book, matches: book === amount, startedBook: startBook });
});

/** "Wait for the next statement": hides the current balance question for this account. */
scoped.post("/accounts/:accountId/balance-snooze", requireWriter, async (c) => {
  const account = await ownAccount(c, c.req.param("accountId"));
  if (!account || !account.lastStatementAt) return c.json({ error: "not found" }, 404);
  await c.get("db").update(schema.accounts).set({ balanceSnoozedFor: account.lastStatementAt }).where(eq(schema.accounts.id, account.id));
  return c.json({ ok: true });
});

/** Adds one entry for the difference so the book matches the bank, dated on the bank's date. */
scoped.post("/accounts/:accountId/balance-correction", requireWriter, async (c) => {
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

/** Inbox of statement emails, newest first. */
scoped.get("/statements", async (c) => {
  const rows = await c
    .get("db")
    .select({
      id: schema.statementEmails.id,
      accountId: schema.statementEmails.accountId,
      accountName: schema.accounts.name,
      fromAddress: schema.statementEmails.fromAddress,
      subject: schema.statementEmails.subject,
      receivedAt: schema.statementEmails.receivedAt,
      rawSize: schema.statementEmails.rawSize,
      status: schema.statementEmails.status,
      parserKey: schema.statementEmails.parserKey,
      attachments: schema.statementEmails.attachments,
      error: schema.statementEmails.error,
      verifyCode: schema.statementEmails.verifyCode,
    })
    .from(schema.statementEmails)
    .leftJoin(schema.accounts, eq(schema.accounts.id, schema.statementEmails.accountId))
    .where(eq(schema.statementEmails.householdId, c.get("household").id))
    .orderBy(desc(schema.statementEmails.receivedAt))
    .limit(100);
  return c.json(rows.map((r) => ({ ...r, attachments: JSON.parse(r.attachments), verifyCode: r.verifyCode ? (JSON.parse(r.verifyCode) as unknown) : null })));
});

/** A forwarding check the family has dealt with. */
scoped.post("/statements/:statementId/dismiss", requireWriter, async (c) => {
  const db = c.get("db");
  const row = await db.query.statementEmails.findFirst({ where: and(eq(schema.statementEmails.id, c.req.param("statementId")), eq(schema.statementEmails.householdId, c.get("household").id)) });
  if (!row) return c.json({ error: "not found" }, 404);
  if (row.status !== "forwarding") return c.json({ error: "only forwarding checks can be dismissed" }, 409);
  await db.update(schema.statementEmails).set({ status: "done" }).where(eq(schema.statementEmails.id, row.id));
  return c.json({ ok: true });
});

/** Admin only: move a quarantined email to the queue after attaching it to an account. */
scoped.post("/statements/:statementId/release", requireAdmin, async (c) => {
  const body = await readJson<{ accountId?: string }>(c);
  const db = c.get("db");
  const row = await db.query.statementEmails.findFirst({ where: and(eq(schema.statementEmails.id, c.req.param("statementId")), eq(schema.statementEmails.householdId, c.get("household").id)) });
  if (!row) return c.json({ error: "not found" }, 404);
  if (row.status !== "quarantined") return c.json({ error: "only quarantined emails can be released" }, 409);
  await db
    .update(schema.statementEmails)
    .set({ status: "received", accountId: body.accountId ?? row.accountId, error: null })
    .where(eq(schema.statementEmails.id, row.id));
  await dispatchParse(c.env, c.executionCtx, { kind: "parse-statement-email", statementEmailId: row.id, householdId: row.householdId });
  return c.json({ ok: true });
});

scoped.route("/", ledgerRoutes);
scoped.route("/", importRoutes);
scoped.route("/", goalRoutes);
scoped.route("/", homeRoutes);

householdRoutes.route("/households/:householdId", scoped);
