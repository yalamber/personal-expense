/**
 * The long-term plan: when each goal is reached if money goes in as planned.
 *
 * Shared by the Worker (Today, Decide) and the web app (Plan, where the lever re-runs it on every
 * tap), so it is pure and works month by month in minor units.
 *
 * Rules, in the order a family would explain them:
 *  - every goal gets its own monthly amount
 *  - anything put in above the sum of those amounts goes to the first unfinished goal that has no
 *    monthly amount yet (the one waiting its turn), else to the first unfinished goal
 *  - when a goal is reached, its monthly amount rolls to the first unfinished goal in priority order
 *  - optionally the whole monthly amount rises once a year (pay rises), and targets of things that
 *    get dearer (land, building, fees) rise by a yearly percentage
 *  - money released later (a loan's installment once it is repaid) joins from its month on
 */

export type PlanGoalKind = "safety" | "purchase" | "build" | "education" | "other";

export type PlanGoal = {
  id: string;
  name: string;
  kind: PlanGoalKind;
  /** Today's price. */
  targetMinor: number;
  savedMinor: number;
  monthlyMinor: number;
  /** YYYY-MM the family wants it by, or null. */
  wantedBy: string | null;
  /** Parts in order (stages for a build); readiness is tracked on their running total. */
  parts: { name: string; amountMinor: number }[];
};

export type PlanOptions = {
  /** YYYY-MM of the first month money goes in (usually next month). */
  startMonth: string;
  /** Total going into goals each month; defaults to the sum of the goals' monthly amounts. */
  poolMinor?: number;
  /** 0.05 = the monthly amount rises 5% every 12 months. */
  growthPerYear?: number;
  /** 0.06 = targets of purchases, builds and education rise 6% a year. */
  priceRisePerYear?: number;
  /** Months to look ahead; goals not reached by then come back as not reached. */
  horizonMonths?: number;
  /**
   * Money that joins the plan later, such as a loan's installment once the loan is repaid: from
   * fromMonth (YYYY-MM) on, amountMinor a month goes to the first unfinished goal.
   */
  releases?: { fromMonth: string; amountMinor: number }[];
};

export type GoalOutcome = {
  id: string;
  name: string;
  kind: PlanGoalKind;
  /** YYYY-MM the goal is fully funded, "now" if it already is, null if not within the horizon. */
  doneMonth: string | null;
  /** What the target costs by then (today's price when prices are not rising). */
  finalTargetMinor: number;
  /** For each part, the YYYY-MM its running total is funded ("now" or null as above). */
  partsReady: (string | null)[];
  wantedBy: string | null;
  /** Months after wantedBy (negative = early), null when there is no wish or no date. */
  lateMonths: number | null;
};

export type PlanResult = {
  poolMinor: number;
  plannedMinor: number;
  /** The amount above the goals' own monthly amounts, and the goal it goes to first. */
  extraMinor: number;
  extraGoalId: string | null;
  outcomes: GoalOutcome[];
};

/** Kinds whose price is expected to rise with time. */
const RISING: PlanGoalKind[] = ["purchase", "build", "education"];

export function monthIndex(month: string): number {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return y * 12 + (m - 1);
}

export function monthAt(index: number): string {
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  return `${y}-${String(m).padStart(2, "0")}`;
}

/** Months from a to b (b later is positive). */
export function monthsBetween(a: string, b: string): number {
  return monthIndex(b) - monthIndex(a);
}

