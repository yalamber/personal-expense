import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type Category, type Household, type ReviewLine } from "../api";
import { CategorySelect, Money } from "../ui";

export function Review({ household, onChanged }: { household: Household; onChanged: () => void }) {
  const [lines, setLines] = useState<ReviewLine[] | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [choice, setChoice] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const canWrite = household.me.role !== "viewer";

  const load = useCallback(async () => {
    try {
      const [l, c] = await Promise.all([api.review(household.id), api.categories(household.id)]);
      setLines(l);
      setCategories(c);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the review queue");
    }
  }, [household.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(line: ReviewLine, action: "accept" | "reject") {
    setBusy(line.id);
    setError(null);
    try {
      const categoryId = choice[line.id] !== undefined ? choice[line.id] : line.suggestedCategoryId;
      await api.decide(household.id, line.id, action, categoryId);
      setLines((prev) => prev?.filter((l) => l.id !== line.id) ?? null);
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save that decision");
    } finally {
      setBusy(null);
    }
  }

  async function acceptSuggested() {
    setBusy("all");
    setError(null);
    try {
      const { accepted } = await api.acceptSuggested(household.id);
      setNotice(accepted ? `Accepted ${accepted} ${accepted === 1 ? "line" : "lines"} with their suggested category.` : "Nothing to accept automatically.");
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not accept them");
    } finally {
      setBusy(null);
    }
  }

  const suggestedCount = lines?.filter((l) => l.suggestedCategoryId && !l.possibleDuplicate).length ?? 0;

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="stack" style={{ gap: 4 }}>
          <h1>Review</h1>
          <span className="muted">Imported lines the app was not sure about. Each decision teaches it the merchant's category.</span>
        </div>
        {canWrite && suggestedCount > 0 && (
          <button type="button" onClick={acceptSuggested} disabled={busy !== null}>
            Accept {suggestedCount} with suggested category
          </button>
        )}
      </div>

      {error && <div className="error">{error}</div>}
      {notice && <div className="ok">{notice}</div>}

      {lines && lines.length === 0 && (
        <div className="card">
          <strong>All caught up.</strong> <span className="muted">New lines appear here when a statement or CSV import has something to check.</span>
        </div>
      )}

      {lines && lines.length > 0 && (
        <div className="card stack">
          {lines.map((line) => {
            const amount = line.amountMinor ?? 0;
            const value = choice[line.id] !== undefined ? choice[line.id]! : line.suggestedCategoryId;
            return (
              <div key={line.id} className="review-row">
                <div className="tx-main">
                  <strong>{line.description}</strong>
                  <span className="muted small">
                    {line.date} · {line.accountName ?? "no account"} · {line.sourceFrom.startsWith("upload:") ? `uploaded ${line.source ?? "CSV"}` : `email: ${line.source ?? line.sourceFrom}`}
                  </span>
                  {line.possibleDuplicate && (
                    <span className="warn small">
                      Possible duplicate of {line.possibleDuplicate.description ?? "a transaction"} on {line.possibleDuplicate.date} ({line.possibleDuplicate.source}).
                    </span>
                  )}
                </div>
                <div className="tx-amt">
                  <Money minor={Math.abs(amount)} currency={household.currency} signed={amount < 0 ? "out" : "in"} />
                </div>
                {canWrite && (
                  <div className="row review-actions">
                    <CategorySelect categories={categories} value={value} onChange={(id) => setChoice((c) => ({ ...c, [line.id]: id }))} label={`Category for ${line.description ?? "line"}`} />
                    <button type="button" onClick={() => decide(line, "accept")} disabled={busy !== null}>
                      {line.possibleDuplicate ? "Not a duplicate, add" : "Add"}
                    </button>
                    <button type="button" className="secondary" onClick={() => decide(line, "reject")} disabled={busy !== null}>
                      {line.possibleDuplicate ? "Duplicate, skip" : "Skip"}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
