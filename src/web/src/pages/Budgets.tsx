import { useCallback, useEffect, useState } from "react";
import { shiftMonth, todayIn } from "../../../shared/dates";
import { minorToDecimal } from "../../../shared/money";
import { api, ApiError, type Budget, type Category, type CategoryKind, type Household, type Summary } from "../api";
import { Money, MonthSwitcher, currentMonth, monthLabel } from "../ui";

export function Budgets({ household }: { household: Household }) {
  const [month, setMonth] = useState(currentMonth(todayIn(household.timezone)));
  const [categories, setCategories] = useState<Category[]>([]);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const canWrite = household.me.role !== "viewer";
  const cur = household.currency;

  const load = useCallback(async () => {
    try {
      const [c, b, s] = await Promise.all([api.categories(household.id), api.budgets(household.id, month), api.summary(household.id, month)]);
      setCategories(c);
      setBudgets(b);
      setSummary(s);
      setDrafts(Object.fromEntries(b.map((x) => [x.categoryId, minorToDecimal(x.amountMinor, cur)])));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load budgets");
    }
  }, [household.id, month, cur]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(categoryId: string) {
    const value = (drafts[categoryId] ?? "").trim();
    const existing = budgets.find((b) => b.categoryId === categoryId);
    if (!value && !existing) return;
    if (existing && value === minorToDecimal(existing.amountMinor, cur)) return;
    try {
      await api.setBudget(household.id, { month, categoryId, amount: value });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save the budget");
    }
  }

  async function copyPrevious() {
    try {
      const { copied } = await api.copyBudgets(household.id, month, shiftMonth(month, -1));
      setNotice(copied ? `Copied ${copied} budgets from ${monthLabel(shiftMonth(month, -1))}.` : `${monthLabel(shiftMonth(month, -1))} has no budgets to copy.`);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not copy budgets");
    }
  }

  const tops = categories.filter((c) => !c.parentId && (c.kind === "need" || c.kind === "want"));
  const spentFor = (id: string) => summary?.byCategory.find((r) => r.categoryId === id)?.spentMinor ?? 0;
  const total = budgets.reduce((s, b) => s + b.amountMinor, 0);

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="stack" style={{ gap: 4 }}>
          <h1>Budgets</h1>
          <span className="muted">A monthly amount per category. Leave a box empty for no budget.</span>
        </div>
        <MonthSwitcher month={month} onChange={setMonth} />
      </div>
      {error && <div className="error">{error}</div>}
      {notice && <div className="ok">{notice}</div>}

      <div className="card table-scroll">
        <table>
          <thead>
            <tr>
              <th>Category</th>
              <th>Type</th>
              <th className="right">Spent</th>
              <th style={{ width: 160 }}>Budget</th>
            </tr>
          </thead>
          <tbody>
            {tops.map((c) => {
              const spent = spentFor(c.id);
              const budget = budgets.find((b) => b.categoryId === c.id);
              const over = budget && spent > budget.amountMinor;
              return (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td className="muted">{c.kind}</td>
                  <td className={`right ${over ? "over-text" : ""}`}>
                    <Money minor={spent} currency={cur} />
                  </td>
                  <td>
                    {canWrite ? (
                      <input
                        inputMode="decimal"
                        aria-label={`Budget for ${c.name}`}
                        value={drafts[c.id] ?? ""}
                        placeholder="—"
                        onChange={(e) => setDrafts((d) => ({ ...d, [c.id]: e.target.value }))}
                        onBlur={() => save(c.id)}
                        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                      />
                    ) : budget ? (
                      <Money minor={budget.amountMinor} currency={cur} />
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
            <tr>
              <td>
                <strong>Total</strong>
              </td>
              <td />
              <td className="right">
                <strong>
                  <Money minor={summary?.spentMinor ?? 0} currency={cur} />
                </strong>
              </td>
              <td>
                <strong>
                  <Money minor={total} currency={cur} />
                </strong>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      {canWrite && budgets.length === 0 && (
        <div>
          <button type="button" className="secondary" onClick={copyPrevious}>
            Copy budgets from {monthLabel(shiftMonth(month, -1))}
          </button>
        </div>
      )}
      {canWrite && <AddCategory household={household} categories={categories} onAdded={load} />}
    </>
  );
}

function AddCategory({ household, categories, onAdded }: { household: Household; categories: Category[]; onAdded: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState("");
  const [kind, setKind] = useState<CategoryKind>("want");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const parent = categories.find((c) => c.id === parentId);
      await api.createCategory(household.id, { name, parentId: parentId || null, kind: parent ? parent.kind : kind });
      setName("");
      await onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add the category");
    }
  }

  return (
    <form className="card stack" onSubmit={submit}>
      <h2>Add a category</h2>
      <div className="row">
        <label style={{ flex: 2 }}>
          Name
          <input required value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label style={{ flex: 2 }}>
          Inside
          <select value={parentId} onChange={(e) => setParentId(e.target.value)}>
            <option value="">Top level</option>
            {categories
              .filter((c) => !c.parentId)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
        </label>
        {!parentId && (
          <label style={{ flex: 1 }}>
            Type
            <select value={kind} onChange={(e) => setKind(e.target.value as CategoryKind)}>
              <option value="need">Need</option>
              <option value="want">Want</option>
              <option value="saving">Saving</option>
              <option value="income">Income</option>
            </select>
          </label>
        )}
      </div>
      {error && <div className="error">{error}</div>}
      <div>
        <button type="submit">Add category</button>
      </div>
    </form>
  );
}
