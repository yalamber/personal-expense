import { useState } from "react";
import { dayLabel } from "../../../shared/recurring";
import { api, ApiError, paths, type Account, type Category, type Household, type RecurringBody, type RecurringRow } from "../api";
import { useQuery } from "../query";
import { PageSkeleton } from "../skeleton";
import { onLinkClick } from "../router";
import { CategorySelect, Checks, Sheet, amountInput, categoryLabel, formatMoney, shortDate } from "../ui";

const everyday = (accounts: Account[]) => accounts.filter((a) => !a.closedAt && a.type !== "deposit" && a.type !== "loan" && a.type !== "lent" && a.type !== "person");

/**
 * Every month: rent, fees, the salary, the tenant's rent. Set up once; Today keeps each bill aside
 * before it is paid and counts income still to come as expected, and Decide asks on the day.
 */
export function EveryMonth({ household, accounts, categories, version, onChanged }: { household: Household; accounts: Account[]; categories: Category[]; version: number; onChanged: () => void }) {
  const q = useQuery<RecurringRow[]>(paths.recurring(household.id), [version]);
  const rows = q.data ?? null;
  const [editing, setEditing] = useState<RecurringRow | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canWrite = household.me.role !== "viewer";
  const cur = household.currency;
  const live = (rows ?? []).filter((r) => r.active);
  const total = (dir: "in" | "out") => live.filter((r) => r.direction === dir).reduce((s, r) => s + r.amountMinor, 0);
  const inTotal = total("in");
  const outTotal = total("out");

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save that");
    }
  }

  function standing(r: RecurringRow) {
    const s = r.status;
    if (!r.active) return null;
    if (s.state === "posted") return <span className="small" style={{ color: "var(--green-deep)" }}>In the book this month <Checks confirmed={false} /></span>;
    if (s.state === "done") return <span className="small muted">Handled this month, outside the book</span>;
    if (s.state === "skipped") return <span className="small muted">Skipped this month</span>;
    if (s.state === "due") return <span className="small" style={{ color: "var(--marigold-deep)" }}>{s.daysUntil === 0 ? "Due today" : `Due ${shortDate(s.due)}`}, not in the book yet</span>;
    return <span className="small muted">Next {shortDate(s.due)}</span>;
  }

  return (
    <>
      <div className="row between" style={{ alignItems: "flex-end" }}>
        <div className="stack" style={{ gap: 4 }}>
          <h1>Every month</h1>
          <span className="muted">What comes in and goes out each month as a matter of course. Today keeps each bill aside before it is paid, and Decide asks on the day whether it went out.</span>
        </div>
        {canWrite && !editing && (
          <button type="button" onClick={() => setEditing("new")}>
            Add one
          </button>
        )}
      </div>
      {(error ?? q.error) && <div className="error">{error ?? q.error}</div>}
      {!rows && !q.error && <PageSkeleton kind="list" />}

      {live.length > 0 && (
        <dl className="ledger-sum" style={{ maxWidth: 520 }}>
          <div>
            <dt>Comes in</dt>
            <dd className="amount-in">{formatMoney(inTotal, cur)}</dd>
          </div>
          <div>
            <dt>Goes out</dt>
            <dd>{formatMoney(outTotal, cur)}</dd>
          </div>
          <div>
            <dt>Left over</dt>
            <dd style={{ color: inTotal - outTotal < 0 ? "var(--rust)" : undefined }}>{formatMoney(inTotal - outTotal, cur)}</dd>
          </div>
        </dl>
      )}

      {rows && rows.length === 0 && (
        <div className="card stack">
          <strong>Nothing listed yet.</strong>
          <span className="muted">Start with the big ones: rent, school fees, the salary. Small subscriptions can wait. A loan's EMI is already known from the loan itself in Accounts.</span>
        </div>
      )}

      {(["out", "in"] as const).map((dir) => {
        const list = (rows ?? []).filter((r) => r.direction === dir);
        if (!list.length) return null;
        return (
          <section key={dir} className="card" aria-labelledby={`em-${dir}`}>
            <div className="row between" style={{ paddingBottom: 6 }}>
              <h2 id={`em-${dir}`}>{dir === "in" ? "Comes in" : "Goes out"}</h2>
              <span className="mono" style={{ fontWeight: 600 }}>
                {formatMoney(total(dir), cur)}
              </span>
            </div>
            {list.map((r) => (
              <div key={r.id} style={{ borderTop: "1px dashed var(--line)", padding: "12px 0" }}>
                <div className="row between" style={{ flexWrap: "nowrap", alignItems: "flex-start" }}>
                  <span className="stack" style={{ gap: 2, minWidth: 0 }}>
                    <strong>
                      {r.name}
                      {!r.active && <span className="pill grey" style={{ marginLeft: 6 }}>paused</span>}
                    </strong>
                    <span className="small muted">
                      {dayLabel(r.dayOfMonth)}
                      {r.categoryId ? ` · ${categoryLabel(categories, r.categoryId)}` : ""}
                      {r.accountId ? ` · ${accounts.find((a) => a.id === r.accountId)?.name ?? "an account"}` : " · account chosen when logging"}
                      {r.note ? ` · ${r.note}` : ""}
                    </span>
                    {standing(r)}
                  </span>
                  <span className={`mono ${dir === "in" ? "amount-in" : ""}`} style={{ fontWeight: 600, whiteSpace: "nowrap" }}>
                    {formatMoney(r.amountMinor, cur, { symbol: false })}
                  </span>
                </div>
                {canWrite && (
                  <div className="row" style={{ gap: 4, marginTop: 6 }}>
                    <button type="button" className="link small" onClick={() => setEditing(r)}>
                      Edit
                    </button>
                    {r.active && (r.status.state === "due" || r.status.state === "upcoming") && (
                      <button type="button" className="link small" onClick={() => run(() => api.skipRecurring(household.id, r.id, {}))}>
                        Skip this month
                      </button>
                    )}
                    {(r.status.state === "skipped" || r.status.state === "done") && (
                      <button type="button" className="link small" onClick={() => run(() => api.undoRecurring(household.id, r.id, {}))}>
                        Undo
                      </button>
                    )}
                    <button type="button" className="link small" onClick={() => run(() => api.updateRecurring(household.id, r.id, { active: !r.active }))}>
                      {r.active ? "Pause" : "Resume"}
                    </button>
                    <button
                      type="button"
                      className="link small"
                      onClick={() => {
                        if (window.confirm(`Remove ${r.name} from every month? Entries already in the book stay.`)) void run(() => api.removeRecurring(household.id, r.id));
                      }}
                    >
                      Remove
                    </button>
                  </div>
                )}
              </div>
            ))}
          </section>
        );
      })}

      <p className="small muted" style={{ margin: 0 }}>
        Loan installments are already known from the loan in{" "}
        <a href={`/h/${household.id}/settings/accounts`} onClick={onLinkClick}>
          Accounts
        </a>
        ; leave them out here. Envelopes watch a category's spending over the month; this list is for fixed amounts that land on a day.
      </p>

      {editing && (
        <ItemSheet
          household={household}
          accounts={accounts}
          categories={categories}
          initial={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onChanged();
          }}
        />
      )}
    </>
  );
}

