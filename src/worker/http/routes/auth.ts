import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import {
  endSession,
  isValidEmail,
  redeemMagicLink,
  requestMagicLink,
  SESSION_COOKIE,
  sessionCookieHeader,
} from "../../auth/service";
import type { HonoEnv } from "../context";
import { requireUser } from "../context";

export const authRoutes = new Hono<HonoEnv>();

authRoutes.post("/magic-link", async (c) => {
  const body = await c.req.json<{ email?: string }>().catch(() => ({}) as { email?: string });
  const email = body.email ?? "";
  if (!isValidEmail(email)) return c.json({ error: "enter a valid email address" }, 400);
  await requestMagicLink(c.get("db"), c.env, email);
  // Same answer whether or not the address is known.
  return c.json({ ok: true });
});

authRoutes.get("/callback", async (c) => {
  const token = c.req.query("token") ?? "";
  const cookieValue = token ? await redeemMagicLink(c.get("db"), c.env, token) : null;
  if (!cookieValue) return c.redirect("/login?error=expired");
  c.header("Set-Cookie", sessionCookieHeader(cookieValue, c.env));
  return c.redirect("/");
});

authRoutes.post("/logout", requireUser, async (c) => {
  await endSession(c.get("db"), c.get("user").sessionId);
  c.header("Set-Cookie", sessionCookieHeader("", c.env, 0));
  return c.json({ ok: true });
});

authRoutes.get("/session", async (c) => {
  // Cheap check used by the web app on load; the cookie is validated by requireUser elsewhere.
  return c.json({ hasCookie: Boolean(getCookie(c, SESSION_COOKIE)) });
});