export function simulatePlan(goals: PlanGoal[], options: PlanOptions): PlanResult {
  const horizon = options.horizonMonths ?? 360;
  const growth = options.growthPerYear ?? 0;
  const rise = options.priceRisePerYear ?? 0;
  const planned = goals.reduce((sum, g) => sum + Math.max(0, g.monthlyMinor), 0);
  const pool = Math.max(0, options.poolMinor ?? planned);
  const start = monthIndex(options.startMonth);

  // Each goal's own amount; a pool smaller than the plan takes from the lowest priorities first.
  const own = goals.map((g) => Math.max(0, g.monthlyMinor));
  let shortfall = Math.max(0, planned - pool);
  for (let i = own.length - 1; i >= 0 && shortfall > 0; i--) {
    const cut = Math.min(own[i]!, shortfall);
    own[i]! -= cut;
    shortfall -= cut;
  }
  const extra = Math.max(0, pool - planned);
  const extraTarget = goals.findIndex((g, i) => own[i] === 0 && g.savedMinor < g.targetMinor);
  const extraIndex = extraTarget >= 0 ? extraTarget : goals.findIndex((g) => g.savedMinor < g.targetMinor);

  const saved = goals.map((g) => g.savedMinor);
  const doneAt: (number | null)[] = goals.map(() => null);
  const finalTarget = goals.map((g) => g.targetMinor);
  const partsAt: (number | null)[][] = goals.map((g) => g.parts.map(() => null));
  const cumulative = goals.map((g) => {
    let run = 0;
    return g.parts.map((p) => (run += p.amountMinor));
  });

  const price = (i: number, m: number) => (RISING.includes(goals[i]!.kind) ? Math.pow(1 + rise, m / 12) : 1);
  const markReady = (i: number, m: number) => {
    const p = price(i, m);
    cumulative[i]!.forEach((amount, j) => {
      if (partsAt[i]![j] === null && saved[i]! >= amount * p - 0.5) partsAt[i]![j] = m;
    });
    if (doneAt[i] === null && saved[i]! >= goals[i]!.targetMinor * p - 0.5) {
      doneAt[i] = m;
      finalTarget[i] = Math.round(goals[i]!.targetMinor * p);
    }
  };

  // Already there before any new money: month -1 reads as "now".
  goals.forEach((_, i) => markReady(i, -1));

  for (let m = 0; m < horizon; m++) {
    const open = goals.map((_, i) => i).filter((i) => doneAt[i] === null);
    if (!open.length) break;
    const f = Math.pow(1 + growth, Math.floor(m / 12));
    const give = goals.map(() => 0);
    let spare = 0;
    goals.forEach((_, i) => {
      if (doneAt[i] === null) give[i] = own[i]! * f;
      else spare += own[i]! * f;
    });
    const extraNow = extra * f;
    if (extraIndex >= 0 && doneAt[extraIndex] === null) give[extraIndex]! += extraNow;
    else spare += extraNow;
    for (const r of options.releases ?? []) if (start + m >= monthIndex(r.fromMonth)) spare += r.amountMinor;
    give[open[0]!]! += spare;
    for (const i of open) {
      saved[i]! += give[i]!;
      markReady(i, m);
    }
  }

  const label = (m: number | null) => (m === null ? null : m < 0 ? "now" : monthAt(start + m));
  return {
    poolMinor: pool,
    plannedMinor: planned,
    extraMinor: extra,
    extraGoalId: extra > 0 && extraIndex >= 0 ? goals[extraIndex]!.id : null,
    outcomes: goals.map((g, i) => {
      const done = label(doneAt[i]!);
      const doneMonth = done === "now" ? monthAt(start - 1) : done;
      return {
        id: g.id,
        name: g.name,
        kind: g.kind,
        doneMonth: done,
        finalTargetMinor: finalTarget[i]!,
        partsReady: partsAt[i]!.map(label),
        wantedBy: g.wantedBy,
        lateMonths: g.wantedBy && doneMonth ? monthsBetween(g.wantedBy, doneMonth) : null,
      };
    }),
  };
}

/** "8 years 1 month", "3 months", "1 year". */
export function spanLabel(months: number): string {
  const a = Math.abs(months);
  const y = Math.floor(a / 12);
  const m = a % 12;
  const parts: string[] = [];
  if (y) parts.push(`${y} ${y === 1 ? "year" : "years"}`);
  if (m) parts.push(`${m} ${m === 1 ? "month" : "months"}`);
  return parts.join(" ") || "0 months";
}

/** How a goal stands against its wish: "on time", "1 month early", "8 years 1 month late". */
export function lateLabel(late: number | null): string | null {
  if (late === null) return null;
  if (late === 0) return "on time";
  return late < 0 ? `${spanLabel(late)} early` : `${spanLabel(late)} late`;
}

/** "Aug 2029" from "2029-08". */
export function monthName(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[m - 1]} ${y}`;
}
