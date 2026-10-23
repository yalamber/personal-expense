import { useCallback, useEffect, useState } from "react";
import { worth } from "../../../shared/worth";
import { api, ApiError, type Account, type AccountType, type Goal, type Household } from "../api";
import { onLinkClick } from "../router";
import { amountInput, formatMoney } from "../ui";
import { AccountAmount, AccountForm, accountLine, typeInfo } from "./accountsKit";

type Step = { id: string; title: string; text: string; types: AccountType[] };

const STEPS: Step[] = [
  { id: "money", title: "Where the money is today", text: "Bank accounts, savings, cash at home and wallets, with the balance each shows today.", types: ["checking", "savings", "cash", "wallet"] },
  { id: "deposits", title: "Fixed deposits", text: "Each FD with the amount put in, the rate and when it matures. Interest builds up on its own.", types: ["deposit"] },
  { id: "owed", title: "Loans, cards and money lent", text: "What we still owe (home or car loan, a friendly loan, the card) and what others owe us.", types: ["loan", "credit", "lent"] },
];

/**
 * Starting point: today's balances, deposits and loans, so the book (and Today, Plan and the
 * net worth) is right from day one instead of building up from zero.
 */
export function StartingPoint({ household, onChanged }: { household: Household; onChanged: () => void }) {
  const cur = household.currency;
  const canWrite = household.me.role !== "viewer";
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [adding, setAdding] = useState<string | null>(null);
  const [income, setIncome] = useState(household.typicalIncomeMinor !== null ? amountInput(household.typicalIncomeMinor, cur) : "");
  const [spend, setSpend] = useState(household.typicalSpendMinor !== null ? amountInput(household.typicalSpendMinor, cur) : "");
  const [typicalSaved, setTypicalSaved] = useState(household.typicalIncomeMinor !== null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [a, g] = await Promise.all([api.accounts(household.id), api.goals(household.id)]);
      setAccounts(a.filter((x) => !x.closedAt));
      setGoals(g.filter((x) => !x.completedAt));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load accounts");
    }
  }, [household.id]);
  useEffect(() => {
    void load();
  }, [load]);

  const saved = () => {
    setAdding(null);
    void load();
    onChanged();
  };

  async function saveTypical(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.updateHousehold(household.id, { typicalIncome: income, typicalSpend: spend });
      setTypicalSaved(true);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  async function holdFor(account: Account, goalId: string) {
    setError(null);
    try {
      await api.updateAccount(household.id, account.id, { goalId: goalId || null });
      void load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  const list = accounts ?? [];
  const { haveMinor: have, oweMinor: owe } = worth(list);
  const contacts = list.filter((a) => a.type === "person");
  const done = (s: Step) => list.some((a) => s.types.includes(a.type));
  const holders = list.filter((a) => ["checking", "savings", "cash", "wallet", "deposit"].includes(a.type));
  const progress = STEPS.filter(done).length + (typicalSaved ? 1 : 0);

  return (
    <>
      <div className="stack" style={{ gap: 4 }}>
        <span className="eyebrow">Starting point · {progress} of 4</span>
        <h1>Start from today, not from zero</h1>
        <span className="muted" style={{ maxWidth: 620 }}>
          Tell the book what you have and what you owe today. Balances, Today and the Plan count from here, so there is no need to wait months for the numbers to
          build up.
        </span>
      </div>
      {error && <div className="error">{error}</div>}

      {list.length > 0 && (
        <dl className="ledger-sum" style={{ maxWidth: 520 }} aria-label="What we have">
          <div>
            <dt>We have</dt>
            <dd>{formatMoney(have, cur)}</dd>
          </div>
          <div>
            <dt>We owe</dt>
            <dd style={{ color: owe > 0 ? "var(--rust)" : undefined }}>{formatMoney(owe, cur)}</dd>
          </div>
          <div>
            <dt>Ours, all told</dt>
            <dd>{formatMoney(have - owe, cur)}</dd>
          </div>
        </dl>
      )}

      {STEPS.map((s, i) => {
        const rows = list.filter((a) => s.types.includes(a.type));
        return (
          <section key={s.id} className="card stack" aria-labelledby={`step-${s.id}`}>
            <div className="row between" style={{ flexWrap: "nowrap", alignItems: "flex-start" }}>
              <span className="stack" style={{ gap: 2 }}>
                <h2 id={`step-${s.id}`}>
                  <span className="mono muted" style={{ marginRight: 8 }}>{i + 1}</span>
                  {s.title}
                </h2>
                <span className="small muted">{s.text}</span>
              </span>
              {done(s) && <span className="pill green">✓ {rows.length}</span>}
            </div>
            {rows.map((a) => (
              <div key={a.id} className="row between" style={{ flexWrap: "nowrap", borderTop: "1px dashed var(--line)", paddingTop: 10, alignItems: "flex-start" }}>
                <span className="stack" style={{ gap: 2, minWidth: 0 }}>
                  <strong>
                    {a.name} <span className="small muted">· {typeInfo(a.type).label}</span>
                  </strong>
                  <span className="small muted">{accountLine(a, cur)}</span>
                </span>
                <AccountAmount a={a} cur={cur} />
              </div>
            ))}
            {canWrite &&
              (adding === s.id ? (
                <AccountForm household={household} accounts={list} goals={goals} initialType={s.types[0]} types={s.types} onCancel={() => setAdding(null)} onSaved={saved} />
              ) : (
                <button type="button" className={rows.length ? "secondary" : undefined} style={{ alignSelf: "flex-start" }} onClick={() => setAdding(s.id)}>
                  {rows.length ? "Add another" : s.id === "money" ? "Add an account" : s.id === "deposits" ? "Add a fixed deposit" : "Add a loan or card"}
                </button>
              ))}
            {s.id === "owed" && !rows.length && <span className="small muted">Nothing owed? Skip this one.</span>}
            {s.id === "owed" && (
              <span className="small muted">
                A running tab with a shop, relative or friend?{" "}
                <a href={`/h/${household.id}/family/contacts`} onClick={onLinkClick}>
                  {contacts.length ? `Contacts (${contacts.length})` : "Add them as contacts"}
                </a>
                , each with its own khata.
              </span>
            )}
          </section>
        );
      })}

      <section className="card stack" aria-labelledby="step-month">
        <div className="row between" style={{ flexWrap: "nowrap", alignItems: "flex-start" }}>
          <span className="stack" style={{ gap: 2 }}>
            <h2 id="step-month">
              <span className="mono muted" style={{ marginRight: 8 }}>4</span>A usual month
            </h2>
            <span className="small muted">
              Roughly what comes in and goes out in a normal month. The Plan uses it until the book has two full months of its own, then switches to the real figures.
            </span>
          </span>
          {typicalSaved && <span className="pill green">✓</span>}
        </div>
        <form className="row" style={{ alignItems: "flex-end" }} onSubmit={saveTypical}>
          <label style={{ flex: "1 1 160px" }}>
            Comes in (salary, rent, interest)
            <input inputMode="decimal" value={income} disabled={!canWrite} onChange={(e) => { setIncome(e.target.value); setTypicalSaved(false); }} />
          </label>
          <label style={{ flex: "1 1 160px" }}>
            Goes out (everyday spending)
            <input inputMode="decimal" value={spend} disabled={!canWrite} onChange={(e) => { setSpend(e.target.value); setTypicalSaved(false); }} />
          </label>
          {canWrite && (
            <button type="submit" className="secondary">
              Save
            </button>
          )}
        </form>
        <span className="small muted">Leave loan installments out of "goes out"; the book already knows them.</span>
      </section>

      {goals.length > 0 && holders.length > 0 && (
        <section className="card stack" aria-labelledby="step-goals">
          <h2 id="step-goals">Money already set aside for goals</h2>
          <span className="small muted">
            If an account or FD is kept for a goal, say so: the goal then counts that account's balance as saved, and the Plan starts from it.
          </span>
          {holders.map((a) => (
            <div key={a.id} className="row between" style={{ borderTop: "1px dashed var(--line)", paddingTop: 10 }}>
              <span>
                {a.name} <span className="small muted mono">{formatMoney(a.balanceMinor, cur)}</span>
              </span>
              <select aria-label={`Goal for ${a.name}`} value={a.goalId ?? ""} disabled={!canWrite} onChange={(e) => holdFor(a, e.target.value)} style={{ maxWidth: 240 }}>
                <option value="">Not for a goal</option>
                {goals.map((g) => (
                  <option key={g.id} value={g.id}>
                    For {g.name}
                  </option>
                ))}
              </select>
            </div>
          ))}
          <span className="small muted">Already given a baina or an advance? Open the goal on the Plan and choose Add money › Paid toward it.</span>
        </section>
      )}

      {progress >= 1 && (
        <div className="row">
          <a className="button" href={`/h/${household.id}`} onClick={onLinkClick}>
            See Today
          </a>
          <a className="button secondary" href={`/h/${household.id}/plan`} onClick={onLinkClick}>
            See the Plan
          </a>
        </div>
      )}
    </>
  );
}
