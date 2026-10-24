/**
 * Every month: the bills and income a family expects (rent, school fees, the salary, the
 * tenant's rent). Pure helpers shared by the Worker (Today, Decide, the hints) and the web app.
 *
 * An item has one instance per month, due on its day of the month. The instance is handled when
 * an entry in the book carries the item's id (posted), or the family skipped it or marked it
 * handled outside the book. Until then it is upcoming, and from its day on it is due.
 */
export type RecurringItem = {
  id: string;
  name: string;
  direction: "out" | "in";
  amountMinor: number;
  /** 1 to 28, so every month has the day. */
  dayOfMonth: number;
  active: boolean;
};

export type Handled = { state: "posted"; transactionId: string; date: string } | { state: "skipped" | "done"; transactionId?: null; date?: null };

export type RecurringState = "posted" | "skipped" | "done" | "due" | "upcoming" | "paused";

export type RecurringStatus = {
  state: RecurringState;
  /** The date it usually lands this month. */
  due: string;
  /** Days from today to the due date; negative once it is past. */
  daysUntil: number;
  transactionId: string | null;
};

const pad = (n: number) => String(n).padStart(2, "0");

/** The date an item lands in a month (YYYY-MM-DD). */
export function dueDate(item: Pick<RecurringItem, "dayOfMonth">, month: string): string {
  const day = Math.min(28, Math.max(1, Math.round(item.dayOfMonth)));
  return `${month}-${pad(day)}`;
}

/** Where an item stands this month. */
export function statusOf(item: RecurringItem, month: string, today: string, handled: Handled | null): RecurringStatus {
  const due = dueDate(item, month);
  const daysUntil = Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (handled) return { state: handled.state, due, daysUntil, transactionId: handled.transactionId ?? null };
  if (!item.active) return { state: "paused", due, daysUntil, transactionId: null };
  return { state: due <= today ? "due" : "upcoming", due, daysUntil, transactionId: null };
}

/** Still to come: expected this month and not yet in the book, skipped or handled. */
export function isOpen(status: Pick<RecurringStatus, "state">): boolean {
  return status.state === "due" || status.state === "upcoming";
}

type Row = { item: Pick<RecurringItem, "direction" | "amountMinor">; status: Pick<RecurringStatus, "state"> };

/** Bills still to go out this month: money Today keeps aside before it is spent. */
export function reserveMinor(rows: Row[]): number {
  return rows.reduce((sum, r) => (r.item.direction === "out" && isOpen(r.status) ? sum + r.item.amountMinor : sum), 0);
}

/** Income still to arrive this month (a salary not yet paid in, rent the tenant has not sent). */
export function expectedInMinor(rows: Row[]): number {
  return rows.reduce((sum, r) => (r.item.direction === "in" && isOpen(r.status) ? sum + r.item.amountMinor : sum), 0);
}

/** "on the 1st", "on the 22nd": how the family says the day. */
export function dayLabel(day: number): string {
  const n = Math.min(28, Math.max(1, Math.round(day)));
  const suffix = n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th";
  return `on the ${n}${suffix}`;
}
