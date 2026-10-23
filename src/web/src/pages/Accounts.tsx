import { useCallback, useEffect, useState } from "react";
import { todayIn } from "../../../shared/dates";
import { api, ApiError, type Account, type Goal, type Household } from "../api";
import { onLinkClick } from "../router";
import { formatMoney, shortDate } from "../ui";
import { AccountAmount, AccountForm, GROUPS, MaturityForm, RepaymentForm, accountLine, typeInfo } from "./accountsKit";
import { CsvImport } from "./CsvImport";

/**
 * "What does the bank say?" The first figure starts the book for the account; later ones are
 * compared with it, and a difference becomes a balance question in Decide.
 */
function BalanceCheck({ household, account, onDone }: { household: Household; account: Account; onDone: () => void }) {
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(todayIn(household.timezone));
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cur = household.currency;
  const owed = account.type === "credit" || account.type === "loan";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const r = await api.bankBalance(household.id, account.id, { amount, date });
      setResult(
        r.startedBook
          ? `The book for ${account.name} starts from ${formatMoney(Math.abs(r.bankMinor), cur)} on ${shortDate(date)}.`
          : r.matches
            ? "The book matches the bank."
            : `The book says ${formatMoney(Math.abs(r.bookMinor ?? 0), cur)}. The difference is waiting in Decide.`,
      );
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not check the balance");
    }
  }

  return (
    <form className="stack" onSubmit={submit} style={{ gap: 8 }}>
      <div className="row" style={{ alignItems: "flex-end" }}>
        <label style={{ flex: "1 1 160px" }}>
          {owed ? "What the bank says is owed" : "Balance the bank shows"}
          <input required inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label style={{ flex: "1 1 140px" }}>
          At the end of
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <button type="submit" className="secondary">
          Check against the book
        </button>
      </div>
      {result && <div className="ok small">{result}</div>}
      {error && <div className="error small">{error}</div>}
    </form>
  );
}

type Panel = "edit" | "check" | "repay" | "mature" | "csv" | null;

