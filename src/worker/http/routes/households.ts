import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import { schema } from "../../db";
import { dispatchParse } from "../../ingest/dispatch";
import { inboundAddressFor } from "../../lib/inbound";
import { newId, nowIso, randomToken } from "../../lib/ids";
import type { HonoEnv } from "../context";
import { readJson, requireAdmin, requireHousehold, requireUser, requireWriter } from "../context";

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
  return c.json(rows);
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
  const [row] = await c
    .get("db")
    .update(schema.accounts)
    .set(patch)
    .where(eq(schema.accounts.id, c.req.param("accountId")))
    .returning();
  if (!row || row.householdId !== c.get("household").id) return c.json({ error: "not found" }, 404);
  return c.json(row);
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
    })
    .from(schema.statementEmails)
    .leftJoin(schema.accounts, eq(schema.accounts.id, schema.statementEmails.accountId))
    .where(eq(schema.statementEmails.householdId, c.get("household").id))
    .orderBy(desc(schema.statementEmails.receivedAt))
    .limit(100);
  return c.json(rows.map((r) => ({ ...r, attachments: JSON.parse(r.attachments) })));
});

/** Admin only: move a quarantined email to the queue after attaching it to an account. */
scoped.post("/statements/:statementId/release", requireAdmin, async (c) => {
  const body = await readJson<{ accountId?: string }>(c);
  const db = c.get("db");
  const row = await db.query.statementEmails.findFirst({ where: eq(schema.statementEmails.id, c.req.param("statementId")) });
  if (!row || row.householdId !== c.get("household").id) return c.json({ error: "not found" }, 404);
  if (row.status !== "quarantined") return c.json({ error: "only quarantined emails can be released" }, 409);
  await db
    .update(schema.statementEmails)
    .set({ status: "received", accountId: body.accountId ?? row.accountId, error: null })
    .where(eq(schema.statementEmails.id, row.id));
  await dispatchParse(c.env, c.executionCtx, { kind: "parse-statement-email", statementEmailId: row.id, householdId: row.householdId });
  return c.json({ ok: true });
});

householdRoutes.route("/households/:householdId", scoped);