const DAYS = Array.from({ length: 28 }, (_, i) => i + 1);

function ItemSheet({ household, accounts, categories, initial, onClose, onSaved }: { household: Household; accounts: Account[]; categories: Category[]; initial?: RecurringRow; onClose: () => void; onSaved: () => void }) {
  const cur = household.currency;
  const options = everyday(accounts);
  const [name, setName] = useState(initial?.name ?? "");
  const [direction, setDirection] = useState<"out" | "in">(initial?.direction ?? "out");
  const [amount, setAmount] = useState(initial ? amountInput(initial.amountMinor, cur) : "");
  const [day, setDay] = useState(initial?.dayOfMonth ?? 1);
  const [categoryId, setCategoryId] = useState<string | null>(initial?.categoryId ?? null);
  const [accountId, setAccountId] = useState(initial?.accountId ?? "");
  const [note, setNote] = useState(initial?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const body: RecurringBody = { name: name.trim(), direction, amount, dayOfMonth: day, categoryId, accountId: accountId || null, note };
      if (initial) await api.updateRecurring(household.id, initial.id, body);
      else await api.createRecurring(household.id, body);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save it");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title={initial ? `Edit ${initial.name}` : "Every month"} onClose={onClose}>
      <form className="stack" onSubmit={submit} style={{ gap: 14 }}>
        <div className="seg" role="group" aria-label="Direction">
          <button type="button" aria-pressed={direction === "out"} onClick={() => { setDirection("out"); setCategoryId(null); }}>
            Goes out
          </button>
          <button type="button" className="in" aria-pressed={direction === "in"} onClick={() => { setDirection("in"); setCategoryId(null); }}>
            Comes in
          </button>
        </div>
        <label>
          Name
          <input required value={name} onChange={(e) => setName(e.target.value)} placeholder={direction === "in" ? "Salary, tenant's rent, pension" : "Rent, school fees, internet"} />
        </label>
        <div className="row" style={{ alignItems: "flex-end" }}>
          <label style={{ flex: "1 1 140px" }}>
            Usual amount
            <input required inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
          </label>
          <label style={{ flex: "1 1 120px" }}>
            Day of the month
            <select value={day} onChange={(e) => setDay(Number(e.target.value))}>
              {DAYS.map((d) => (
                <option key={d} value={d}>
                  {dayLabel(d).replace("on the ", "")}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="row" style={{ alignItems: "flex-end" }}>
          <label style={{ flex: "1 1 180px" }}>
            Category
            <CategorySelect categories={categories} value={categoryId} onChange={setCategoryId} label="Category" filter={(c) => (direction === "in" ? c.kind === "income" : c.kind !== "income" && c.kind !== "transfer")} />
          </label>
          <label style={{ flex: "1 1 160px" }}>
            {direction === "in" ? "Into" : "Paid from"}
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">Choose when logging</option>
              {options.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          Note (optional)
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Landlord's account ends 4471" />
        </label>
        <span className="small muted">After the 28th? Use the 28th; the month is what matters.</span>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <button type="submit" disabled={busy}>
          {busy ? "Saving…" : initial ? "Save changes" : "Add it"}
        </button>
      </form>
    </Sheet>
  );
}
