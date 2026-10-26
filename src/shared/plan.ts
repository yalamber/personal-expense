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
 *  - a goal can be part-borrowed: only the rest (the down payment) is saved, and once it is bought
 *    the loan's installment comes out of the money going into the goals until the loan is repaid
 *  - money moments: one-off or yearly money in (a bonus, an FD maturing) goes to a chosen goal or
 *    the first unfinished one; money out (a wedding, an admission fee) comes out of what goes
 *    into the goals, carried into the next months if one month cannot cover it
 */
import { emi } from "./loan";

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
  /** Part of the price borrowed when it is bought: only the rest is saved. */
  loan?: { amountMinor: number; rateBp: number; months: number } | null;
};

/** Money that comes in or goes out once (or every year from its month): + in, − out. */
export type PlanEvent = { id?: string; name: string; month: string; amountMinor: number; yearly?: boolean; untilMonth?: string | null; goalId?: string | null };

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
  /** Also return what each goal holds month by month, for drawing the road. */
  trajectory?: boolean;
  /** Bonuses, maturing deposits, weddings, fees: see PlanEvent. */
  events?: PlanEvent[];
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
  /** What has to be saved: the price, less any loan. */
  needMinor: number;
  /** The loan once it is bought: its installment, first and last month, interest, and any month it is more than the plan's money. */
  loan: { amountMinor: number; emiMinor: number; startMonth: string | null; endMonth: string | null; totalInterestMinor: number; shortMinor: number } | null;
};

