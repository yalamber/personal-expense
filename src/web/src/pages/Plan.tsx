import { useCallback, useEffect, useMemo, useState } from "react";
import { lateLabel, monthName, simulatePlan, spanLabel, type GoalOutcome, type PlanGoal } from "../../../shared/plan";
import { minorDigits, parseAmountToMinor } from "../../../shared/money";
import { api, ApiError, type Goal, type Household, type PlanData } from "../api";
import { onLinkClick } from "../router";
import { Icon, amountInput, formatMoney } from "../ui";

export function toPlanGoals(goals: Goal[]): PlanGoal[] {
  return goals
    .filter((g) => !g.completedAt)
    .map((g) => ({ id: g.id, name: g.name, kind: g.kind, targetMinor: g.targetMinor, savedMinor: g.savedMinor, monthlyMinor: g.monthlyPlanMinor, wantedBy: g.wantedBy, parts: g.parts.map((p) => ({ name: p.name, amountMinor: p.amountMinor })) }));
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
  if (!outcomes.length) return "Add what you are saving for, and the road appears here.";
  if (!wished.length) return "Here is when each goal lands. Add a wanted-by date to see if that is soon enough.";
  if (!late.length) return wished.length === 1 ? `${wished[0]!.name} lands on time.` : "Everything lands on time.";
  const first = late[0]!;
  const lateText = first.doneMonth === null ? `${first.name} is out of reach at this amount.` : `${first.name} is ${spanLabel(first.lateMonths!)} late.`;
  return onTime.length ? `${onTime[0]!.name} lands on time. ${lateText}` : `${lateText}`;
}

const KIND_ICON = { safety: Icon.safety, purchase: Icon.purchase, build: Icon.build, education: Icon.education, other: Icon.other };

