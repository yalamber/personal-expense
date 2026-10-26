/**
 * Repayment terms for money between people: when the family means to pay it back (or expects it
 * back), and whether there is interest. Used by the khata contact sheet and the money-lent form,
 * and shown on the khata list, a contact's page and Today.
 */
import { addDays } from "../../../shared/dates";
import { addMonths } from "../../../shared/deposit";
import { rateInput, rateText, rateToBp, settleStatus, type RatePer } from "../../../shared/terms";
import type { Account, AccountBody } from "../api";
import { formatMoney, shortDate } from "../ui";

export type Side = "owe" | "owed" | "settled";
export type TermsValue = { settleBy: string; interest: boolean; rate: string; per: RatePer; from: string };

export function termsFrom(a?: Pick<Account, "endDate" | "rateBp" | "ratePer" | "startDate"> | null): TermsValue {
  const per: RatePer = a?.ratePer ?? "month";
  return { settleBy: a?.endDate ?? "", interest: (a?.rateBp ?? 0) > 0, rate: rateInput(a?.rateBp ?? null, per), per, from: a?.startDate ?? "" };
}

/** The fields to send with the account. */
export function termsBody(v: TermsValue): Pick<AccountBody, "endDate" | "rate" | "ratePer" | "startDate"> {
  return { endDate: v.settleBy || null, ratePer: v.per, rate: v.interest && v.rate.trim() ? v.rate.trim() : "0", startDate: v.interest && v.from ? v.from : null };
}

const fullDate = (d: string) => `${shortDate(d)} ${d.slice(0, 4)}`;

/** "in 20 days", "today", "6 days late". */
export function dueWords(days: number): string {
  if (days === 0) return "today";
  if (days > 0) return days === 1 ? "tomorrow" : days < 60 ? `in ${days} days` : `in about ${Math.round(days / 30)} months`;
  return -days === 1 ? "a day late" : `${-days} days late`;
}

/** The settle-by date in a few words for a list row: "pay back by 15 Dec, in 20 days". */
export function dueLine(a: Pick<Account, "endDate" | "balanceMinor">, side: Side, today: string): { text: string; late: boolean } | null {
  const s = settleStatus(a.endDate, today);
  if (!s || side === "settled") return null;
  return { text: `${side === "owe" ? "pay back by" : "back by"} ${shortDate(a.endDate!)}, ${dueWords(s.days)}`, late: s.late };
}

