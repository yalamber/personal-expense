import { useMemo, useState } from "react";
import { addDays, monthRange } from "../../../shared/dates";
import { daysBetween } from "../../../shared/deposit";
import { lateLabel, monthName } from "../../../shared/plan";
import { spendOf, summarize } from "../../../shared/summary";
import { Bars, Lines, Meter, SERIES, Stacked } from "../charts";
import { api, ApiError, paths, type Account, type Category, type Goal, type Household, type Today as TodayData, type Transaction } from "../api";
import { useQuery } from "../query";
import { PageSkeleton } from "../skeleton";
import { onLinkClick } from "../router";
import { Pending } from "./Pending";
import { dueLine } from "./termsKit";
import { normalizeToday } from "../compat";
import { CategorySelect, Checks, Icon, MonthSwitcher, amountInput, categoryLabel, dayLabel, formatMoney, shortDate } from "../ui";

/**
 * Today: one figure (what a day can cost until payday), the month under it as one bar, anything
 * that needs the family, then the month day by day and the book, with what is coming up, where
 * the money went, what the family has and the next goal beside them.
 */
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
  const [month, setMonth] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const cur = household.currency;
  const canWrite = household.me.role !== "viewer";
  const tq = useQuery<TodayData>(paths.today(household.id), [version]);
  const data = useMemo(() => (tq.data ? normalizeToday(tq.data) : null), [tq.data]);
  const monthKey = month ?? data?.month ?? null;
  const xq = useQuery<Transaction[]>(monthKey ? paths.transactions(household.id, monthKey) : null, [version]);
  const txs = xq.data ?? null;
  const mq = useQuery<{ month: string; incomeMinor: number; spentMinor: number; savedMinor: number }[]>(paths.months(household.id, 6), [version]);
  // The pay period can start in last month: its first month's entries are read too.
  const periodStartMonth = data && data.period.from.slice(0, 7) !== data.month ? data.period.from.slice(0, 7) : null;
  const pq = useQuery<Transaction[]>(periodStartMonth ? paths.transactions(household.id, periodStartMonth) : null, [version]);
  const months = mq.data ?? [];
  const error = tq.error;

  const byDay = useMemo(() => {
    const groups = new Map<string, Transaction[]>();
    for (const t of (txs ?? []).slice(0, all ? undefined : 40)) groups.set(t.date, [...(groups.get(t.date) ?? []), t]);
    return [...groups.entries()];
  }, [txs, all]);

  if (error) return <div className="error">{error}</div>;
  if (!data) return <PageSkeleton kind="today" />;

  const weekday = new Date(`${data.today}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  const nothingYet = data.mode === "nothing";
  const waiting = data.mode === "waiting";
  const over = data.mode === "over";
  const base = `/h/${household.id}`;
  const goalName = (id: string | null) => goals.find((g) => g.id === id)?.name;
  const setAside = data.goalsMinor + data.loansMinor + data.billsMinor + data.savedOtherMinor;
  // The figure, and the sentence that says what it means.
  const figure = nothingYet ? "Log this month's income" : waiting ? "Nothing in yet" : over ? `${formatMoney(-data.everydayLeftMinor, cur)} over` : `${formatMoney(data.perDayMinor, cur)} a day`;
  const verdict = nothingYet
    ? "When it comes in, the book says what a day can cost until payday."
    : waiting
      ? `${formatMoney(data.spentMinor + setAside, cur)} is spent or set aside already. The day figure appears once income is logged.`
      : over
        ? "Spent and set aside, this month has gone past what came in."
        : data.mode === "unplanned"
          ? "to spend on everyday things until payday, with nothing set aside yet."
          : "to spend on everyday things until payday. The bills, the goals and the loans are already set aside.";
  // The month in pictures: spending by day against the pace, and where it went.
  const viewing = month ?? data.month;
  const isCurrent = viewing === data.month;
  // This month's view follows the pay period (payday to payday); other months are calendar months.
  const { from, to } = isCurrent ? data.period : monthRange(viewing);
  const byPayday = isCurrent && data.period.from !== monthRange(data.month).from;
  const kept = new Set(accounts.filter((a) => a.type === "deposit" || a.type === "loan" || a.type === "lent").map((a) => a.id));
  const rangeTxs = isCurrent ? [...(pq.data ?? []), ...(txs ?? [])].filter((t) => t.date >= from && t.date <= to) : (txs ?? []);
  const spendTxs = rangeTxs.filter((t) => !kept.has(t.accountId));
  const spentByDay = new Map<string, number>();
  for (const t of spendTxs) spentByDay.set(t.date, (spentByDay.get(t.date) ?? 0) + spendOf(t, categories));
  const lastDay = isCurrent && data.today < to ? data.today : to;
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  const budget = data.everydayLeftMinor + data.spentMinor;
  // Spent so far, day by day, against the straight line that spends the month's money evenly.
  let running = 0;
  const soFar = days.map((d) => (d > lastDay ? null : (running += spentByDay.get(d) ?? 0)));
  const onPlan = budget > 0 ? days.map((_, i) => Math.round((budget * (i + 1)) / days.length)) : null;
  const paceSeries = [{ name: "Spent so far", color: SERIES[0], values: soFar }, ...(onPlan ? [{ name: "On plan", color: "var(--muted)", values: onPlan }] : [])];
  const elapsed = Math.min(1, Math.max(0, (daysBetween(from, data.today) + 1) / (daysBetween(from, to) + 1)));
  const paceTone = budget <= 0 ? "serious" : data.spentMinor / budget <= elapsed ? "good" : data.spentMinor <= budget ? "warning" : "serious";
  const perTop = summarize(spendTxs, categories).perTop;
  const catRows = [...perTop.entries()]
    .filter(([, v]) => v > 0)
    .map(([id, v]) => ({ label: id ? categories.find((c) => c.id === id)?.name ?? "Other" : "Uncategorised", value: v }))
    .sort((a, b) => b.value - a.value);
  const topRows = catRows.length > 6 ? [...catRows.slice(0, 5), { label: "Everything else", value: catRows.slice(5).reduce((s, r) => s + r.value, 0) }] : catRows;
  // The months before the book began are not months of nothing; start at the first with entries.
  const history = months.slice(Math.max(0, months.findIndex((m) => m.incomeMinor || m.spentMinor)));
  const hasHistory = history.filter((m) => m.incomeMinor || m.spentMinor).length >= 2;
  const people = accounts.filter((a) => a.type === "person" && !a.closedAt);
  const weOwe = people.reduce((s, a) => s + Math.max(0, -a.balanceMinor), 0);
  const theyOwe = people.reduce((s, a) => s + Math.max(0, a.balanceMinor), 0);
  const dues = people
    .filter((a) => a.endDate && a.balanceMinor !== 0)
    .sort((a, b) => a.endDate!.localeCompare(b.endDate!))
    .slice(0, 2);
  const statementsThrough = data.bank.map((b) => b.lastLineDate).filter((d): d is string => Boolean(d)).sort().pop() ?? null;
  const incomeLabel = byPayday ? `since payday, ${shortDate(data.period.from)}` : "this month";

  return (
    <>
      <section className="hero" aria-label="This month at a glance">
        <div className="headline">
          <span className="eyebrow">
            {weekday} · {data.daysLeft} {data.daysLeft === 1 ? "day" : "days"} to payday ({shortDate(data.payday)})
          </span>
          <h1 className={nothingYet || waiting ? undefined : "figure"} aria-live="polite">
            {figure}
          </h1>
          <p className="verdict" style={{ margin: 0 }}>
            {verdict}
          </p>
          {!nothingYet && !waiting && (
            <div className="month-bar" aria-label="The month so far">
              <span className="small" style={{ color: "var(--ink-soft)" }}>
                <strong>{formatMoney(data.incomeMinor, cur)}</strong> came in {incomeLabel}
                {data.expectedLaterMinor > 0 ? `; ${formatMoney(data.expectedLaterMinor, cur)} more is expected under Every month and counts once it is in the book` : ""}.
              </span>
              <Stacked
                segments={
                  over
                    ? [
                        { label: "Came in", value: data.incomeMinor, color: SERIES[0] },
                        { label: "Over by", value: -data.everydayLeftMinor, color: "var(--rust)" },
                      ]
                    : [
                        { label: "Spent so far", value: data.spentMinor, color: SERIES[2] },
                        { label: "Set aside: goals, loans, bills", value: setAside, color: SERIES[1] },
                        { label: "For everyday things", value: data.everydayLeftMinor, color: SERIES[0] },
                      ]
                }
                format={(v) => formatMoney(v, cur, { symbol: false })}
              />
            </div>
          )}
          {data.mode === "unplanned" && canWrite && (
            <span className="small" style={{ color: "var(--ink-soft)" }}>
              Nothing is set aside yet, so the whole month reads as spending money. Add what comes{" "}
              <a href={`${base}/settings/every-month`} onClick={onLinkClick}>
                every month
              </a>{" "}
              and give the{" "}
              <a href={`${base}/plan`} onClick={onLinkClick}>
                goals
              </a>{" "}
              a monthly amount, and this figure means something.
            </span>
          )}
          {!nothingYet && <HowItWorks data={data} cur={cur} />}
          {data.bookMatchesThrough ? (
            <span className="trust">
              <Checks confirmed /> <span>The book matches the bank through {shortDate(data.bookMatchesThrough)}</span>
            </span>
          ) : statementsThrough ? (
            <span className="trust">
              <Checks confirmed /> <span>Bank statements read through {shortDate(statementsThrough)}</span>
            </span>
          ) : (
            <span className="trust">
              <Checks confirmed={false} />{" "}
              <span>
                Everything here is logged by the family.{" "}
                <a href={`${base}/settings/statements`} onClick={onLinkClick}>
                  Forward a bank email
                </a>{" "}
                to have it double-checked.
              </span>
            </span>
          )}
        </div>
      </section>

      {(data.needsStart && canWrite) || data.decideCount > 0 || data.mail.unread > 0 ? (
        <div className="needs" aria-label="Needs you">
          {data.needsStart && canWrite && (
            <a className="banner" href={`${base}/settings/start`} onClick={onLinkClick}>
              <Icon.plus />
              <span style={{ flex: "1 1 auto" }}>Start from today: add your balances, fixed deposits and loans, and the numbers are right from day one.</span>
              <Icon.next />
            </a>
          )}
          {data.decideCount > 0 && (
            <a className="banner" href={`${base}/decide`} onClick={onLinkClick}>
              <span className="count">{data.decideCount}</span>
              <span style={{ flex: "1 1 auto" }}>
                {data.decideCount === 1 ? "decision waiting" : "decisions waiting"} · about {Math.max(1, Math.round(data.decideCount * 0.5))} {data.decideCount > 2 ? "minutes" : "minute"}
              </span>
              <Icon.next />
            </a>
          )}
          {data.mail.unread > 0 && (
            <a className="banner" href={`${base}/settings/inbox`} onClick={onLinkClick}>
              <span className="count">{data.mail.unread}</span>
              <span style={{ flex: "1 1 auto" }}>{data.mail.unread === 1 ? "email the app could not read; the inbox says why" : "emails the app could not read; the inbox says why"}</span>
              <Icon.next />
            </a>
          )}
        </div>
      ) : null}

      <div className="columns">
        <div className="main">
          <section className="card stack" aria-labelledby="month-h">
            <div className="row between">
              <h2 id="month-h">{!isCurrent ? `${monthName(viewing)}, day by day` : byPayday ? "Since payday, day by day" : "This month, day by day"}</h2>
              <span className="small muted">
                {shortDate(from)} to {shortDate(to)}
              </span>
            </div>
            {isCurrent && budget > 0 && (
              <Meter value={data.spentMinor} max={budget} tone={paceTone} marker={elapsed} markerLabel="today" left={`Spent ${formatMoney(data.spentMinor, cur)}`} right={`${formatMoney(budget, cur)} for everyday things`} />
            )}
            {spendTxs.length > 0 ? (
              <Lines series={paceSeries} labels={days.map((d) => String(Number(d.slice(8))))} currency={cur} format={(v) => formatMoney(v, cur)} height={160} head="Day" />
            ) : (
              <span className="small muted">Nothing spent yet this month. The days fill in as you log.</span>
            )}
          </section>

          <section className="card book" aria-labelledby="book-h" style={{ paddingTop: 8 }}>
            <div className="row between" style={{ padding: "12px 0 4px" }}>
              <h2 id="book-h">The book</h2>
              <span className="mono small muted">✓ logged by family · ✓✓ confirmed by the bank</span>
            </div>
            <Pending household={household} accounts={accounts} goals={goals} />
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
                    onChanged={onChanged}
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

          {hasHistory && (
            <section className="card stack" aria-labelledby="months-h">
              <div className="row between">
                <h2 id="months-h">The last six months</h2>
                <span className="small muted">what came in, what was spent</span>
              </div>
              <Lines
                series={[
                  { name: "Came in", color: SERIES[0], values: history.map((m) => m.incomeMinor) },
                  { name: "Spent", color: SERIES[1], values: history.map((m) => m.spentMinor) },
                ]}
                labels={history.map((m) => monthName(m.month).slice(0, 3))}
                currency={cur}
                format={(v) => formatMoney(v, cur)}
                height={170}
              />
            </section>
          )}
        </div>

        <aside className="side">
          <ComingUp household={household} data={data} canWrite={canWrite} onChanged={onChanged} />

          {(topRows.length > 0 || data.envelopes.length > 0) && (
            <section className="card stack" aria-labelledby="where-h">
              <div className="row between">
                <h2 id="where-h">Where it went</h2>
                <a className="small" href={`${base}/settings/envelopes`} onClick={onLinkClick}>
                  {data.envelopes.length ? "Envelopes" : "Set envelopes"}
                </a>
              </div>
              {topRows.length > 0 ? <Bars rows={topRows} format={(v) => formatMoney(v, cur, { symbol: false })} /> : <span className="small muted">Nothing spent yet {incomeLabel}.</span>}
              {data.envelopes.length > 0 && (
                <div className="stack" style={{ gap: 6, paddingTop: 4 }}>
                  <span className="small" style={{ fontWeight: 600 }}>
                    Envelopes
                  </span>
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
                </div>
              )}
            </section>
          )}

          {!data.needsStart && (
            <section className="card stack" aria-labelledby="worth-h" style={{ gap: 6 }}>
              <div className="row between">
                <h2 id="worth-h">What we have</h2>
                <span className="row" style={{ gap: 10 }}>
                  <a className="small" href={`${base}/settings/accounts`} onClick={onLinkClick}>
                    Accounts
                  </a>
                  {people.length > 0 && (
                    <a className="small" href={`${base}/khata`} onClick={onLinkClick}>
                      Khata
                    </a>
                  )}
                </span>
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
              {(weOwe > 0 || theyOwe > 0) && (
                <div className="kv small" style={{ borderTop: "1px dashed var(--line)", paddingTop: 8, marginTop: 2 }}>
                  <span className="muted">Khata</span>
                  <span className="mono">
                    {weOwe > 0 && <span style={{ color: "var(--rust)" }}>we owe {formatMoney(weOwe, cur, { symbol: false })}</span>}
                    {weOwe > 0 && theyOwe > 0 ? " · " : ""}
                    {theyOwe > 0 && <span className="amount-in">owed to us {formatMoney(theyOwe, cur, { symbol: false })}</span>}
                  </span>
                </div>
              )}
              {dues.map((a) => {
                const due = dueLine(a, a.balanceMinor < 0 ? "owe" : "owed", data.today);
                return (
                  <a key={a.id} className="small" href={`${base}/khata/${a.id}`} onClick={onLinkClick} style={{ color: due?.late ? "var(--rust)" : "var(--marigold-deep)", textDecoration: "none" }}>
                    {a.name}: {due?.text}
                  </a>
                );
              })}
            </section>
          )}

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
              <a href={`${base}/plan`} onClick={onLinkClick} style={{ fontWeight: 600, fontSize: 14 }}>
                The whole plan
              </a>
            </section>
          ) : (
            <section className="card night stack" style={{ gap: 10 }}>
              <h2 className="display" style={{ fontSize: 21 }}>What are you saving for?</h2>
              <span className="small muted">Land, a house, college, a cushion for bad months. Add one and see when it lands.</span>
              <a href={`${base}/plan/new`} onClick={onLinkClick} style={{ fontWeight: 600, fontSize: 14 }}>
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
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState(amountInput(tx.amountMinor, household.currency));
  const [date, setDate] = useState(tx.date);
  const [desc, setDesc] = useState(tx.description ?? tx.merchantName ?? "");
  const [error, setError] = useState<string | null>(null);
  const isMove = Boolean(tx.transferPairId || tx.direction === "transfer" || tx.goalId);
  const name = tx.merchantName ?? tx.description ?? "(no description)";
  const confirmed = tx.source !== "manual" || Boolean(tx.confirmedAt);
  const sign = isMove ? "" : tx.direction === "in" ? "+" : "−";
  // The family's own figures can be corrected; the bank's stay as the bank wrote them.
  const ownFigures = tx.source === "manual" || tx.source === "recurring";
  const meta = [goalName ? `Toward ${goalName}` : isMove ? "Move between accounts" : categoryLabel(categories, tx.categoryId), tx.accountName, tx.paidByName, tx.isPersonal ? "personal" : null, tx.recurringId ? "every month" : null, tx.note]
    .filter(Boolean)
    .join(" · ");
  const changed = amount !== amountInput(tx.amountMinor, household.currency) || date !== tx.date || desc.trim() !== (tx.description ?? tx.merchantName ?? "");

  async function update(body: Parameters<typeof api.updateTransaction>[2]) {
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
                {ownFigures && !isMove && !editing && (
                  <button type="button" className="secondary" onClick={() => setEditing(true)}>
                    Change amount, date or name
                  </button>
                )}
                <button type="button" className="quiet" onClick={remove}>
                  Remove
                </button>
              </div>
              {editing && (
                <form
                  className="row"
                  style={{ alignItems: "flex-end" }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void update({ amount, date, description: desc.trim() || undefined }).then(() => setEditing(false));
                  }}
                >
                  <label style={{ flex: "1 1 140px" }}>
                    {tx.direction === "in" ? "From" : "Paid to"}
                    <input value={desc} onChange={(e) => setDesc(e.target.value)} />
                  </label>
                  <label style={{ flex: "0 1 120px" }}>
                    Amount
                    <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
                  </label>
                  <label style={{ flex: "0 1 150px" }}>
                    Date
                    <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
                  </label>
                  <button type="submit" className="secondary" disabled={!changed}>
                    Save changes
                  </button>
                  <button type="button" className="quiet" onClick={() => setEditing(false)}>
                    Cancel
                  </button>
                </form>
              )}
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

/** The arithmetic behind the figure, line by line, and where the income figure comes from. */
function HowItWorks({ data, cur }: { data: TodayData; cur: string }) {
  const n = (m: number) => formatMoney(m, cur, { symbol: false });
  const incomeLabel = data.period.from.slice(8) === "01" ? "Came in this month" : `Came in since payday (${shortDate(data.period.from)})`;
  return (
    <details className="how">
      <summary>How is this worked out?</summary>
      <div className="sum mono">
        <span>{incomeLabel}</span>
        <span>{n(data.incomeMinor)}</span>
        <span>− Spent so far</span>
        <span>{n(data.spentMinor)}</span>
        <span>− To the goals</span>
        <span>{n(data.goalsMinor)}</span>
        {data.loansMinor > 0 && (
          <>
            <span>− Loan installments</span>
            <span>{n(data.loansMinor)}</span>
          </>
        )}
        {data.billsMinor > 0 && (
          <>
            <span>− Bills still to come</span>
            <span>{n(data.billsMinor)}</span>
          </>
        )}
        {data.savedOtherMinor > 0 && (
          <>
            <span>− Saved outside the goals</span>
            <span>{n(data.savedOtherMinor)}</span>
          </>
        )}
        <span className="total">= For everyday things</span>
        <span className="total">{n(data.everydayLeftMinor)}</span>
        <span>
          ÷ {data.daysLeft} {data.daysLeft === 1 ? "day" : "days"} to payday ({shortDate(data.payday)})
        </span>
        <span>{n(data.perDayMinor)} a day</span>
      </div>
      <span className="small muted">
        Only income already in the book counts{data.expectedLaterMinor > 0 ? `; the ${formatMoney(data.expectedLaterMinor, cur)} still expected under Every month joins when it is logged` : ""}. Goals count the larger of what is planned and what has moved this month. The day figure is rounded down to whole {cur === "NPR" || cur === "INR" ? "rupees" : "units"}.
      </span>
    </details>
  );
}

/** This month's every-month items: what is in, what is due, what is still to come. */
function ComingUp({ household, data, canWrite, onChanged }: { household: Household; data: TodayData; canWrite: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cur = household.currency;
  const base = `/h/${household.id}`;
  const rows = data.comingUp.filter((r) => r.state !== "paused");
  const open = rows.filter((r) => r.state === "due" || r.state === "upcoming");

  async function logIt(r: TodayData["comingUp"][number]) {
    setBusy(r.id);
    setError(null);
    try {
      await api.postRecurring(household.id, r.id, { date: r.due <= data.today ? r.due : data.today });
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not log it");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card stack" aria-labelledby="coming-h" style={{ gap: 4 }}>
      <div className="row between">
        <h2 id="coming-h">Every month</h2>
        <a className="small" href={`${base}/settings/every-month`} onClick={onLinkClick}>
          {rows.length ? "Change" : "Set them"}
        </a>
      </div>
      {rows.length === 0 && <span className="small muted">Rent, school fees, the salary: add what comes every month, and Today sets each bill aside before it is paid.</span>}
      {rows.map((r) => {
        const done = r.state === "posted" || r.state === "done" || r.state === "skipped";
        const when =
          r.state === "posted"
            ? "in the book"
            : r.state === "done"
              ? "handled"
              : r.state === "skipped"
                ? "skipped this month"
                : r.state === "due"
                  ? r.daysUntil === 0
                    ? "due today"
                    : `due ${shortDate(r.due)}`
                  : r.daysUntil === 1
                    ? "tomorrow"
                    : `in ${r.daysUntil} days`;
        return (
          <div key={r.id} className="bill-row">
            <span className="who">
              <strong className={done ? "done" : ""}>{r.name}</strong>
              <span className="small muted">{when}</span>
            </span>
            <span className="end">
              <span className={`mono ${r.direction === "in" ? "amount-in" : ""}`} style={{ color: done ? "var(--muted)" : undefined }}>
                {r.direction === "in" ? "+" : "−"}
                {formatMoney(r.amountMinor, cur, { symbol: false })}
              </span>
              {r.state === "posted" ? (
                <Checks confirmed={false} />
              ) : canWrite && r.state === "due" ? (
                r.accountId ? (
                  <button type="button" className="link small" disabled={busy === r.id} onClick={() => logIt(r)}>
                    Log it
                  </button>
                ) : (
                  <a className="small" href={`${base}/decide`} onClick={onLinkClick}>
                    Log it
                  </a>
                )
              ) : null}
            </span>
          </div>
        );
      })}
      {open.length > 0 && data.billsMinor > 0 && <span className="small muted">{formatMoney(data.billsMinor, cur)} of bills still to come is kept out of the day figure.</span>}
      {error && <div className="error small">{error}</div>}
    </section>
  );
}
