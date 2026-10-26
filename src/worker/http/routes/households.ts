import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { parseAmountToMinor } from "../../../shared/money";
import { schema } from "../../db";
import { dispatchParse } from "../../ingest/dispatch";
import { ensureCategories } from "../../ledger/categories";
import { inboundAddressFor, senderMatches } from "../../lib/inbound";
import { buildPreview, loadRaw, realSender } from "../../ingest/preview";
import { newId, nowIso, randomToken } from "../../lib/ids";
import type { HonoEnv } from "../context";
import { idempotent, readJson, requireAdmin, requireHousehold, requireUser, requireWriter } from "../context";
import { accountRoutes } from "./accounts";
import { goalRoutes } from "./goals";
import { homeRoutes } from "./home";
import { importRoutes } from "./imports";
import { ledgerRoutes } from "./ledger";
import { recurringRoutes } from "./recurring";

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
scoped.use("*", idempotent);

scoped.get("/", async (c) => {
  const h = c.get("household");
  return c.json({
    id: h.id,
    name: h.name,
    currency: h.currency,
    timezone: h.timezone,
    monthStartDay: h.monthStartDay,
    typicalIncomeMinor: h.typicalIncomeMinor,
    typicalSpendMinor: h.typicalSpendMinor,
    inboundAddress: inboundAddressFor(c.env.INBOUND_LOCAL_PART, h.inboundToken, c.env.INBOUND_DOMAIN),
    me: c.get("member"),
  });
});

/**
 * Household settings: name, the day of the month salary arrives (it sets "days to payday"), and a
 * typical month's income and spending so the plan works before the book has history.
 */
