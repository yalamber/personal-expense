import { useCallback, useEffect, useMemo, useState } from "react";
import { lateLabel, monthName } from "../../../shared/plan";
import { api, ApiError, type Account, type AccountType, type Category, type Goal, type Household, type Today as TodayData, type Transaction } from "../api";
import { onLinkClick } from "../router";
import { CategorySelect, Checks, Icon, MonthSwitcher, categoryLabel, dayLabel, formatMoney, shortDate } from "../ui";

/** Accounts that get bank statements; deposits, loans and money lent are kept by the family. */
const STATEMENT_TYPES: AccountType[] = ["checking", "savings", "credit", "wallet"];

/** Today: one number that connects tonight's dinner to the land date, then the book itself. */
export function Today({
  household,
  accounts,
  categories,
  goals,
  version,
  onChanged,
  onLog,
}: {
  household: Household;
  accounts: Account[];
  categories: Category[];
  goals: Goal[];
  version: number;
  onChanged: () => void;
  onLog: () => void;
}) {
  const [data, setData] = useState<TodayData | null>(null);
  const [month, setMonth] = useState<string | null>(null);
  const [txs, setTxs] = useState<Transaction[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cur = household.currency;
  const canWrite = household.me.role !== "viewer";

  const load = useCallback(async () => {
    try {
      const t = await api.today(household.id);
      setData(t);
      const m = month ?? t.month;
      if (!month) setMonth(m);
      setTxs(await api.transactions(household.id, m));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load today");
    }
  }, [household.id, month]);

  useEffect(() => {
    void load();
  }, [load, version]);

  const byDay = useMemo(() => {
    const groups = new Map<string, Transaction[]>();
    for (const t of (txs ?? []).slice(0, all ? undefined : 40)) groups.set(t.date, [...(groups.get(t.date) ?? []), t]);
    return [...groups.entries()];
  }, [txs, all]);

  if (error) return <div className="error">{error}</div>;
  if (!data) return <p className="muted">Opening the book…</p>;

  const weekday = new Date(`${data.today}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  const nothingYet = data.incomeMinor === 0 && data.spentMinor === 0;
  const over = data.everydayLeftMinor < 0;
  const goalName = (id: string | null) => goals.find((g) => g.id === id)?.name;
  const people = accounts.filter((a) => a.type === "person" && !a.closedAt);
  const weOwe = people.reduce((s, a) => s + Math.max(0, -a.balanceMinor), 0);
  const theyOwe = people.reduce((s, a) => s + Math.max(0, a.balanceMinor), 0);

  return (
    <>
      <section className="hero" aria-label="This month at a glance">
        <div className="headline">
          <span className="eyebrow">
            {weekday} · {data.daysLeft} {data.daysLeft === 1 ? "day" : "days"} to payday
          </span>
          <h1>
            {nothingYet
              ? "Log this month's income, and the book will tell you what a day can cost."
              : over
                ? `This month is ${formatMoney(-data.everydayLeftMinor, cur)} past the plan.`
                : `${formatMoney(data.perDayMinor, cur)} a day keeps everything on plan.`}
          </h1>
          {data.bookMatchesThrough ? (
            <span className="trust">
              <Checks confirmed /> The book matches the bank through {shortDate(data.bookMatchesThrough)}
            </span>
          ) : data.bank.every((b) => !b.lastLineDate) ? (
            <span className="trust">
              <Checks confirmed={false} /> Everything here is logged by the family. Forward a bank email to have it double-checked.
            </span>
          ) : null}
        </div>
        <dl className="ledger-sum">
          <div>
            <dt>{data.incomeExpected ? "Expected in" : "Came in"}</dt>
            <dd className="amount-in">{formatMoney(data.incomeMinor, cur, { sign: true, symbol: false })}</dd>
          </div>
          <div>
            <dt>Spent so far</dt>
            <dd>{formatMoney(-data.spentMinor, cur, { symbol: false })}</dd>
          </div>
          <div>
            <dt>To the goals</dt>
            <dd>{formatMoney(data.goalsMinor, cur, { symbol: false })}</dd>
          </div>
          {data.loansMinor > 0 && (
            <div>
              <dt>Loan installments</dt>
              <dd>{formatMoney(data.loansMinor, cur, { symbol: false })}</dd>
            </div>
          )}
          <div>
            <dt>For everyday things</dt>
            <dd style={{ color: over ? "var(--rust)" : undefined }}>{formatMoney(data.everydayLeftMinor, cur, { symbol: false })}</dd>
          </div>
        </dl>
      </section>

      {data.needsStart && canWrite && (
        <a className="banner" href={`/h/${household.id}/family/start`} onClick={onLinkClick}>
          <Icon.plus />
          <span style={{ flex: "1 1 auto" }}>Start from today: add your balances, fixed deposits and loans, and the numbers are right from day one.</span>
          <Icon.next />
        </a>
      )}

      {data.decideCount > 0 && (
        <a className="banner" href={`/h/${household.id}/decide`} onClick={onLinkClick}>
          <span className="count">{data.decideCount}</span>
          <span style={{ flex: "1 1 auto" }}>
            {data.decideCount === 1 ? "decision waiting" : "decisions waiting"} · about {Math.max(1, Math.round(data.decideCount * 0.5))} {data.decideCount > 2 ? "minutes" : "minute"}
          </span>
          <Icon.next />
        </a>
      )}

      <div className="columns">
        <div className="main">
          <section className="card book" aria-labelledby="book-h" style={{ paddingTop: 8 }}>
            <div className="row between" style={{ padding: "12px 0 4px" }}>
              <h2 id="book-h">The book</h2>
              <span className="mono small muted">✓ logged by family · ✓✓ confirmed by the bank</span>
            </div>
            {txs && txs.length === 0 && (
              <div className="stack" style={{ padding: "18px 0" }}>
                <span className="muted">Nothing in the book for this month yet.</span>
                {canWrite && (
                  <div>
                    <button type="button" onClick={onLog}>
                      <Icon.plus /> Log the first one
                    </button>
                  </div>
                )}
              </div>
            )}
            {byDay.map(([date, rows]) => (
              <div key={date}>
                <div className="day-head">{dayLabel(date, data.today)}</div>
                {rows.map((t) => (
                  <BookRow
                    key={t.id}
                    tx={t}
                    household={household}
                    categories={categories}
                    goalName={goalName(t.goalId)}
                    open={open === t.id}
                    canEdit={canWrite && !(t.isPersonal && t.paidByMemberId !== household.me.id)}
                    onToggle={() => setOpen(open === t.id ? null : t.id)}
                    onChanged={() => {
                      void load();
                      onChanged();
                    }}
                  />
                ))}
              </div>
            ))}
            <div className="row between" style={{ paddingTop: 12 }}>
              {txs && txs.length > 40 && !all ? (
                <button type="button" className="link" onClick={() => setAll(true)}>
                  Show all {txs.length} this month
                </button>
              ) : (
                <span />
              )}
              {month && <MonthSwitcher month={month} onChange={(m) => { setMonth(m); setAll(false); }} />}
            </div>
          </section>
        </div>

        <aside className="side">
          <section className="card stack" aria-labelledby="env-h">
            <div className="row between">
              <h2 id="env-h">Envelopes</h2>
              <a className="small" href={`/h/${household.id}/family/envelopes`} onClick={onLinkClick}>
                {data.envelopes.length ? "Change" : "Set them"}
              </a>
            </div>
            {data.envelopes.length === 0 && <span className="small muted">Give a few categories a monthly amount, and they show here as envelopes filling up.</span>}
            {data.envelopes.map((e) => {
              const left = e.budgetMinor - e.spentMinor;
              return (
                <div key={e.categoryId} className="envelope">
                  <div className="row between small" style={{ flexWrap: "nowrap" }}>
                    <span style={{ fontWeight: 500 }}>{e.name}</span>
                    <span className="mono" style={{ color: left < 0 ? "var(--rust)" : "var(--ink-soft)" }}>
                      {left < 0 ? `over by ${formatMoney(-left, cur, { symbol: false })}` : `${formatMoney(left, cur, { symbol: false })} left`}
                    </span>
                  </div>
                  <div className="track" aria-hidden="true">
                    <div className={`fill ${left < 0 ? "over" : ""}`} style={{ width: `${Math.min(100, Math.max(0, (e.spentMinor / e.budgetMinor) * 100))}%` }} />
                  </div>
                </div>
              );
            })}
          </section>

          {!data.needsStart && (
            <section className="card stack" aria-labelledby="worth-h" style={{ gap: 6 }}>
              <div className="row between">
                <h2 id="worth-h">What we have</h2>
                <a className="small" href={`/h/${household.id}/family/accounts`} onClick={onLinkClick}>
                  Accounts
                </a>
              </div>
              <span className="display" style={{ fontSize: 26 }}>{formatMoney(data.worth.netMinor, cur)}</span>
              <div className="kv small">
                <span className="muted">Held, with FDs and money owed to us</span>
                <span className="mono">{formatMoney(data.worth.haveMinor, cur, { symbol: false })}</span>
              </div>
              {data.worth.oweMinor !== 0 && (
                <div className="kv small">
                  <span className="muted">Owed on loans, cards and to people</span>
                  <span className="mono" style={{ color: "var(--rust)" }}>−{formatMoney(data.worth.oweMinor, cur, { symbol: false })}</span>
                </div>
              )}
              {data.worth.accruedMinor > 0 && (
                <div className="kv small">
                  <span className="muted">FD interest earned so far</span>
                  <span className="mono amount-in">+{formatMoney(data.worth.accruedMinor, cur, { symbol: false })}</span>
                </div>
              )}
            </section>
          )}

          {people.length > 0 && (
            <section className="card stack" aria-labelledby="khata-h" style={{ gap: 4 }}>
              <div className="row between">
                <h2 id="khata-h">Khata</h2>
                <a className="small" href={`/h/${household.id}/khata`} onClick={onLinkClick}>
                  All {people.length}
                </a>
              </div>
              {weOwe > 0 && (
                <div className="kv">
                  <span className="muted">We owe</span>
                  <span className="mono" style={{ color: "var(--rust)" }}>{formatMoney(weOwe, cur, { symbol: false })}</span>
                </div>
              )}
              {theyOwe > 0 && (
                <div className="kv">
                  <span className="muted">Owed to us</span>
                  <span className="mono amount-in">{formatMoney(theyOwe, cur, { symbol: false })}</span>
                </div>
              )}
              {weOwe === 0 && theyOwe === 0 && <span className="small muted">All settled.</span>}
              {weOwe > 0 && <span className="small muted">{people.filter((a) => a.balanceMinor < 0).sort((a, b) => a.balanceMinor - b.balanceMinor).slice(0, 3).map((a) => a.name).join(", ")}</span>}
            </section>
          )}

          <section className="card" aria-labelledby="bank-h">
            <h2 id="bank-h" style={{ marginBottom: 6 }}>The bank and the book</h2>
            {accounts.length === 0 && <span className="small muted">No accounts yet.</span>}
            {data.bank.filter((b) => STATEMENT_TYPES.includes(b.type)).map((b) => (
              <div key={b.accountId} className="kv">
                <span className="stack" style={{ gap: 0 }}>
                  {b.name}
                  <span className="small muted mono">
                    {b.type === "credit" ? `${formatMoney(-b.balanceMinor, cur, { symbol: false })} owed` : formatMoney(b.balanceMinor, cur, { symbol: false })}
                  </span>
                </span>
                {b.questions > 0 ? (
                  <a href={`/h/${household.id}/decide`} onClick={onLinkClick} style={{ fontWeight: 600, color: "var(--marigold-deep)" }}>
                    Balance question
                  </a>
                ) : b.lastLineDate ? (
                  <span className="row small" style={{ gap: 6, color: "var(--green-deep)" }}>
                    through {shortDate(b.lastLineDate)} <Checks confirmed />
                  </span>
                ) : (
                  <span className="small muted">no statements yet</span>
                )}
              </div>
            ))}
            <p className="small muted" style={{ margin: "8px 0 0" }}>
              Statements arrive by email and check themselves against the book. Only the odd ones ask for you.{" "}
              <a href={`/h/${household.id}/family/forwarding`} onClick={onLinkClick}>
                Set up forwarding
              </a>
            </p>
          </section>

          {data.nextGoal ? (
            <section className="card night stack" aria-labelledby="next-h" style={{ gap: 10 }}>
              <h2 id="next-h" className="display" style={{ fontSize: 21 }}>
                Next on the road: {data.nextGoal.name}.
              </h2>
              <div className="row between small muted">
                <span>
                  {formatMoney(data.nextGoal.savedMinor, cur)} of {formatMoney(data.nextGoal.targetMinor, cur, { symbol: false })}
                </span>
                <span>{data.nextGoal.outcome?.doneMonth && data.nextGoal.outcome.doneMonth !== "now" ? monthName(data.nextGoal.outcome.doneMonth) : ""}</span>
              </div>
              <div className="progress" aria-hidden="true">
                <div style={{ width: `${Math.min(100, (data.nextGoal.savedMinor / Math.max(1, data.nextGoal.targetMinor)) * 100)}%` }} />
              </div>
              <span className="small muted">
                {data.nextGoal.outcome?.lateMonths !== null && data.nextGoal.outcome?.lateMonths !== undefined
                  ? `At the current plan: ${lateLabel(data.nextGoal.outcome.lateMonths)}.`
                  : `${formatMoney(data.nextGoal.monthlyPlanMinor, cur)} a month goes in.`}
              </span>
              <a href={`/h/${household.id}/plan`} onClick={onLinkClick} style={{ fontWeight: 600, fontSize: 14 }}>
                The whole road
              </a>
            </section>
          ) : (
            <section className="card night stack" style={{ gap: 10 }}>
              <h2 className="display" style={{ fontSize: 21 }}>What are you saving for?</h2>
              <span className="small muted">Land, a house, college, a cushion for bad months. Add one and see when it lands.</span>
              <a href={`/h/${household.id}/plan/new`} onClick={onLinkClick} style={{ fontWeight: 600, fontSize: 14 }}>
                Add a goal
              </a>
            </section>
          )}
        </aside>
      </div>
    </>
  );
}

function BookRow({
  tx,
  household,
  categories,
  goalName,
  open,
  canEdit,
  onToggle,
  onChanged,
}: {
  tx: Transaction;
  household: Household;
  categories: Category[];
  goalName: string | undefined;
  open: boolean;
  canEdit: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const [note, setNote] = useState(tx.note ?? "");
  const [error, setError] = useState<string | null>(null);
  const isMove = Boolean(tx.transferPairId || tx.direction === "transfer" || tx.goalId);
  const name = tx.merchantName ?? tx.description ?? "(no description)";
  const confirmed = tx.source !== "manual" || Boolean(tx.confirmedAt);
  const sign = isMove ? "" : tx.direction === "in" ? "+" : "−";
  const meta = [goalName ? `Toward ${goalName}` : isMove ? "Move between accounts" : categoryLabel(categories, tx.categoryId), tx.accountName, tx.paidByName, tx.isPersonal ? "personal" : null, tx.note]
    .filter(Boolean)
    .join(" · ");

  async function update(body: { categoryId?: string | null; note?: string }) {
    setError(null);
    try {
      await api.updateTransaction(household.id, tx.id, body);
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save");
    }
  }

  async function remove() {
    const what = tx.transferPairId ? "both sides of this move" : "this entry";
    if (!window.confirm(`Remove ${what}? It stays in the history as removed.`)) return;
    try {
      await api.voidTransaction(household.id, tx.id);
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not remove it");
    }
  }

  return (
    <>
      <button type="button" className="book-row" aria-expanded={open} onClick={onToggle}>
        <span className={`avatar ${tx.direction === "in" || isMove ? "in" : ""}`} aria-hidden="true">
          {name.slice(0, 1).toUpperCase()}
        </span>
        <span className="what">
          <strong>{name}</strong>
          <span>{meta}</span>
        </span>
        <span className="amount">
          <span className={tx.direction === "in" && !isMove ? "amount-in" : ""}>
            {sign}
            {formatMoney(tx.amountMinor, household.currency, { symbol: false })}
          </span>
          <Checks confirmed={confirmed} />
        </span>
      </button>
      {open && (
        <div className="book-edit">
          <span className="small muted">
            {confirmed ? (tx.source === "manual" ? "Logged by the family and confirmed by the bank." : `From the bank (${tx.source}).`) : "Logged by the family. It is confirmed when a statement shows the same payment."}
          </span>
          {canEdit ? (
            <>
              {!isMove && (
                <label>
                  Category
                  <CategorySelect categories={categories} value={tx.categoryId} onChange={(id) => update({ categoryId: id })} label={`Category for ${name}`} />
                </label>
              )}
              <div className="row" style={{ alignItems: "flex-end" }}>
                <label style={{ flex: "1 1 220px" }}>
                  Note
                  <input value={note} onChange={(e) => setNote(e.target.value)} />
                </label>
                <button type="button" className="secondary" onClick={() => update({ note })} disabled={note === (tx.note ?? "")}>
                  Save note
                </button>
                <button type="button" className="quiet" onClick={remove}>
                  Remove
                </button>
              </div>
            </>
          ) : (
            <span className="small muted">Only the person who paid can change a personal entry.</span>
          )}
          {error && <div className="error">{error}</div>}
        </div>
      )}
    </>
  );
}