/** Accounts: where the money is and what is owed, grouped, with today's balances. */
export function Accounts({ household }: { household: Household }) {
  const [rows, setRows] = useState<Account[] | null>(null);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<{ id: string; panel: Panel } | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const canWrite = household.me.role !== "viewer";
  const cur = household.currency;

  const load = useCallback(async () => {
    try {
      const [a, g] = await Promise.all([api.accounts(household.id), api.goals(household.id)]);
      setRows(a);
      setGoals(g.filter((x) => !x.completedAt));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load accounts");
    }
  }, [household.id]);
  useEffect(() => {
    void load();
  }, [load]);

  const live = (rows ?? []).filter((a) => !a.closedAt);
  const closed = (rows ?? []).filter((a) => a.closedAt);
  const have = live.filter((a) => a.type !== "credit" && a.type !== "loan").reduce((s, a) => s + a.balanceMinor, 0);
  const owe = live.filter((a) => a.type === "credit" || a.type === "loan").reduce((s, a) => s - a.balanceMinor, 0);
  const toggle = (id: string, panel: Panel) => setOpen(open?.id === id && open.panel === panel ? null : { id, panel });

  async function close(a: Account) {
    if (!window.confirm(`Close ${a.name}? Its history stays; it leaves the totals.`)) return;
    try {
      await api.closeAccount(household.id, a.id, {});
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not close it");
    }
  }

  async function reopen(a: Account) {
    try {
      await api.updateAccount(household.id, a.id, { closed: false });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not reopen it");
    }
  }

  return (
    <>
      <div className="row between" style={{ alignItems: "flex-end" }}>
        <div className="stack" style={{ gap: 4 }}>
          <h1>Accounts</h1>
          <span className="muted">Today's balances, from each account's starting balance plus everything since.</span>
        </div>
        {canWrite && !adding && (
          <button type="button" onClick={() => setAdding(true)}>
            Add an account
          </button>
        )}
      </div>
      {error && <div className="error">{error}</div>}

      {live.length > 0 && (
        <dl className="ledger-sum" style={{ maxWidth: 520 }}>
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

      {adding && (
        <AccountForm
          household={household}
          accounts={rows ?? []}
          goals={goals}
          onCancel={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            void load();
          }}
        />
      )}

      {rows && rows.length === 0 && !adding && (
        <div className="card stack">
          <strong>No accounts yet.</strong>
          <span className="muted">
            The quickest way in is the{" "}
            <a href={`/h/${household.id}/family/start`} onClick={onLinkClick}>
              starting point
            </a>
            : today's balances, fixed deposits and loans in a couple of minutes.
          </span>
        </div>
      )}

      {GROUPS.map((g) => {
        const list = live.filter((a) => typeInfo(a.type).group === g.id);
        if (!list.length) return null;
        const total = list.reduce((s, a) => s + a.balanceMinor, 0);
        return (
          <section key={g.id} className="card" aria-labelledby={`grp-${g.id}`}>
            <div className="row between" style={{ paddingBottom: 6 }}>
              <h2 id={`grp-${g.id}`}>{g.label}</h2>
              <span className="mono" style={{ fontWeight: 600 }}>
                {formatMoney(g.id === "owed" ? -total : total, cur)}
              </span>
            </div>
            {list.map((a) => (
              <div key={a.id} style={{ borderTop: "1px dashed var(--line)", padding: "12px 0" }}>
                <div className="row between" style={{ flexWrap: "nowrap", alignItems: "flex-start" }}>
                  <span className="stack" style={{ gap: 2, minWidth: 0 }}>
                    <strong>
                      {a.name} <span className="pill grey" style={{ marginLeft: 6 }}>{typeInfo(a.type).label}</span>
                      {a.goalName && <span className="pill green" style={{ marginLeft: 6 }}>for {a.goalName}</span>}
                    </strong>
                    <span className="small muted">{accountLine(a, cur)}</span>
                    {a.type === "deposit" && a.deposit && a.deposit.daysToMaturity <= 14 && (
                      <span className="small warn">{a.deposit.daysToMaturity < 0 ? "Matured" : `Matures in ${a.deposit.daysToMaturity} days`}: renew or close it below.</span>
                    )}
                    {!a.openingBalanceDate && a.type !== "deposit" && <span className="small warn">No starting balance yet: edit it to add today's balance.</span>}
                  </span>
                  <AccountAmount a={a} cur={cur} />
                </div>
                {canWrite && (
                  <div className="row" style={{ gap: 4, marginTop: 6 }}>
                    <button type="button" className="link small" onClick={() => toggle(a.id, "edit")}>Edit</button>
                    {(a.type === "loan" || a.type === "lent") && (
                      <button type="button" className="link small" onClick={() => toggle(a.id, "repay")}>
                        {a.type === "loan" ? "Log a payment" : "Money came back"}
                      </button>
                    )}
                    {a.type === "deposit" && <button type="button" className="link small" onClick={() => toggle(a.id, "mature")}>Renew or close</button>}
                    {a.type !== "deposit" && a.type !== "lent" && a.type !== "cash" && (
                      <button type="button" className="link small" onClick={() => toggle(a.id, "check")}>Check balance</button>
                    )}
                    {(a.type === "checking" || a.type === "savings" || a.type === "credit") && (
                      <button type="button" className="link small" onClick={() => toggle(a.id, "csv")}>Import CSV</button>
                    )}
                    {a.type !== "deposit" && <button type="button" className="link small" onClick={() => close(a)}>Close</button>}
                  </div>
                )}
                {open?.id === a.id && (
                  <div style={{ marginTop: 8 }}>
                    {open.panel === "edit" && <AccountForm household={household} accounts={rows ?? []} goals={goals} initial={a} onCancel={() => setOpen(null)} onSaved={() => { setOpen(null); void load(); }} />}
                    {open.panel === "check" && <BalanceCheck household={household} account={a} onDone={() => void load()} />}
                    {open.panel === "repay" && <RepaymentForm household={household} account={a} accounts={rows ?? []} onDone={() => void load()} />}
                    {open.panel === "mature" && <MaturityForm household={household} account={a} accounts={rows ?? []} onDone={() => { setOpen(null); void load(); }} />}
                    {open.panel === "csv" && <CsvImport household={household} account={a} onCancel={() => setOpen(null)} onDone={() => { setOpen(null); void load(); }} />}
                  </div>
                )}
              </div>
            ))}
          </section>
        );
      })}

      {closed.length > 0 && (
        <section className="card stack" aria-label="Closed accounts">
          <button type="button" className="link" style={{ alignSelf: "flex-start" }} onClick={() => setShowClosed((v) => !v)}>
            {showClosed ? "Hide" : "Show"} {closed.length} closed {closed.length === 1 ? "account" : "accounts"}
          </button>
          {showClosed &&
            closed.map((a) => (
              <div key={a.id} className="kv">
                <span>
                  {a.name} <span className="small muted">· {typeInfo(a.type).label}</span>
                </span>
                {canWrite && (
                  <button type="button" className="link small" onClick={() => reopen(a)}>
                    Reopen
                  </button>
                )}
              </div>
            ))}
        </section>
      )}
    </>
  );
}
