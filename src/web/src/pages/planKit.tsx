/**
 * Planning a big purchase: how a goal is paid for (saved, or saved in part and borrowed for the
 * rest), the ways to reach a goal that is late, and money moments (bonuses, a maturing FD, a
 * wedding) that move the road.
 */
import { useMemo, useState } from "react";
import { emi } from "../../../shared/loan";
import { minorDigits, parseAmountToMinor } from "../../../shared/money";
import { monthName, simulatePlan, spanLabel, waysToReach, type PlanEvent } from "../../../shared/plan";
import { api, ApiError, type Account, type Goal, type Household, type PlanData, type PlanEventRow } from "../api";
import { Sheet, amountInput, formatMoney } from "../ui";
import { toPlanGoals } from "./Plan";

const pct = (n: number) => `${Math.round(n * 100)}%`;
/** Installments and interest read in whole rupees: "Rs 7,131 a month", not "Rs 7,131.28". */
export const wholeMoney = (minor: number, currency: string) => formatMoney(Math.round(minor / 10 ** minorDigits(currency)) * 10 ** minorDigits(currency), currency);
const roundUp = (minor: number, step: number) => Math.ceil(minor / step) * step;

/** The plan's settings for a simulation: start, paid-off loans and money moments. */
export function planOptions(plan: PlanData) {
  return { startMonth: plan.startMonth, releases: plan.loans.releases, events: plan.events as PlanEvent[] };
}

/** How a usual month's income takes an installment: the share and a plain verdict. */
export function emiShare(emiMinor: number, incomeMinor: number): { share: number; tone: "good" | "warn" | "bad"; text: string } | null {
  if (incomeMinor <= 0) return null;
  const share = emiMinor / incomeMinor;
  if (share <= 0.3) return { share, tone: "good", text: "comfortable" };
  if (share <= 0.5) return { share, tone: "warn", text: "tight; banks may still lend" };
  return { share, tone: "bad", text: "more than banks usually lend against" };
}

// ---------------------------------------------------------------------------
// How we pay for it
// ---------------------------------------------------------------------------

