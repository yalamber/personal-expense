import { Fragment, useEffect, useMemo, useState } from "react";
import { lateLabel, monthName, simulatePlan, spanLabel, type GoalOutcome, type PlanGoal } from "../../../shared/plan";
import { minorDigits, parseAmountToMinor } from "../../../shared/money";
import { api, ApiError, paths, type Account, type Goal, type Household, type PlanData } from "../api";
import { useQuery } from "../query";
import { PageSkeleton } from "../skeleton";
import { onLinkClick } from "../router";
import { Icon, amountInput, formatMoney } from "../ui";
import { Lines, SERIES } from "../charts";
import { MomentsCard, wholeMoney } from "./planKit";
import { normalizePlan } from "../compat";

export function toPlanGoals(goals: Goal[]): PlanGoal[] {
  return goals
    .filter((g) => !g.completedAt)
    .map((g) => ({ id: g.id, name: g.name, kind: g.kind, targetMinor: g.targetMinor, savedMinor: g.savedMinor, monthlyMinor: g.monthlyPlanMinor, wantedBy: g.wantedBy, parts: g.parts.map((p) => ({ name: p.name, amountMinor: p.amountMinor })), loan: g.loan }));
}

function tidy(minor: number, currency: string): number {
  const step = 500 * 10 ** minorDigits(currency);
  return Math.max(step, Math.round(minor / step) * step);
}

/** One sentence for the whole road. */
function headline(outcomes: GoalOutcome[]): string {
  const wished = outcomes.filter((o) => o.wantedBy);
  const late = wished.filter((o) => (o.lateMonths ?? 1) > 0 || o.doneMonth === null);
  const onTime = wished.filter((o) => o.lateMonths !== null && o.lateMonths <= 0);
  if (!wished.length) return "Give a goal a wanted-by date to see whether its money is ready in time.";
  if (!late.length) return wished.length === 1 ? `${wished[0]!.name} is on time.` : "Everything is on time.";
  const first = late[0]!;
  const lateText = first.doneMonth === null ? `${first.name} is out of reach at this pace.` : `${first.name} is ${spanLabel(first.lateMonths!)} late.`;
  return onTime.length ? `${onTime[0]!.name} is on time. ${lateText}` : lateText;
}

const KIND_ICON = { safety: Icon.safety, purchase: Icon.purchase, build: Icon.build, education: Icon.education, other: Icon.other };

/** Months from one YYYY-MM to another; "now" counts as the plan's first month. */
function monthsBetween(a: string, b: string, start: string): number {
  const [x, y] = [a === "now" ? start : a, b === "now" ? start : b];
  return (Number(y.slice(0, 4)) - Number(x.slice(0, 4))) * 12 + (Number(y.slice(5, 7)) - Number(x.slice(5, 7)));
}

/** When a goal's money is ready, in words. */
function readyText(o: GoalOutcome | undefined): string {
  if (!o) return "";
  if (o.doneMonth === null) return "not within 30 years at this pace";
  if (o.doneMonth === "now") return "ready now";
  return monthName(o.doneMonth);
}

/** The chip on a goal: how it stands against the date the family wants. */
function verdict(g: Goal, o: GoalOutcome | undefined): { text: string; tone: "green" | "amber" | "grey" } | null {
  if (g.completedAt) return { text: "reached", tone: "green" };
  if (!o) return null;
  if (o.doneMonth === null) return { text: "out of reach", tone: "amber" };
  if (o.lateMonths === null) return g.wantedBy ? null : { text: "no date wanted", tone: "grey" };
  const text = lateLabel(o.lateMonths);
  return text ? { text, tone: o.lateMonths > 0 ? "amber" : "green" } : null;
}

/** What a different monthly amount does to one goal's date: "Dec 2041 → Jun 2033, 8 years 6 months sooner". */
function diffText(before: GoalOutcome | undefined, after: GoalOutcome | undefined, start: string): string {
  if (!before || !after) return "";
  if (before.doneMonth === null && after.doneMonth === null) return "still out of reach";
  if (before.doneMonth === null) return `within reach: ${readyText(after)}`;
  if (after.doneMonth === null) return "out of reach";
  if (before.doneMonth === after.doneMonth) return `${readyText(after)}, no change`;
  const months = monthsBetween(after.doneMonth, before.doneMonth, start);
  return `${readyText(before)} → ${readyText(after)}, ${spanLabel(Math.abs(months))} ${months > 0 ? "sooner" : "later"}`;
}

