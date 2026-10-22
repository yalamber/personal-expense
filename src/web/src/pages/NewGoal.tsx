import { useEffect, useMemo, useState } from "react";
import { addDays, todayIn } from "../../../shared/dates";
import { parseAmountToMinor } from "../../../shared/money";
import { lateLabel, monthName, monthsBetween, simulatePlan, type PlanGoalKind } from "../../../shared/plan";
import { api, ApiError, type Account, type Household, type PlanData } from "../api";
import { navigate, onLinkClick } from "../router";
import { Icon, amountInput, formatMoney } from "../ui";
import { toPlanGoals } from "./Plan";

type Template = { id: string; label: string; sub: string; kind: PlanGoalKind; name: string; parts: string[]; years: number; partsLabel: string };

/** Starting points. Part names only: the amounts are the family's own. */
const TEMPLATES: Template[] = [
  { id: "land", label: "Land", sub: "Plot and fees", kind: "purchase", name: "Land purchase", parts: ["Plot price", "Registration and tax", "Survey and legal", "Boundary wall"], years: 3, partsLabel: "What it costs" },
  { id: "house", label: "House build", sub: "In stages", kind: "build", name: "House build", parts: ["Design and permits", "Foundation and plinth", "Structure: pillars and slabs", "Walls, roof, plumbing, wiring", "Finishing and moving in"], years: 5, partsLabel: "Stages, in build order" },
  { id: "safety", label: "Emergency fund", sub: "Months of costs", kind: "safety", name: "Emergency fund", parts: [], years: 1, partsLabel: "" },
  { id: "education", label: "Education", sub: "Fees ahead", kind: "education", name: "Children's education", parts: ["Admission", "Fees and books"], years: 8, partsLabel: "What it covers" },
  { id: "vehicle", label: "Vehicle", sub: "Car or scooter", kind: "purchase", name: "Vehicle", parts: ["Price", "Registration and insurance"], years: 1, partsLabel: "What it costs" },
  { id: "ceremony", label: "Ceremony", sub: "Wedding, bratabandha", kind: "other", name: "Wedding", parts: ["Venue and food", "Clothes and jewellery", "Gifts and travel"], years: 2, partsLabel: "What it costs" },
  { id: "travel", label: "Travel", sub: "A family trip", kind: "other", name: "Family trip", parts: ["Tickets", "Stay and food"], years: 1, partsLabel: "What it costs" },
  { id: "other", label: "Something else", sub: "Your own", kind: "other", name: "", parts: [], years: 2, partsLabel: "What it costs" },
];

type Part = { name: string; amount: string };