export function FundingCard({ household, goal, plan, initialAmount, onSaved }: { household: Household; goal: Goal; plan: PlanData; initialAmount?: number | null; onSaved: (message: string) => void }) {
  const cur = household.currency;
  const unit = 10 ** minorDigits(cur);
  const canWrite = household.me.role !== "viewer";
  const [mode, setMode] = useState<"save" | "borrow">(goal.loan || initialAmount ? "borrow" : "save");
  // A suggested amount ("what is missing by the date") wins over the loan already planned.
  const [amount, setAmount] = useState(initialAmount ? amountInput(initialAmount, cur) : goal.loan ? amountInput(goal.loan.amountMinor, cur) : "");
  const [rate, setRate] = useState(goal.loan ? String(goal.loan.rateBp / 100) : "11");
  const [years, setYears] = useState(goal.loan ? Math.round(goal.loan.months / 12) || 1 : 10);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const price = goal.targetMinor;
  const loanMinor = mode === "borrow" ? Math.max(0, parseAmountToMinor(amount, cur) ?? 0) : 0;
  const rateBp = Math.round((Number(rate) || 0) * 100);
  const months = Math.max(1, Math.round(years * 12));
  const emiMinor = loanMinor > 0 ? emi(loanMinor, rateBp, months) : 0;
  const interest = Math.max(0, emiMinor * months - loanMinor);
  const down = Math.max(0, price - loanMinor);
  const tooBig = loanMinor >= price;

  // The road with this way of paying.
  const sim = useMemo(() => {
    const goals = toPlanGoals(plan.goals).map((g) => (g.id === goal.id ? { ...g, loan: loanMinor > 0 && !tooBig ? { amountMinor: loanMinor, rateBp, months } : null } : g));
    return simulatePlan(goals, planOptions(plan)).outcomes.find((o) => o.id === goal.id) ?? null;
  }, [plan, goal.id, loanMinor, rateBp, months, tooBig]);
  const share = emiShare(emiMinor, plan.basis.incomeMinor);
  const gap = useMemo(() => waysToReach(toPlanGoals(plan.goals), goal.id, { ...planOptions(plan), stepMinor: 500 * unit }).gapAtDateMinor, [plan, goal.id, unit]);
  const chips: [string, number][] = [
    ["30%", roundUp(price * 0.3, 10_000 * unit)],
    ["50%", roundUp(price * 0.5, 10_000 * unit)],
    ["70%", roundUp(price * 0.7, 10_000 * unit)],
  ];
  if (goal.wantedBy && gap && gap > 0 && gap < price) chips.push([`What is missing by ${monthName(goal.wantedBy)}`, roundUp(gap, 10_000 * unit)]);

  async function save() {
    setError(null);
    setBusy(true);
    try {
      if (mode === "save") {
        await api.updateGoal(household.id, goal.id, { loan: null });
        onSaved(`${goal.name} is saved for in full.`);
      } else {
        await api.updateGoal(household.id, goal.id, { loan: { amount, rate, years } });
        onSaved(`${goal.name}: save ${formatMoney(down, cur)}, borrow ${formatMoney(loanMinor, cur)}.`);
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save that");
    } finally {
      setBusy(false);
    }
  }

  const changed = mode === "save" ? Boolean(goal.loan) : !goal.loan || goal.loan.amountMinor !== loanMinor || goal.loan.rateBp !== rateBp || goal.loan.months !== months;

  return (
    <section className="card stack" aria-labelledby="pay-h" id="how-we-pay">
      <h2 id="pay-h">How we pay for it</h2>
      <div className="seg" role="group" aria-label="How we pay">
        <button type="button" aria-pressed={mode === "save"} onClick={() => setMode("save")}>
          Save for all of it
        </button>
        <button type="button" aria-pressed={mode === "borrow"} onClick={() => setMode("borrow")}>
          Save part, borrow the rest
        </button>
      </div>

      {mode === "save" ? (
        <span className="small" style={{ color: "var(--ink-soft)" }}>
          The whole {formatMoney(price, cur)} is saved before it is bought. {sim?.doneMonth ? (sim.doneMonth === "now" ? "The money is there now." : `At the current plan the money is ready in ${monthName(sim.doneMonth)}.`) : "At the current plan it is out of reach; see the ways to get there."}
        </span>
      ) : (
        <>
          <div className="stack" style={{ gap: 6 }}>
            <label htmlFor="loan-amount" className="small" style={{ fontWeight: 500 }}>
              Borrow
            </label>
            <div className="chips" role="group" aria-label="Loan amount">
              {chips.map(([label, v]) => (
                <button key={label} type="button" className="chip" aria-pressed={loanMinor === v} onClick={() => setAmount(amountInput(v, cur))}>
                  {label} <span className="mono">{formatMoney(v, cur, { symbol: false })}</span>
                </button>
              ))}
            </div>
            <input id="loan-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount to borrow" style={{ maxWidth: 260 }} />
          </div>
          <div className="row" style={{ alignItems: "flex-end" }}>
            <label style={{ flex: "0 1 140px" }}>
              Rate, % a year
              <input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
            </label>
            <div className="stack" style={{ gap: 6, flex: "1 1 260px" }}>
              <span className="small" style={{ fontWeight: 500 }}>
                Years
              </span>
              <div className="chips" role="group" aria-label="Years">
                {[5, 10, 15, 20].map((y) => (
                  <button key={y} type="button" className="chip" aria-pressed={years === y} onClick={() => setYears(y)}>
                    {y}
                  </button>
                ))}
                <label className="sr-only" htmlFor="loan-years">
                  Other number of years
                </label>
                <input id="loan-years" inputMode="numeric" value={[5, 10, 15, 20].includes(years) ? "" : String(years)} placeholder="Other" onChange={(e) => setYears(Math.min(30, Math.max(1, Number(e.target.value) || 1)))} style={{ width: 90, borderRadius: 999, minHeight: 44 }} />
              </div>
            </div>
          </div>
          <span className="small muted">The rate is a starting guess: use your bank's. Interest is worked out monthly on what is still owed, as banks do.</span>

          {tooBig ? (
            <div className="why" role="note">
              The loan has to be less than the price of {formatMoney(price, cur)}.
            </div>
          ) : loanMinor > 0 ? (
            <dl className="terms">
              <dt>Save first</dt>
              <dd>
                <strong>{formatMoney(down, cur)}</strong>{" "}
                <span className="muted">
                  {sim?.doneMonth === "now" ? "· there now" : sim?.doneMonth ? `· ready ${monthName(sim.doneMonth)}` : "· out of reach at the current plan"}
                </span>
              </dd>
              <dt>Installment</dt>
              <dd>
                <strong>{wholeMoney(emiMinor, cur)}</strong> a month for {spanLabel(months)}
                {sim?.loan?.startMonth ? <span className="muted">, {monthName(sim.loan.startMonth)} to {monthName(sim.loan.endMonth!)}</span> : null}
              </dd>
              <dt>Interest on the loan</dt>
              <dd>
                {wholeMoney(interest, cur)} <span className="muted">· {wholeMoney(price + interest, cur)} paid in all</span>
              </dd>
              {share && (
                <>
                  <dt>Of a usual month's income</dt>
                  <dd>
                    <strong style={{ color: share.tone === "good" ? "var(--green-deep)" : share.tone === "warn" ? "var(--marigold-deep)" : "var(--rust)" }}>{pct(share.share)}</strong> <span className="muted">· {share.text}</span>
                  </dd>
                </>
              )}
            </dl>
          ) : null}
          {sim?.loan && sim.loan.shortMinor > 0 && (
            <div className="why" role="note">
              After it is bought, the installment is more than goes into the plan in some months: up to {wholeMoney(sim.loan.shortMinor, cur)} a month would come from everyday money. Put more into the plan, borrow less, or take longer.
            </div>
          )}
        </>
      )}
      {error && <div className="error small">{error}</div>}
      {canWrite && changed && (
        <div className="row">
          <button type="button" disabled={busy || (mode === "borrow" && (loanMinor <= 0 || tooBig))} onClick={save}>
            {mode === "save" ? "Save for all of it" : `Plan to borrow ${formatMoney(loanMinor, cur)}`}
          </button>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Ways to get there
// ---------------------------------------------------------------------------

export function WaysCard({ household, goal, plan, onBorrow, onChanged }: { household: Household; goal: Goal; plan: PlanData; onBorrow: (amountMinor: number) => void; onChanged: (message: string) => void }) {
  const cur = household.currency;
  const unit = 10 ** minorDigits(cur);
  const canWrite = household.me.role !== "viewer";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const goals = useMemo(() => toPlanGoals(plan.goals), [plan]);
  const ways = useMemo(() => waysToReach(goals, goal.id, { ...planOptions(plan), spareMinor: plan.spareMinor, stepMinor: 500 * unit }), [goals, goal.id, plan, unit]);
  const spare = plan.spareMinor ?? 0;
  const extra = ways.monthlyMinor !== null ? Math.max(0, ways.monthlyMinor - goal.monthlyPlanMinor) : null;
  const gap = ways.gapAtDateMinor ? roundUp(ways.gapAtDateMinor, 10_000 * unit) : 0;
  const gapEmi = gap ? emi(gap, 1100, 120) : 0;

  async function run(fn: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged(message);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not change the plan");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card stack" aria-labelledby="ways-h">
      <h2 id="ways-h">Ways to get there{goal.wantedBy ? ` by ${monthName(goal.wantedBy)}` : ""}</h2>
      <span className="small" style={{ color: "var(--ink-soft)" }}>
        {ways.currentMonth ? `At the current plan the money is ready in ${monthName(ways.currentMonth)}.` : "At the current plan the money never gets there."} Any one of these closes the gap; they can be mixed.
      </span>

      <div className="way">
        <div className="stack" style={{ gap: 2 }}>
          <strong>Save more each month</strong>
          <span className="small" style={{ color: "var(--ink-soft)" }}>
            {ways.monthlyMinor === null
              ? "No monthly amount gets there in time; the date is too close. Borrow or move the date."
              : `${formatMoney(ways.monthlyMinor, cur)} a month into ${goal.name}${extra ? `, ${formatMoney(extra, cur)} more than now` : ""}. ${spare > 0 ? (extra !== null && extra <= spare ? `That fits in the ${formatMoney(spare, cur)} spare in a usual month.` : `That is more than the ${formatMoney(spare, cur)} spare in a usual month.`) : ""}`}
          </span>
        </div>
        {canWrite && ways.monthlyMinor !== null && (
          <button type="button" className="secondary" disabled={busy} onClick={() => run(() => api.updateGoal(household.id, goal.id, { monthly: amountInput(ways.monthlyMinor!, cur) }), `${goal.name}: ${formatMoney(ways.monthlyMinor!, cur)} a month.`)}>
            Make it {formatMoney(ways.monthlyMinor, cur)} a month
          </button>
        )}
      </div>

      {ways.withSpare && spare > 0 && (
        <div className="way">
          <div className="stack" style={{ gap: 2 }}>
            <strong>Put the spare money in</strong>
            <span className="small" style={{ color: "var(--ink-soft)" }}>
              {formatMoney(spare, cur)} a month is spare after spending{plan.loans.monthlyMinor ? ", installments" : ""} and the other goals{plan.basis.source === "typical" ? ", going by your usual month" : ""}. With it, {goal.name} is ready {ways.withSpare.doneMonth ? (ways.withSpare.doneMonth === "now" ? "now" : `in ${monthName(ways.withSpare.doneMonth)}`) : "only after 30 years"}.
            </span>
          </div>
          {canWrite && (
            <button type="button" className="secondary" disabled={busy} onClick={() => run(() => api.updateGoal(household.id, goal.id, { monthly: amountInput(goal.monthlyPlanMinor + spare, cur) }), `${goal.name}: ${formatMoney(goal.monthlyPlanMinor + spare, cur)} a month.`)}>
              Add {formatMoney(spare, cur)} a month
            </button>
          )}
        </div>
      )}

      {gap > 0 && gap < goal.targetMinor && (
        <div className="way">
          <div className="stack" style={{ gap: 2 }}>
            <strong>Borrow what is missing</strong>
            <span className="small" style={{ color: "var(--ink-soft)" }}>
              About {formatMoney(gap, cur)} is still missing at {goal.wantedBy ? monthName(goal.wantedBy) : "the date"}. Over 10 years at 11% that is about {wholeMoney(gapEmi, cur)} a month{plan.basis.incomeMinor > 0 ? `, ${pct(gapEmi / plan.basis.incomeMinor)} of a usual month's income` : ""}.
            </span>
          </div>
          {canWrite && (
            <button type="button" className="secondary" disabled={busy} onClick={() => onBorrow(gap)}>
              Plan the loan
            </button>
          )}
        </div>
      )}

      {ways.currentMonth && goal.wantedBy && ways.currentMonth > goal.wantedBy && (
        <div className="way">
          <div className="stack" style={{ gap: 2 }}>
            <strong>Move the date</strong>
            <span className="small" style={{ color: "var(--ink-soft)" }}>
              Keep the plan as it is and want it by {monthName(ways.currentMonth)}, {spanLabel(monthsAfter(goal.wantedBy, ways.currentMonth))} later.
            </span>
          </div>
          {canWrite && (
            <button type="button" className="secondary" disabled={busy} onClick={() => run(() => api.updateGoal(household.id, goal.id, { wantedBy: ways.currentMonth! }), `${goal.name}: wanted by ${monthName(ways.currentMonth!)}.`)}>
              Move it to {monthName(ways.currentMonth)}
            </button>
          )}
        </div>
      )}
      {error && <div className="error small">{error}</div>}
    </section>
  );
}

function monthsAfter(a: string, b: string): number {
  const [ya, ma] = a.split("-").map(Number) as [number, number];
  const [yb, mb] = b.split("-").map(Number) as [number, number];
  return (yb - ya) * 12 + (mb - ma);
}

// ---------------------------------------------------------------------------
// Money moments
// ---------------------------------------------------------------------------

/** When a moment happens, in words: "Oct 2027", "every Oct from 2027", "every Oct, 2027 to 2030". */
export function whenText(e: Pick<PlanEventRow, "month" | "yearly" | "untilMonth">): string {
  if (!e.yearly) return monthName(e.month);
  const [m, y] = monthName(e.month).split(" ");
  return e.untilMonth ? `every ${m}, ${y} to ${e.untilMonth.slice(0, 4)}` : `every ${m} from ${y}`;
}

export function MomentsCard({ household, plan, accounts, onChanged }: { household: Household; plan: PlanData; accounts: Account[]; onChanged: () => void }) {
  const cur = household.currency;
  const canWrite = household.me.role !== "viewer";
  const [editing, setEditing] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const goalName = (id: string | null) => plan.goals.find((g) => g.id === id)?.name ?? null;
  // A fixed deposit that matures is money coming: offer it once.
  const maturing = accounts.filter((a) => a.type === "deposit" && !a.closedAt && a.endDate && a.endDate.slice(0, 7) >= plan.startMonth && !plan.events.some((e) => e.name === `${a.name} matures`));

  async function remove(e: PlanEventRow) {
    if (!window.confirm(`Take "${e.name}" off the plan?`)) return;
    try {
      await api.removePlanEvent(household.id, e.id);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not remove it");
    }
  }

  return (
    <section className="card stack" aria-labelledby="moments-h">
      <div className="row between">
        <h2 id="moments-h">Money moments</h2>
        {canWrite && (
          <button type="button" className="link small" onClick={() => setEditing({})}>
            Add one
          </button>
        )}
      </div>
      <span className="small" style={{ color: "var(--ink-soft)" }}>
        Money that comes or goes once, or every year: a festival bonus, an FD maturing, a plot sold, a wedding, a school admission. The road moves with them.
      </span>
      {plan.events.length === 0 && canWrite && (
        <div className="chips" role="group" aria-label="Suggestions">
          {[
            { name: "Dashain bonus", direction: "in" as const, yearly: true, month: nextOf(plan.startMonth, 10) },
            { name: "A wedding in the family", direction: "out" as const, yearly: false, month: plan.startMonth },
            { name: "School admission", direction: "out" as const, yearly: true, month: nextOf(plan.startMonth, 4) },
          ].map((s) => (
            <button key={s.name} type="button" className="chip" onClick={() => setEditing(s)}>
              {s.direction === "in" ? "+" : "−"} {s.name}
            </button>
          ))}
        </div>
      )}
      {plan.events.map((e) => (
        <div key={e.id} className="kv">
          <span className="stack" style={{ gap: 1, minWidth: 0 }}>
            <strong style={{ fontWeight: 500 }}>{e.name}</strong>
            <span className="small muted">
              {whenText(e)}
              {e.goalId && goalName(e.goalId) ? ` · into ${goalName(e.goalId)}` : ""}
            </span>
          </span>
          <span className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
            <span className={`mono ${e.amountMinor > 0 ? "amount-in" : ""}`} style={{ color: e.amountMinor < 0 ? "var(--rust)" : undefined }}>
              {e.amountMinor > 0 ? "+" : "−"}
              {formatMoney(Math.abs(e.amountMinor), cur, { symbol: false })}
            </span>
            {canWrite && (
              <>
                <button type="button" className="link small" onClick={() => setEditing(e)}>
                  Edit
                </button>
                <button type="button" className="link small" onClick={() => remove(e)}>
                  Remove
                </button>
              </>
            )}
          </span>
        </div>
      ))}
      {canWrite &&
        maturing.map((a) => (
          <button
            key={a.id}
            type="button"
            className="chip"
            style={{ alignSelf: "flex-start" }}
            onClick={() => setEditing({ name: `${a.name} matures`, direction: "in", amountMinor: a.deposit?.maturityValueMinor ?? a.balanceMinor, month: a.endDate!.slice(0, 7), yearly: false, goalId: a.goalId })}
          >
            + {a.name} matures {monthName(a.endDate!.slice(0, 7))}: about {formatMoney(a.deposit?.maturityValueMinor ?? a.balanceMinor, cur)}
          </button>
        ))}
      {error && <div className="error small">{error}</div>}
      {editing && (
        <MomentSheet
          household={household}
          plan={plan}
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onChanged();
          }}
        />
      )}
    </section>
  );
}

/** A moment being added or edited; a suggestion carries its direction before it has an amount. */
type Draft = Partial<PlanEventRow> & { direction?: "in" | "out" };

/** The next time a month of the year comes round, from a start month: October → "2026-10" or "2027-10". */
function nextOf(startMonth: string, monthOfYear: number): string {
  const y = Number(startMonth.slice(0, 4));
  const m = Number(startMonth.slice(5, 7));
  return `${monthOfYear >= m ? y : y + 1}-${String(monthOfYear).padStart(2, "0")}`;
}

function MomentSheet({ household, plan, initial, onClose, onSaved }: { household: Household; plan: PlanData; initial: Draft; onClose: () => void; onSaved: () => void }) {
  const cur = household.currency;
  const isNew = !initial.id;
  const [dir, setDir] = useState<"in" | "out">(initial.direction ?? ((initial.amountMinor ?? 0) < 0 ? "out" : "in"));
  const [name, setName] = useState(initial.name ?? "");
  const [amount, setAmount] = useState(initial.amountMinor ? amountInput(Math.abs(initial.amountMinor), cur) : "");
  const [month, setMonth] = useState(initial.month ?? plan.startMonth);
  const [yearly, setYearly] = useState(Boolean(initial.yearly));
  const [until, setUntil] = useState(initial.untilMonth ? initial.untilMonth.slice(0, 4) : "");
  const [goalId, setGoalId] = useState(initial.goalId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const body = { name, direction: dir, amount, month, yearly, untilMonth: yearly && until ? `${until}-${month.slice(5, 7)}` : null, goalId: dir === "in" ? goalId || null : null };
      if (isNew) await api.createPlanEvent(household.id, body);
      else await api.updatePlanEvent(household.id, initial.id!, body);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save it");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title={isNew ? "A money moment" : `Edit ${initial.name}`} onClose={onClose}>
      <form className="stack" onSubmit={submit} style={{ gap: 14 }}>
        <div className="seg" role="group" aria-label="Direction">
          <button type="button" className="in" aria-pressed={dir === "in"} onClick={() => setDir("in")}>
            Money comes in
          </button>
          <button type="button" aria-pressed={dir === "out"} onClick={() => setDir("out")}>
            Money goes out
          </button>
        </div>
        <label>
          What is it
          <input required value={name} onChange={(e) => setName(e.target.value)} placeholder={dir === "in" ? "Dashain bonus, FD matures, plot sold" : "Wedding, school admission, new scooter"} />
        </label>
        <div className="row" style={{ alignItems: "flex-end" }}>
          <label style={{ flex: "1 1 150px" }}>
            Amount
            <input required inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
          </label>
          <label style={{ flex: "1 1 150px" }}>
            Month
            <input required type="month" value={month} min={plan.startMonth} onChange={(e) => e.target.value && setMonth(e.target.value)} />
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={yearly} onChange={(e) => setYearly(e.target.checked)} />
          <span>Every year in {monthName(month).split(" ")[0]}</span>
        </label>
        {yearly && (
          <label style={{ maxWidth: 220 }}>
            Until (year, optional)
            <input inputMode="numeric" value={until} onChange={(e) => setUntil(e.target.value.replace(/\D/g, "").slice(0, 4))} placeholder="No end" />
          </label>
        )}
        {dir === "in" && plan.goals.length > 0 && (
          <label>
            Into
            <select value={goalId} onChange={(e) => setGoalId(e.target.value)}>
              <option value="">The first goal still being saved for</option>
              {plan.goals
                .filter((g) => !g.completedAt)
                .map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
            </select>
          </label>
        )}
        <span className="small muted">
          {dir === "in"
            ? "It goes into the goals that month, so every date after it can come closer."
            : "It comes out of what goes into the goals; if one month cannot cover it, the next months do."}{" "}
          Nothing is logged in the book until it happens.
        </span>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <button type="submit" disabled={busy}>
          {busy ? "Saving…" : isNew ? "Add it to the plan" : "Save changes"}
        </button>
      </form>
    </Sheet>
  );
}