/**
 * One goal as a card: how far along it is, when its money is ready against the date wanted, what
 * goes into it each month, and the way to its own page. A late goal says so and offers ways there.
 */
function GoalCard({ household, goal: g, outcome: o, index, count, canWrite, onMove }: { household: Household; goal: Goal; outcome: GoalOutcome | undefined; index: number; count: number; canWrite: boolean; onMove: (delta: -1 | 1) => void }) {
  const cur = household.currency;
  const Kind = g.kind === "build" ? Icon.house : KIND_ICON[g.kind];
  const v = verdict(g, o);
  const target = o?.finalTargetMinor ?? g.targetMinor;
  const pct = Math.min(100, Math.round((g.savedMinor / Math.max(1, g.targetMinor)) * 100));
  const late = !g.completedAt && Boolean(o) && (o!.doneMonth === null || (o!.lateMonths ?? 0) > 0);
  const href = `/h/${household.id}/plan/goals/${g.id}`;
  const start = g.kind === "build" && g.parts.length >= 2 && o ? (o.partsReady[1] ?? null) : undefined;
  return (
    <article className={`card goal-card ${late ? "late" : ""}`} aria-label={g.name}>
      <div className="head">
        <span className="kind" aria-hidden="true">
          <Kind />
        </span>
        <h3>
          <a href={href} onClick={onLinkClick}>
            {g.name}
          </a>
        </h3>
        {g.completedAt && <span className="pill green">reached</span>}
        {canWrite && count > 1 && (
          <span className="order">
            <button type="button" className="icon-button" aria-label={`Move ${g.name} earlier`} disabled={index === 0} onClick={() => onMove(-1)}>
              <span aria-hidden="true">↑</span>
            </button>
            <button type="button" className="icon-button" aria-label={`Move ${g.name} later`} disabled={index === count - 1} onClick={() => onMove(1)}>
              <span aria-hidden="true">↓</span>
            </button>
          </span>
        )}
      </div>
      <div className="row between" style={{ alignItems: "baseline", gap: 8 }}>
        <span>
          <span className="mono" style={{ fontWeight: 600 }}>{formatMoney(g.savedMinor, cur)}</span>{" "}
          <span className="small muted">
            of {formatMoney(target, cur)}
            {target !== g.targetMinor ? " at the risen price" : ""}
          </span>
        </span>
        <span className="mono small muted">{pct}%</span>
      </div>
      <div className="progress" aria-hidden="true">
        <div style={{ width: `${pct}%` }} />
      </div>
      {!g.completedAt && (
        <dl className="goal-facts">
          <dt>Money ready</dt>
          <dd className={late ? "late" : ""}>
            {readyText(o)}
            {g.wantedBy ? ` · wanted by ${monthName(g.wantedBy)}` : ""}
            {v && (
              <>
                {" "}
                <span className={`pill ${v.tone}`}>{v.text}</span>
              </>
            )}
          </dd>
          <dt>Each month</dt>
          <dd>{g.monthlyPlanMinor ? `${formatMoney(g.monthlyPlanMinor, cur)} of its own` : "nothing of its own yet: it moves only on extra money put into the plan, or on what rolls on when a goal is reached"}</dd>
          {g.loan && (
            <>
              <dt>Borrowing</dt>
              <dd>
                {formatMoney(g.loan.amountMinor, cur)} when it is bought{o?.loan?.emiMinor ? `, then ${wholeMoney(o.loan.emiMinor, cur)} a month` : ""}
              </dd>
            </>
          )}
          {start !== undefined && (
            <>
              <dt>Building starts</dt>
              <dd>{start === null ? "not yet in sight" : start === "now" ? "can start now" : monthName(start)}</dd>
            </>
          )}
          {g.paidMinor > 0 && (
            <>
              <dt>Already paid</dt>
              <dd>{formatMoney(g.paidMinor, cur)}</dd>
            </>
          )}
        </dl>
      )}
      {late && (
        <a className="ways" href={href} onClick={onLinkClick}>
          Ways to get there{g.wantedBy ? ` by ${monthName(g.wantedBy)}` : " sooner"} <Icon.next size={16} />
        </a>
      )}
    </article>
  );
}

