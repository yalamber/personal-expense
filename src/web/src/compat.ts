/**
 * Saved copies of the API's answers outlive an update: the phone paints from what it kept, and a
 * copy kept by the previous version can lack fields the new pages read. These fill such fields
 * with their empty values, so the first paint after an update works and the fresh copy follows.
 */
import { monthRange } from "../../shared/dates";
import type { PlanData, Today } from "./api";

export function normalizePlan(p: PlanData): PlanData {
  return {
    ...p,
    events: Array.isArray(p.events) ? p.events : [],
    goals: (p.goals ?? []).map((g) => ({ ...g, loan: g.loan ?? null, parts: g.parts ?? [], accounts: g.accounts ?? [] })),
    loans: {
      monthlyMinor: p.loans?.monthlyMinor ?? 0,
      monthlyInterestMinor: p.loans?.monthlyInterestMinor ?? 0,
      dueThisMonthMinor: p.loans?.dueThisMonthMinor ?? 0,
      paidThisMonthMinor: p.loans?.paidThisMonthMinor ?? 0,
      releases: p.loans?.releases ?? [],
    },
  };
}

export function normalizeToday(t: Today): Today {
  const month = monthRange(t.month);
  return {
    ...t,
    period: t.period ?? { from: month.from, to: month.to },
    savedOtherMinor: t.savedOtherMinor ?? 0,
    expectedLaterMinor: t.expectedLaterMinor ?? 0,
    billsMinor: t.billsMinor ?? 0,
    loansMinor: t.loansMinor ?? 0,
    comingUp: Array.isArray(t.comingUp) ? t.comingUp : [],
    mail: t.mail ?? { newSender: 0, unread: 0 },
    mode: t.mode ?? (t.incomeMinor === 0 && t.spentMinor === 0 ? "nothing" : t.everydayLeftMinor < 0 ? "over" : "ok"),
    envelopes: t.envelopes ?? [],
    bank: t.bank ?? [],
  };
}
