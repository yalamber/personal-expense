/**
 * Goals and the long-term plan: what the family is saving for, in what order, what each goal is
 * made of (cost items or build stages), and the money that has gone in.
 */
import { Hono } from "hono";
import { and, asc, desc, eq, inArray, isNull, max } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { isDate, payPeriod, shiftMonth, todayIn } from "../../../shared/dates";
import { formatMinor, parseAmountToMinor } from "../../../shared/money";
import { schema } from "../../db";
import { newId, nowIso } from "../../lib/ids";
import { goalPace, loadAccountViews, loadGoals, loadPlanEvents, loanCommitments, monthlyBasis, spareAfter } from "../../ledger/overview";
import { parseRate } from "../../../shared/deposit";
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

type LoanBody = { amount?: string; rate?: string; years?: number; months?: number } | null;

/** A goal's loan plan from the request: an amount, a yearly rate and a term; null clears it. */
function loanFields(c: AppContext, loan: LoanBody | undefined): { error: string } | { values: Pick<typeof schema.goals.$inferInsert, "loanMinor" | "loanRateBp" | "loanMonths"> } | null {
  if (loan === undefined) return null;
  if (loan === null) return { values: { loanMinor: null, loanRateBp: null, loanMonths: null } };
  const amount = money(c, loan.amount);
  if (!amount) return { error: "how much would you borrow?" };
  const rateText = String(loan.rate ?? "").trim();
  const rate = rateText === "" || Number(rateText) === 0 ? 0 : parseRate(rateText);
  if (rate === null) return { error: "enter the loan's yearly interest rate, like 11" };
  const months = Math.round(loan.months ?? (loan.years ?? 0) * 12);
  if (!Number.isFinite(months) || months < 1 || months > 360) return { error: "the loan's term is 1 month to 30 years" };
  return { values: { loanMinor: amount, loanRateBp: rate, loanMonths: months } };
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

goalRoutes.get("/goals", async (c) => c.json(await loadGoals(c.get("db"), c.get("household").id, todayIn(c.get("household").timezone))));

/** Everything the plan screen needs; the simulation itself runs in the browser so the lever is instant. */
goalRoutes.get("/plan", async (c) => {
  const db = c.get("db");
  const household = c.get("household");
  const today = todayIn(household.timezone);
  const month = today.slice(0, 7);
  const [goals, basis, accounts] = await Promise.all([loadGoals(db, household.id, today), monthlyBasis(db, household.id, month), loadAccountViews(db, household.id, today)]);
  const pace = await goalPace(db, household.id, goals, today, household.monthStartDay);
  const plannedMinor = goals.filter((g) => !g.completedAt).reduce((s, g) => s + g.monthlyPlanMinor, 0);
  const loans = loanCommitments(accounts);
  return c.json({
    currency: household.currency,
    today,
    // The pay period the "in so far" figures cover.
    period: payPeriod(today, household.monthStartDay),
    startMonth: shiftMonth(month, 1),
    goals: goals.map((g) => ({ ...g, ...(pace.get(g.id) ?? { inPeriodMinor: 0, usualMonthlyMinor: null, usualPeriods: 0 }) })),
    plannedMinor,
    basis,
    loans,
    spareMinor: spareAfter(basis, plannedMinor, loans),
    events: await loadPlanEvents(db, household.id),
  });
});

// ---------------------------------------------------------------------------
// Money moments: bonuses, maturing deposits, weddings, fees
// ---------------------------------------------------------------------------

type EventBody = { name?: string; direction?: string; amount?: string; month?: string; yearly?: boolean; untilMonth?: string | null; goalId?: string | null; note?: string };

async function eventFields(c: AppContext, body: EventBody, partial: boolean): Promise<{ error: string } | { values: Partial<typeof schema.planEvents.$inferInsert> }> {
  const v: Partial<typeof schema.planEvents.$inferInsert> = {};
  if (body.name !== undefined || !partial) {
    const name = (body.name ?? "").trim().slice(0, 80);
    if (!name) return { error: "give it a name, such as Dashain bonus or the wedding" };
    v.name = name;
  }
  if (body.amount !== undefined || !partial) {
    const amount = money(c, body.amount);
    if (!amount) return { error: "enter the amount" };
    v.amountMinor = body.direction === "out" ? -amount : amount;
  } else if (body.direction === "out" || body.direction === "in") {
    return { error: "send the amount with its direction" };
  }
  if (body.month !== undefined || !partial) {
    if (!isWantedBy(body.month ?? "")) return { error: "the month must be YYYY-MM" };
    v.month = body.month!;
  }
  if (typeof body.yearly === "boolean") v.yearly = body.yearly;
  if (body.untilMonth !== undefined) {
    if (body.untilMonth && !isWantedBy(body.untilMonth)) return { error: "the last year must be YYYY-MM" };
    v.untilMonth = body.untilMonth || null;
  }
  if (body.goalId !== undefined) {
    if (body.goalId && !(await findGoal(c, body.goalId))) return { error: "goal not found" };
    v.goalId = body.goalId || null;
  }
  if (typeof body.note === "string") v.note = body.note.trim().slice(0, 200) || null;
  return { values: v };
}

goalRoutes.get("/plan-events", async (c) => c.json(await loadPlanEvents(c.get("db"), c.get("household").id)));

goalRoutes.post("/plan-events", requireWriter, async (c) => {
  const fields = await eventFields(c, await readJson<EventBody>(c), false);
  if ("error" in fields) return c.json({ error: fields.error }, 400);
  const id = newId();
  await c.get("db").insert(schema.planEvents).values({ ...fields.values, id, householdId: c.get("household").id } as typeof schema.planEvents.$inferInsert);
  return c.json({ id }, 201);
});

async function findEvent(c: AppContext) {
  return c.get("db").query.planEvents.findFirst({ where: and(eq(schema.planEvents.id, c.req.param("eventId") ?? ""), eq(schema.planEvents.householdId, c.get("household").id)) });
}

goalRoutes.patch("/plan-events/:eventId", requireWriter, async (c) => {
  const event = await findEvent(c);
  if (!event) return c.json({ error: "not found" }, 404);
  const body = await readJson<EventBody>(c);
  // Changing direction alone flips the sign of the amount already there.
  if ((body.direction === "in" || body.direction === "out") && body.amount === undefined) body.amount = String(Math.abs(event.amountMinor) / 100);
  const fields = await eventFields(c, body, true);
  if ("error" in fields) return c.json({ error: fields.error }, 400);
  if (Object.keys(fields.values).length) await c.get("db").update(schema.planEvents).set(fields.values).where(eq(schema.planEvents.id, event.id));
  return c.json({ ok: true });
});

goalRoutes.delete("/plan-events/:eventId", requireWriter, async (c) => {
  const event = await findEvent(c);
  if (!event) return c.json({ error: "not found" }, 404);
  await c.get("db").delete(schema.planEvents).where(eq(schema.planEvents.id, event.id));
  return c.json({ ok: true });
});

/** An account chosen to hold a goal's money also counts toward it, unless it already serves another goal. */
async function claimAccount(c: AppContext, accountId: string, goalId: string): Promise<void> {
  await c
    .get("db")
    .update(schema.accounts)
    .set({ goalId })
    .where(and(eq(schema.accounts.id, accountId), eq(schema.accounts.householdId, c.get("household").id), isNull(schema.accounts.goalId)));
}

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
    paid?: string;
    note?: string;
    linkedAccountId?: string | null;
    parts?: { name?: string; amount?: string }[];
    loan?: LoanBody;
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
  const paid = money(c, body.paid);
  if (monthly === null || saved === null || paid === null) return c.json({ error: "amounts must be positive" }, 400);
  const loan = loanFields(c, body.loan);
  if (loan && "error" in loan) return c.json({ error: loan.error }, 400);
  if (loan && (loan.values.loanMinor ?? 0) >= target) return c.json({ error: "the loan has to be less than the price" }, 400);
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
      ...(loan ? loan.values : {}),
    }),
    ...parts.map((p, i) => db.insert(schema.goalParts).values({ id: newId(), householdId: household.id, goalId, name: p.name, amountMinor: p.amountMinor, sort: i })),
  ];
  if (saved) {
    statements.push(
      db.insert(schema.goalContributions).values({ id: newId(), goalId, date: todayIn(household.timezone), amountMinor: saved, note: "Already saved", memberId: c.get("member").id }),
    );
  }
  if (paid) {
    statements.push(
      db.insert(schema.goalContributions).values({ id: newId(), goalId, date: todayIn(household.timezone), amountMinor: paid, note: "Already paid", kind: "paid", memberId: c.get("member").id }),
    );
  }
  await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  if (body.linkedAccountId) await claimAccount(c, body.linkedAccountId, goalId);
  return c.json({ id: goalId }, 201);
});