export function NewGoal({ household, accounts }: { household: Household; accounts: Account[] }) {
  const cur = household.currency;
  const today = todayIn(household.timezone);
  const [plan, setPlan] = useState<PlanData | null>(null);
  const [tpl, setTpl] = useState<Template>(TEMPLATES[0]!);
  const [name, setName] = useState(TEMPLATES[0]!.name);
  const [parts, setParts] = useState<Part[]>(TEMPLATES[0]!.parts.map((n) => ({ name: n, amount: "" })));
  const [target, setTarget] = useState("");
  const [months, setMonths] = useState(6);
  const [wantedBy, setWantedBy] = useState(addDays(today, 365 * 3).slice(0, 7));
  const [saved, setSaved] = useState("");
  const [monthly, setMonthly] = useState("");
  const [account, setAccount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.plan(household.id).then(setPlan).catch(() => undefined);
  }, [household.id]);

  function pick(t: Template) {
    setTpl(t);
    setName(t.name);
    setParts(t.parts.map((n) => ({ name: n, amount: "" })));
    setTarget("");
    setWantedBy(addDays(today, Math.round(365.25 * t.years)).slice(0, 7));
  }

  const essentials = plan?.basis.months ? plan.basis.spendMinor : null;
  const minor = (v: string) => (v.trim() ? parseAmountToMinor(v, cur) ?? 0 : 0);
  const partsTotal = parts.reduce((s, p) => s + Math.max(0, minor(p.amount)), 0);
  const targetMinor = tpl.kind === "safety" && essentials ? essentials * months : parts.some((p) => p.amount.trim()) ? partsTotal : minor(target);
  const savedMinor = Math.max(0, minor(saved));
  const monthlyMinor = Math.max(0, minor(monthly));
  const monthsLeft = plan ? Math.max(1, monthsBetween(plan.startMonth, wantedBy) + 1) : 1;
  const neededMinor = Math.max(0, Math.ceil((targetMinor - savedMinor) / monthsLeft));

  const outcome = useMemo(() => {
    if (!plan || !targetMinor) return null;
    const goals = [...toPlanGoals(plan.goals), { id: "new", name: name || "This goal", kind: tpl.kind, targetMinor, savedMinor, monthlyMinor, wantedBy, parts: [] }];
    return simulatePlan(goals, { startMonth: plan.startMonth }).outcomes.find((o) => o.id === "new") ?? null;
  }, [plan, targetMinor, savedMinor, monthlyMinor, wantedBy, name, tpl.kind]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError("Give the goal a name.");
    if (!targetMinor) return setError(tpl.kind === "safety" && !essentials ? "Type how much the fund should hold." : "Add what it costs, as a total or in parts.");
    setBusy(true);
    try {
      const filled = parts.filter((p) => p.name.trim() && p.amount.trim());
      await api.createGoal(household.id, {
        name: name.trim(),
        kind: tpl.kind,
        target: filled.length ? undefined : tpl.kind === "safety" && essentials ? amountInput(targetMinor, cur) : target,
        wantedBy,
        monthly,
        saved,
        linkedAccountId: account || null,
        parts: filled,
      });
      navigate(`/h/${household.id}/plan`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add the goal");
    } finally {
      setBusy(false);
    }
  }

  const spare = plan?.spareMinor ?? null;
  const fits = spare === null ? null : neededMinor <= spare;

  return (
    <form className="stack" style={{ gap: 20, maxWidth: 720 }} onSubmit={save}>
      <a className="back" href={`/h/${household.id}/plan`} onClick={onLinkClick}>
        <Icon.back /> Plan
      </a>
      <h1>A new goal</h1>

      <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend style={{ fontWeight: 600, marginBottom: 10 }}>What are you saving for?</legend>
        <div className="template-grid">
          {TEMPLATES.map((t) => (
            <button key={t.id} type="button" aria-pressed={tpl.id === t.id} onClick={() => pick(t)}>
              {t.label}
              <span>{t.sub}</span>
            </button>
          ))}
        </div>
      </fieldset>

      <div className="row" style={{ alignItems: "flex-end" }}>
        <label style={{ flex: "2 1 240px" }}>
          Name
          <input required value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label style={{ flex: "1 1 160px" }}>
          Already saved
          <input inputMode="decimal" placeholder="0" value={saved} onChange={(e) => setSaved(e.target.value)} />
        </label>
      </div>

      {tpl.kind === "safety" ? (
        essentials ? (
          <div className="stack" style={{ gap: 8 }}>
            <span style={{ fontWeight: 500, fontSize: 14 }}>How many months of spending should it cover?</span>
            <div className="chips">
              {[3, 6, 9].map((m) => (
                <button key={m} type="button" className="chip" aria-pressed={months === m} onClick={() => setMonths(m)}>
                  {m} months · {formatMoney(essentials * m, cur)}
                </button>
              ))}
            </div>
            <span className="small muted">A typical month costs about {formatMoney(essentials, cur)}, from the last {plan!.basis.months} months in the book.</span>
          </div>
        ) : (
          <label>
            How much should it hold?
            <input inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="Three to six months of spending" />
          </label>
        )
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          <div className="row between">
            <span style={{ fontWeight: 500, fontSize: 14 }}>{tpl.partsLabel || "What it costs"}</span>
            <span className="small muted">{parts.some((p) => p.amount.trim()) ? `Total ${formatMoney(partsTotal, cur)}` : "The target is their total"}</span>
          </div>
          <div className="parts">
            {parts.map((p, i) => (
              <div key={i} className="part">
                <span className="n">{i + 1}</span>
                <label className="sr-only" htmlFor={`part-name-${i}`}>Part {i + 1}</label>
                <input id={`part-name-${i}`} value={p.name} onChange={(e) => setParts(parts.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                <label className="sr-only" htmlFor={`part-amount-${i}`}>Amount for part {i + 1}</label>
                <input id={`part-amount-${i}`} inputMode="decimal" placeholder="Amount" value={p.amount} onChange={(e) => setParts(parts.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
                <button type="button" className="icon-button" aria-label={`Remove ${p.name || "part"}`} onClick={() => setParts(parts.filter((_, j) => j !== i))}>
                  <Icon.close size={18} />
                </button>
              </div>
            ))}
            <button type="button" className="add" onClick={() => setParts([...parts, { name: "", amount: "" }])}>
              <Icon.plus size={16} /> {tpl.kind === "build" ? "Add a stage" : "Add a cost"}
            </button>
          </div>
          {!parts.length && (
            <label>
              Or one total
              <input inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} />
            </label>
          )}
        </div>
      )}

      <div className="row" style={{ alignItems: "flex-end" }}>
        <label style={{ flex: "1 1 180px" }}>
          Wanted by
          <input type="month" required value={wantedBy} min={today.slice(0, 7)} onChange={(e) => e.target.value && setWantedBy(e.target.value)} />
        </label>
        <label style={{ flex: "1 1 180px" }}>
          A month of its own
          <input inputMode="decimal" placeholder="0 — wait its turn" value={monthly} onChange={(e) => setMonthly(e.target.value)} />
        </label>
        <label style={{ flex: "1 1 200px" }}>
          Keep the money in
          <select value={account} onChange={(e) => setAccount(e.target.value)}>
            <option value="">Just track it</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
      </div>

      {targetMinor > 0 && (
        <section aria-live="polite" className={fits === false ? "note stack" : "ok stack"} style={{ gap: 6 }}>
          <strong>
            {formatMoney(neededMinor, cur)} a month until {monthName(wantedBy)} would make it.
          </strong>
          <span className="small" style={{ color: "var(--ink-soft)" }}>
            {spare === null
              ? "A few months in the book will show whether that fits."
              : fits
                ? `About ${formatMoney(spare, cur)} a month is spare, so it fits, with ${formatMoney(spare - neededMinor, cur)} left over.`
                : `About ${formatMoney(Math.max(0, spare), cur)} a month is spare. Pick a later date, start with fewer parts, or plan a loan for part of it.`}
            {outcome && (
              <>
                {" "}
                In the order of your other goals, it lands {outcome.doneMonth === null ? "beyond the next 30 years" : outcome.doneMonth === "now" ? "right away" : `in ${monthName(outcome.doneMonth)}`}
                {outcome.lateMonths !== null ? `, ${lateLabel(outcome.lateMonths)}` : ""}.
              </>
            )}
          </span>
        </section>
      )}

      {error && <div className="error" role="alert">{error}</div>}
      <div className="row">
        <a className="button secondary" href={`/h/${household.id}/plan`} onClick={onLinkClick}>
          Cancel
        </a>
        <button type="submit" disabled={busy}>
          {busy ? "Adding…" : "Add the goal"}
        </button>
      </div>
    </form>
  );
}
