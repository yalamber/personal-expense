/**
 * Goals and the long-term plan: what the family is saving for, in what order, what each goal is
 * made of (cost items or build stages), and the money that has gone in.
 */
import { Hono } from "hono";
import { and, asc, desc, eq, isNull, max } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { isDate, shiftMonth, todayIn } from "../../../shared/dates";
import { parseAmountToMinor } from "../../../shared/money";
import { schema } from "../../db";
import { newId, nowIso } from "../../lib/ids";
import { loadGoals, monthlyBasis } from "../../ledger/overview";
import { createTransfer, transactionValues } from "../../ledger/transactions";
import type { AppContext, HonoEnv } from "../context";
import { readJson, requireWriter } from "../context";

export const goalRoutes = new Hono<HonoEnv>();

const KINDS = schema.goalKinds;
type Kind = (typeof KINDS)[number];

function isWantedBy(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function money(c: AppContext, value: unknown): number | null {
  if (value === undefined || value === null || String(value).trim() === "") return 0;
  const minor = parseAmountToMinor(String(value), c.get("household").currency);
  return minor === null || minor < 0 ? null : minor;
}

async function findGoal(c: AppContext, goalId: string) {
  return c.get("db").query.goals.findFirst({ where: and(eq(schema.goals.id, goalId), eq(schema.goals.householdId, c.get("household").id)) });
}

/** Keeps a goal's target equal to the sum of its parts whenever it has parts. */
async function syncTarget(c: AppContext, goalId: string): Promise<void> {
  const db = c.get("db");
  const parts = await db.query.goalParts.findMany({ where: eq(schema.goalParts.goalId, goalId) });
  if (!parts.length) return;
  await db.update(schema.goals).set({ targetMinor: parts.reduce((s, p) => s + p.amountMinor, 0) }).where(eq(schema.goals.id, goalId));
}

async function savingCategoryId(c: AppContext): Promise<string | null> {
  const rows = await c.get("db").query.categories.findMany({ where: and(eq(schema.categories.householdId, c.get("household").id), eq(schema.categories.kind, "saving")) });
  return (rows.find((r) => /goal/i.test(r.name)) ?? rows.find((r) => r.parentId) ?? rows[0])?.id ?? null;
}

goalRoutes.get("/goals", async (c) => c.json(await loadGoals(c.get("db"), c.get("household").id)));

/** Everything the plan screen needs; the simulation itself runs in the browser so the lever is instant. */
goalRoutes.get("/plan", async (c) => {
  const db = c.get("db");
  const household = c.get("household");
  const month = todayIn(household.timezone).slice(0, 7);
  const [goals, basis] = await Promise.all([loadGoals(db, household.id), monthlyBasis(db, household.id, month)]);
  const plannedMinor = goals.filter((g) => !g.completedAt).reduce((s, g) => s + g.monthlyPlanMinor, 0);
  return c.json({
    currency: household.currency,
    startMonth: shiftMonth(month, 1),
    goals,
    plannedMinor,
    basis,
    spareMinor: basis.months ? basis.incomeMinor - basis.spendMinor - plannedMinor : null,
  });
});

goalRoutes.post("/goals", requireWriter, async (c) => {
  const db = c.get("db");
  const household = c.get("household");
  const body = await readJson<{
    name?: string;
    kind?: string;
    target?: string;
    wantedBy?: string;
    monthly?: string;
    saved?: string;
    note?: string;
    linkedAccountId?: string | null;
    parts?: { name?: string; amount?: string }[];
  }>(c);
  const name = (body.name ?? "").trim().slice(0, 80);
  if (!name) return c.json({ error: "give the goal a name" }, 400);
  const kind: Kind = (KINDS as readonly string[]).includes(body.kind ?? "") ? (body.kind as Kind) : "other";
  if (body.wantedBy && !isWantedBy(body.wantedBy)) return c.json({ error: "wanted-by must be YYYY-MM" }, 400);

  const parts: { name: string; amountMinor: number }[] = [];
  for (const p of body.parts ?? []) {
    const partName = (p.name ?? "").trim().slice(0, 80);
    const amount = money(c, p.amount);
    if (!partName && !amount) continue;
    if (!partName || amount === null) return c.json({ error: "each part needs a name and an amount" }, 400);
    parts.push({ name: partName, amountMinor: amount });
  }
  const typedTarget = money(c, body.target);
  const target = parts.length ? parts.reduce((s, p) => s + p.amountMinor, 0) : typedTarget;
  if (!target) return c.json({ error: "how much does it cost? add an amount or its parts" }, 400);
  const monthly = money(c, body.monthly);
  const saved = money(c, body.saved);
  if (monthly === null || saved === null) return c.json({ error: "amounts must be positive" }, 400);
  if (body.linkedAccountId) {
    const a = await db.query.accounts.findFirst({ where: and(eq(schema.accounts.id, body.linkedAccountId), eq(schema.accounts.householdId, household.id)), columns: { id: true } });
    if (!a) return c.json({ error: "account not found" }, 404);
  }

  const [last] = await db.select({ p: max(schema.goals.priority) }).from(schema.goals).where(and(eq(schema.goals.householdId, household.id), isNull(schema.goals.archivedAt)));
  const goalId = newId();
  const statements: BatchItem<"sqlite">[] = [
    db.insert(schema.goals).values({
      id: goalId,
      householdId: household.id,
      name,
      kind,
      targetMinor: target,
      targetDate: body.wantedBy ? `${body.wantedBy}-01` : null,
      priority: (last?.p ?? -1) + 1,
      monthlyPlanMinor: monthly,
      note: (body.note ?? "").trim() || null,
      linkedAccountId: body.linkedAccountId ?? null,
    }),
    ...parts.map((p, i) => db.insert(schema.goalParts).values({ id: newId(), householdId: household.id, goalId, name: p.name, amountMinor: p.amountMinor, sort: i })),
  ];
  if (saved) {
    statements.push(
      db.insert(schema.goalContributions).values({ id: newId(), goalId, date: todayIn(household.timezone), amountMinor: saved, note: "Already saved", memberId: c.get("member").id }),
    );
  }
  await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  return c.json({ id: goalId }, 201);
});

goalRoutes.patch("/goals/:goalId", requireWriter, async (c) => {
  const goal = await findGoal(c, c.req.param("goalId"));
  if (!goal || goal.archivedAt) return c.json({ error: "not found" }, 404);
  const body = await readJson<{ name?: string; kind?: string; target?: string; wantedBy?: string | null; monthly?: string; note?: string; linkedAccountId?: string | null; completed?: boolean }>(c);
  const patch: Partial<typeof schema.goals.$inferInsert> = {};
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim().slice(0, 80);
  if (typeof body.kind === "string" && (KINDS as readonly string[]).includes(body.kind)) patch.kind = body.kind as Kind;
  if (body.wantedBy === null) patch.targetDate = null;
  else if (typeof body.wantedBy === "string") {
    if (!isWantedBy(body.wantedBy)) return c.json({ error: "wanted-by must be YYYY-MM" }, 400);
    patch.targetDate = `${body.wantedBy}-01`;
  }
  if (body.monthly !== undefined) {
    const m = money(c, body.monthly);
    if (m === null) return c.json({ error: "enter a positive monthly amount" }, 400);
    patch.monthlyPlanMinor = m;
  }
  if (body.target !== undefined) {
    const hasParts = await c.get("db").query.goalParts.findFirst({ where: eq(schema.goalParts.goalId, goal.id), columns: { id: true } });
    if (hasParts) return c.json({ error: "this goal's target is the sum of its parts; change the parts instead" }, 409);
    const t = money(c, body.target);
    if (!t) return c.json({ error: "enter the target amount" }, 400);
    patch.targetMinor = t;
  }
  if (typeof body.note === "string") patch.note = body.note.trim() || null;
  if (body.linkedAccountId !== undefined) {
    if (body.linkedAccountId) {
      const a = await c.get("db").query.accounts.findFirst({ where: and(eq(schema.accounts.id, body.linkedAccountId), eq(schema.accounts.householdId, c.get("household").id)), columns: { id: true } });
      if (!a) return c.json({ error: "account not found" }, 404);
    }
    patch.linkedAccountId = body.linkedAccountId || null;
  }
  if (typeof body.completed === "boolean") patch.completedAt = body.completed ? nowIso() : null;
  if (Object.keys(patch).length) await c.get("db").update(schema.goals).set(patch).where(eq(schema.goals.id, goal.id));
  return c.json({ ok: true });
});

/** Goals are archived, never deleted, so their history stays explainable. */
goalRoutes.delete("/goals/:goalId", requireWriter, async (c) => {
  const goal = await findGoal(c, c.req.param("goalId"));
  if (!goal || goal.archivedAt) return c.json({ error: "not found" }, 404);
  await c.get("db").update(schema.goals).set({ archivedAt: nowIso() }).where(eq(schema.goals.id, goal.id));
  return c.json({ ok: true });
});

/** Sets the priority order: the first id is funded first. */
goalRoutes.put("/goals/order", requireWriter, async (c) => {
  const db = c.get("db");
  const body = await readJson<{ ids?: string[] }>(c);
  const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === "string") : [];
  const goals = await loadGoals(db, c.get("household").id);
  const known = new Set(goals.map((g) => g.id));
  if (!ids.length || ids.some((id) => !known.has(id))) return c.json({ error: "unknown goal in the order" }, 400);
  const rest = goals.map((g) => g.id).filter((id) => !ids.includes(id));
  const order = [...ids, ...rest];
  const statements = order.map((id, i) => db.update(schema.goals).set({ priority: i }).where(eq(schema.goals.id, id)));
  await db.batch(statements as [(typeof statements)[number], ...typeof statements]);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Parts: cost items for a purchase, stages for a build
// ---------------------------------------------------------------------------

goalRoutes.post("/goals/:goalId/parts", requireWriter, async (c) => {
  const goal = await findGoal(c, c.req.param("goalId"));
  if (!goal || goal.archivedAt) return c.json({ error: "not found" }, 404);
  const body = await readJson<{ name?: string; amount?: string }>(c);
  const name = (body.name ?? "").trim().slice(0, 80);
  const amount = money(c, body.amount);
  if (!name || !amount) return c.json({ error: "a part needs a name and an amount" }, 400);
  const db = c.get("db");
  const existing = await db.query.goalParts.findMany({ where: eq(schema.goalParts.goalId, goal.id) });
  // The first part of a goal that had a typed target keeps the rest of that target as its own part.
  const rows: (typeof schema.goalParts.$inferInsert)[] = [];
  if (!existing.length && goal.targetMinor > 0) rows.push({ id: newId(), householdId: goal.householdId, goalId: goal.id, name: "Everything else", amountMinor: goal.targetMinor, sort: 0 });
  rows.push({ id: newId(), householdId: goal.householdId, goalId: goal.id, name, amountMinor: amount, sort: existing.length + rows.length });
  for (const r of rows) await db.insert(schema.goalParts).values(r);
  await syncTarget(c, goal.id);
  return c.json({ id: rows[rows.length - 1]!.id }, 201);
});

async function findPart(c: AppContext, partId: string) {
  return c.get("db").query.goalParts.findFirst({ where: and(eq(schema.goalParts.id, partId), eq(schema.goalParts.householdId, c.get("household").id)) });
}

goalRoutes.patch("/goal-parts/:partId", requireWriter, async (c) => {
  const part = await findPart(c, c.req.param("partId"));
  if (!part) return c.json({ error: "not found" }, 404);
  const body = await readJson<{ name?: string; amount?: string; done?: boolean; sort?: number }>(c);
  const patch: Partial<typeof schema.goalParts.$inferInsert> = {};
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim().slice(0, 80);
  if (body.amount !== undefined) {
    const amount = money(c, body.amount);
    if (!amount) return c.json({ error: "enter an amount" }, 400);
    patch.amountMinor = amount;
  }
  if (typeof body.done === "boolean") patch.doneAt = body.done ? nowIso() : null;
  if (typeof body.sort === "number") patch.sort = Math.round(body.sort);
  await c.get("db").update(schema.goalParts).set(patch).where(eq(schema.goalParts.id, part.id));
  await syncTarget(c, part.goalId);
  return c.json({ ok: true });
});

goalRoutes.delete("/goal-parts/:partId", requireWriter, async (c) => {
  const part = await findPart(c, c.req.param("partId"));
  if (!part) return c.json({ error: "not found" }, 404);
  const db = c.get("db");
  const siblings = await db.query.goalParts.findMany({ where: eq(schema.goalParts.goalId, part.goalId) });
  if (siblings.length === 1) {
    // Removing the last part leaves the goal with a typed target of the same amount.
    await db.batch([db.delete(schema.goalParts).where(eq(schema.goalParts.id, part.id)), db.update(schema.goals).set({ targetMinor: part.amountMinor }).where(eq(schema.goals.id, part.goalId))]);
    return c.json({ ok: true });
  }
  await db.delete(schema.goalParts).where(eq(schema.goalParts.id, part.id));
  await syncTarget(c, part.goalId);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Money in
// ---------------------------------------------------------------------------

goalRoutes.get("/goals/:goalId/contributions", async (c) => {
  const goal = await findGoal(c, c.req.param("goalId"));
  if (!goal) return c.json({ error: "not found" }, 404);
  const rows = await c
    .get("db")
    .select({
      id: schema.goalContributions.id,
      date: schema.goalContributions.date,
      amountMinor: schema.goalContributions.amountMinor,
      note: schema.goalContributions.note,
      memberName: schema.members.name,
      transactionId: schema.goalContributions.transactionId,
    })
    .from(schema.goalContributions)
    .leftJoin(schema.members, eq(schema.members.id, schema.goalContributions.memberId))
    .where(eq(schema.goalContributions.goalId, goal.id))
    .orderBy(desc(schema.goalContributions.date), asc(schema.goalContributions.id))
    .limit(200);
  return c.json(rows);
});

/**
 * Money toward a goal. With a from-account it is also real money leaving that account: a transfer
 * into the goal's own account when it has one, otherwise money out filed under savings (so it is
 * "saved", not "spent"). Without a from-account it only records money already set aside.
 */
goalRoutes.post("/goals/:goalId/contributions", requireWriter, async (c) => {
  const db = c.get("db");
  const household = c.get("household");
  const goal = await findGoal(c, c.req.param("goalId"));
  if (!goal || goal.archivedAt) return c.json({ error: "not found" }, 404);
  const body = await readJson<{ amount?: string; date?: string; note?: string; fromAccountId?: string | null }>(c);
  const amount = money(c, body.amount);
  if (!amount) return c.json({ error: "enter an amount" }, 400);
  const date = body.date ?? todayIn(household.timezone);
  if (!isDate(date)) return c.json({ error: "date must be YYYY-MM-DD" }, 400);
  const note = (body.note ?? "").trim() || null;
  const memberId = c.get("member").id;

  let transactionId: string | null = null;
  if (body.fromAccountId) {
    const from = await db.query.accounts.findFirst({ where: and(eq(schema.accounts.id, body.fromAccountId), eq(schema.accounts.householdId, household.id)), columns: { id: true } });
    if (!from) return c.json({ error: "account not found" }, 404);
    if (goal.linkedAccountId && goal.linkedAccountId !== from.id) {
      const t = await createTransfer(db, { householdId: household.id, fromAccountId: from.id, toAccountId: goal.linkedAccountId, amountMinor: amount, date, note, memberId, goalId: goal.id, description: `To ${goal.name}` });
      transactionId = t.outId;
    } else {
      const values = transactionValues({
        householdId: household.id,
        accountId: from.id,
        date,
        amountMinor: amount,
        direction: "out",
        categoryId: await savingCategoryId(c),
        description: `To ${goal.name}`,
        note,
        paidByMemberId: memberId,
        source: "manual",
        goalId: goal.id,
      });
      await db.insert(schema.transactions).values(values);
      transactionId = values.id!;
    }
  }
  const id = newId();
  await db.insert(schema.goalContributions).values({ id, goalId: goal.id, date, amountMinor: amount, note, transactionId, memberId });
  return c.json({ id, transactionId }, 201);
});

goalRoutes.delete("/goal-contributions/:id", requireWriter, async (c) => {
  const db = c.get("db");
  const row = await db
    .select({ id: schema.goalContributions.id, transactionId: schema.goalContributions.transactionId })
    .from(schema.goalContributions)
    .innerJoin(schema.goals, eq(schema.goals.id, schema.goalContributions.goalId))
    .where(and(eq(schema.goalContributions.id, c.req.param("id")), eq(schema.goals.householdId, c.get("household").id)))
    .get();
  if (!row) return c.json({ error: "not found" }, 404);
  const statements: BatchItem<"sqlite">[] = [db.delete(schema.goalContributions).where(eq(schema.goalContributions.id, row.id))];
  if (row.transactionId) {
    const tx = await db.query.transactions.findFirst({ where: eq(schema.transactions.id, row.transactionId) });
    const where = tx?.transferPairId ? eq(schema.transactions.transferPairId, tx.transferPairId) : eq(schema.transactions.id, row.transactionId);
    statements.push(db.update(schema.transactions).set({ voidedAt: nowIso() }).where(and(where, eq(schema.transactions.householdId, c.get("household").id))));
  }
  await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  return c.json({ ok: true });
});
