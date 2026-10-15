import { Hono } from "hono";
import type { HonoEnv } from "./context";
import { withDb } from "./context";
import { authRoutes } from "./routes/auth";
import { householdRoutes } from "./routes/households";

export const app = new Hono<HonoEnv>();

app.use("*", withDb);

app.get("/api/health", (c) =>
  c.json({ ok: true, authSecret: c.env.AUTH_SECRET ? "worker-secret" : "generated", time: new Date().toISOString() }),
);
app.route("/api/auth", authRoutes);
app.route("/api", householdRoutes);

app.notFound((c) => c.json({ error: "not found" }, 404));
app.onError((err, c) => {
  console.error("unhandled error", err);
  return c.json({ error: "internal error" }, 500);
});