goalRoutes.patch("/goals/:goalId", requireWriter, async (c) => {
  const goal = await findGoal(c, c.req.param("goalId"));
  if (!goal || goal.archivedAt) return c.json({ error: "not found" }, 404);
  const body = await readJson<{ name?: string; kind?: string; target?: string; wantedBy?: string | null; monthly?: string; note?: string; linkedAccountId?: string | null; completed?: boolean; loan?: LoanBody }>(c);
  const patch: Partial<typeof schema.goals.$inferInsert> = {};
  const loan = loanFields(c, body.loan);
  if (loan && "error" in loan) return c.json({ error: loan.error }, 400);
  if (loan) {
    if ((loan.values.loanMinor ?? 0) >= goal.targetMinor) return c.json({ error: "the loan has to be less than the price" }, 400);
    Object.assign(patch, loan.values);
  }
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
    if (body.linkedAccountId) await claimAccount(c, body.linkedAccountId, goal.id);
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
  const goals = await loadGoals(db, c.get("household").id, todayIn(c.get("household").timezone));
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
      kind: schema.goalContributions.kind,
    })
    .from(schema.goalContributions)
    .leftJoin(schema.members, eq(schema.members.id, schema.goalContributions.memberId))
    .where(eq(schema.goalContributions.goalId, goal.id))
    .orderBy(desc(schema.goalContributions.date), asc(schema.goalContributions.id))
    .limit(200);
  return c.json(rows);
});