/** Pay-back date and interest, as part of a form. `amountMinor` is the balance, for the per-month example. */
export function TermsEditor({ value: v, onChange, side, currency, amountMinor, today }: { value: TermsValue; onChange: (v: TermsValue) => void; side: Side; currency: string; amountMinor: number; today: string }) {
  const set = (patch: Partial<TermsValue>) => onChange({ ...v, ...patch });
  const quick: [string, string][] = [
    ["In a month", addMonths(today, 1)],
    ["3 months", addMonths(today, 3)],
    ["6 months", addMonths(today, 6)],
    ["A year", addMonths(today, 12)],
  ];
  const pct = Number(v.rate);
  const perMonth = v.interest && pct > 0 && amountMinor ? Math.round((Math.abs(amountMinor) * rateToBp(pct, v.per)) / 10_000 / 12) : 0;
  return (
    <div className="stack terms-editor" style={{ gap: 12 }}>
      <div className="stack" style={{ gap: 6 }}>
        <span className="small" style={{ fontWeight: 500 }}>
          {side === "owe" ? "We mean to pay it back by" : side === "owed" ? "We expect it back by" : "To be settled by"} <span className="muted">(optional)</span>
        </span>
        <div className="chips" role="group" aria-label="Settle by">
          {quick.map(([label, date]) => (
            <button key={label} type="button" className="chip" aria-pressed={v.settleBy === date} onClick={() => set({ settleBy: date })}>
              {label}
            </button>
          ))}
          <button type="button" className="chip" aria-pressed={!v.settleBy} onClick={() => set({ settleBy: "" })}>
            No date
          </button>
        </div>
        <label className="sr-only" htmlFor="terms-date">
          Settle-by date
        </label>
        <input id="terms-date" type="date" value={v.settleBy} min={addDays(today, -365)} onChange={(e) => set({ settleBy: e.target.value })} style={{ maxWidth: 220 }} />
        {v.settleBy && <span className="small muted">{fullDate(v.settleBy)}, {dueWords(settleStatus(v.settleBy, today)!.days)}. Decide reminds you a week before.</span>}
      </div>

      <div className="stack" style={{ gap: 6 }}>
        <span className="small" style={{ fontWeight: 500 }}>Interest</span>
        <div className="chips" role="group" aria-label="Interest">
          <button type="button" className="chip" aria-pressed={!v.interest} onClick={() => set({ interest: false })}>
            No interest
          </button>
          <button type="button" className="chip" aria-pressed={v.interest} onClick={() => set({ interest: true })}>
            With interest
          </button>
        </div>
        {!v.interest ? (
          <span className="small muted">A friendly loan between family and friends: only the amount is paid back.</span>
        ) : (
          <>
            <div className="row" style={{ alignItems: "flex-end" }}>
              <label style={{ flex: "1 1 110px" }}>
                Rate, %
                <input inputMode="decimal" value={v.rate} onChange={(e) => set({ rate: e.target.value })} placeholder={v.per === "month" ? "1.5" : "12"} />
              </label>
              <label style={{ flex: "1 1 120px" }}>
                Per
                <select value={v.per} onChange={(e) => set({ per: e.target.value as RatePer })}>
                  <option value="month">month</option>
                  <option value="year">year</option>
                </select>
              </label>
              <label style={{ flex: "1 1 150px" }}>
                Counted from
                <input type="date" value={v.from} max={today} onChange={(e) => set({ from: e.target.value })} />
              </label>
            </div>
            <span className="small muted">
              Simple interest on what is owed each day.{" "}
              {perMonth > 0 ? `At ${rateText(rateToBp(pct, v.per), v.per)}, ${formatMoney(Math.abs(amountMinor), currency)} grows by about ${formatMoney(perMonth, currency)} a month. ` : ""}
              Leave "counted from" empty to start when the money moved.
            </span>
          </>
        )}
      </div>
    </div>
  );
}

/** The terms on a contact's page or an account: date, interest so far, what settles it. */
export function TermsSummary({ account: a, side, currency, today }: { account: Account; side: Side; currency: string; today: string }) {
  const t = a.terms;
  const s = settleStatus(a.endDate, today);
  const owed = Math.abs(a.balanceMinor);
  const interest = Math.abs(t?.interestMinor ?? 0);
  const bySettle = t?.interestBySettleMinor !== null && t?.interestBySettleMinor !== undefined ? Math.abs(t.interestBySettleMinor) : null;
  const money = (m: number) => formatMoney(m, currency);
  return (
    <dl className="terms">
      <dt>{side === "owe" ? "Pay back by" : side === "owed" ? "Expected back by" : "Settle by"}</dt>
      <dd>
        {a.endDate ? (
          <>
            {fullDate(a.endDate)} <span style={{ color: s?.late ? "var(--rust)" : s?.soon ? "var(--marigold-deep)" : "var(--muted)" }}>· {dueWords(s!.days)}</span>
          </>
        ) : (
          <span className="muted">no date set</span>
        )}
      </dd>
      <dt>Interest</dt>
      <dd>{(a.rateBp ?? 0) > 0 ? `${rateText(a.rateBp, a.ratePer)}${t?.from ? `, from ${fullDate(t.from)}` : ""}` : "none: a friendly loan"}</dd>
      {(a.rateBp ?? 0) > 0 && (
        <>
          <dt>Interest so far</dt>
          <dd>
            <strong>{money(interest)}</strong> <span className="muted">{side === "owe" ? "we owe" : "owed to us"}</span>
          </dd>
          {bySettle !== null && a.endDate && (
            <>
              <dt>To settle on {shortDate(a.endDate)}</dt>
              <dd>
                about <strong>{money(owed + bySettle)}</strong> <span className="muted">({money(owed)} and {money(bySettle)} interest)</span>
              </dd>
            </>
          )}
        </>
      )}
    </dl>
  );
}