export type PlanResult = {
  poolMinor: number;
  plannedMinor: number;
  /** The amount above the goals' own monthly amounts, and the goal it goes to first. */
  extraMinor: number;
  extraGoalId: string | null;
  outcomes: GoalOutcome[];
  /** With trajectory: months[0] is the month before money starts; saved[g][i] is goal g's money at the end of months[i]. */
  trajectory?: { months: string[]; saved: number[][] };
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

/** Does a money moment fall in this month? Yearly ones repeat on their month until untilMonth. */
function eventIn(e: PlanEvent, monthIdx: number): boolean {
  const first = monthIndex(e.month);
  if (monthIdx < first) return false;
  if (e.untilMonth && monthIdx > monthIndex(e.untilMonth)) return false;
  return e.yearly ? (monthIdx - first) % 12 === 0 : monthIdx === first;
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

  // Month -1 is "now", at today's price; the first month of saving is a twelfth of a year on.
  const price = (i: number, m: number) => (RISING.includes(goals[i]!.kind) ? Math.pow(1 + rise, Math.max(0, m + 1) / 12) : 1);
  const loanOf = (i: number) => {
    const l = goals[i]!.loan;
    return l && l.amountMinor > 0 && l.months > 0 ? l : null;
  };
  // What has to be saved: the price (risen by then), less a loan of a fixed sum.
  const need = (i: number, m: number) => Math.max(0, goals[i]!.targetMinor * price(i, m) - (loanOf(i)?.amountMinor ?? 0));
  const emiOf = goals.map((_, i) => {
    const l = loanOf(i);
    return l ? emi(l.amountMinor, l.rateBp, l.months) : 0;
  });
  const shortOf = goals.map(() => 0);
  /** A bought goal's loan is being repaid in month m: from the month after it is bought, for its term. */
  const paying = (i: number, m: number) => {
    const l = loanOf(i);
    const from = doneAt[i] ?? null;
    return Boolean(l && from !== null && m > from && m <= from + l.months);
  };
  const markReady = (i: number, m: number) => {
    const p = price(i, m);
    const lent = loanOf(i)?.amountMinor ?? 0;
    cumulative[i]!.forEach((amount, j) => {
      // A loan pays for the last stretch: earlier parts are ready on the savings alone.
      if (partsAt[i]![j] === null && saved[i]! >= Math.min(amount * p, Math.max(0, goals[i]!.targetMinor * p - lent)) - 0.5) partsAt[i]![j] = m;
    });
    if (doneAt[i] === null && saved[i]! >= need(i, m) - 0.5) {
      doneAt[i] = m;
      finalTarget[i] = Math.round(goals[i]!.targetMinor * p);
    }
  };

  // Already there before any new money: month -1 reads as "now".
  goals.forEach((_, i) => markReady(i, -1));
  const track: number[][] = options.trajectory ? [saved.map((v) => Math.round(v))] : [];

  const events = options.events ?? [];
  let owing = 0;
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
    // The extra goes to the first unfinished goal with no monthly amount of its own (the one waiting
    // its turn), else to the first unfinished goal: worked out again each month as goals finish.
    const waitingNow = open.find((i) => own[i] === 0) ?? open[0]!;
    give[waitingNow]! += extra * f;
    for (const r of options.releases ?? []) if (start + m >= monthIndex(r.fromMonth)) spare += r.amountMinor;
    give[open[0]!]! += spare;

    // Money out (an EMI on something already bought, a wedding, money still owed from an earlier
    // month) comes out of what would go into the goals, from the last in line first.
    let out = owing;
    owing = 0;
    goals.forEach((_, i) => {
      if (paying(i, m)) out += emiOf[i]!;
    });
    for (const e of events) {
      if (!eventIn(e, start + m)) continue;
      if (e.amountMinor >= 0) {
        const to = e.goalId ? goals.findIndex((g) => g.id === e.goalId) : -1;
        give[to >= 0 && doneAt[to] === null ? to : open[0]!]! += e.amountMinor;
      } else out += -e.amountMinor;
    }
    for (let k = open.length - 1; k >= 0 && out > 0; k--) {
      const cut = Math.min(give[open[k]!]!, out);
      give[open[k]!]! -= cut;
      out -= cut;
    }
    if (out > 0) {
      // More going out than coming into the goals this month. An installment is paid from everyday
      // money (noted against its goal); a one-off is carried into the next months.
      let emis = 0;
      goals.forEach((_, i) => {
        if (paying(i, m)) emis += emiOf[i]!;
      });
      const shortEmi = Math.min(out, emis);
      if (shortEmi > 0) {
        goals.forEach((_, i) => {
          if (paying(i, m)) shortOf[i] = Math.max(shortOf[i]!, Math.round((shortEmi * emiOf[i]!) / emis));
        });
      }
      owing = out - shortEmi;
    }
    // A goal takes only what it still needs; the rest rolls on to the next unfinished goal.
    let carry = 0;
    open.forEach((i, k) => {
      give[i]! += carry;
      carry = 0;
      const room = Math.max(0, need(i, m) - saved[i]!);
      if (give[i]! > room && k < open.length - 1) {
        carry = give[i]! - room;
        give[i] = room;
      }
    });
    for (const i of open) {
      saved[i]! += give[i]!;
      markReady(i, m);
    }
    if (options.trajectory) track.push(saved.map((v) => Math.round(v)));
  }

  const label = (m: number | null) => (m === null ? null : m < 0 ? "now" : monthAt(start + m));
  return {
    poolMinor: pool,
    plannedMinor: planned,
    extraMinor: extra,
    extraGoalId: extra > 0 && extraIndex >= 0 ? goals[extraIndex]!.id : null,
    trajectory: options.trajectory
      ? { months: track.map((_, i) => monthAt(start + i - 1)), saved: goals.map((_, g) => track.map((row) => row[g]!)) }
      : undefined,
    outcomes: goals.map((g, i) => {
      const done = label(doneAt[i]!);
      const doneMonth = done === "now" ? monthAt(start - 1) : done;
      const l = loanOf(i);
      const loanStart = l && doneAt[i] !== null ? monthAt(start + doneAt[i]! + 1) : null;
      return {
        id: g.id,
        name: g.name,
        kind: g.kind,
        doneMonth: done,
        finalTargetMinor: finalTarget[i]!,
        partsReady: partsAt[i]!.map(label),
        wantedBy: g.wantedBy,
        lateMonths: g.wantedBy && doneMonth ? monthsBetween(g.wantedBy, doneMonth) : null,
        needMinor: Math.round(Math.max(0, finalTarget[i]! - (l?.amountMinor ?? 0))),
        loan: l
          ? {
              amountMinor: l.amountMinor,
              emiMinor: emiOf[i]!,
              startMonth: loanStart,
              endMonth: loanStart ? monthAt(monthIndex(loanStart) + l.months - 1) : null,
              totalInterestMinor: Math.max(0, emiOf[i]! * l.months - l.amountMinor),
              shortMinor: shortOf[i]!,
            }
          : null,
      };
    }),
  };
}

