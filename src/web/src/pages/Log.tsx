import { useEffect, useMemo, useState } from "react";
import { addDays, todayIn } from "../../../shared/dates";
import { api, ApiError, isQueued, QUEUED_NOTE, type Account, type Category, type Goal, type Household, type LogHints, type Member, type Twin } from "../api";
import { onLinkClick } from "../router";
import { CategorySelect, Checks, Icon, Sheet, amountInput, categoryLabel, formatMoney, shortDate } from "../ui";

type Kind = "out" | "in" | "move";
type Phase = { step: "edit" } | { step: "twin"; twins: Twin[] } | { step: "done"; message: string };

/**
 * Logging money in two taps: pick a repeat or type an amount and where, and save. Merchant memory
 * fills the category and account; a payment that looks already in the book is shown before it is
 * saved, so the family decides whether it is the same one.
 */
export function Log({
  household,
  accounts,
  categories,
  members,
  goals,
  initialKind = "out",
  onClose,
  onSaved,
}: {
  household: Household;
  accounts: Account[];
  categories: Category[];
  members: Member[];
  goals: Goal[];
  initialKind?: Kind;
  onClose: () => void;
  onSaved: () => void;
}) {
  const today = todayIn(household.timezone);
  const cur = household.currency;
  // Spending and income touch everyday accounts and cards; deposits, loans and money lent only move.
  const open = accounts.filter((a) => !a.closedAt);
  const everyday = open.filter((a) => a.type !== "deposit" && a.type !== "loan" && a.type !== "lent" && a.type !== "person");
  // A contact's khata: buying on credit from them, or money they owe us, or a move to settle up.
  const contacts = open.filter((a) => a.type === "person");
  const [kind, setKind] = useState<Kind>(initialKind);
  const [amount, setAmount] = useState("");
  const [payee, setPayee] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [categoryTouched, setCategoryTouched] = useState(false);
  const [accountId, setAccountId] = useState(everyday[0]?.id ?? open[0]?.id ?? "");
  const [accountTouched, setAccountTouched] = useState(false);
  const [target, setTarget] = useState(goals[0] ? `goal:${goals[0].id}` : open[1] ? `account:${open[1].id}` : "");
  const [date, setDate] = useState(today);
  const [paidBy, setPaidBy] = useState(household.me.id);
  const [note, setNote] = useState("");
  const [isPersonal, setIsPersonal] = useState(false);
  const [more, setMore] = useState(false);
  const [hints, setHints] = useState<LogHints | null>(null);
  const [phase, setPhase] = useState<Phase>({ step: "edit" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.logHints(household.id).then(setHints).catch(() => setHints({ repeats: [], merchants: [] }));
  }, [household.id]);

  const known = useMemo(() => {
    const p = payee.trim().toLowerCase();
    if (!p || !hints) return null;
    return hints.merchants.find((m) => m.name.toLowerCase() === p) ?? null;
  }, [payee, hints]);

  // Merchant memory: fill what the family used last time, unless someone already chose.
  useEffect(() => {
    if (!known || kind === "move") return;
    if (!categoryTouched && known.categoryId) setCategoryId(known.categoryId);
    if (!accountTouched && accounts.some((a) => a.id === known.accountId)) setAccountId(known.accountId);
  }, [known, kind, categoryTouched, accountTouched, accounts]);

  const accountName = (id: string) => accounts.find((a) => a.id === id)?.name ?? "an account";
  const repeats = (hints?.repeats ?? []).filter((r) => (kind === "in" ? r.direction === "in" : r.direction === "out"));
  const yesterday = addDays(today, -1);

  function useRepeat(r: LogHints["repeats"][number]) {
    setPayee(r.name);
    setAmount(amountInput(r.amountMinor, cur));
    setCategoryId(r.categoryId);
    setCategoryTouched(true);
    if (accounts.some((a) => a.id === r.accountId)) {
      setAccountId(r.accountId);
      setAccountTouched(true);
    }
  }

  function reset() {
    setAmount("");
    setPayee("");
    setCategoryId(null);
    setCategoryTouched(false);
    setAccountTouched(false);
    setNote("");
    setIsPersonal(false);
    setPhase({ step: "edit" });
    setError(null);
  }

  async function save(force = false) {
    setError(null);
    if (!amount.trim()) return setError("Type the amount first.");
    const onContact = contacts.find((a) => a.id === accountId);
    if (kind !== "move" && !payee.trim() && !onContact) return setError(kind === "out" ? "Where was it paid? A shop or person is enough." : "Who paid you? An employer or person is enough.");
    setBusy(true);
    try {
      if (kind === "move") {
        if (target.startsWith("goal:")) {
          const goal = goals.find((g) => `goal:${g.id}` === target);
          const r = await api.addContribution(household.id, target.slice(5), { amount, date, note, fromAccountId: accountId || null });
          setPhase({ step: "done", message: isQueued(r) ? QUEUED_NOTE : `Moved to ${goal?.name ?? "the goal"}. It counts as saved, not spent.` });
        } else if (target.startsWith("account:")) {
          const to = open.find((a) => a.id === target.slice(8));
          const from = open.find((a) => a.id === accountId);
          if (to?.type === "person" || from?.type === "person") {
            // Settling up with a contact goes into their khata.
            const contact = to?.type === "person" ? to : from!;
            const mine = to?.type === "person" ? from : to;
            if (!mine || mine.type === "person") return setError("Choose one of your own accounts on the other side.");
            const r = await api.addEntry(household.id, contact.id, { kind: contact === to ? "gave" : "got", amount, date, otherAccountId: mine.id, note });
            setPhase({ step: "done", message: isQueued(r) ? QUEUED_NOTE : contact === to ? `Paid ${contact.name}; their khata is updated.` : `Got money from ${contact.name}; their khata is updated.` });
          } else if (to?.type === "loan") {
            // A payment on a loan: the interest part is an expense, the rest comes off what is owed.
            const r = await api.repayment(household.id, to.id, { amount, date, otherAccountId: accountId, note });
            setPhase({ step: "done", message: isQueued(r) ? QUEUED_NOTE : `Paid toward ${to.name}: ${formatMoney(r.principalMinor, cur)} off the loan${r.interestMinor ? `, ${formatMoney(r.interestMinor, cur)} interest` : ""}.` });
          } else if (from?.type === "lent" && to) {
            const r = await api.repayment(household.id, from.id, { amount, date, otherAccountId: to.id, note });
            setPhase({ step: "done", message: isQueued(r) ? QUEUED_NOTE : `${formatMoney(r.principalMinor, cur)} came back from ${from.name}.` });
          } else {
            const r = await api.addTransfer(household.id, { fromAccountId: accountId, toAccountId: target.slice(8), amount, date, note });
            setPhase({ step: "done", message: isQueued(r) ? QUEUED_NOTE : "Moved between your accounts. Moves are not spending." });
          }
        } else {
          setError("Choose where the money goes.");
          return;
        }
      } else {
        const res = await api.addTransaction(household.id, {
          date,
          amount,
          direction: kind,
          accountId,
          categoryId,
          description: payee.trim() || (onContact ? `On credit from ${onContact.name}` : ""),
          note,
          isPersonal,
          paidByMemberId: paidBy,
          force,
        });
        const filed = !categoryId && res.categoryId ? ` Filed under ${categoryLabel(categories, res.categoryId)}, from last time.` : "";
        setPhase({ step: "done", message: isQueued(res) ? QUEUED_NOTE : `Logged.${filed} The first check is yours; the second comes when the bank confirms it.` });
      }
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && (err.details as { twins?: Twin[] })?.twins?.length) {
        setPhase({ step: "twin", twins: (err.details as { twins: Twin[] }).twins });
      } else {
        setError(err instanceof ApiError ? err.message : "Could not save it");
      }
    } finally {
      setBusy(false);
    }
  }

  async function sameAs(twin: Twin) {
    setBusy(true);
    setError(null);
    try {
      if (twin.kind === "line") {
        await api.decide(household.id, twin.id, "accept", categoryId, { description: payee.trim(), note: note.trim(), paidByMemberId: paidBy });
        setPhase({ step: "done", message: "Counted once. The bank's line now carries your name for it, category and note." });
      } else {
        const patch: { categoryId?: string | null; note?: string } = {};
        if (categoryId) patch.categoryId = categoryId;
        if (note.trim()) patch.note = twin.note ? `${twin.note} · ${note.trim()}` : note.trim();
        if (Object.keys(patch).length) await api.updateTransaction(household.id, twin.id, patch);
        setPhase({ step: "done", message: `Counted once. Nothing new was added${Object.keys(patch).length ? "; your details were added to it" : ""}.` });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update it");
    } finally {
      setBusy(false);
    }
  }

  if (!open.length) {
    return (
      <Sheet title="Log it" onClose={onClose}>
        <p>
          Add an account first, such as a joint bank account, a card, or cash.{" "}
          <a href={`/h/${household.id}/family/accounts`} onClick={(e) => { onClose(); onLinkClick(e); }}>
            Add an account
          </a>
        </p>
      </Sheet>
    );
  }

  const sign = kind === "in" ? "+" : kind === "out" ? "−" : "";
  const symbol = formatMoney(0, cur).replace(/[\d.,\s−+]/g, "") || cur;

  const footer =
    phase.step === "done" ? (
      <>
        <button type="button" className="secondary" onClick={onClose}>
          Done
        </button>
        <button type="button" className="wide" onClick={reset}>
          Log another
        </button>
      </>
    ) : phase.step === "twin" ? null : (
      <>
        <button type="button" className="secondary" aria-expanded={more} onClick={() => setMore((m) => !m)}>
          <Icon.note />
          Note
        </button>
        <button type="button" className={`wide ${kind === "in" ? "" : "dark"}`} disabled={busy} onClick={() => save(false)}>
          {busy ? "Saving…" : "Save"}
        </button>
      </>
    );

  return (
    <Sheet title="Log it" onClose={onClose} footer={footer}>
      <div className="seg" role="group" aria-label="Direction">
        {(["out", "in", "move"] as const).map((k) => (
          <button key={k} type="button" className={k === "in" ? "in" : ""} aria-pressed={kind === k} onClick={() => { setKind(k); setPhase({ step: "edit" }); }}>
            {k === "out" ? "Money out" : k === "in" ? "Money in" : "Move or save"}
          </button>
        ))}
      </div>

      <div className="amount-entry">
        <span className="sign" aria-hidden="true">
          {sign}
          {symbol}
        </span>
        <label className="sr-only" htmlFor="log-amount">
          Amount
        </label>
        <input id="log-amount" inputMode="decimal" autoComplete="off" placeholder="0" style={{ width: `${Math.max(2, amount.length + 1)}ch` }} value={amount} onChange={(e) => { setAmount(e.target.value); setPhase({ step: "edit" }); }} />
      </div>

      {phase.step === "edit" && kind !== "move" && repeats.length > 0 && (
        <div className="stack" style={{ gap: 6 }}>
          <span className="small muted">Again, in one tap</span>
          <div className="chips">
            {repeats.map((r) => (
              <button key={`${r.name}-${r.amountMinor}-${r.accountId}`} type="button" className="chip" onClick={() => useRepeat(r)}>
                {r.name} <span className="mono">{formatMoney(r.amountMinor, cur, { symbol: false })}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {kind !== "move" ? (
        <>
          <label>
            {kind === "out" ? "Paid to" : "From"}
            <input list="log-merchants" value={payee} onChange={(e) => setPayee(e.target.value)} placeholder={kind === "out" ? "Shop, person or bill" : "Employer, tenant or person"} />
            <datalist id="log-merchants">
              {hints?.merchants.filter((m) => m.direction === kind).map((m) => <option key={m.name} value={m.name} />)}
            </datalist>
          </label>
          {known && (
            <p className="memory">
              {known.name} is usually {known.categoryId ? categoryLabel(categories, known.categoryId) : "uncategorised"} on {accountName(known.accountId)}, last {formatMoney(known.amountMinor, cur)}.
            </p>
          )}
          <div className="row" style={{ alignItems: "flex-end" }}>
            <label style={{ flex: "1 1 180px" }}>
              Category
              <CategorySelect
                categories={categories}
                value={categoryId}
                onChange={(id) => { setCategoryId(id); setCategoryTouched(true); }}
                label="Category"
                filter={(c) => (kind === "in" ? c.kind === "income" : c.kind !== "income" && c.kind !== "transfer")}
              />
            </label>
            <label style={{ flex: "1 1 150px" }}>
              {kind === "out" ? "Paid from" : "Into"}
              <select value={accountId} onChange={(e) => { setAccountId(e.target.value); setAccountTouched(true); }}>
                {everyday.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                {contacts.length > 0 && (
                  <optgroup label={kind === "out" ? "On credit from (we owe them)" : "Owed to us by"}>
                    {contacts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </optgroup>
                )}
              </select>
            </label>
          </div>
        </>
      ) : (
        <div className="row" style={{ alignItems: "flex-end" }}>
          <label style={{ flex: "1 1 160px" }}>
            From
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {open.filter((a) => a.type !== "person").map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              {contacts.length > 0 && (
                <optgroup label="A contact (they paid or lent us)">
                  {contacts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </optgroup>
              )}
            </select>
          </label>
          <label style={{ flex: "1 1 180px" }}>
            To
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              {goals.length > 0 && (
                <optgroup label="A goal">
                  {goals.map((g) => <option key={g.id} value={`goal:${g.id}`}>{g.name}</option>)}
                </optgroup>
              )}
              <optgroup label="Another account">
                {open.filter((a) => a.id !== accountId && a.type !== "loan" && a.type !== "person").map((a) => <option key={a.id} value={`account:${a.id}`}>{a.name}</option>)}
              </optgroup>
              {contacts.some((a) => a.id !== accountId) && (
                <optgroup label="A contact (we paid them)">
                  {contacts.filter((a) => a.id !== accountId).map((a) => <option key={a.id} value={`account:${a.id}`}>{a.name}</option>)}
                </optgroup>
              )}
              {open.some((a) => a.type === "loan") && (
                <optgroup label="A loan payment">
                  {open.filter((a) => a.id !== accountId && a.type === "loan").map((a) => <option key={a.id} value={`account:${a.id}`}>{a.name}</option>)}
                </optgroup>
              )}
            </select>
          </label>
        </div>
      )}

      <div className="stack" style={{ gap: 6 }}>
        <span className="small" style={{ fontWeight: 500 }}>When</span>
        <div className="chips">
          <button type="button" className="chip" aria-pressed={date === today} onClick={() => setDate(today)}>Today</button>
          <button type="button" className="chip" aria-pressed={date === yesterday} onClick={() => setDate(yesterday)}>Yesterday</button>
          <label className="sr-only" htmlFor="log-date">Pick a date</label>
          <input id="log-date" type="date" value={date} max={today} onChange={(e) => e.target.value && setDate(e.target.value)} style={{ minHeight: 44, borderRadius: 999 }} />
        </div>
      </div>

      {more && (
        <div className="stack">
          <label>
            Note
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="For Dashain shopping" />
          </label>
          {kind !== "move" && members.length > 1 && (
            <label>
              Who
              <select value={paidBy} onChange={(e) => setPaidBy(e.target.value)}>
                {members.map((m) => <option key={m.id} value={m.id}>{m.id === household.me.id ? `${m.name} (you)` : m.name}</option>)}
              </select>
            </label>
          )}
          {kind === "out" && (
            <label className="check">
              <input type="checkbox" checked={isPersonal} onChange={(e) => setIsPersonal(e.target.checked)} />
              Personal: others see the amount, not the details
            </label>
          )}
        </div>
      )}

      {error && <div className="error" role="alert">{error}</div>}

      {phase.step === "twin" && (
        <div className="note stack" role="status" style={{ gap: 10 }}>
          <strong>{phase.twins[0]!.kind === "line" || phase.twins[0]!.confirmed ? "The bank already has one like this" : "Someone already logged one like this"}</strong>
          {phase.twins.map((t) => (
            <div key={t.id} className="card" style={{ padding: "10px 12px", color: "var(--ink)" }}>
              <div className="row between" style={{ flexWrap: "nowrap" }}>
                <span className="stack" style={{ gap: 0, minWidth: 0 }}>
                  <strong style={{ fontFamily: t.kind === "line" ? "var(--font-mono)" : undefined, fontSize: t.kind === "line" ? 13 : undefined }}>{t.name ?? "(no description)"}</strong>
                  <span className="small muted">
                    {shortDate(t.date)} · {t.accountName}
                    {t.byName ? ` · ${t.byName} logged it` : ""}
                    {t.kind === "line" ? " · from the statement" : ""}
                  </span>
                </span>
                <span className="stack" style={{ gap: 2, alignItems: "flex-end" }}>
                  <span className="mono">{formatMoney(t.amountMinor, cur, { symbol: false })}</span>
                  <Checks confirmed={t.confirmed} />
                </span>
              </div>
            </div>
          ))}
          <span className="small" style={{ color: "var(--ink-soft)" }}>Same account, same amount, within a couple of days.</span>
          <button type="button" className="dark" disabled={busy} onClick={() => sameAs(phase.twins[0]!)}>
            Same payment — count it once
          </button>
          <button type="button" className="secondary" disabled={busy} onClick={() => save(true)}>
            No, this is a separate payment
          </button>
        </div>
      )}

      {phase.step === "done" && (
        <div className="ok row" role="status" style={{ flexWrap: "nowrap", alignItems: "flex-start" }}>
          <Checks confirmed={false} />
          <span>{phase.message}</span>
        </div>
      )}
    </Sheet>
  );
}
