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
import { MailError } from "../../lib/mailer";
import type { HonoEnv } from "../context";
import { requireUser } from "../context";

export const authRoutes = new Hono<HonoEnv>();

const isHttps = (url: string) => new URL(url).protocol === "https:";

authRoutes.post("/magic-link", async (c) => {
  const body = await c.req.json<{ email?: string }>().catch(() => ({}) as { email?: string });
  const email = body.email ?? "";
  if (!isValidEmail(email)) return c.json({ error: "enter a valid email address" }, 400);
  try {
    await requestMagicLink(c.get("db"), c.env, email, new URL(c.req.url).origin);
  } catch (err) {
    const code = err instanceof MailError ? err.code : undefined;
    const hint =
      code === "E_SENDER_NOT_VERIFIED" || code === "E_NO_BINDING"
        ? "The app's sending address is not set up in Cloudflare Email Routing yet."
        : "If this is a new address, it may first need to be verified under Email Routing, Destination addresses, in Cloudflare.";
    return c.json({ error: `The sign-in email could not be sent. ${hint}` }, 502);
  }
  // Same answer whether or not the address is known.
  return c.json({ ok: true });
});

authRoutes.get("/callback", async (c) => {
  const token = c.req.query("token") ?? "";
  const cookieValue = token ? await redeemMagicLink(c.get("db"), c.env, token) : null;
  if (!cookieValue) return c.redirect("/login?error=expired");
  c.header("Set-Cookie", sessionCookieHeader(cookieValue, isHttps(c.req.url)));
  return c.redirect("/");
});

authRoutes.post("/logout", requireUser, async (c) => {
  await endSession(c.get("db"), c.get("user").sessionId);
  c.header("Set-Cookie", sessionCookieHeader("", isHttps(c.req.url), 0));
  return c.json({ ok: true });
});

authRoutes.get("/session", async (c) => {
  // Cheap check used by the web app on load; the cookie is validated by requireUser elsewhere.
  return c.json({ hasCookie: Boolean(getCookie(c, SESSION_COOKIE)) });
});
