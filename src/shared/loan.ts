/**
 * Loan maths for EMIs and friendly loans, shared by the Worker and the web app.
 *
 * Bank loans in Nepal (and most places) charge interest monthly on the reducing balance: each
 * installment first pays that month's interest, and the rest reduces what is owed. A friendly
 * loan is the same with a 0% rate. These are estimates; the lender's statement is the truth.
 */
import { addMonths } from "./deposit";

/** Monthly rate from a yearly rate in basis points. */
function monthly(rateBp: number): number {
  return rateBp / 10_000 / 12;
}

/** The installment that repays `principal` in `months` months: the usual EMI formula. */
export function emi(principalMinor: number, rateBp: number, months: number): number {
  if (months <= 0) return principalMinor;
  const r = monthly(rateBp);
  if (r === 0) return Math.ceil(principalMinor / months);
  const f = Math.pow(1 + r, months);
  return Math.ceil((principalMinor * r * f) / (f - 1));
}

/** One payment split into this month's interest and the part that reduces the balance. */
export function splitPayment(owedMinor: number, rateBp: number, paymentMinor: number): { interestMinor: number; principalMinor: number } {
  const interest = Math.min(paymentMinor, Math.max(0, Math.round(owedMinor * monthly(rateBp))));
  return { interestMinor: interest, principalMinor: paymentMinor - interest };
}

/**
 * Installments left until `owed` is repaid at `installment` a month, or null when the
 * installment does not even cover the interest.
 */
export function monthsLeft(owedMinor: number, rateBp: number, installmentMinor: number): number | null {
  if (owedMinor <= 0) return 0;
  if (installmentMinor <= 0) return null;
  const r = monthly(rateBp);
  if (r === 0) return Math.ceil(owedMinor / installmentMinor);
  if (installmentMinor <= owedMinor * r) return null;
  return Math.ceil(-Math.log(1 - (r * owedMinor) / installmentMinor) / Math.log(1 + r));
}

/** Interest still to pay if the installment stays the same until the end. */
export function interestLeft(owedMinor: number, rateBp: number, installmentMinor: number): number | null {
  let owed = owedMinor;
  let interest = 0;
  for (let i = 0; i < 1200 && owed > 0; i++) {
    const split = splitPayment(owed, rateBp, installmentMinor);
    if (split.principalMinor <= 0) return null;
    interest += split.interestMinor;
    owed -= split.principalMinor;
  }
  return owed > 0 ? null : interest;
}

/** The next date an installment is due on or after `today`, given its day of the month. */
export function nextDue(today: string, day: number): string {
  const d = Math.min(Math.max(1, day), 28);
  const thisMonth = `${today.slice(0, 7)}-${String(d).padStart(2, "0")}`;
  return thisMonth >= today ? thisMonth : addMonths(thisMonth, 1);
}

/** The month (YYYY-MM) of the last installment, counting from the next one due. */
export function payoffMonth(today: string, day: number, months: number): string {
  return addMonths(nextDue(today, day), Math.max(0, months - 1)).slice(0, 7);
}

export type Payoff = { months: number; interestMinor: number };

/**
 * Paying a loan faster: the installment plus an extra amount each month, and/or a one-off sum
 * now. Returns how long it takes and the interest paid, as it is and with the extra, or null where
 * the installment does not cover the interest.
 */
export function payMore(owedMinor: number, rateBp: number, installmentMinor: number, extra: { monthlyMinor?: number; lumpMinor?: number } = {}): { before: Payoff | null; after: Payoff | null } {
  const run = (owed: number, payment: number): Payoff | null => {
    let left = owed;
    let interest = 0;
    let months = 0;
    while (left > 0) {
      if (months >= 1200) return null;
      const due = Math.max(0, Math.round(left * monthly(rateBp)));
      const pay = Math.min(payment, left + due);
      if (pay <= due && left > 0) return null;
      interest += due;
      left -= pay - due;
      months++;
    }
    return { months, interestMinor: interest };
  };
  const lump = Math.max(0, extra.lumpMinor ?? 0);
  const more = Math.max(0, extra.monthlyMinor ?? 0);
  return { before: run(owedMinor, installmentMinor), after: run(Math.max(0, owedMinor - lump), installmentMinor + more) };
}
