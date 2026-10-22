import { useCallback, useEffect, useState } from "react";
import { monthName } from "../../../shared/plan";
import { api, ApiError, type Category, type DecideCard, type Household } from "../api";
import { onLinkClick } from "../router";
import { CategorySelect, Checks, amountInput, categoryLabel, formatMoney, shortDate } from "../ui";

/**
 * Decide: quick calls that keep the book clean, one card at a time. Every card has two clear
 * answers and a way to leave it for later; nothing here needs a spreadsheet.
 */
export function Decide({ household, categories, version, onChanged }: { household: Household; categories: Category[]; version: number; onChanged: () => void }) {
  const [cards, setCards] = useState<DecideCard[] | null>(null);
  const [idx, setIdx] = useState(0);
  const [results, setResults] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canWrite = household.me.role !== "viewer";
  const cur = household.currency;
  const money = (minor: number) => formatMoney(minor, cur);

  const load = useCallback(async () => {
    try {
      setCards(await api.decideCards(household.id));
      setIdx(0);
      setResults([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load decisions");
    }
  }, [household.id]);

  useEffect(() => {
    void load();
  }, [load, version]);

  async function act(run: () => Promise<unknown>, result: string) {
    setBusy(true);
    setError(null);
    try {
      await run();
      setResults((r) => [...r, result]);
      setIdx((i) => i + 1);
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save that");
    } finally {
      setBusy(false);
    }
  }

  function later(what: string) {
    setResults((r) => [...r, `${what} left for later.`]);
    setIdx((i) => i + 1);
  }

  if (error && !cards) return <div className="error">{error}</div>;
  if (!cards) return <p className="muted">Gathering what needs a look…</p>;

  const card = cards[idx];
  const total = cards.length;

  return (
    <div className="decide">
      <div className="row between">
        <div className="stack" style={{ gap: 2 }}>
          <h1>Decide</h1>
          <span className="muted small">Quick calls that keep the book clean</span>
        </div>
        {total > 0 && (
          <span className="mono small muted" aria-live="polite">
            {idx >= total ? "done" : `${idx + 1} of ${total}`}
          </span>
        )}
      </div>
      {total > 0 && (
        <div className="dots" aria-hidden="true">
          {cards.map((c, i) => (
            <span key={c.key} className={i < idx ? "done" : i === idx ? "now" : ""} />
          ))}
        </div>
      )}
      {error && <div className="error" role="alert">{error}</div>}

      {!card && (
        <section className="decide-card settled" aria-label="All settled">
          <span className="settled-mark">
            <svg width="34" height="22" viewBox="0 0 20 12" fill="none" stroke="var(--green)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M1 6.5l3.2 3.8L10.5 2" />
              <path d="M8.5 6.5l3.2 3.8L18 2" />
            </svg>
          </span>
          <h2>{total === 0 ? "Nothing to decide." : "All settled."}</h2>
          {results.length > 0 ? (
            <ul className="plain muted" style={{ listStyle: "none", padding: 0, textAlign: "center" }}>
              {results.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          ) : (
            <span className="muted">Possible double entries, balance gaps and new merchants show up here when statements arrive.</span>
          )}
          <a className="button" href={`/h/${household.id}/plan`} onClick={onLinkClick}>
            See the plan
          </a>
        </section>
      )}

      {card?.kind === "forwarding" && (
        <section className="decide-card" aria-label="Forwarding check">
          <span className="eyebrow" style={{ color: "var(--marigold-deep)" }}>Forwarding check</span>
          <h2>Gmail wants to confirm forwarding{card.requester ? ` from ${card.requester}` : ""}.</h2>
          {card.code ? (
            <>
              <div className="code" aria-label={`Confirmation code ${card.code.split("").join(" ")}`}>{card.code}</div>
              <button type="button" className="secondary" onClick={() => navigator.clipboard?.writeText(card.code!)}>
                Copy the code
              </button>
            </>
          ) : (
            <span className="muted">The code was not in the email; use the confirmation link below.</span>
          )}
          <ol className="plain small" style={{ color: "var(--ink-soft)" }}>
            <li>In Gmail on a computer, open Settings › See all settings › Forwarding and POP/IMAP.</li>
            <li>Enter this code next to the new address and choose Verify.</li>
            <li>Then make a filter that forwards only your bank's emails to it.</li>
          </ol>
          {card.link && (
            <a href={card.link} target="_blank" rel="noopener noreferrer" className="small">
              Or open Gmail's confirmation link
            </a>
          )}
          <div className="actions">
            <button type="button" disabled={busy || !canWrite} onClick={() => act(() => api.dismissStatement(household.id, card.statementId), "Gmail forwarding confirmed.")}>
              Done, it is verified
            </button>
            <button type="button" className="quiet" onClick={() => later("Forwarding check")}>
              Leave it for later
            </button>
          </div>
        </section>
      )}

      {card?.kind === "twin" && (
        <section className="decide-card" aria-label="Possible double entry">
          <span className="eyebrow" style={{ color: "var(--marigold-deep)" }}>Possible double entry</span>
          <h2>One payment, written down twice?</h2>
          <div className="pair">
            <div>
              <span className="stack" style={{ gap: 0, minWidth: 0 }}>
                <strong>{card.match.name ?? "(no description)"}</strong>
                <span className="small muted">
                  {shortDate(card.match.date)} · {card.match.source === "manual" ? `${card.match.byName ?? "someone"} logged it` : `from the bank (${card.match.source})`}
                  {card.match.note ? ` · ${card.match.note}` : ""}
                </span>
              </span>
              <span className="stack" style={{ gap: 2, alignItems: "flex-end" }}>
                <span className="mono">{formatMoney(card.match.direction === "in" ? card.match.amountMinor : -card.match.amountMinor, cur, { symbol: false })}</span>
                <Checks confirmed={card.match.confirmed} />
              </span>
            </div>
            <div>
              <span className="stack" style={{ gap: 0, minWidth: 0 }}>
                <strong className="mono" style={{ fontSize: 13 }}>{card.line.description ?? "(no description)"}</strong>
                <span className="small muted">
                  {card.line.date ? shortDate(card.line.date) : ""} · {card.line.accountName ?? "statement"} · statement
                </span>
              </span>
              <span className="mono">{formatMoney(card.line.amountMinor ?? 0, cur, { symbol: false })}</span>
            </div>
          </div>
          <span className="small" style={{ color: "var(--ink-soft)" }}>Same account and amount, a day or two apart. Cards often post the next day.</span>
          {canWrite && (
            <div className="actions">
              <button type="button" disabled={busy} onClick={() => act(() => api.decide(household.id, card.lineId, "same"), `${card.match.name ?? "That payment"} counted once.`)}>
                Same payment — count it once
              </button>
              <button type="button" className="secondary" disabled={busy} onClick={() => act(() => api.decide(household.id, card.lineId, "accept"), `${card.line.description ?? "The statement line"} kept as a separate payment.`)}>
                Two different payments
              </button>
              <button type="button" className="quiet" onClick={() => later(card.match.name ?? "That payment")}>
                Leave it for later
              </button>
            </div>
          )}
        </section>
      )}

      {card?.kind === "balance" && (
        <section className="decide-card" aria-label="Balance check">
          <span className="eyebrow" style={{ color: "var(--marigold-deep)" }}>Balance check · {card.accountName}</span>
          <h2>
            The book is {money(Math.abs(card.bookMinor - card.bankMinor))} {card.bookMinor > card.bankMinor ? "ahead of" : "behind"} the bank.
          </h2>
          <div className="tally">
            <div>
              <span className="eyebrow">Bank says, {shortDate(card.asOf)}</span>
              <span className="mono" style={{ fontWeight: 600, fontSize: 16 }}>{formatMoney(card.bankMinor, cur, { symbol: false })}</span>
            </div>
            <div>
              <span className="eyebrow">Book says</span>
              <span className="mono" style={{ fontWeight: 600, fontSize: 16 }}>{formatMoney(card.bookMinor, cur, { symbol: false })}</span>
            </div>
          </div>
          {card.suspects.length > 0 && (
            <div className="stack" style={{ gap: 6 }}>
              <span className="small" style={{ color: "var(--ink-soft)" }}>Entries the bank has not confirmed yet. One of these may be in the wrong account or logged twice:</span>
              {card.suspects.map((s) => (
                <div key={s.id} className="kv">
                  <span>
                    {s.name ?? "(no description)"} <span className="small muted">· {shortDate(s.date)}{s.byName ? ` · ${s.byName}` : ""}</span>
                  </span>
                  <span className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                    <span className="mono">{formatMoney(s.direction === "in" ? s.amountMinor : -s.amountMinor, cur, { symbol: false })}</span>
                    {canWrite && (
                      <button type="button" className="link small" disabled={busy} onClick={() => act(() => api.voidTransaction(household.id, s.id), `${s.name ?? "An entry"} removed from ${card.accountName}.`)}>
                        Remove
                      </button>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
          {canWrite && (
            <div className="actions">
              <button type="button" disabled={busy} onClick={() => act(() => api.correctBalance(household.id, card.accountId), `${card.accountName} corrected to match the bank.`)}>
                Add a correction so they match
              </button>
              <button type="button" className="secondary" disabled={busy} onClick={() => act(() => api.snoozeBalance(household.id, card.accountId), `${card.accountName}: waiting for the next statement.`)}>
                Wait for the next statement
              </button>
              <button type="button" className="quiet" onClick={() => later(`${card.accountName} balance`)}>
                Leave it for later
              </button>
            </div>
          )}
        </section>
      )}

      {card?.kind === "category" && <CategoryCard key={card.key} card={card} household={household} categories={categories} busy={busy} canWrite={canWrite} act={act} later={later} />}

      {card?.kind === "plan" && (
        <section className="decide-card" aria-label="For the plan">
          <span className="eyebrow" style={{ color: "var(--green-deep)" }}>For the plan</span>
          <h2>
            Put {money(card.suggestMinor)} a month toward {card.goalName}?
          </h2>
          <span style={{ color: "var(--ink-soft)" }}>
            There is about {money(card.spareMinor)} a month spare after spending and goals.{" "}
            {card.fromMonth && card.toMonth ? (
              <>
                This brings {card.goalName} from {card.fromMonth === "now" ? "now" : monthName(card.fromMonth)} to <strong style={{ color: "var(--ink)" }}>{card.toMonth === "now" ? "now" : monthName(card.toMonth)}</strong>
                {card.onTime ? ", in time." : "."}
              </>
            ) : card.toMonth ? (
              <>It would be ready by {monthName(card.toMonth)}.</>
            ) : (
              <>It brings {card.goalName} closer.</>
            )}
          </span>
          {canWrite && (
            <div className="actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => act(() => api.updateGoal(household.id, card.goalId, { monthly: amountInput(card.suggestMinor, cur) }), `${card.goalName} now gets ${money(card.suggestMinor)} a month.`)}
              >
                Yes, {money(card.suggestMinor)} a month
              </button>
              <button type="button" className="secondary" disabled={busy} onClick={() => act(() => api.snooze(household.id, card.key, `Fund ${card.goalName}`), `${card.goalName}: ask again next month.`)}>
                Ask me again next month
              </button>
              <button type="button" className="quiet" onClick={() => later(card.goalName)}>
                Leave it for later
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function CategoryCard({
  card,
  household,
  categories,
  busy,
  canWrite,
  act,
  later,
}: {
  card: Extract<DecideCard, { kind: "category" }>;
  household: Household;
  categories: Category[];
  busy: boolean;
  canWrite: boolean;
  act: (run: () => Promise<unknown>, result: string) => Promise<void>;
  later: (what: string) => void;
}) {
  const [categoryId, setCategoryId] = useState<string | null>(card.suggestedCategoryId);
  const isIn = card.totalMinor > 0;
  const lines = card.count === 1 ? "payment" : "payments";
  return (
    <section className="decide-card" aria-label="Needs a category">
      <span className="eyebrow">Needs a category · {card.accountName ?? "statement"}</span>
      <h2>
        {card.count > 1 ? `${card.count} ${lines} ${isIn ? "from" : "to"} ` : isIn ? "Money in from " : ""}
        {card.description}
      </h2>
      <span className="small muted">
        {formatMoney(Math.abs(card.totalMinor), household.currency)} in all
        {card.firstDate ? ` · ${shortDate(card.firstDate)}` : ""}
        {card.lastDate && card.lastDate !== card.firstDate ? ` to ${shortDate(card.lastDate)}` : ""}. One choice files every one, and the next ones too.
      </span>
      {canWrite && (
        <>
          <label>
            Category
            <CategorySelect categories={categories} value={categoryId} onChange={setCategoryId} label="Category" filter={(c) => (isIn ? c.kind === "income" || c.kind === "need" || c.kind === "want" : c.kind !== "income")} />
          </label>
          <div className="actions">
            <button type="button" disabled={busy || !categoryId} onClick={() => act(() => api.acceptMany(household.id, card.lineIds, categoryId), `${card.description} filed under ${categoryLabel(categories, categoryId)}.`)}>
              {categoryId ? `File under ${categoryLabel(categories, categoryId)}` : "Choose a category above"}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => act(async () => { for (const id of card.lineIds) await api.decide(household.id, id, "reject"); }, `${card.description} left out of the book.`)}
            >
              Not ours, leave {card.count > 1 ? "them" : "it"} out
            </button>
            <button type="button" className="quiet" onClick={() => later(card.description)}>
              Leave it for later
            </button>
          </div>
        </>
      )}
    </section>
  );
}
