/**
 * Accounts of every kind — bank, cash, wallet, fixed deposit, card, loan, money lent — as one
 * form and one card, shared by the Starting point page and the Accounts page.
 */
import { useState } from "react";
import { addDays, todayIn } from "../../../shared/dates";
import { rateLabel } from "../../../shared/deposit";
import { parseAmountToMinor } from "../../../shared/money";
import { rateText } from "../../../shared/terms";
import { TermsEditor, termsBody, termsFrom, type TermsValue } from "./termsKit";
import { minorDigits } from "../../../shared/money";
import { monthName } from "../../../shared/plan";
import { api, ApiError, isQueued, QUEUED_NOTE, type Account, type AccountBody, type AccountType, type DepositPayout, type Goal, type Household } from "../api";
import { amountInput, formatMoney, shortDate } from "../ui";

export const TYPES: { type: AccountType; label: string; group: Group; hint: string }[] = [
  { type: "checking", label: "Bank account", group: "everyday", hint: "Current or salary account" },
  { type: "savings", label: "Savings", group: "saved", hint: "A savings account" },
  { type: "cash", label: "Cash", group: "everyday", hint: "Cash at home or in hand" },
  { type: "wallet", label: "Wallet", group: "everyday", hint: "eSewa, Khalti and the like" },
  { type: "deposit", label: "Fixed deposit", group: "saved", hint: "Money locked in for a term" },
  { type: "credit", label: "Credit card", group: "owed", hint: "What is owed on a card" },
  { type: "loan", label: "Loan we owe", group: "owed", hint: "Home, car or personal loan, or a friendly loan with a fixed sum" },
  { type: "lent", label: "Money we lent", group: "lent", hint: "A sum lent to someone, to be repaid" },
  { type: "person", label: "Contact", group: "people", hint: "A shop, relative or friend we run a tab with" },
];

export type Group = "everyday" | "saved" | "lent" | "owed" | "people";
export const GROUPS: { id: Group; label: string }[] = [
  { id: "everyday", label: "Everyday money" },
  { id: "saved", label: "Savings and deposits" },
  { id: "lent", label: "Money lent to others" },
  { id: "owed", label: "What we owe" },
];

export const typeInfo = (t: AccountType) => TYPES.find((x) => x.type === t)!;
const TERMS = [3, 6, 12, 24, 36, 60];

/** A one-line summary under an account's name. */
export function accountLine(a: Account, cur: string): string {
  const m = (v: number) => formatMoney(v, cur);
  const about = (v: number) => formatMoney(Math.round(v / 10 ** minorDigits(cur)) * 10 ** minorDigits(cur), cur);
  if (a.type === "deposit" && a.deposit && a.rateBp !== null && a.endDate) {
    return `${rateLabel(a.rateBp)} · matures ${shortDate(a.endDate)} ${a.endDate.slice(0, 4)} · ${a.depositPayout === "maturity" || !a.depositPayout ? `about ${about(a.deposit.maturityValueMinor)} then` : `interest paid ${a.depositPayout}`}`;
  }
  if (a.type === "loan" && a.loan) {
    const rate = a.rateBp ? rateLabel(a.rateBp) : "no interest";
    if (a.installmentMinor) {
      return `${rate} · ${m(a.installmentMinor)} on the ${a.installmentDay ?? 1}${ordinalSuffix(a.installmentDay ?? 1)}${a.loan.payoffMonth ? ` · paid off ${monthName(a.loan.payoffMonth)}` : a.loan.monthsLeft === null ? " · the installment does not cover the interest" : ""}`;
    }
    return `${rate}${a.endDate ? ` · repay by ${shortDate(a.endDate)} ${a.endDate.slice(0, 4)}` : " · no fixed installment"}`;
  }
  if (a.type === "lent") {
    const rate = (a.rateBp ?? 0) > 0 ? `${rateText(a.rateBp, a.ratePer)}${a.terms?.interestMinor ? ` · ${about(Math.abs(a.terms.interestMinor))} interest so far` : ""}` : "no interest";
    return `${a.endDate ? `Expected back by ${shortDate(a.endDate)} ${a.endDate.slice(0, 4)}` : "No date agreed"} · ${rate}`;
  }
  if (a.openingBalanceDate) {
    const from = addDays(a.openingBalanceDate, 1);
    return `Counting from ${shortDate(from)} ${from.slice(0, 4)}${a.institution ? ` · ${a.institution}` : ""}`;
  }
  return a.institution ?? "No starting balance yet";
}

