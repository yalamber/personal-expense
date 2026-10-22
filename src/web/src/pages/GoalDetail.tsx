import { useCallback, useEffect, useMemo, useState } from "react";
import { todayIn } from "../../../shared/dates";
import { lateLabel, monthName, simulatePlan } from "../../../shared/plan";
import { api, ApiError, type Account, type Contribution, type Goal, type Household, type PlanData } from "../api";
import { navigate, onLinkClick } from "../router";
import { Icon, amountInput, formatMoney, shortDate } from "../ui";
import { toPlanGoals } from "./Plan";

/** One goal: what it is made of, when each part's money is ready, and the money that went in. */
export function GoalDetail({ household, accounts, goalId, onChanged }: { household: Household; accounts: Account[]; goalId: string; onChanged: () => void }) {
  const cur = household.currency;
  const today = todayIn(household.timezone);
  const canWrite = household.me.role !== "viewer";
  const [plan, setPlan] = useState<PlanData | null>(null);
  const [history, setHistory] = useState<Contribution[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [from, setFrom] = useState("");
  const [date, setDate] = useState(today);
  const [moneyNote, setMoneyNote] = useState("");
  const [newPart, setNewPart] = useState({ name: "", amount: "" });

  const load = useCallback(async () => {
    try {
      const [p, h] = await Promise.all([api.plan(household.id), api.contributions(household.id, goalId)]);
      setPlan(p);
      setHistory(h);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the goal");
    }
  }, [household.id, goalId]);

  useEffect(() => {
    void load();
  }, [load]);

  const goal: Goal | undefined = plan?.goals.find((g) => g.id === goalId);
  const outcome = useMemo(() => (plan && goal ? simulatePlan(toPlanGoals(plan.goals), { startMonth: plan.startMonth }).outcomes.find((o) => o.id === goal.id) ?? null : null), [plan, goal]);

  async function run(fn: () => Promise<unknown>, done?: string) {
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (done) setNotice(done);
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save that");
    }
  }

  if (error && !plan) return <div className="error">{error}</div>;
  if (!plan) return <p className="muted">Opening the goal…</p>;
  if (!goal) {
    return (
      <div className="stack">
        <a className="back" href={`/h/${household.id}/plan`} onClick={onLinkClick}>
          <Icon.back /> Plan
        </a>
        <p className="muted">This goal is no longer on the plan.</p>
      </div>
    );
  }

  const pct = Math.min(100, (goal.savedMinor / Math.max(1, goal.targetMinor)) * 100);
  let running = 0;

  return (
    <>
      <a className="back" href={`/h/${household.id}/plan`} onClick={onLinkClick}>
        <Icon.back /> Plan
      </a>
      <section className="stack" style={{ gap: 8 }}>
        <div className="row" style={{ gap: 10 }}>
          <h1>{goal.name}</h1>
          {outcome && outcome.lateMonths !== null && <span className={`pill ${outcome.lateMonths > 0 ? "amber" : "green"}`}>{lateLabel(outcome.lateMonths)}</span>}
          {goal.completedAt && <span className="pill green">reached</span>}
        </div>
        <span className="muted">
          Priority {plan.goals.indexOf(goal) + 1}
          {goal.wantedBy ? ` · wanted by ${monthName(goal.wantedBy)}` : ""}
          {outcome?.doneMonth ? ` · ${outcome.doneMonth === "now" ? "fully funded" : `money ready ${monthName(outcome.doneMonth)}`}` : outcome ? " · not within 30 years at this plan" : ""}
        </span>
      </section>

      <div className="columns">
        <div className="main">
          <section className="card stack" aria-label="Progress">
            <div className="row between" style={{ alignItems: "baseline" }}>
              <span>
                <span className="display" style={{ fontSize: 30 }}>{formatMoney(goal.savedMinor, cur)}</span> <span className="muted">of {formatMoney(goal.targetMinor, cur)}</span>
              </span>
              <span className="mono small muted">{Math.round(pct)}%</span>
            </div>
            <div className="progress" aria-hidden="true">
              <div style={{ width: `${pct}%` }} />
            </div>
          </section>

          <section className="card stack" aria-labelledby="parts-h">
            <h2 id="parts-h">{goal.kind === "build" ? "Stages" : "What it costs"}</h2>
            {goal.parts.length === 0 && <span className="small muted">One total for now. Split it into parts, such as the plot price and the fees, or the stages of a build.</span>}
            {goal.parts.length > 0 && (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>{goal.kind === "build" ? "Stage" : "Part"}</th>
                      <th className="right">Amount</th>
                      <th>Money ready</th>
                      <th>
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {goal.parts.map((p, i) => {
                      running += p.amountMinor;
                      const ready = outcome?.partsReady[i] ?? null;
                      return (
                        <tr key={p.id}>
                          <td>
                            <span className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
                              <span className="pill grey">{i + 1}</span>
                              <strong style={{ fontWeight: 600 }}>{p.name}</strong>
                              {p.doneAt && <span className="pill green">paid</span>}
                            </span>
                          </td>
                          <td className="right mono">{formatMoney(p.amountMinor, cur, { symbol: false })}</td>
                          <td style={{ color: ready === null ? "var(--marigold-deep)" : undefined, fontWeight: 500 }}>
                            {goal.savedMinor >= running ? "ready now" : ready === null ? "not yet" : ready === "now" ? "ready now" : monthName(ready)}
                          </td>
                          <td className="right">
                            {canWrite && (
                              <span className="row" style={{ gap: 0, justifyContent: "flex-end", flexWrap: "nowrap" }}>
                                <button type="button" className="link small" onClick={() => run(() => api.updatePart(household.id, p.id, { done: !p.doneAt }))}>
                                  {p.doneAt ? "Not paid" : "Paid"}
                                </button>
                                <button
                                  type="button"
                                  className="link small"
                                  onClick={() => {
                                    const v = window.prompt(`New amount for ${p.name}`, amountInput(p.amountMinor, cur));
                                    if (v) void run(() => api.updatePart(household.id, p.id, { amount: v }));
                                  }}
                                >
                                  Change
                                </button>
                                <button type="button" className="icon-button" aria-label={`Remove ${p.name}`} onClick={() => window.confirm(`Remove ${p.name}?`) && run(() => api.removePart(household.id, p.id))}>
                                  <Icon.close size={16} />
                                </button>
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {canWrite && (
              <form
                className="row"
                style={{ alignItems: "flex-end" }}
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(() => api.addPart(household.id, goal.id, newPart), "Added.").then(() => setNewPart({ name: "", amount: "" }));
                }}
              >
                <label style={{ flex: "2 1 200px" }}>
                  {goal.kind === "build" ? "New stage" : "New part"}
                  <input required value={newPart.name} onChange={(e) => setNewPart({ ...newPart, name: e.target.value })} />
                </label>
                <label style={{ flex: "1 1 120px" }}>
                  Amount
                  <input required inputMode="decimal" value={newPart.amount} onChange={(e) => setNewPart({ ...newPart, amount: e.target.value })} />
                </label>
                <button type="submit" className="secondary">
                  Add
                </button>
              </form>
            )}
          </section>

          <section className="card stack" aria-labelledby="hist-h">
            <h2 id="hist-h">Money in so far</h2>
            {history.length === 0 && <span className="small muted">Nothing yet.</span>}
            {history.map((c) => (
              <div key={c.id} className="kv">
                <span className="stack" style={{ gap: 0 }}>
                  <span style={{ fontWeight: 500 }}>{c.note ?? (c.transactionId ? "Moved from an account" : "Set aside")}</span>
                  <span className="small muted">
                    {shortDate(c.date)}
                    {c.memberName ? ` · ${c.memberName}` : ""}
                  </span>
                </span>
                <span className="row" style={{ gap: 4, flexWrap: "nowrap" }}>
                  <span className="mono amount-in">{formatMoney(c.amountMinor, cur, { sign: true, symbol: false })}</span>
                  {canWrite && (
                    <button type="button" className="icon-button" aria-label="Remove this" onClick={() => window.confirm("Remove this money from the goal? A linked move between accounts is removed too.") && run(() => api.removeContribution(household.id, c.id))}>
                      <Icon.close size={16} />
                    </button>
                  )}
                </span>
              </div>
            ))}
          </section>
        </div>

        <aside className="side">
          {canWrite && !goal.completedAt && (
            <form
              className="card stack"
              aria-labelledby="add-h"
              onSubmit={(e) => {
                e.preventDefault();
                void run(() => api.addContribution(household.id, goal.id, { amount, date, note: moneyNote, fromAccountId: from || null }), "Added to the goal.").then(() => {
                  setAmount("");
                  setMoneyNote("");
                });
              }}
            >
              <h2 id="add-h">Add money</h2>
              <label>
                Amount
                <input required inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
              </label>
              <label>
                From
                <select value={from} onChange={(e) => setFrom(e.target.value)}>
                  <option value="">Already set aside (no account)</option>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </label>
              <label>
                Date
                <input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} />
              </label>
              <label>
                Note
                <input value={moneyNote} onChange={(e) => setMoneyNote(e.target.value)} placeholder="Dashain bonus" />
              </label>
              <button type="submit">Add to {goal.name}</button>
            </form>
          )}

          {canWrite && <GoalSettings household={household} goal={goal} accounts={accounts} run={run} />}
          {notice && <div className="ok">{notice}</div>}
          {error && <div className="error">{error}</div>}
        </aside>
      </div>
    </>
  );
}

function GoalSettings({ household, goal, accounts, run }: { household: Household; goal: Goal; accounts: Account[]; run: (fn: () => Promise<unknown>, done?: string) => Promise<void> }) {
  const cur = household.currency;
  const [name, setName] = useState(goal.name);
  const [wantedBy, setWantedBy] = useState(goal.wantedBy ?? "");
  const [monthly, setMonthly] = useState(amountInput(goal.monthlyPlanMinor, cur));
  const [target, setTarget] = useState(amountInput(goal.targetMinor, cur));
  const [linked, setLinked] = useState(goal.linkedAccountId ?? "");

  return (
    <form
      className="card stack"
      aria-labelledby="set-h"
      onSubmit={(e) => {
        e.preventDefault();
        void run(
          () =>
            api.updateGoal(household.id, goal.id, {
              name,
              wantedBy: wantedBy || null,
              monthly,
              linkedAccountId: linked || null,
              ...(goal.parts.length ? {} : { target }),
            }),
          "Saved.",
        );
      }}
    >
      <h2 id="set-h">Goal settings</h2>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      {!goal.parts.length && (
        <label>
          Target
          <input inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} />
        </label>
      )}
      <label>
        Wanted by
        <input type="month" value={wantedBy} onChange={(e) => setWantedBy(e.target.value)} />
      </label>
      <label>
        A month of its own
        <input inputMode="decimal" value={monthly} onChange={(e) => setMonthly(e.target.value)} />
      </label>
      <label>
        Money kept in
        <select value={linked} onChange={(e) => setLinked(e.target.value)}>
          <option value="">Just tracked</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </label>
      <button type="submit" className="secondary">
        Save changes
      </button>
      <div className="row between">
        <button type="button" className="link" onClick={() => run(() => api.updateGoal(household.id, goal.id, { completed: !goal.completedAt }), goal.completedAt ? "Back on the plan." : "Marked as reached.")}>
          {goal.completedAt ? "Not reached yet" : "Mark as reached"}
        </button>
        <button
          type="button"
          className="link"
          style={{ color: "var(--rust)" }}
          onClick={async () => {
            if (!window.confirm(`Take ${goal.name} off the plan? Its history is kept.`)) return;
            await run(() => api.archiveGoal(household.id, goal.id));
            navigate(`/h/${household.id}/plan`);
          }}
        >
          Take off the plan
        </button>
      </div>
    </form>
  );
}