/**
 * Money toward a goal.
 *
 * Saved (the default): with a from-account it is real money leaving that account, a transfer into
 * the goal's own account when it has one, otherwise money out filed under savings (so it is
 * "saved", not "spent"). Without a from-account it only records money already set aside.
 *
 * Paid (kind "paid"): money already paid toward it, such as a baina to the land's seller. From an
 * account it is money out of that account filed under savings; with fromSaved it comes out of the
 * money recorded as saved for the goal; with neither it was paid before the book started.
 */
goalRoutes.post("/goals/:goalId/contributions", requireWriter, async (c) => {
  const db = c.get("db");
  const household = c.get("household");
  const goal = await findGoal(c, c.req.param("goalId"));
  if (!goal || goal.archivedAt) return c.json({ error: "not found" }, 404);
  const body = await readJson<{ amount?: string; date?: string; note?: string; fromAccountId?: string | null; kind?: string; fromSaved?: boolean }>(c);
  const amount = money(c, body.amount);
  if (!amount) return c.json({ error: "enter an amount" }, 400);
  const date = body.date ?? todayIn(household.timezone);
  if (!isDate(date)) return c.json({ error: "date must be YYYY-MM-DD" }, 400);
  const note = (body.note ?? "").trim() || null;
  const memberId = c.get("member").id;
  const paying = body.kind === "paid";
  let kind: (typeof schema.contributionKinds)[number] = paying ? "paid" : "saved";

  let transactionId: string | null = null;
  if (paying && body.fromSaved) {
    const [view] = (await loadGoals(db, household.id, todayIn(household.timezone), { includeArchived: true })).filter((g) => g.id === goal.id);
    if (!view || view.savedFrom !== "records") return c.json({ error: "this goal's money is in an account; choose that account instead" }, 400);
    if (amount > view.heldMinor) return c.json({ error: `only ${formatMinor(view.heldMinor, household.currency, "en-IN")} is saved for it` }, 400);
    kind = "paid_from_saved";
  } else if (body.fromAccountId) {
    const from = await db.query.accounts.findFirst({ where: and(eq(schema.accounts.id, body.fromAccountId), eq(schema.accounts.householdId, household.id)), columns: { id: true } });
    if (!from) return c.json({ error: "account not found" }, 404);
    // Money goes into the goal's own account: the one chosen for it, or one that holds its money
    // and can take deposits (not a fixed deposit mid-term). A payment goes out to the seller instead.
    const holder = paying
      ? null
      : await db.query.accounts.findFirst({
          where: and(eq(schema.accounts.householdId, household.id), eq(schema.accounts.goalId, goal.id), isNull(schema.accounts.closedAt), inArray(schema.accounts.type, ["savings", "checking", "cash", "wallet"])),
          columns: { id: true },
        });
    const target = paying ? null : goal.linkedAccountId ?? holder?.id ?? null;
    if (target && target !== from.id) {
      const t = await createTransfer(db, { householdId: household.id, fromAccountId: from.id, toAccountId: target, amountMinor: amount, date, note, memberId, goalId: goal.id, description: `To ${goal.name}` });
      transactionId = t.outId;
    } else {
      const values = transactionValues({
        householdId: household.id,
        accountId: from.id,
        date,
        amountMinor: amount,
        direction: "out",
        categoryId: await savingCategoryId(c),
        description: paying ? `Paid toward ${goal.name}` : `To ${goal.name}`,
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
  await db.insert(schema.goalContributions).values({ id, goalId: goal.id, date, amountMinor: amount, note, transactionId, memberId, kind });
  return c.json({ id, transactionId, kind }, 201);
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