scoped.patch("/", requireWriter, async (c) => {
  const body = await readJson<{ name?: string; payDay?: number; typicalIncome?: string; typicalSpend?: string }>(c);
  const isAdmin = c.get("member").role === "admin";
  const patch: Partial<typeof schema.households.$inferInsert> = {};
  if (isAdmin && typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim().slice(0, 80);
  if (isAdmin && typeof body.payDay === "number" && body.payDay >= 1 && body.payDay <= 28) patch.monthStartDay = Math.round(body.payDay);
  for (const [key, column] of [["typicalIncome", "typicalIncomeMinor"], ["typicalSpend", "typicalSpendMinor"]] as const) {
    const raw = body[key];
    if (raw === undefined) continue;
    const minor = raw.trim() ? parseAmountToMinor(raw, c.get("household").currency) : null;
    if (raw.trim() && (minor === null || minor < 0)) return c.json({ error: "amounts must be positive" }, 400);
    patch[column] = minor;
  }
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

/** A forwarding check the family has dealt with, or mail from a new sender that is not a statement. */
scoped.post("/statements/:statementId/dismiss", requireWriter, async (c) => {
  const db = c.get("db");
  const row = await db.query.statementEmails.findFirst({ where: and(eq(schema.statementEmails.id, c.req.param("statementId")), eq(schema.statementEmails.householdId, c.get("household").id)) });
  if (!row) return c.json({ error: "not found" }, 404);
  if (row.status !== "forwarding" && row.status !== "quarantined") return c.json({ error: "only forwarding checks and mail from new senders can be dismissed" }, 409);
  await db
    .update(schema.statementEmails)
    .set({ status: "done", error: row.status === "quarantined" ? "set aside: not a statement" : row.error })
    .where(eq(schema.statementEmails.id, row.id));
  return c.json({ ok: true });
});

/**
 * Admin only: attach mail from a new sender to an account and read it. With `remember`, the
 * sender joins that account's list, so the next one goes straight through.
 */
scoped.post("/statements/:statementId/release", requireAdmin, async (c) => {
  const body = await readJson<{ accountId?: string; remember?: boolean }>(c);
  const db = c.get("db");
  const row = await db.query.statementEmails.findFirst({ where: and(eq(schema.statementEmails.id, c.req.param("statementId")), eq(schema.statementEmails.householdId, c.get("household").id)) });
  if (!row) return c.json({ error: "not found" }, 404);
  if (row.status !== "quarantined") return c.json({ error: "only quarantined emails can be released" }, 409);
  const accountId = body.accountId ?? row.accountId;
  if (!accountId) return c.json({ error: "choose the account this email is about" }, 400);
  const account = await db.query.accounts.findFirst({ where: and(eq(schema.accounts.id, accountId), eq(schema.accounts.householdId, row.householdId)) });
  if (!account || account.type === "person") return c.json({ error: "account not found" }, 404);
  // The sender to remember is the bank behind any forward, never a forwarder or the family's own mailbox.
  const sender = await realSender(db, row, await loadRaw(c.env, row).catch(() => null));
  let remembered = false;
  if (body.remember !== false && sender && !senderMatches(account.statementSenderPattern, sender)) {
    const pattern = [account.statementSenderPattern?.trim(), sender].filter(Boolean).join(", ");
    await db.update(schema.accounts).set({ statementSenderPattern: pattern }).where(eq(schema.accounts.id, account.id));
    remembered = true;
  }
  await db
    .update(schema.statementEmails)
    .set({ status: "received", accountId: account.id, error: null, ...(sender ? { fromAddress: sender } : {}) })
    .where(eq(schema.statementEmails.id, row.id));
  await dispatchParse(c.env, c.executionCtx, { kind: "parse-statement-email", statementEmailId: row.id, householdId: row.householdId });
  return c.json({ ok: true, remembered, sender });
});

/** A stored email as a person sees it: who sent and forwarded it, what it says, what can be read, and the likely account. */
scoped.get("/statements/:statementId/preview", async (c) => {
  const db = c.get("db");
  const row = await db.query.statementEmails.findFirst({ where: and(eq(schema.statementEmails.id, c.req.param("statementId")), eq(schema.statementEmails.householdId, c.get("household").id)) });
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(await buildPreview(c.env, db, row));
});

/** Reads an email again (after the readers improve): one that could not be read, or failed. */
scoped.post("/statements/:statementId/reread", requireWriter, async (c) => {
  const db = c.get("db");
  const row = await db.query.statementEmails.findFirst({ where: and(eq(schema.statementEmails.id, c.req.param("statementId")), eq(schema.statementEmails.householdId, c.get("household").id)) });
  if (!row) return c.json({ error: "not found" }, 404);
  if (row.status !== "unparsed" && row.status !== "failed") return c.json({ error: "only an email that was not read can be read again" }, 409);
  if (!row.accountId) return c.json({ error: "link it to an account first" }, 409);
  // A failed read may have left lines waiting; they are read afresh.
  await db.delete(schema.importLines).where(and(eq(schema.importLines.statementEmailId, row.id), eq(schema.importLines.decision, "pending")));
  await db.update(schema.statementEmails).set({ status: "received", error: null, parserKey: null, processedAt: null }).where(eq(schema.statementEmails.id, row.id));
  await dispatchParse(c.env, c.executionCtx, { kind: "parse-statement-email", statementEmailId: row.id, householdId: row.householdId });
  return c.json({ ok: true });
});

/** Admin only: the raw message as it arrived (.eml), for a look or to send in as a parser sample. */
scoped.get("/statements/:statementId/raw", requireAdmin, async (c) => {
  const row = await c.get("db").query.statementEmails.findFirst({ where: and(eq(schema.statementEmails.id, c.req.param("statementId")), eq(schema.statementEmails.householdId, c.get("household").id)) });
  if (!row) return c.json({ error: "not found" }, 404);
  const object = await c.env.RAW_MAIL.get(row.r2Key);
  if (!object) return c.json({ error: "the raw message is no longer stored" }, 404);
  return new Response(object.body, {
    headers: { "content-type": "message/rfc822", "content-disposition": `attachment; filename="statement-${row.id.slice(0, 8)}.eml"`, "cache-control": "private, no-store" },
  });
});

scoped.route("/", accountRoutes);
scoped.route("/", ledgerRoutes);
scoped.route("/", importRoutes);
scoped.route("/", goalRoutes);
scoped.route("/", recurringRoutes);
scoped.route("/", homeRoutes);

householdRoutes.route("/households/:householdId", scoped);
