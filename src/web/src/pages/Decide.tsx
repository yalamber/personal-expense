import { useCallback, useEffect, useState } from "react";
import { monthName } from "../../../shared/plan";
import { todayIn } from "../../../shared/dates";
import { addMonths } from "../../../shared/deposit";
import { rateText } from "../../../shared/terms";
import { api, ApiError, type Account, type Category, type DecideCard, type Household, type RecurringCandidate } from "../api";
import { onLinkClick } from "../router";
import { PageSkeleton } from "../skeleton";
import { CategorySelect, Checks, amountInput, categoryLabel, formatMoney, shortDate } from "../ui";
import { LinkAccount, MailDetails, MailSkeleton, WhyHeld, senderTitle, useMailPreview, when } from "./MailView";

/**
 * Decide: quick calls that keep the book clean, one card at a time. Every card has two clear
 * answers and a way to leave it for later; nothing here needs a spreadsheet.
 */
export function Decide({ household, accounts, categories, version, onChanged }: { household: Household; accounts: Account[]; categories: Category[]; version: number; onChanged: () => void }) {
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
  if (!cards) return <PageSkeleton kind="decide" />;

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

      {card?.kind === "inbox" && <InboxCard key={card.key} card={card} household={household} accounts={accounts} busy={busy} canWrite={canWrite} act={act} later={later} />}

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

      {card?.kind === "maturity" && <MaturityCard key={card.key} card={card} household={household} accounts={accounts} busy={busy} canWrite={canWrite} act={act} later={later} />}

      {card?.kind === "installment" && <InstallmentCard key={card.key} card={card} household={household} accounts={accounts} busy={busy} canWrite={canWrite} act={act} later={later} />}

      {card?.kind === "settle" && <SettleCard key={card.key} card={card} household={household} accounts={accounts} categories={categories} busy={busy} canWrite={canWrite} act={act} later={later} />}

      {card?.kind === "recurring" && <RecurringCard key={card.key} card={card} household={household} accounts={accounts} busy={busy} canWrite={canWrite} act={act} later={later} />}

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
          {card.suggestedBy === "ai" && categoryId && categoryId === card.suggestedCategoryId && (
            <span className="small ai-guess">The AI's guess from the name. Check it: once you file it, the app remembers this name.</span>
          )}
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

type CardProps<K extends DecideCard["kind"]> = {
  card: Extract<DecideCard, { kind: K }>;
  household: Household;
  accounts: Account[];
  busy: boolean;
  canWrite: boolean;
  act: (run: () => Promise<unknown>, result: string) => Promise<void>;
  later: (what: string) => void;
};

const spendable = (accounts: Account[]) => accounts.filter((a) => !a.closedAt && ["checking", "savings", "cash", "wallet"].includes(a.type));
const termLabel = (t: number) => (t < 12 ? `${t} months` : t === 12 ? "1 year" : t % 12 ? `${t} months` : `${t / 12} years`);

/** A fixed deposit at maturity: renew it as it is, or move the money out. */
function MaturityCard({ card, household, accounts, busy, canWrite, act, later }: CardProps<"maturity">) {
  const cur = household.currency;
  const today = todayIn(household.timezone);
  const others = spendable(accounts);
  const [to, setTo] = useState(card.settleAccountId ?? others[0]?.id ?? "");
  const [interest, setInterest] = useState(card.interestMinor > 0 ? amountInput(card.interestMinor, cur) : "");
  const days = Math.round((Date.parse(card.maturity) - Date.parse(today)) / 86_400_000);
  const keptIn = card.payout === "maturity";
  const when = days < 0 ? `matured on ${shortDate(card.maturity)}` : days === 0 ? "matures today" : `matures in ${days} ${days === 1 ? "day" : "days"}`;
  return (
    <section className="decide-card" aria-label="Fixed deposit maturing">
      <span className="eyebrow" style={{ color: "var(--green-deep)" }}>
        Fixed deposit{card.institution ? ` · ${card.institution}` : ""}
      </span>
      <h2>
        {card.name} {when}. Renew it, or move the money?
      </h2>
      <div className="tally">
        <div>
          <span className="eyebrow">In it now</span>
          <span className="mono" style={{ fontWeight: 600, fontSize: 16 }}>{formatMoney(card.balanceMinor, cur, { symbol: false })}</span>
        </div>
        <div>
          <span className="eyebrow">{keptIn ? "Interest at maturity" : "Interest since last payout"}</span>
          <span className="mono amount-in" style={{ fontWeight: 600, fontSize: 16 }}>+{formatMoney(card.interestMinor, cur, { symbol: false })}</span>
        </div>
      </div>
      {card.goalName && <span className="small" style={{ color: "var(--ink-soft)" }}>It is kept for {card.goalName}; renewing keeps it there.</span>}
      {canWrite && (
        <>
          <div className="row" style={{ alignItems: "flex-end" }}>
            <label style={{ flex: "1 1 160px" }}>
              Interest the bank paid
              <input inputMode="decimal" value={interest} onChange={(e) => setInterest(e.target.value)} />
            </label>
            <label style={{ flex: "1 1 180px" }}>
              If closing, move it to
              <select value={to} onChange={(e) => setTo(e.target.value)}>
                {others.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>
          </div>
          <div className="actions">
            <button type="button" disabled={busy} onClick={() => act(() => api.renewDeposit(household.id, card.accountId, { interest, termMonths: card.termMonths }), `${card.name} renewed for ${termLabel(card.termMonths)}.`)}>
              Renew for another {card.termMonths === 12 ? "year" : termLabel(card.termMonths)}
            </button>
            <button type="button" className="secondary" disabled={busy || !to} onClick={() => act(() => api.closeAccount(household.id, card.accountId, { interest, toAccountId: to }), `${card.name} closed into ${others.find((a) => a.id === to)?.name ?? "the account"}.`)}>
              Close it and move the money
            </button>
            <button type="button" className="quiet" onClick={() => later(card.name)}>
              Leave it for later
            </button>
          </div>
          <span className="small muted">A different rate or term? Use Renew or close on the Accounts page.</span>
        </>
      )}
    </section>
  );
}

/** A loan installment coming up or past its date: log it as paid in one tap. */
function InstallmentCard({ card, household, accounts, busy, canWrite, act, later }: CardProps<"installment">) {
  const cur = household.currency;
  const today = todayIn(household.timezone);
  const others = spendable(accounts);
  const [from, setFrom] = useState(card.settleAccountId ?? others[0]?.id ?? "");
  const overdue = card.due < today;
  const principal = card.installmentMinor - card.interestMinor;
  return (
    <section className="decide-card" aria-label="Loan installment">
      <span className="eyebrow" style={{ color: overdue ? "var(--rust)" : "var(--marigold-deep)" }}>
        Loan installment{card.institution ? ` · ${card.institution}` : ""}
      </span>
      <h2>
        {formatMoney(card.installmentMinor, cur)} for {card.name} {overdue ? `was due ${shortDate(card.due)}` : card.due === today ? "is due today" : `is due ${shortDate(card.due)}`}. Paid it?
      </h2>
      <span className="small" style={{ color: "var(--ink-soft)" }}>
        {card.interestMinor > 0 ? `About ${formatMoney(card.interestMinor, cur)} is interest and ${formatMoney(principal, cur)} comes off the loan. ` : "No interest: all of it comes off the loan. "}
        {formatMoney(Math.max(0, card.owedMinor - principal), cur)} will be left.
      </span>
      {canWrite && (
        <>
          <label style={{ maxWidth: 280 }}>
            Paid from
            <select value={from} onChange={(e) => setFrom(e.target.value)}>
              {others.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
          <div className="actions">
            <button
              type="button"
              disabled={busy || !from}
              onClick={() => act(() => api.repayment(household.id, card.accountId, { amount: amountInput(card.installmentMinor, cur), date: overdue ? card.due : today, otherAccountId: from }), `${card.name}: ${formatMoney(card.installmentMinor, cur)} logged.`)}
            >
              Yes, log {formatMoney(card.installmentMinor, cur)}
            </button>
            <button type="button" className="quiet" onClick={() => later(`${card.name} installment`)}>
              Not yet
            </button>
          </div>
          <span className="small muted">A different amount? Use Log a payment on the Accounts page.</span>
        </>
      )}
    </section>
  );
}

const everyday = (accounts: Account[]) => accounts.filter((a) => !a.closedAt && a.type !== "deposit" && a.type !== "loan" && a.type !== "lent" && a.type !== "person");

/** An every-month item past its day: log it, point at the entry already in the book, or skip the month. */
function RecurringCard({ card, household, accounts, busy, canWrite, act, later }: CardProps<"recurring">) {
  const cur = household.currency;
  const today = todayIn(household.timezone);
  const others = everyday(accounts);
  const [account, setAccount] = useState(card.accountId ?? others[0]?.id ?? "");
  const [date, setDate] = useState(card.due);
  const [found, setFound] = useState<RecurringCandidate[] | null>(null);
  const [seeking, setSeeking] = useState(false);
  const money = formatMoney(card.amountMinor, cur);
  const isIn = card.direction === "in";
  const late = card.due < today;

  async function lookForIt() {
    setSeeking(true);
    try {
      setFound(await api.recurringCandidates(household.id, card.recurringId, card.month));
    } catch {
      setFound([]);
    } finally {
      setSeeking(false);
    }
  }

  return (
    <section className="decide-card" aria-label="Every month">
      <span className="eyebrow" style={{ color: late ? "var(--rust)" : "var(--marigold-deep)" }}>Every month</span>
      <h2>
        {isIn ? `Did ${money} from ${card.name} come in` : `Did ${money} for ${card.name} go out`} {card.due === today ? "today" : `on ${shortDate(card.due)}`}?
      </h2>
      <span className="small" style={{ color: "var(--ink-soft)" }}>
        {isIn ? "Until it is in the book, Today counts it as expected, not as money in hand." : "Until it is in the book, Today keeps it aside, out of the day figure."}
        {card.note ? ` ${card.note}` : ""}
      </span>
      {canWrite && (
        <>
          <div className="row" style={{ alignItems: "flex-end" }}>
            <label style={{ flex: "1 1 160px" }}>
              {isIn ? "Into" : "Paid from"}
              <select value={account} onChange={(e) => setAccount(e.target.value)}>
                {others.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>
            <label style={{ flex: "1 1 140px" }}>
              On
              <input type="date" value={date} max={today} onChange={(e) => e.target.value && setDate(e.target.value)} />
            </label>
          </div>
          <div className="actions">
            <button type="button" disabled={busy || !account} onClick={() => act(() => api.postRecurring(household.id, card.recurringId, { date, accountId: account }), `${card.name}: ${money} logged.`)}>
              Yes, log {money}
            </button>
            {found === null ? (
              <button type="button" className="secondary" disabled={busy || seeking} onClick={lookForIt}>
                {seeking ? "Looking…" : "It is already in the book"}
              </button>
            ) : (
              <div className="stack choice-list" style={{ gap: 6 }}>
                <span className="small muted">{found.length ? "Which entry is it?" : "Nothing in this month's book looks like it."}</span>
                {found.map((t) => (
                  <button key={t.id} type="button" className="secondary" disabled={busy} onClick={() => act(() => api.doneRecurring(household.id, card.recurringId, { month: card.month, transactionId: t.id }), `${card.name}: counted as the entry from ${shortDate(t.date)}.`)}>
                    <span>
                      {t.name ?? "(no description)"} · {shortDate(t.date)}
                      {t.accountName ? ` · ${t.accountName}` : ""}
                    </span>
                    <span className="mono">{formatMoney(t.amountMinor, cur, { symbol: false })}</span>
                  </button>
                ))}
                <button type="button" className="quiet" disabled={busy} onClick={() => act(() => api.doneRecurring(household.id, card.recurringId, { month: card.month }), `${card.name}: marked handled this month.`)}>
                  It was handled outside the book
                </button>
              </div>
            )}
            <button type="button" className="quiet" disabled={busy} onClick={() => act(() => api.skipRecurring(household.id, card.recurringId, { month: card.month }), `${card.name}: skipped this month.`)}>
              Skip this month
            </button>
            <button type="button" className="quiet" onClick={() => later(card.name)}>
              Later
            </button>
          </div>
          <span className="small muted">A different amount this time? Log it from the + button and pick {card.name} from the chips.</span>
        </>
      )}
    </section>
  );
}

/** An email waiting for a person: where it came from, what it says, and which account it is about. */
function InboxCard({ card, household, busy, act, later }: CardProps<"inbox">) {
  const { data, error } = useMailPreview(household.id, card.statementId);
  const forwarded = data?.held === "forwarded";
  return (
    <section className="decide-card" aria-label="Email waiting for an account">
      <span className="eyebrow" style={{ color: forwarded ? "var(--green-deep)" : "var(--marigold-deep)" }}>
        {forwarded ? "Held email" : "Email from a new sender"} · arrived {when(card.receivedAt)}
      </span>
      <h2>
        {data ? `${data.subject ?? "An email"} from ${senderTitle(data)}.` : `${card.subject ?? "An email"} arrived.`} Which account is it about?
      </h2>
      {error && <div className="error small">{error}</div>}
      {!data && !error && <MailSkeleton />}
      {data && <WhyHeld preview={data} />}
      {data && <MailDetails preview={data} household={household} />}
      {data && (
        <LinkAccount
          household={household}
          preview={data}
          busy={busy}
          onLink={(accountId, name, remember) =>
            act(() => api.releaseStatement(household.id, card.statementId, accountId, remember), `"${data.subject ?? "The email"}" is being read for ${name}${remember && data.sender ? `; ${data.sender} is remembered` : ""}.`)
          }
          onDismiss={() => act(() => api.dismissStatement(household.id, card.statementId), `"${data.subject ?? "The email"}" set aside: not a statement.`)}
          onLater={() => later("An email")}
        />
      )}
    </section>
  );
}

/**
 * Money between people with its settle-by date a week away or past: pay it (or say it came back),
 * with the interest if there is any, or move the date.
 */
function SettleCard({ card, household, accounts, categories, busy, canWrite, act, later }: CardProps<"settle"> & { categories: Category[] }) {
  const cur = household.currency;
  const today = todayIn(household.timezone);
  const others = spendable(accounts);
  const weOwe = card.balanceMinor < 0;
  const owed = Math.abs(card.balanceMinor);
  const interest = Math.abs(card.interestMinor);
  const [from, setFrom] = useState(others[0]?.id ?? "");
  const [withInterest, setWithInterest] = useState(interest > 0);
  const [moving, setMoving] = useState(false);
  const [newDate, setNewDate] = useState(addMonths(card.settleBy < today ? today : card.settleBy, 1));
  const total = owed + (withInterest ? interest : 0);
  const when = card.days === 0 ? "today" : card.days > 0 ? `in ${card.days} ${card.days === 1 ? "day" : "days"}` : `${-card.days} ${card.days === -1 ? "day" : "days"} ago`;
  const otherName = others.find((a) => a.id === from)?.name ?? "the account";
  const expenseCat = categories.find((c) => /^interest$/i.test(c.name) && c.kind !== "income")?.id ?? null;
  const incomeCat = categories.find((c) => /interest/i.test(c.name) && c.kind === "income")?.id ?? null;

  async function settle() {
    if (card.type === "person") {
      if (withInterest && interest > 0) {
        await api.addEntry(household.id, card.accountId, { kind: weOwe ? "credit" : "charge", amount: amountInput(interest, cur), date: today, categoryId: weOwe ? expenseCat : incomeCat, description: `Interest to ${shortDate(today)}` });
      }
      await api.addEntry(household.id, card.accountId, { kind: weOwe ? "gave" : "got", amount: amountInput(total, cur), date: today, otherAccountId: from, description: weOwe ? "Paid back in full" : "Got it back in full" });
    } else {
      await api.repayment(household.id, card.accountId, { amount: amountInput(owed, cur), date: today, otherAccountId: from });
      if (withInterest && interest > 0) {
        await api.addTransaction(household.id, { date: today, amount: amountInput(interest, cur), direction: "in", accountId: from, categoryId: incomeCat, description: `Interest: ${card.name}`, note: "", isPersonal: false, force: true });
      }
    }
  }

  return (
    <section className="decide-card" aria-label="Money to settle">
      <span className="eyebrow" style={{ color: card.days < 0 ? "var(--rust)" : "var(--marigold-deep)" }}>
        {weOwe ? "To pay back" : "Money owed to us"} · {card.days < 0 ? `the date was ${when}` : `due ${when}`}
      </span>
      <h2>
        {weOwe
          ? `Pay ${card.name} back ${formatMoney(owed, cur)}${interest ? ` and ${formatMoney(interest, cur)} interest` : ""}${card.days < 0 ? `; the date was ${shortDate(card.settleBy)}.` : ` by ${shortDate(card.settleBy)}?`}`
          : `${card.name} was to pay back ${formatMoney(owed, cur)}${interest ? ` and ${formatMoney(interest, cur)} interest` : ""} by ${shortDate(card.settleBy)}. Did it come?`}
      </h2>
      <span className="small" style={{ color: "var(--ink-soft)" }}>
        {card.rateBp ? `${rateText(card.rateBp, card.ratePer)}, simple interest to today.` : "No interest: a friendly loan."} The date was your own plan; move it if plans changed.
      </span>
      {canWrite && (
        <>
          <div className="row" style={{ alignItems: "flex-end" }}>
            <label style={{ flex: "1 1 180px" }}>
              {weOwe ? "Paid from" : "Came into"}
              <select value={from} onChange={(e) => setFrom(e.target.value)}>
                {others.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>
          </div>
          {interest > 0 && (
            <label className="check">
              <input type="checkbox" checked={withInterest} onChange={(e) => setWithInterest(e.target.checked)} />
              <span>With the {formatMoney(interest, cur)} interest</span>
            </label>
          )}
          <div className="actions">
            <button type="button" disabled={busy || !from} onClick={() => act(settle, weOwe ? `${card.name}: ${formatMoney(total, cur)} paid from ${otherName}.` : `${card.name}: ${formatMoney(total, cur)} back into ${otherName}.`)}>
              {weOwe ? `Paid ${formatMoney(total, cur)}` : `Yes, ${formatMoney(total, cur)} came back`}
            </button>
            {!moving ? (
              <button type="button" className="secondary" disabled={busy} onClick={() => setMoving(true)}>
                Move the date
              </button>
            ) : (
              <div className="row" style={{ alignItems: "flex-end" }}>
                <label style={{ flex: "1 1 160px" }}>
                  New date
                  <input type="date" value={newDate} min={today} onChange={(e) => e.target.value && setNewDate(e.target.value)} />
                </label>
                <button type="button" className="secondary" disabled={busy} onClick={() => act(() => api.updateAccount(household.id, card.accountId, { endDate: newDate }), `${card.name}: moved to ${shortDate(newDate)}.`)}>
                  Save the date
                </button>
              </div>
            )}
            <button type="button" className="quiet" onClick={() => later(card.name)}>
              Later
            </button>
          </div>
          <span className="small muted">Paid part of it? Add the entry on {card.name}'s khata page.</span>
        </>
      )}
    </section>
  );
}
