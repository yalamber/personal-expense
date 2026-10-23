import { useState } from "react";
import { todayIn } from "../../../shared/dates";
import { daysBetween } from "../../../shared/deposit";
import { Meter } from "../charts";
import { worth } from "../../../shared/worth";
import { api, ApiError, paths, type Account, type Goal, type Household } from "../api";
import { useQuery } from "../query";
import { PageSkeleton } from "../skeleton";
import { onLinkClick } from "../router";
import { Icon, formatMoney, shortDate } from "../ui";
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
export function Accounts({ household, version, onChanged }: { household: Household; version: number; onChanged: () => void }) {
  const aq = useQuery<Account[]>(paths.accounts(household.id), [version]);
  const gq = useQuery<Goal[]>(paths.goals(household.id), [version]);
  const rows = aq.data ?? null;
  const goals = (gq.data ?? []).filter((x) => !x.completedAt);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<{ id: string; panel: Panel } | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const canWrite = household.me.role !== "viewer";
  const cur = household.currency;


  const live = (rows ?? []).filter((a) => !a.closedAt);
  const closed = (rows ?? []).filter((a) => a.closedAt && a.type !== "person");
  const { haveMinor: have, oweMinor: owe } = worth(live);
  const contacts = live.filter((a) => a.type === "person");
  const toggle = (id: string, panel: Panel) => setOpen(open?.id === id && open.panel === panel ? null : { id, panel });

  async function close(a: Account) {
    if (!window.confirm(`Close ${a.name}? Its history stays; it leaves the totals.`)) return;
    try {
      await api.closeAccount(household.id, a.id, {});
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not close it");
    }
  }

  async function reopen(a: Account) {
    try {
      await api.updateAccount(household.id, a.id, { closed: false });
      onChanged();
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
      {(error ?? aq.error) && <div className="error">{error ?? aq.error}</div>}
      {!rows && !aq.error && <PageSkeleton kind="list" />}

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

      {contacts.length > 0 && (
        <a className="card row between" href={`/h/${household.id}/khata`} onClick={onLinkClick} style={{ flexWrap: "nowrap", textDecoration: "none", color: "inherit" }}>
          <span>
            <strong>Khata</strong>{" "}
            <span className="small muted">
            · {contacts.length} · we owe {formatMoney(contacts.reduce((s, a) => s + Math.max(0, -a.balanceMinor), 0), cur)} · owed to us{" "}
            {formatMoney(contacts.reduce((s, a) => s + Math.max(0, a.balanceMinor), 0), cur)}
            </span>
          </span>
          <Icon.next />
        </a>
      )}

      {adding && (
        <AccountForm
          household={household}
          accounts={rows ?? []}
          goals={goals}
          onCancel={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            onChanged();
          }}
        />
      )}

      {rows && rows.length === 0 && !adding && (
        <div className="card stack">
          <strong>No accounts yet.</strong>
          <span className="muted">
            The quickest way in is the{" "}
            <a href={`/h/${household.id}/settings/start`} onClick={onLinkClick}>
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
                    {a.type === "deposit" && a.deposit && a.startDate && a.endDate && (
                      <span style={{ display: "block", maxWidth: 360, marginTop: 6 }}>
                        <Meter value={Math.max(0, daysBetween(a.startDate, a.endDate) - a.deposit.daysToMaturity)} max={daysBetween(a.startDate, a.endDate)} compact left={`from ${shortDate(a.startDate)}`} right={a.deposit.daysToMaturity > 0 ? `${a.deposit.daysToMaturity} days to go` : "matured"} />
                      </span>
                    )}
                    {a.type === "loan" && a.loan && a.principalMinor && a.principalMinor > 0 && (
                      <span style={{ display: "block", maxWidth: 360, marginTop: 6 }}>
                        <Meter value={Math.max(0, a.principalMinor - a.loan.owedMinor)} max={a.principalMinor} compact left={`${formatMoney(Math.max(0, a.principalMinor - a.loan.owedMinor), cur, { symbol: false })} paid off`} right={`of ${formatMoney(a.principalMinor, cur, { symbol: false })}`} />
                      </span>
                    )}
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
                    {open.panel === "edit" && <AccountForm household={household} accounts={rows ?? []} goals={goals} initial={a} onCancel={() => setOpen(null)} onSaved={() => { setOpen(null); onChanged(); }} />}
                    {open.panel === "check" && <BalanceCheck household={household} account={a} onDone={() => onChanged()} />}
                    {open.panel === "repay" && <RepaymentForm household={household} account={a} accounts={rows ?? []} onDone={() => onChanged()} />}
                    {open.panel === "mature" && <MaturityForm household={household} account={a} accounts={rows ?? []} onDone={() => { setOpen(null); onChanged(); }} />}
                    {open.panel === "csv" && <CsvImport household={household} account={a} onCancel={() => setOpen(null)} onDone={() => { setOpen(null); onChanged(); }} />}
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