/**
 * Plan: the goals as cards in the order they are funded, one lever (what goes in each month) that
 * shows what it does to every date before anything is saved, the timeline of what happens when,
 * the guesses that move the dates, and the money moments.
 */
export function Plan({ household, version, onChanged }: { household: Household; version: number; onChanged: () => void }) {
  const pq = useQuery<PlanData>(paths.plan(household.id), [version]);
  const aq = useQuery<Account[]>(paths.accounts(household.id), [version]);
  const data = useMemo(() => (pq.data ? normalizePlan(pq.data) : null), [pq.data]);
  const accounts = useMemo(() => (aq.data ?? []).filter((x) => !x.closedAt), [aq.data]);
  const [withReleases, setWithReleases] = useState(true);
  const [pool, setPool] = useState<number | null>(null);
  const [custom, setCustom] = useState("");
  const [rise, setRise] = useState(0);
  const [growth, setGrowth] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cur = household.currency;
  const canWrite = household.me.role !== "viewer";

  // A fresh plan from the server puts the lever back where the plan is.
  useEffect(() => setPool(null), [data]);

  const goals = useMemo(() => (data ? toPlanGoals(data.goals) : []), [data]);
  const current = data?.plannedMinor ?? 0;
  const amount = pool ?? current;
  const releases = useMemo(() => (withReleases ? (data?.loans.releases ?? []) : []), [data, withReleases]);
  const options = useMemo(() => (data ? { startMonth: data.startMonth, priceRisePerYear: rise, growthPerYear: growth, releases, events: data.events } : null), [data, rise, growth, releases]);
  const sim = useMemo(() => (options && goals.length ? simulatePlan(goals, { ...options, poolMinor: amount, trajectory: true }) : null), [options, goals, amount]);
  // The plan as it is today, to say what a different amount changes.
  const base = useMemo(() => (options && goals.length && amount !== current ? simulatePlan(goals, { ...options, poolMinor: current }) : null), [options, goals, amount, current]);

  if (pq.error && !data) return <div className="error">{pq.error}</div>;
  if (!data) return <PageSkeleton kind="plan" />;

  const spare = data.spareMinor;
  const picks = [current];
  if (spare && spare > 0) for (const f of [0.25, 0.5, 0.85]) picks.push(current + tidy(spare * f, cur));
  else for (const f of [0.2, 0.4]) picks.push(current + tidy(Math.max(current, 10_000 * 10 ** minorDigits(cur)) * f, cur));
  const levers = [...new Set(picks)];

  async function adopt() {
    if (!sim || !sim.extraGoalId) return;
    const goal = data!.goals.find((g) => g.id === sim.extraGoalId);
    if (!goal) return;
    setBusy(true);
    try {
      await api.updateGoal(household.id, goal.id, { monthly: amountInput(goal.monthlyPlanMinor + sim.extraMinor, cur) });
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not change the plan");
    } finally {
      setBusy(false);
    }
  }

  async function move(id: string, delta: -1 | 1) {
    const ids = data!.goals.map((g) => g.id);
    const i = ids.indexOf(id);
    const j = i + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    try {
      await api.orderGoals(household.id, ids);
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not reorder");
    }
  }

  if (!data.goals.length) {
    return (
      <>
        <div className="stack" style={{ gap: 6 }}>
          <span className="eyebrow">The long view</span>
          <h1>What is the family saving for?</h1>
          <p className="muted" style={{ margin: 0, maxWidth: 560 }}>
            Land, building a house, college, a cushion for a bad month. Add the goals in the order you want them, and the plan shows when each one lands.
          </p>
        </div>
        {canWrite && (
          <div>
            <a className="button" href={`/h/${household.id}/plan/new`} onClick={onLinkClick}>
              <Icon.plus /> Add the first goal
            </a>
          </div>
        )}
      </>
    );
  }

  const outcomes = sim?.outcomes ?? [];
  const byId = new Map(outcomes.map((o) => [o.id, o]));
  const baseById = new Map((base?.outcomes ?? []).map((o) => [o.id, o]));
  const active = data.goals.filter((g) => !g.completedAt);
  const total = outcomes.reduce((s, o) => s + o.finalTargetMinor, 0);
  const changed = amount !== current;
  const extraTo = sim?.extraGoalId ? data.goals.find((g) => g.id === sim.extraGoalId)?.name : null;
  const noMonthly = active.length > 0 && active.every((g) => !g.monthlyPlanMinor);

  // The timeline: each goal's money ready (and a build's start), loans paid off, money moments.
  type Mile = { key: string; order: string; when: string; late: boolean; done: boolean; href: string; title: string; chip: string | null; chipTone: string; note: string; Icon: (p: { size?: number }) => React.ReactElement };
  const miles: Mile[] = [];
  for (const o of outcomes) {
    const g = data.goals.find((x) => x.id === o.id)!;
    const KindIcon = KIND_ICON[g.kind];
    if (g.kind === "build" && g.parts.length >= 2) {
      const ready = o.partsReady[1] ?? null;
      miles.push({
        key: `${g.id}-start`,
        order: ready === null ? "9999-99" : ready === "now" ? "0000-00" : ready,
        when: ready === null ? "later" : ready === "now" ? "now" : monthName(ready),
        late: false,
        done: ready === "now",
        href: `/h/${household.id}/plan/goals/${g.id}`,
        title: `${g.name}: building can start`,
        chip: null,
        chipTone: "grey",
        note: `${g.parts[0]!.name} and ${g.parts[1]!.name.toLowerCase()} paid for: ${formatMoney(g.parts[0]!.amountMinor + g.parts[1]!.amountMinor, cur)} of ${formatMoney(g.targetMinor, cur)}.`,
        Icon: Icon.build,
      });
    }
    const late = o.lateMonths !== null && o.lateMonths > 0;
    miles.push({
      key: g.id,
      order: o.doneMonth === null ? "9999-99" : o.doneMonth === "now" ? "0000-00" : o.doneMonth,
      when: o.doneMonth === null ? "not yet" : o.doneMonth === "now" ? "now" : monthName(o.doneMonth),
      late: late || o.doneMonth === null,
      done: o.doneMonth === "now",
      href: `/h/${household.id}/plan/goals/${g.id}`,
      title: g.kind === "build" ? `${g.name}: moving in` : `${g.name}: money ready`,
      chip: o.doneMonth === null ? "out of reach" : o.lateMonths === null ? (g.wantedBy ? null : "no date set") : lateLabel(o.lateMonths),
      chipTone: o.doneMonth === null || late ? "amber" : o.lateMonths === null ? "grey" : "green",
      note: `${formatMoney(o.finalTargetMinor, cur)}${o.finalTargetMinor !== g.targetMinor ? " at the risen price" : ""}${g.wantedBy ? ` · wanted by ${monthName(g.wantedBy)}` : ""}`,
      Icon: g.kind === "build" ? Icon.house : KindIcon,
    });
  }

  // A loan paid off is a milestone too: its installment joins the plan from the next month.
  for (const r of data.loans.releases) {
    miles.push({
      key: `loan-${r.accountId}`,
      order: r.fromMonth,
      when: monthName(r.fromMonth),
      late: false,
      done: false,
      href: `/h/${household.id}/settings/accounts`,
      title: `${r.name} paid off`,
      chip: withReleases ? `+${wholeMoney(r.amountMinor, cur)} a month` : null,
      chipTone: "green",
      note: withReleases ? "Its installment goes to the first unfinished goal from here on." : "Counted as spending money once paid off; see If things change.",
      Icon: Icon.unlock,
    });
  }

  // A goal bought with a loan: the purchase, then the month the loan is repaid and its installment frees up.
  for (const o of outcomes) {
    if (!o.loan || !o.loan.startMonth) continue;
    const g = data.goals.find((x) => x.id === o.id)!;
    const bought = o.doneMonth === "now" ? data.startMonth : o.doneMonth!;
    const i = miles.findIndex((m) => m.key === g.id);
    if (i >= 0) {
      miles[i] = {
        ...miles[i]!,
        title: `${g.name}: bought, ${formatMoney(o.loan.amountMinor, cur)} borrowed`,
        note: `${formatMoney(o.needMinor, cur)} saved first, then ${wholeMoney(o.loan.emiMinor, cur)} a month until ${monthName(o.loan.endMonth!)} (${wholeMoney(o.loan.totalInterestMinor, cur)} interest), out of what goes into the later goals.`,
      };
    }
    const end = o.loan.endMonth!;
    miles.push({
      key: `loan-goal-${g.id}`,
      order: end,
      when: monthName(end),
      late: false,
      done: false,
      href: `/h/${household.id}/plan/goals/${g.id}`,
      title: `${g.name} loan repaid`,
      chip: `+${wholeMoney(o.loan.emiMinor, cur)} a month`,
      chipTone: "green",
      note: `Bought ${bought === data.startMonth && o.doneMonth === "now" ? "now" : `in ${monthName(bought)}`}; from here its installment goes back into the goals.`,
      Icon: Icon.unlock,
    });
  }

  // Money moments: the next time each one happens.
  for (const e of data.events) {
    let next = e.month;
    if (e.yearly) while (next < data.startMonth) next = `${Number(next.slice(0, 4)) + 1}${next.slice(4)}`;
    if (next < data.startMonth || (e.untilMonth && next > e.untilMonth)) continue;
    const into = e.goalId ? data.goals.find((g) => g.id === e.goalId)?.name : null;
    miles.push({
      key: `moment-${e.id}`,
      order: next,
      when: monthName(next),
      late: false,
      done: false,
      href: `/h/${household.id}/plan#moments-h`,
      title: e.name,
      chip: `${e.amountMinor > 0 ? "+" : "−"}${formatMoney(Math.abs(e.amountMinor), cur)}${e.yearly ? " every year" : ""}`,
      chipTone: e.amountMinor > 0 ? "green" : "amber",
      note: e.amountMinor > 0 ? `Into ${into ?? "the first goal still being saved for"}.` : "Out of what goes into the goals; the dates after it move later.",
      Icon: e.amountMinor > 0 ? Icon.unlock : Icon.other,
    });
  }

  // The road reads as a timeline: earliest first, whatever the funding order.
  miles.sort((a, b) => a.order.localeCompare(b.order));
  const road = sim?.trajectory ? roadChart(sim.trajectory, data.goals, outcomes) : null;

  return (
    <>
      <section className="stack" style={{ gap: 8 }} aria-label="The plan">
        <div className="row between" style={{ alignItems: "flex-end" }}>
          <div className="stack" style={{ gap: 6 }}>
            <span className="eyebrow">The long view{rise ? ` · prices rising ${Math.round(rise * 100)}% a year` : ""}</span>
            <h1>Plan</h1>
          </div>
          {canWrite && (
            <a className="button secondary" href={`/h/${household.id}/plan/new`} onClick={onLinkClick}>
              <Icon.plus /> Add a goal
            </a>
          )}
        </div>
        <p className="muted" style={{ margin: 0, maxWidth: "52em" }}>
          {active.length === 1 ? "One goal" : `${active.length} goals`}, {formatMoney(total, cur)} in all. {formatMoney(current, cur)} a month goes in, to the goals in this order; when one is reached, its money rolls on to the next.
        </p>
        <p className="verdict" aria-live="polite" style={{ margin: 0 }}>
          {headline(outcomes)}
        </p>
      </section>

      <section className="goal-grid" aria-label="The goals, in the order they are funded">
        {data.goals.map((g, i) => (
          <GoalCard key={g.id} household={household} goal={g} outcome={byId.get(g.id)} index={i} count={data.goals.length} canWrite={canWrite} onMove={(d) => void move(g.id, d)} />
        ))}
      </section>
      {noMonthly && (
        <div className="note small" role="status">
          None of the goals has a monthly amount yet, so nothing goes in and Today sets nothing aside. Try an amount below and make it the plan, or open a goal and give it a month of its own.
        </div>
      )}
      {error && <div className="error">{error}</div>}

      <section className="card stack lever-card" aria-labelledby="lever-h">
        <div className="row between">
          <h2 id="lever-h">What goes in each month</h2>
          <span className="small muted">
            {spare !== null && spare > 0
              ? `about ${formatMoney(spare, cur)} a month is spare after spending${data.loans.monthlyMinor ? " and loan installments" : ""}${data.basis.source === "typical" ? ", by your usual month" : ""}`
              : data.basis.source !== "none"
                ? "no spare money in a usual month yet"
                : "two months in the book show what is spare"}
          </span>
        </div>
        <div className="row" style={{ alignItems: "baseline", gap: 10 }}>
          <span className="display figure">{formatMoney(amount, cur)}</span>
          <span className="muted">a month{changed ? ` · the plan today is ${formatMoney(current, cur)}` : " · the plan today"}</span>
        </div>
        <div className="chips" role="group" aria-label="Monthly amount">
          {levers.map((v) => (
            <button key={v} type="button" className="chip" aria-pressed={amount === v} onClick={() => { setPool(v); setCustom(""); }}>
              {formatMoney(v, cur)}
              {v === current ? " · today" : ""}
            </button>
          ))}
          <label className="sr-only" htmlFor="lever-custom">Another amount</label>
          <input
            id="lever-custom"
            inputMode="decimal"
            placeholder="Other"
            value={custom}
            style={{ width: 110, borderRadius: 999, minHeight: 44 }}
            onChange={(e) => {
              setCustom(e.target.value);
              const m = parseAmountToMinor(e.target.value, cur);
              if (m !== null && m >= 0) setPool(m);
            }}
          />
        </div>
        {changed ? (
          <>
            <div className="diff" aria-live="polite" aria-label="What this amount changes">
              {active.map((g) => (
                <Fragment key={g.id}>
                  <span className="name">{g.name}</span>
                  <span>{diffText(baseById.get(g.id), byId.get(g.id), data.startMonth)}</span>
                </Fragment>
              ))}
            </div>
            <div className="actions">
              {canWrite && sim?.extraGoalId && (
                <button type="button" disabled={busy} onClick={adopt}>
                  Make {formatMoney(amount, cur)} a month our plan
                </button>
              )}
              <button type="button" className="quiet" onClick={() => { setPool(null); setCustom(""); }}>
                Back to today's plan
              </button>
            </div>
            <span className="small muted">Nothing changes until you make it the plan{extraTo ? `; the extra goes to ${extraTo} first` : ""}. The cards and the timeline already show this amount.</span>
          </>
        ) : (
          <span className="small muted">Try a bigger amount: every goal above shows its new date, and the timeline below moves. Nothing changes until you make it the plan.</span>
        )}
      </section>

      <section className="card road" aria-labelledby="road-h">
        <div className="row between" style={{ paddingBottom: 18 }}>
          <h2 id="road-h">When things happen</h2>
          <span className="small muted">at {formatMoney(amount, cur)} a month</span>
        </div>
        {miles.map((m, i) => (
          <div key={m.key} className="mile">
            <span className="when" style={{ color: m.late ? "var(--marigold-deep)" : undefined }}>{m.when}</span>
            <span className="rail" aria-hidden="true">
              <span className={`node ${m.done ? "done" : m.late ? "late" : ""}`}>
                <m.Icon />
              </span>
              {i < miles.length - 1 && <span className="line" />}
            </span>
            <div className="body">
              <div className="row" style={{ gap: 10 }}>
                <h3>
                  <a href={m.href} onClick={onLinkClick}>
                    {m.title}
                  </a>
                </h3>
                {m.chip && <span className={`pill ${m.chipTone}`}>{m.chip}</span>}
              </div>
              <span className="small" style={{ color: "var(--ink-soft)" }}>{m.note}</span>
            </div>
          </div>
        ))}
        {road && (
          <details className="how" style={{ marginBottom: 12 }}>
            <summary>Month by month: what each goal holds as the money goes in</summary>
            <div className="stack" style={{ paddingTop: 10 }}>
              <Lines series={road.series} labels={road.labels} markers={road.markers} currency={cur} format={(v) => formatMoney(v, cur)} height={220} caption="Show as a table" head="Month" />
              {road.hidden > 0 && <span className="small muted">The first five goals are drawn; {road.hidden} more are in the table.</span>}
            </div>
          </details>
        )}
      </section>

      <section className="card stack" aria-labelledby="assume-h">
        <div className="row between">
          <h2 id="assume-h">If things change</h2>
          <span className="small muted">guesses that move the dates above; nothing is saved</span>
        </div>
        <div className="assume">
          <span className="label">
            <strong>If land and building get dearer</strong>
            <span className="small muted">Far-off goals need more than today's price.</span>
          </span>
          <div className="chips" role="group" aria-label="Prices rise each year">
            {[0, 0.04, 0.06, 0.08].map((r) => (
              <button key={r} type="button" className="chip" aria-pressed={rise === r} onClick={() => setRise(r)}>
                {r === 0 ? "Today's prices" : `${Math.round(r * 100)}% a year`}
              </button>
            ))}
          </div>
          <span className="label">
            <strong>If our income rises</strong>
            <span className="small muted">Pay rises put more into the plan each year.</span>
          </span>
          <div className="chips" role="group" aria-label="Income rises each year">
            {[0, 0.05, 0.08, 0.1].map((r) => (
              <button key={r} type="button" className="chip" aria-pressed={growth === r} onClick={() => setGrowth(r)}>
                {r === 0 ? "No rise" : `${Math.round(r * 100)}% a year`}
              </button>
            ))}
          </div>
          {data.loans.releases.length > 0 && (
            <>
              <span className="label">
                <strong>When a loan is paid off</strong>
                <span className="small muted">Its installment can go into the goals instead of everyday spending.</span>
              </span>
              <div className="chips" role="group" aria-label="Paid-off installments">
                <button type="button" className="chip" aria-pressed={withReleases} onClick={() => setWithReleases(true)}>
                  Into the goals
                </button>
                <button type="button" className="chip" aria-pressed={!withReleases} onClick={() => setWithReleases(false)}>
                  Keep for spending
                </button>
              </div>
            </>
          )}
        </div>
      </section>

      <MomentsCard household={household} plan={data} accounts={accounts} onChanged={onChanged} />
    </>
  );
}

