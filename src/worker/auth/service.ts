import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "../db";
import { schema } from "../db";
import type { AppEnv } from "../env";
import { sha256Hex, sign, verify } from "../lib/crypto";
import { isoInMinutes, newId, nowIso, randomToken } from "../lib/ids";
import { sendMail } from "../lib/mailer";

export const SESSION_COOKIE = "pe_session";
const MAGIC_LINK_MINUTES = 15;
const SESSION_DAYS = 30;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

/**
 * Creates a one-time magic link and emails it. Always resolves, so callers cannot probe for accounts.
 * `requestOrigin` is used for the link unless APP_ORIGIN pins a public origin.
 */
export async function requestMagicLink(db: Db, env: AppEnv, rawEmail: string, requestOrigin: string): Promise<void> {
  const email = normalizeEmail(rawEmail);
  const token = randomToken(40);
  await db.insert(schema.magicLinks).values({
    id: newId(),
    tokenHash: await sha256Hex(token),
    email,
    expiresAt: isoInMinutes(MAGIC_LINK_MINUTES),
  });
  const origin = (env.APP_ORIGIN || requestOrigin).replace(/\/+$/, "");
  const url = `${origin}/api/auth/callback?token=${encodeURIComponent(token)}`;
  await sendMail(env, {
    to: email,
    subject: "Your sign-in link",
    text: `Open this link within ${MAGIC_LINK_MINUTES} minutes to sign in:\n\n${url}\n\nIf you did not ask for it, ignore this email.`,
  });
}

/**
 * Redeems a magic-link token: marks it used, finds or creates the user, links any
 * pending member invitations for that email, and returns a signed session cookie value.
 */
export async function redeemMagicLink(db: Db, env: AppEnv, token: string): Promise<string | null> {
  const tokenHash = await sha256Hex(token);
  const link = await db.query.magicLinks.findFirst({
    where: and(eq(schema.magicLinks.tokenHash, tokenHash), isNull(schema.magicLinks.usedAt), gt(schema.magicLinks.expiresAt, nowIso())),
  });
  if (!link) return null;
  await db.update(schema.magicLinks).set({ usedAt: nowIso() }).where(eq(schema.magicLinks.id, link.id));

  let user = await db.query.users.findFirst({ where: eq(schema.users.email, link.email) });
  if (!user) {
    const inserted = await db.insert(schema.users).values({ id: newId(), email: link.email }).returning();
    user = inserted[0]!;
  }

  // Claim invitations sent to this address.
  await db
    .update(schema.members)
    .set({ userId: user.id, joinedAt: nowIso() })
    .where(and(eq(schema.members.email, user.email), isNull(schema.members.userId)));

  const sessionId = newId();
  await db.insert(schema.sessions).values({
    id: sessionId,
    userId: user.id,
    expiresAt: new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString(),
  });
  return sign(env.AUTH_SECRET, sessionId);
}

export type SessionUser = { id: string; email: string; sessionId: string };

/** Resolves a signed session cookie to its user, or null. */
export async function userFromCookie(db: Db, env: AppEnv, cookie: string | undefined): Promise<SessionUser | null> {
  if (!cookie) return null;
  const sessionId = await verify(env.AUTH_SECRET, cookie);
  if (!sessionId) return null;
  const row = await db
    .select({ sessionId: schema.sessions.id, expiresAt: schema.sessions.expiresAt, id: schema.users.id, email: schema.users.email })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(eq(schema.sessions.id, sessionId))
    .get();
  if (!row || row.expiresAt <= nowIso()) return null;
  return { id: row.id, email: row.email, sessionId: row.sessionId };
}

export async function endSession(db: Db, sessionId: string): Promise<void> {
  await db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
}

/** `secure` should be true whenever the request came in over HTTPS (always the case once deployed). */
export function sessionCookieHeader(value: string, secure: boolean, maxAgeSeconds = SESSION_DAYS * 86_400): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}
