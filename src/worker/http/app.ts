import { Hono } from "hono";
import type { HonoEnv } from "./context";
import { withDb } from "./context";
import { authRoutes } from "./routes/auth";
import { householdRoutes } from "./routes/households";

export const app = new Hono<HonoEnv>();

app.use("*", withDb);

app.get("/api/health", (c) =>
  c.json({ ok: true, authConfigured: Boolean(c.env.AUTH_SECRET), time: new Date().toISOString() }),
);

// Without AUTH_SECRET nothing can be signed safely, so fail loudly instead of running insecurely.
app.use("/api/*", async (c, next) => {
  if (!c.env.AUTH_SECRET) {
    return c.json({ error: "Server is not configured: set the AUTH_SECRET secret on the Worker." }, 503);
  }
  await next();
});
app.route("/api/auth", authRoutes);
app.route("/api", householdRoutes);

app.notFound((c) => c.json({ error: "not found" }, 404));
app.onError((err, c) => {
  console.error("unhandled error", err);
  return c.json({ error: "internal error" }, 500);
});