function ordinalSuffix(n: number): string {
  return n % 100 >= 11 && n % 100 <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
}

/** The form for a new account of any kind, or for editing one. */
export function AccountForm({
  household,
  accounts,
  goals,
  initial,
  initialType = "checking",
  types,
  onSaved,
  onCancel,
}: {
  household: Household;
  accounts: Account[];
  goals: Goal[];
  initial?: Account;
  initialType?: AccountType;
  types?: AccountType[];
  onSaved: () => void;
  onCancel?: () => void;
}) {
  const cur = household.currency;
  const today = todayIn(household.timezone);
  const a = initial;
  const [type, setType] = useState<AccountType>(a?.type ?? initialType);
  const [name, setName] = useState(a?.name ?? "");
  const [institution, setInstitution] = useState(a?.institution ?? "");
  const [balance, setBalance] = useState(a && a.openingBalanceMinor !== null && a.type !== "deposit" ? amountInput(Math.abs(a.openingBalanceMinor), cur) : "");
  const [balanceDate, setBalanceDate] = useState(today);
  const [balanceTouched, setBalanceTouched] = useState(false);
  const [principal, setPrincipal] = useState(a?.principalMinor ? amountInput(a.principalMinor, cur) : "");
  const [rate, setRate] = useState(a?.rateBp ? String(a.rateBp / 100) : "");
  const [startDate, setStartDate] = useState(a?.startDate ?? today);
  const [term, setTerm] = useState<number | null>(a ? null : 12);
  const [endDate, setEndDate] = useState(a?.endDate ?? "");
  const [payout, setPayout] = useState<DepositPayout>(a?.depositPayout ?? "maturity");
  const [settle, setSettle] = useState(a?.settleAccountId ?? "");
  const [installment, setInstallment] = useState(a?.installmentMinor ? amountInput(a.installmentMinor, cur) : "");
  const [months, setMonths] = useState("");
  const [day, setDay] = useState(a?.installmentDay ?? Math.min(28, Number(today.slice(8, 10))));
  const [goalId, setGoalId] = useState(a?.goalId ?? "");
  const [sender, setSender] = useState(a?.statementSenderPattern ?? "");
  const [terms, setTerms] = useState<TermsValue>(termsFrom(a));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const others = accounts.filter((x) => x.id !== a?.id && !x.closedAt && ["checking", "savings", "cash", "wallet"].includes(x.type));
  const info = typeInfo(type);
  const isOwed = type === "credit" || type === "loan";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const body: AccountBody = { name: name.trim() || defaultName(type, institution), institution, goalId: goalId || null };
    if (type === "deposit") {
      Object.assign(body, { principal, rate, startDate, payout, settleAccountId: payout === "maturity" ? null : settle || null });
      if (term) body.termMonths = term;
      else body.endDate = endDate || null;
    } else {
      // Editing sends the balance only when it was changed, as of the date shown (today = right now).
      if (!a || balanceTouched) Object.assign(body, { balance: balance.trim() || "0", balanceDate });
      if (["checking", "savings", "credit"].includes(type)) body.statementSenderPattern = sender;
    }
    if (type === "loan") {
      Object.assign(body, { rate: rate || "0", settleAccountId: settle || null, endDate: endDate || null });
      if (installment.trim()) Object.assign(body, { installment, installmentDay: day });
      else if (months.trim() && Number(months) > 0) Object.assign(body, { termMonths: Number(months), installmentDay: day });
      if (principal.trim()) body.principal = principal;
    }
    if (type === "lent") Object.assign(body, termsBody(terms));
    setBusy(true);
    try {
      if (a) await api.updateAccount(household.id, a.id, body);
      else await api.createAccount(household.id, { ...body, type });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the account");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card stack" onSubmit={submit} aria-label={a ? `Edit ${a.name}` : "Add an account"}>
      {!a && (
        <div className="chips" role="group" aria-label="Kind of account">
          {(types ?? TYPES.filter((t) => t.group !== "people").map((t) => t.type)).map((t) => (
            <button key={t} type="button" className="chip" aria-pressed={type === t} onClick={() => setType(t)}>
              {typeInfo(t).label}
            </button>
          ))}
        </div>
      )}
      <span className="small muted">{info.hint}</span>

      <div className="row" style={{ alignItems: "flex-end" }}>
        <label style={{ flex: "2 1 200px" }}>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={placeholderName(type)} />
        </label>
        <label style={{ flex: "1 1 160px" }}>
          {type === "loan" ? "Lender" : type === "lent" ? "Lent to" : type === "cash" ? "Kept where (optional)" : "Bank or provider"}
          <input value={institution} onChange={(e) => setInstitution(e.target.value)} placeholder={type === "loan" ? "Bank, or the person" : type === "lent" ? "Who has it" : ""} />
        </label>
      </div>

      {type === "deposit" ? (
        <>
          <div className="row" style={{ alignItems: "flex-end" }}>
            <label style={{ flex: "1 1 150px" }}>
              Amount put in
              <input required inputMode="decimal" value={principal} onChange={(e) => setPrincipal(e.target.value)} />
            </label>
            <label style={{ flex: "1 1 110px" }}>
              Interest a year, %
              <input required inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="8.5" />
            </label>
            <label style={{ flex: "1 1 150px" }}>
              Started on
              <input type="date" required value={startDate} max={today} onChange={(e) => setStartDate(e.target.value)} />
            </label>
          </div>
          <div className="stack" style={{ gap: 6 }}>
            <span className="small" style={{ fontWeight: 500 }}>Term</span>
            <div className="chips">
              {TERMS.map((t) => (
                <button key={t} type="button" className="chip" aria-pressed={term === t} onClick={() => setTerm(t)}>
                  {t < 12 ? `${t} months` : t === 12 ? "1 year" : `${t / 12} years`}
                </button>
              ))}
              <label className="sr-only" htmlFor={`mat-${a?.id ?? "new"}`}>Or the maturity date</label>
              <input
                id={`mat-${a?.id ?? "new"}`}
                type="date"
                value={term ? "" : endDate}
                onChange={(e) => { setEndDate(e.target.value); setTerm(null); }}
                style={{ minHeight: 44, borderRadius: 999 }}
                aria-label="Maturity date"
              />
            </div>
          </div>
          <div className="row" style={{ alignItems: "flex-end" }}>
            <label style={{ flex: "1 1 220px" }}>
              Interest
              <select value={payout} onChange={(e) => setPayout(e.target.value as DepositPayout)}>
                <option value="maturity">Stays in, paid at maturity</option>
                <option value="quarterly">Paid out every quarter</option>
                <option value="monthly">Paid out every month</option>
              </select>
            </label>
            {payout !== "maturity" && (
              <label style={{ flex: "1 1 180px" }}>
                Paid into
                <select value={settle} onChange={(e) => setSettle(e.target.value)}>
                  <option value="">Choose an account</option>
                  {others.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
              </label>
            )}
          </div>
        </>
      ) : (
        <div className="row" style={{ alignItems: "flex-end" }}>
          <label style={{ flex: "1 1 180px" }}>
            {type === "loan" ? "Still owed" : type === "credit" ? "Owed on the card" : type === "lent" ? "They still owe us" : "Balance"}
            <input inputMode="decimal" required={!a || type === "loan"} value={balance} onChange={(e) => { setBalance(e.target.value); setBalanceTouched(true); }} placeholder={isOwed ? "What you owe, e.g. 1,250,000" : "What the bank shows"} />
          </label>
          <label style={{ flex: "1 1 160px" }}>
            As of
            <input type="date" value={balanceDate} max={today} onChange={(e) => { setBalanceDate(e.target.value); setBalanceTouched(true); }} />
          </label>
        </div>
      )}

      {type === "loan" && (
        <>
          <div className="row" style={{ alignItems: "flex-end" }}>
            <label style={{ flex: "1 1 110px" }}>
              Interest a year, %
              <input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="0 for a friendly loan" />
            </label>
            <label style={{ flex: "1 1 140px" }}>
              Installment (EMI)
              <input inputMode="decimal" value={installment} onChange={(e) => setInstallment(e.target.value)} placeholder="Monthly amount" />
            </label>
            <label style={{ flex: "1 1 140px" }}>
              Or months left
              <input inputMode="numeric" value={months} disabled={Boolean(installment.trim())} onChange={(e) => setMonths(e.target.value)} placeholder="We work out the EMI" />
            </label>
          </div>
          <div className="row" style={{ alignItems: "flex-end" }}>
            <label style={{ flex: "1 1 140px" }}>
              Due on day
              <select value={day} onChange={(e) => setDay(Number(e.target.value))}>
                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>
            <label style={{ flex: "1 1 180px" }}>
              Paid from
              <select value={settle} onChange={(e) => setSettle(e.target.value)}>
                <option value="">Choose when paying</option>
                {others.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </label>
            <label style={{ flex: "1 1 160px" }}>
              Repay by (optional)
              <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </label>
          </div>
          <span className="small muted">For a friendly loan, leave the rate empty. Without an installment, it shows as owed until it is repaid.</span>
        </>
      )}

      {type === "lent" && (
        <TermsEditor value={terms} onChange={setTerms} side="owed" currency={cur} amountMinor={parseAmountToMinor(balance, cur) ?? a?.balanceMinor ?? 0} today={today} />
      )}

      <div className="row" style={{ alignItems: "flex-end" }}>
        {(type === "deposit" || type === "savings" || type === "checking" || type === "cash" || type === "wallet") && goals.length > 0 && (
          <label style={{ flex: "1 1 200px" }}>
            Money for a goal
            <select value={goalId} onChange={(e) => setGoalId(e.target.value)}>
              <option value="">Not for a goal</option>
              {goals.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </label>
        )}
        {["checking", "savings", "credit"].includes(type) && (
          <label style={{ flex: "2 1 260px" }}>
            Bank email senders (optional)
            <input value={sender} onChange={(e) => setSender(e.target.value)} placeholder="alerts@bank.example, @bank.example" />
          </label>
        )}
      </div>

      {error && <div className="error" role="alert">{error}</div>}
      <div className="row">
        <button type="submit" disabled={busy}>
          {busy ? "Saving…" : a ? "Save changes" : `Add ${info.label.toLowerCase()}`}
        </button>
        {onCancel && (
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

function placeholderName(t: AccountType): string {
  return { checking: "Salary account", savings: "Joint savings", cash: "Cash at home", wallet: "eSewa", deposit: "Land FD", credit: "Joint card", loan: "Home loan", lent: "Loan to Ram", person: "Ram Kirana" }[t];
}

function defaultName(t: AccountType, institution: string): string {
  const base = typeInfo(t).label;
  return institution.trim() ? `${institution.trim()} ${base.toLowerCase()}` : base;
}

/** Money in or out of an account in its group's sense: owed shows as positive "owed". */
export function AccountAmount({ a, cur }: { a: Account; cur: string }) {
  const owed = a.type === "credit" || a.type === "loan";
  return (
    <span className="stack" style={{ gap: 0, alignItems: "flex-end" }}>
      <span className="mono" style={{ fontWeight: 600, color: owed && a.balanceMinor < 0 ? "var(--rust)" : undefined }}>
        {formatMoney(owed ? -a.balanceMinor : a.balanceMinor, cur, { symbol: false })}
      </span>
      {a.deposit && a.deposit.accruedMinor > 0 && <span className="small muted">+{formatMoney(a.deposit.accruedMinor, cur, { symbol: false })} interest so far</span>}
      {owed && a.balanceMinor < 0 && <span className="small muted">owed</span>}
    </span>
  );
}

/** Pay an installment on a loan, or record money coming back on one we gave. */
export function RepaymentForm({ household, account, accounts, onDone }: { household: Household; account: Account; accounts: Account[]; onDone: () => void }) {
  const cur = household.currency;
  const today = todayIn(household.timezone);
  const isLoan = account.type === "loan";
  const others = accounts.filter((x) => x.id !== account.id && !x.closedAt && ["checking", "savings", "cash", "wallet"].includes(x.type));
  const [amount, setAmount] = useState(account.installmentMinor ? amountInput(Math.min(account.installmentMinor, (account.loan?.owedMinor ?? 0) + (account.loan?.nextInterestMinor ?? 0)), cur) : "");
  const [date, setDate] = useState(today);
  const [other, setOther] = useState(account.settleAccountId ?? others[0]?.id ?? "");
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const r = await api.repayment(household.id, account.id, { amount, date, otherAccountId: other });
      setMsg(isQueued(r) ? QUEUED_NOTE : isLoan ? `Logged: ${formatMoney(r.principalMinor, cur)} off the loan${r.interestMinor ? `, ${formatMoney(r.interestMinor, cur)} interest` : ""}.` : `Logged: ${formatMoney(r.principalMinor, cur)} back.`);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not log it");
    }
  }

  return (
    <form className="stack" onSubmit={submit} style={{ gap: 8 }}>
      <div className="row" style={{ alignItems: "flex-end" }}>
        <label style={{ flex: "1 1 130px" }}>
          {isLoan ? "Paid" : "Got back"}
          <input required inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label style={{ flex: "1 1 160px" }}>
          {isLoan ? "From" : "Into"}
          <select required value={other} onChange={(e) => setOther(e.target.value)}>
            <option value="">Choose an account</option>
            {others.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </label>
        <label style={{ flex: "1 1 140px" }}>
          On
          <input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} />
        </label>
        <button type="submit">{isLoan ? "Log the payment" : "Log it"}</button>
      </div>
      {isLoan && (account.rateBp ?? 0) > 0 && <span className="small muted">This month's interest is filed as an expense; the rest reduces the loan.</span>}
      {msg && <div className="ok small">{msg}</div>}
      {error && <div className="error small">{error}</div>}
    </form>
  );
}

/** A deposit at maturity: renew it, or close it into another account. */
export function MaturityForm({ household, account, accounts, onDone }: { household: Household; account: Account; accounts: Account[]; onDone: () => void }) {
  const cur = household.currency;
  const keptIn = (account.depositPayout ?? "maturity") === "maturity";
  const estimate = account.deposit ? (keptIn ? account.deposit.maturityValueMinor - (account.principalMinor ?? 0) : account.deposit.accruedMinor) : 0;
  const others = accounts.filter((x) => x.id !== account.id && !x.closedAt && ["checking", "savings", "cash", "wallet"].includes(x.type));
  const [interest, setInterest] = useState(estimate > 0 ? amountInput(estimate, cur) : "");
  const [to, setTo] = useState(account.settleAccountId ?? others[0]?.id ?? "");
  const [term, setTerm] = useState(account.deposit?.termMonths ?? 12);
  const [rate, setRate] = useState(account.rateBp ? String(account.rateBp / 100) : "");
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  return (
    <div className="stack" style={{ gap: 10 }}>
      <label style={{ maxWidth: 260 }}>
        Interest the bank paid{keptIn ? "" : " (if not logged yet)"}
        <input inputMode="decimal" value={interest} onChange={(e) => setInterest(e.target.value)} />
      </label>
      <div className="row" style={{ alignItems: "flex-end" }}>
        <label style={{ flex: "1 1 140px" }}>
          Renew for
          <select value={term} onChange={(e) => setTerm(Number(e.target.value))}>
            {TERMS.map((t) => <option key={t} value={t}>{t < 12 ? `${t} months` : t === 12 ? "1 year" : `${t / 12} years`}</option>)}
          </select>
        </label>
        <label style={{ flex: "1 1 110px" }}>
          New rate, %
          <input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
        </label>
        <button type="button" onClick={() => run(() => api.renewDeposit(household.id, account.id, { interest, termMonths: term, rate }))}>
          Renew it
        </button>
      </div>
      <div className="row" style={{ alignItems: "flex-end" }}>
        <label style={{ flex: "1 1 180px" }}>
          Or close it into
          <select value={to} onChange={(e) => setTo(e.target.value)}>
            {others.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </label>
        <button type="button" className="secondary" disabled={!to} onClick={() => run(() => api.closeAccount(household.id, account.id, { interest, toAccountId: to }))}>
          Close and move the money
        </button>
      </div>
      {error && <div className="error small">{error}</div>}
    </div>
  );
}