export type Ways = {
  /** The goal's own monthly amount that makes its wanted-by date, the others unchanged; null if no amount can. */
  monthlyMinor: number | null;
  /** When it lands if the spare money also goes into the plan. */
  withSpare: { poolMinor: number; doneMonth: string | null } | null;
  /** Still missing at the wanted-by date at the current plan; borrowing this much closes it. */
  gapAtDateMinor: number | null;
  /** When it lands at the current plan: the date to move it to. */
  currentMonth: string | null;
};

/**
 * Three ways to reach a goal that is late or out of reach: put more into it each month, add the
 * spare money to the plan, or borrow what is still missing at the date (or move the date).
 */
export function waysToReach(goals: PlanGoal[], goalId: string, options: PlanOptions & { spareMinor?: number | null; stepMinor?: number }): Ways {
  const i = goals.findIndex((g) => g.id === goalId);
  if (i < 0) return { monthlyMinor: null, withSpare: null, gapAtDateMinor: null, currentMonth: null };
  const g = goals[i]!;
  const step = Math.max(1, options.stepMinor ?? 1);
  const planned = goals.reduce((s, x) => s + Math.max(0, x.monthlyMinor), 0);
  const basePool = options.poolMinor ?? planned;
  const base = simulatePlan(goals, { ...options, trajectory: true });
  const outcome = base.outcomes[i]!;
  const currentMonth = outcome.doneMonth === "now" ? null : outcome.doneMonth;
  const onTime = (r: PlanResult) => {
    const o = r.outcomes[i]!;
    return o.doneMonth === "now" || (o.lateMonths !== null && o.lateMonths <= 0);
  };

  let monthlyMinor: number | null = null;
  if (g.wantedBy && monthIndex(g.wantedBy) >= monthIndex(options.startMonth)) {
    const withMonthly = (amount: number) => {
      const next = goals.map((x, k) => (k === i ? { ...x, monthlyMinor: amount } : x));
      return simulatePlan(next, { ...options, poolMinor: basePool - Math.max(0, g.monthlyMinor) + amount });
    };
    let hi = Math.max(step, Math.ceil(Math.max(0, g.targetMinor * 3 - g.savedMinor) / step) * step);
    if (onTime(withMonthly(hi))) {
      let lo = 0;
      while (hi - lo > step) {
        const mid = Math.floor((lo + hi) / 2 / step) * step;
        if (mid <= lo) break;
        if (onTime(withMonthly(mid))) hi = mid;
        else lo = mid;
      }
      monthlyMinor = hi;
    }
  }

  const spare = options.spareMinor ?? 0;
  const withSpare = spare > 0 ? { poolMinor: basePool + spare, doneMonth: simulatePlan(goals, { ...options, poolMinor: basePool + spare }).outcomes[i]!.doneMonth } : null;

  let gapAtDateMinor: number | null = null;
  if (g.wantedBy && base.trajectory) {
    const months = base.trajectory.months;
    let k = months.indexOf(g.wantedBy);
    if (k < 0) k = monthIndex(g.wantedBy) < monthIndex(months[0]!) ? 0 : months.length - 1;
    const savedThen = base.trajectory.saved[i]![k] ?? g.savedMinor;
    const elapsed = Math.max(0, monthsBetween(options.startMonth, g.wantedBy));
    const p = RISING.includes(g.kind) ? Math.pow(1 + (options.priceRisePerYear ?? 0), elapsed / 12) : 1;
    gapAtDateMinor = Math.max(0, Math.round(g.targetMinor * p - savedThen));
  }
  return { monthlyMinor, withSpare, gapAtDateMinor, currentMonth };
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