/**
 * The simulator's month-by-month figures, thinned to a drawable number of points, one line per
 * goal (the first five) with a marker where each lands.
 */
function roadChart(t: { months: string[]; saved: number[][] }, goals: Goal[], outcomes: GoalOutcome[]) {
  const n = t.months.length;
  const stepSize = Math.max(1, Math.ceil(n / 60));
  const idx: number[] = [];
  for (let i = 0; i < n; i += stepSize) idx.push(i);
  if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);
  const labels = idx.map((i) => monthName(t.months[i]!));
  const active = goals.filter((g) => !g.completedAt);
  const shown = active.slice(0, 5);
  const series = shown.map((g, gi) => ({ name: g.name, color: SERIES[gi % SERIES.length]!, values: idx.map((i) => t.saved[active.indexOf(g)]?.[i] ?? null) }));
  const markers = shown.flatMap((g, gi) => {
    const o = outcomes.find((x) => x.id === g.id);
    if (!o?.doneMonth || o.doneMonth === "now") return [];
    const at = t.months.indexOf(o.doneMonth);
    if (at < 0) return [];
    const near = idx.reduce((best, i) => (Math.abs(i - at) < Math.abs(best - at) ? i : best), idx[0]!);
    return [{ index: idx.indexOf(near), label: `${g.name} · ${monthName(o.doneMonth)}`, short: monthName(o.doneMonth), series: gi }];
  });
  return { labels, series, markers, hidden: Math.max(0, active.length - shown.length) };
}
