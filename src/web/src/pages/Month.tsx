import { useCallback, useEffect, useMemo, useState } from "react";
import { monthRange, todayIn } from "../../../shared/dates";
import { api, ApiError, type Account, type Category, type Household, type Summary, type Transaction } from "../api";
import { onLinkClick } from "../router";
import { CategorySelect, Money, MonthSwitcher, categoryLabel, currentMonth } from "../ui";

type Mode = "out" | "in" | "transfer";

export function Month({ household }: { household: Household }) {
  const today = todayIn(household.timezone);
  const [month, setMonth] = useState(currentMonth(today));
  const [summary, setSummary] = useState<Summary | null>(null);
  const [txs, setTxs] = useState<Transaction[] | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [error, setError] = useState<string | null>(null);
  const canWrite = household.me.role !== "viewer";

  const load = useCallback(async () => {
    try {
      const [s, t] = await Promise.all([api.summary(household.id, month), api.transactions(household.id, month)]);
      setSummary(s);
      setTxs(t);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load this month");
    }
  }, [household.id, month]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    Promise.all([api.accounts(household.id), api.categories(household.id)])
      .then(([a, c]) => {
        setAccounts(a);
        setCategories(c);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load accounts"));
  }, [household.id]);

  const { from, to } = monthRange(month);
  const cur = household.currency;

  async function setCategory(tx: Transaction, categoryId: string | null) {
    try {
      await api.updateTransaction(household.id, tx.id, { categoryId });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not update the category");
    }
  }

  async function remove(tx: Transaction) {
    const what = tx.transferPairId ? "both sides of this transfer" : "this transaction";
    if (!window.confirm(`Remove ${what}? It stays in the history as voided.`)) return;
    try {
      await api.voidTransaction(household.id, tx.id);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not remove it");
    }
  }

  const byDate = useMemo(() => {
    const groups = new Map<string, Transaction[]>();
    for (const t of txs ?? []) groups.set(t.date, [...(groups.get(t.date) ?? []), t]);
    return [...groups.entries()];
  }, [txs]);

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <MonthSwitcher month={month} onChange={setMonth} />
        <a className="button secondary" href={api.exportUrl(household.id, from, to)} download>
          Export CSV
        </a>
      </div>

      {error && <div className="error">{error}</div>}

      {summary && summary.pendingReview > 0 && (
        <a className="banner" href={`/h/${household.id}/review`} onClick={onLinkClick}>
          {summary.pendingReview} imported {summary.pendingReview === 1 ? "line needs" : "lines need"} a decision. Review them →
        </a>
      )}

      {summary && (
        <div className="tiles">
          <div className="card tile dark">
            <div className="eyebrow">Spent</div>
            <div className="big">
              <Money minor={summary.spentMinor} currency={cur} />
            </div>
            <div className="small">
              {summary.budgetTotalMinor > 0 ? (
                <>
                  of <Money minor={summary.budgetTotalMinor} currency={cur} /> budgeted
                </>
              ) : (
                "no budget set"
              )}
            </div>
          </div>
          <div className="card tile">
            <div className="eyebrow">Income</div>
            <div className="big">
              <Money minor={summary.incomeMinor} currency={cur} />
            </div>
            <div className="small muted">salary, freelance, other money in</div>
          </div>
          <div className="card tile">
            <div className="eyebrow">Saved</div>
            <div className="big">
              <Money minor={summary.savedMinor} currency={cur} />
            </div>
            <div className="small muted">moved to savings categories</div>
          </div>
          <div className="card tile">
            <div className="eyebrow">Left over</div>
            <div className="big">
              <Money minor={summary.netMinor} currency={cur} />
            </div>
            <div className="small muted">{summary.uncategorizedCount ? `${summary.uncategorizedCount} uncategorised` : "everything categorised"}</div>
          </div>
        </div>
      )}

      <div className="split">
        <section className="card stack grow" aria-labelledby="where-heading">
          <h2 id="where-heading">Where it went</h2>
          {summary && summary.byCategory.length === 0 && <span className="muted">No spending recorded for this month yet.</span>}
          {summary?.byCategory.map((row) => {
            const max = Math.max(...summary.byCategory.map((r) => Math.max(r.spentMinor, r.budgetMinor ?? 0)), 1);
            const over = row.budgetMinor !== null && row.spentMinor > row.budgetMinor;
            return (
              <div key={row.categoryId ?? "none"} className="bar-row">
                <span>{row.name}</span>
                <div className="bar" aria-hidden="true">
                  <div className={`fill ${over ? "over" : ""}`} style={{ width: `${Math.max(0, (row.spentMinor / max) * 100)}%` }} />
                  {row.budgetMinor !== null && <div className="budget-mark" style={{ left: `${(row.budgetMinor / max) * 100}%` }} />}
                </div>
                <span className="mono right">
                  <Money minor={row.spentMinor} currency={cur} />
                  {row.budgetMinor !== null && (
                    <span className={over ? "over-text" : "muted"}>
                      {" "}
                      / <Money minor={row.budgetMinor} currency={cur} />
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </section>

        {canWrite && (
          <QuickAdd household={household} accounts={accounts} categories={categories} defaultDate={month === currentMonth(today) ? today : from} onAdded={load} />
        )}
      </div>

      <section className="card stack" aria-labelledby="tx-heading">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 id="tx-heading">Transactions</h2>
          <span className="muted">{txs ? `${txs.length} this month` : "Loading…"}</span>
        </div>
        {txs && txs.length === 0 && (
          <span className="muted">
            Nothing here yet. Add an expense above, import a CSV from the Accounts page, or forward a statement to {household.inboundAddress}.
          </span>
        )}
        {byDate.map(([date, rows]) => (
          <div key={date} className="day">
            <div className="eyebrow">{new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })}</div>
            {rows.map((t) => (
              <div key={t.id} className="tx">
                <div className="tx-main">
                  <strong>{t.merchantName ?? t.description ?? "(no description)"}</strong>
                  <span className="muted small">
                    {t.accountName}
                    {t.paidByName ? ` · ${t.paidByName}` : ""}
                    {t.isPersonal ? " · personal" : ""}
                    {t.source !== "manual" ? ` · ${t.source}` : ""}
                    {t.note ? ` · ${t.note}` : ""}
                  </span>
                </div>
                <div className="tx-cat">
                  {t.transferPairId || t.direction === "transfer" ? (
                    <span className="pill grey">transfer</span>
                  ) : canWrite && !(t.isPersonal && t.paidByMemberId !== household.me.id) ? (
                    <CategorySelect categories={categories} value={t.categoryId} onChange={(id) => setCategory(t, id)} label={`Category for ${t.merchantName ?? t.description ?? "transaction"}`} />
                  ) : (
                    <span className="muted">{categoryLabel(categories, t.categoryId)}</span>
                  )}
                </div>
                <div className="tx-amt">
                  <Money minor={t.amountMinor} currency={cur} signed={t.direction} />
                </div>
                {canWrite && !(t.isPersonal && t.paidByMemberId !== household.me.id) && (
                  <button type="button" className="quiet" aria-label="Remove transaction" onClick={() => remove(t)}>
                    ✕
                  </button>
                )}
              </div>
            ))}
          </div>
        ))}
      </section>
    </>
  );
}

function QuickAdd({
  household,
  accounts,
  categories,
  defaultDate,
  onAdded,
}: {
  household: Household;
  accounts: Account[];
  categories: Category[];
  defaultDate: string;
  onAdded: () => Promise<void>;
}) {
  const [mode, setMode] = useState<Mode>("out");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [accountId, setAccountId] = useState("");
  const [toAccountId, setToAccountId] = useState("");
  const [date, setDate] = useState(defaultDate);
  const [note, setNote] = useState("");
  const [isPersonal, setIsPersonal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => setDate(defaultDate), [defaultDate]);
  useEffect(() => {
    if (!accountId && accounts[0]) setAccountId(accounts[0].id);
    if (!toAccountId && accounts[1]) setToAccountId(accounts[1].id);
  }, [accounts, accountId, toAccountId]);

  if (!accounts.length) {
    return (
      <section className="card stack" style={{ flex: "1 1 320px" }}>
        <h2>Add an expense</h2>
        <span className="muted">
          Add an account first on the{" "}
          <a href={`/h/${household.id}/accounts`} onClick={onLinkClick}>
            Accounts
          </a>{" "}
          page, such as a joint checking account, a credit card, or cash.
        </span>
      </section>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      if (mode === "transfer") {
        await api.addTransfer(household.id, { fromAccountId: accountId, toAccountId, amount, date, note });
        setDone("Transfer recorded.");
      } else {
        const res = await api.addTransaction(household.id, { date, amount, direction: mode, accountId, categoryId, description, note, isPersonal });
        setDone(!categoryId && res.categoryId ? `Added, and filed under ${categoryLabel(categories, res.categoryId)} from earlier entries.` : "Added.");
      }
      setAmount("");
      setDescription("");
      setCategoryId(null);
      setNote("");
      setIsPersonal(false);
      await onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add it");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card stack" style={{ flex: "1 1 320px" }} onSubmit={submit} aria-labelledby="add-heading">
      <h2 id="add-heading">Add</h2>
      <div className="segmented" role="radiogroup" aria-label="Type">
        {(["out", "in", "transfer"] as const).map((m) => (
          <button key={m} type="button" role="radio" aria-checked={mode === m} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>
            {m === "out" ? "Expense" : m === "in" ? "Income" : "Transfer"}
          </button>
        ))}
      </div>
      <div className="row">
        <label style={{ flex: 1 }}>
          Amount
          <input inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
        </label>
        <label style={{ flex: 1 }}>
          Date
          <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      </div>
      {mode !== "transfer" && (
        <label>
          {mode === "out" ? "Where" : "From"}
          <input required value={description} onChange={(e) => setDescription(e.target.value)} placeholder={mode === "out" ? "Shop or payee" : "Employer or source"} />
        </label>
      )}
      <div className="row">
        <label style={{ flex: 1 }}>
          {mode === "transfer" ? "From account" : "Account"}
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        {mode === "transfer" ? (
          <label style={{ flex: 1 }}>
            To account
            <select value={toAccountId} onChange={(e) => setToAccountId(e.target.value)}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label style={{ flex: 1 }}>
            Category
            <CategorySelect
              categories={categories}
              value={categoryId}
              onChange={setCategoryId}
              label="Category"
              filter={(c) => (mode === "in" ? c.kind === "income" : c.kind !== "income" && c.kind !== "transfer")}
            />
          </label>
        )}
      </div>
      <label>
        Note <span className="muted small">(optional)</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      {mode === "out" && (
        <label className="check">
          <input type="checkbox" checked={isPersonal} onChange={(e) => setIsPersonal(e.target.checked)} />
          Personal: others see the amount, not the details
        </label>
      )}
      {error && <div className="error">{error}</div>}
      {done && <div className="ok">{done}</div>}
      <div>
        <button type="submit" disabled={busy}>
          {busy ? "Saving…" : mode === "transfer" ? "Record transfer" : mode === "out" ? "Add expense" : "Add income"}
        </button>
      </div>
    </form>
  );
}
