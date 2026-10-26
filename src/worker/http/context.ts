import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { and, eq } from "drizzle-orm";
import { getDb, schema, type Db } from "../db";
import type { AppEnv } from "../env";
import { SESSION_COOKIE, userFromCookie, type SessionUser } from "../auth/service";

export type MemberRole = "admin" | "member" | "viewer";

export type Variables = {
  db: Db;
  user: SessionUser;
  household: {
    id: string;
    name: string;
    currency: string;
    timezone: string;
    monthStartDay: number;
    inboundToken: string;
    typicalIncomeMinor: number | null;
    typicalSpendMinor: number | null;
    aiEnabled: boolean;
  };
  member: { id: string; role: MemberRole; name: string };
};

export type HonoEnv = { Bindings: AppEnv; Variables: Variables };
export type AppContext = Context<HonoEnv>;

/** Attaches a Drizzle instance to every request. */
export const withDb: MiddlewareHandler<HonoEnv> = async (c, next) => {
  c.set("db", getDb(c.env.DB));
  await next();
};

/** Rejects requests without a valid session. */
export const requireUser: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const user = await userFromCookie(c.get("db"), c.env, getCookie(c, SESSION_COOKIE));
  if (!user) return c.json({ error: "unauthenticated" }, 401);
  c.set("user", user);
  await next();
};

/**
 * Loads the household from the `:householdId` route param and checks that the
 * signed-in user is a member of it. Every household-scoped route sits behind this,
 * so a household id in the URL is never trusted on its own.
 */
export const requireHousehold: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const householdId = c.req.param("householdId");
  if (!householdId) return c.json({ error: "missing household" }, 400);
  const db = c.get("db");
  const row = await db
    .select({
      household: schema.households,
      memberId: schema.members.id,
      role: schema.members.role,
      memberName: schema.members.name,
    })
    .from(schema.members)
    .innerJoin(schema.households, eq(schema.households.id, schema.members.householdId))
    .where(and(eq(schema.members.householdId, householdId), eq(schema.members.userId, c.get("user").id)))
    .get();
  if (!row) return c.json({ error: "not a member of this household" }, 404);
  c.set("household", row.household);
  c.set("member", { id: row.memberId, role: row.role, name: row.memberName });
  await next();
};

/**
 * A write with an Idempotency-Key header runs once per household: the first response is stored
 * and handed back to any retry of the same key. Phones replaying their offline outbox use it, so
 * a lost reply never means a payment logged twice.
 */
export const idempotent: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const key = c.req.header("idempotency-key");
  if (!key || !["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method)) return next();
  if (key.length > 80 || !/^[\w.-]+$/.test(key)) return c.json({ error: "bad idempotency key" }, 400);
  const db = c.get("db");
  const householdId = c.get("household").id;
  const seen = await db.query.idempotencyKeys.findFirst({ where: and(eq(schema.idempotencyKeys.householdId, householdId), eq(schema.idempotencyKeys.key, key)) });
  if (seen) return new Response(seen.body, { status: seen.status, headers: { "content-type": "application/json", "x-idempotent-replay": "1" } });
  await next();
  // Only a settled answer is worth keeping; a server error should be retried for real.
  if (c.res.status >= 500) return;
  const body = await c.res.clone().text();
  await db.insert(schema.idempotencyKeys).values({ householdId, key, status: c.res.status, body, createdAt: new Date().toISOString() }).onConflictDoNothing();
};

export function requireRole(...roles: MemberRole[]): MiddlewareHandler<HonoEnv> {
  return async (c, next) => {
    if (!roles.includes(c.get("member").role)) return c.json({ error: "forbidden" }, 403);
    await next();
  };
}

/** Admins and members may write; viewers are read-only. */
export const requireWriter = requireRole("admin", "member");
export const requireAdmin = requireRole("admin");

/** Reads a JSON body; a missing or malformed body reads as an empty object. */
export async function readJson<T extends object>(c: AppContext): Promise<Partial<T>> {
  return c.req.json<T>().catch(() => ({}) as Partial<T>);
}