/** Plan: the goals as one road, in the order they are funded, with one lever — money per month. */
export function Plan({ household, version, onChanged }: { household: Household; version: number; onChanged: () => void }) {
  const [data, setData] = useState<PlanData | null>(null);
  const [pool, setPool] = useState<number | null>(null);
  const [custom, setCustom] = useState("");
  const [rise, setRise] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cur = household.currency;
  const canWrite = household.me.role !== "viewer";

  const load = useCallback(async () => {
    try {
      const d = await api.plan(household.id);
      setData(d);
      setPool(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the plan");
    }
  }, [household.id]);

  useEffect(() => {
    void load();
  }, [load, version]);

  const goals = useMemo(() => (data ? toPlanGoals(data.goals) : []), [data]);
  const current = data?.plannedMinor ?? 0;
  const amount = pool ?? current;
  const sim = useMemo(() => (data && goals.length ? simulatePlan(goals, { startMonth: data.startMonth, poolMinor: amount, priceRisePerYear: rise }) : null), [data, goals, amount, rise]);

  if (error && !data) return <div className="error">{error}</div>;
  if (!data) return <p className="muted">Drawing the road…</p>;

  const spare = data.spareMinor;
  const options = [current];
  if (spare && spare > 0) for (const f of [0.25, 0.5, 0.85]) options.push(current + tidy(spare * f, cur));
  else for (const f of [0.2, 0.4]) options.push(current + tidy(Math.max(current, 10_000 * 10 ** minorDigits(cur)) * f, cur));
  const levers = [...new Set(options)];

  async function adopt() {
    if (!sim || !sim.extraGoalId) return;
    const goal = data!.goals.find((g) => g.id === sim.extraGoalId);
    if (!goal) return;
    setBusy(true);
    try {
      await api.updateGoal(household.id, goal.id, { monthly: amountInput(goal.monthlyPlanMinor + sim.extraMinor, cur) });
      await load();
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
      await load();
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
  const total = outcomes.reduce((s, o) => s + o.finalTargetMinor, 0);
  type Mile = { key: string; order: string; when: string; late: boolean; done: boolean; goalId: string; title: string; chip: string | null; chipTone: string; note: string; Icon: (p: { size?: number }) => React.ReactElement };
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
        goalId: g.id,
        title: `${g.name}: building can start`,
        chip: null,
        chipTone: "grey",
        note: `${g.parts[0]!.name}, then ${g.parts[1]!.name.toLowerCase()}, paid for: ${formatMoney(g.parts[0]!.amountMinor + g.parts[1]!.amountMinor, cur)} of ${formatMoney(g.targetMinor, cur)}.`,
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
      goalId: g.id,
      title: g.kind === "build" ? `${g.name}: moving in` : g.name,
      chip: o.doneMonth === null ? "out of reach" : o.lateMonths === null ? (g.wantedBy ? null : "no date set") : lateLabel(o.lateMonths),
      chipTone: o.doneMonth === null || late ? "amber" : o.lateMonths === null ? "grey" : "green",
      note: `${formatMoney(g.savedMinor, cur)} of ${formatMoney(o.finalTargetMinor, cur)}${o.finalTargetMinor !== g.targetMinor ? " at the risen price" : ""} · ${g.monthlyPlanMinor ? `${formatMoney(g.monthlyPlanMinor, cur)} a month of its own` : "gets money when it is its turn"}${g.wantedBy ? ` · wanted by ${monthName(g.wantedBy)}` : ""}`,
      Icon: g.kind === "build" ? Icon.house : KindIcon,
    });
  }

  // The road reads as a timeline: earliest first, whatever the funding order.
  miles.sort((a, b) => a.order.localeCompare(b.order));

  return (
    <>
      <section className="stack" style={{ gap: 10 }} aria-label="The plan in one sentence">
        <span className="eyebrow">The long view · {rise ? `prices rising ${Math.round(rise * 100)}% a year` : "at today's prices"}</span>
        <h1 aria-live="polite" className="display" style={{ fontSize: "clamp(28px, 4vw, 40px)", maxWidth: "20em" }}>
          {headline(outcomes)}
        </h1>
        <p className="muted" style={{ margin: 0, maxWidth: "52em" }}>
          Goals are funded in this order. When one is reached, its money rolls to the next. The dates follow the money.
        </p>
      </section>

      <section className="card lever" aria-label="The lever">
        <span style={{ fontWeight: 600 }}>Into the plan each month</span>
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
        <span style={{ flex: "1 1 auto" }} />
        {amount !== current && canWrite && sim?.extraGoalId ? (
          <button type="button" disabled={busy} onClick={adopt}>
            Make {formatMoney(amount, cur)} a month our plan
          </button>
        ) : (
          <span className="small muted">
            {spare !== null && spare > 0 ? `About ${formatMoney(spare, cur)} a month is spare after spending and goals.` : data.basis.months ? "No spare money in a typical month yet." : "A few months in the book will show what is spare."}
          </span>
        )}
      </section>

      <section className="card road" aria-label="The road">
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
                  <a href={`/h/${household.id}/plan/goals/${m.goalId}`} onClick={onLinkClick}>
                    {m.title}
                  </a>
                </h3>
                {m.chip && <span className={`pill ${m.chipTone}`}>{m.chip}</span>}
              </div>
              <span className="small" style={{ color: "var(--ink-soft)" }}>{m.note}</span>
            </div>
          </div>
        ))}
        <div className="mile">
          <span />
          <span />
          <p className="display" style={{ margin: "0 0 20px", fontSize: 20, color: "var(--green-deep)" }}>
            Everything on the road: {formatMoney(total, cur)}.
          </p>
        </div>
      </section>

      <section className="stack" aria-labelledby="levers-h">
        <h2 id="levers-h">What else moves the dates</h2>
        <div className="goal-grid">
          <div className="card stack" style={{ gap: 8 }}>
            <strong>If land and building get dearer</strong>
            <span className="small" style={{ color: "var(--ink-soft)" }}>Your own guess of how fast prices rise. Far-off goals need more than today's price.</span>
            <div className="chips" role="group" aria-label="Prices rise each year">
              {[0, 0.04, 0.06, 0.08].map((r) => (
                <button key={r} type="button" className="chip" aria-pressed={rise === r} onClick={() => setRise(r)}>
                  {r === 0 ? "Today's prices" : `${Math.round(r * 100)}% a year`}
                </button>
              ))}
            </div>
          </div>
          <div className="card stack" style={{ gap: 8 }}>
            <strong>A rule for bonuses</strong>
            <span className="small" style={{ color: "var(--ink-soft)" }}>
              Moving half of each festival bonus to the first unfinished goal brings every date after it closer. Log it with Move or save when it arrives.
            </span>
          </div>
          <div className="card stack" style={{ gap: 8 }}>
            <strong>A loan for the last stretch</strong>
            <span className="small" style={{ color: "var(--ink-soft)" }}>
              Borrowing for the final stage of a build brings moving in forward. Ask your bank for a rate; repayments then come out of what goes into the plan.
            </span>
          </div>
        </div>
      </section>

      <section className="card stack" aria-labelledby="order-h">
        <div className="row between">
          <h2 id="order-h">Goals, in the order they are funded</h2>
          {canWrite && (
            <a className="button secondary" href={`/h/${household.id}/plan/new`} onClick={onLinkClick}>
              <Icon.plus /> Add a goal
            </a>
          )}
        </div>
        {data.goals.map((g, i) => (
          <div key={g.id} className="kv" style={{ alignItems: "center" }}>
            <span className="row" style={{ gap: 10, flexWrap: "nowrap", minWidth: 0 }}>
              <span className="pill grey">{i + 1}</span>
              <a href={`/h/${household.id}/plan/goals/${g.id}`} onClick={onLinkClick} style={{ fontWeight: 600, color: "var(--ink)" }}>
                {g.name}
              </a>
              {g.completedAt && <span className="pill green">reached</span>}
            </span>
            <span className="row" style={{ gap: 4, flexWrap: "nowrap" }}>
              <span className="mono small muted" style={{ marginRight: 8 }}>
                {Math.round((g.savedMinor / Math.max(1, g.targetMinor)) * 100)}%
              </span>
              {canWrite && (
                <>
                  <button type="button" className="icon-button" aria-label={`Move ${g.name} earlier`} disabled={i === 0} onClick={() => move(g.id, -1)}>
                    <span aria-hidden="true">↑</span>
                  </button>
                  <button type="button" className="icon-button" aria-label={`Move ${g.name} later`} disabled={i === data.goals.length - 1} onClick={() => move(g.id, 1)}>
                    <span aria-hidden="true">↓</span>
                  </button>
                </>
              )}
            </span>
          </div>
        ))}
        {error && <div className="error">{error}</div>}
      </section>
    </>
  );
}
