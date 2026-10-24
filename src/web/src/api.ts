import type { CsvMapping } from "../../shared/csv-mapping";
import type { PlanGoalKind } from "../../shared/plan";
import { enqueue, markStale } from "./offline";
import { queueable } from "./offline/core";

export { isQueued, QUEUED_NOTE, type Queued } from "./offline";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

/**
 * One call to the API. With no connection, money logged, moved or paid waits in the phone's
 * outbox and the caller gets a Queued answer; reads come back from the service worker's store,
 * marked with when they were saved.
 */
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const write = method !== "GET";
  if (write && typeof navigator !== "undefined" && !navigator.onLine && queueable(method, path)) return enqueue(method, path, body) as unknown as T;
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
    });
  } catch {
    if (write && queueable(method, path)) return enqueue(method, path, body) as unknown as T;
    throw new ApiError(0, "No connection. Try again when you're back online.");
  }
  if (!write) {
    const fromCache = res.headers.get("x-from-cache");
    markStale(fromCache === null ? null : fromCache || "unknown");
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string } & T;
  if (!res.ok) {
    if (res.status === 503 && res.headers.get("x-offline")) throw new ApiError(503, data.message ?? "You're offline.", data);
    throw new ApiError(res.status, data.error ?? `request failed (${res.status})`, data);
  }
  return data;
}

export type Role = "admin" | "member" | "viewer";

export type Me = {
  user: { id: string; email: string };
  households: { householdId: string; name: string; currency: string; role: Role; memberId: string }[];
};

export type Household = {
  id: string;
  name: string;
  currency: string;
  timezone: string;
  monthStartDay: number;
  typicalIncomeMinor: number | null;
  typicalSpendMinor: number | null;
  inboundAddress: string;
  me: { id: string; role: Role; name: string };
};

export type Member = { id: string; name: string; email: string; role: Role; color: string; joinedAt: string | null; invitedAt: string };

export type AccountType = "checking" | "savings" | "cash" | "wallet" | "deposit" | "lent" | "credit" | "loan" | "person";
export type DepositPayout = "maturity" | "quarterly" | "monthly";

export type Account = {
  id: string;
  name: string;
  type: AccountType;
  institution: string | null;
  isShared: boolean;
  statementSenderPattern: string | null;
  csvMapping: CsvMapping | null;
  lastStatementBalanceMinor: number | null;
  lastStatementAt: string | null;
  openingBalanceMinor: number | null;
  openingBalanceDate: string | null;
  goalId: string | null;
  goalName: string | null;
  principalMinor: number | null;
  rateBp: number | null;
  startDate: string | null;
  endDate: string | null;
  depositPayout: DepositPayout | null;
  settleAccountId: string | null;
  installmentMinor: number | null;
  installmentDay: number | null;
  closedAt: string | null;
  phone: string | null;
  note: string | null;
  /** Contacts: what happened last in their khata. */
  lastEntry: { date: string; description: string | null; direction: "in" | "out" | "transfer"; amountMinor: number; transferPairId: string | null } | null;
  /** Today, from the starting balance; negative for what is owed. */
  balanceMinor: number;
  deposit: { accruedMinor: number; maturityValueMinor: number; totalInterestMinor: number; daysToMaturity: number; termMonths: number } | null;
  loan: {
    owedMinor: number;
    nextDue: string | null;
    settledThisMonth: boolean;
    monthsLeft: number | null;
    payoffMonth: string | null;
    interestLeftMinor: number | null;
    nextInterestMinor: number;
    paidThisMonthMinor: number;
  } | null;
};

export type AccountBody = Partial<{
  name: string;
  type: AccountType;
  institution: string;
  isShared: boolean;
  statementSenderPattern: string;
  balance: string;
  balanceDate: string;
  goalId: string | null;
  principal: string;
  rate: string;
  startDate: string;
  endDate: string | null;
  termMonths: number;
  payout: DepositPayout;
  settleAccountId: string | null;
  installment: string;
  installmentDay: number;
  closed: boolean;
  phone: string;
  note: string;
  weOwe: boolean;
}>;

/** One line in a contact's khata. "in" is money we gave them (debit), "out" money we got (credit). */
export type ContactEntry = {
  id: string;
  date: string;
  amountMinor: number;
  direction: "in" | "out" | "transfer";
  description: string | null;
  note: string | null;
  categoryId: string | null;
  transferPairId: string | null;
  otherAccountName: string | null;
  byName: string | null;
  counted: boolean;
  balanceMinor: number;
};
export type ContactLedger = { openingMinor: number; openingDate: string | null; balanceMinor: number; entries: ContactEntry[] };
export type ContactEntryBody = { kind: "gave" | "got" | "credit" | "charge"; amount: string; date: string; otherAccountId?: string; categoryId?: string | null; description?: string; note?: string };

export type CategoryKind = "need" | "want" | "saving" | "transfer" | "income";
export type Category = { id: string; parentId: string | null; name: string; kind: CategoryKind; sort: number };

export type Transaction = {
  id: string;
  date: string;
  amountMinor: number;
  direction: "out" | "in" | "transfer";
  accountId: string;
  accountName: string | null;
  categoryId: string | null;
  merchantId: string | null;
  merchantName: string | null;
  description: string | null;
  note: string | null;
  isPersonal: boolean;
  paidByMemberId: string | null;
  paidByName: string | null;
  source: string;
  transferPairId: string | null;
  confirmedAt: string | null;
  goalId: string | null;
  /** This month's instance of an every-month item (the rent, the salary). */
  recurringId: string | null;
};

export type RecurringState = "posted" | "skipped" | "done" | "due" | "upcoming" | "paused";

/** An every-month item with where it stands in the month asked for. */
export type RecurringRow = {
  id: string;
  name: string;
  direction: "out" | "in";
  amountMinor: number;
  dayOfMonth: number;
  active: boolean;
  categoryId: string | null;
  accountId: string | null;
  note: string | null;
  status: { state: RecurringState; due: string; daysUntil: number; transactionId: string | null };
};

export type RecurringBody = Partial<{ name: string; direction: "out" | "in"; amount: string; dayOfMonth: number; categoryId: string | null; accountId: string | null; note: string; active: boolean }>;

/** An entry already in the book that could be this month's instance of an item. */
export type RecurringCandidate = { id: string; date: string; amountMinor: number; name: string | null; accountName: string | null; source: string };

export type Summary = {
  month: string;
  currency: string;
  spentMinor: number;
  incomeMinor: number;
  savedMinor: number;
  netMinor: number;
  budgetTotalMinor: number;
  uncategorizedCount: number;
  pendingReview: number;
  transactionCount: number;
  byCategory: { categoryId: string | null; name: string; kind: string; spentMinor: number; budgetMinor: number | null }[];
};

export type Budget = { id: string; categoryId: string; month: string; amountMinor: number };

export type StatementStatus = "received" | "quarantined" | "unparsed" | "parsed" | "review" | "done" | "failed" | "forwarding";

export type Statement = {
  id: string;
  accountId: string | null;
  accountName: string | null;
  fromAddress: string;
  subject: string | null;
  receivedAt: string;
  rawSize: number;
  status: StatementStatus;
  parserKey: string | null;
  attachments: { filename: string; mimeType: string; size: number }[];
  error: string | null;
  verifyCode: { provider: string; code: string | null; link: string | null; requester: string | null } | null;
};

export type ReviewLine = {
  id: string;
  statementEmailId: string;
  rawText: string;
  date: string | null;
  amountMinor: number | null;
  description: string | null;
  confidence: number;
  suggestedCategoryId: string | null;
  matchTransactionId: string | null;
  source: string | null;
  sourceFrom: string;
  accountId: string | null;
  accountName: string | null;
  possibleDuplicate: { id: string; date: string; amountMinor: number; description: string | null; source: string } | null;
};

export type ImportResult = {
  statementId: string;
  total: number;
  autoPosted: number;
  confirmed: number;
  needsReview: number;
  duplicates: number;
  alreadyQueued: number;
  skipped: number;
  errors: { line: number; raw: string; reason: string }[];
};

export type Twin = {
  kind: "transaction" | "line";
  id: string;
  date: string;
  amountMinor: number;
  name: string | null;
  accountName: string | null;
  byName: string | null;
  source: string;
  confirmed: boolean;
  note: string | null;
};

export type GoalPart = { id: string; name: string; amountMinor: number; sort: number; doneAt: string | null };

export type Goal = {
  id: string;
  name: string;
  kind: PlanGoalKind;
  targetMinor: number;
  wantedBy: string | null;
  priority: number;
  monthlyPlanMinor: number;
  linkedAccountId: string | null;
  note: string | null;
  completedAt: string | null;
  /** Held plus paid: how far along it is. */
  savedMinor: number;
  heldMinor: number;
  /** Already paid toward it: a baina or advance, a stage paid to the builder. */
  paidMinor: number;
  savedFrom: "accounts" | "records";
  accounts: { id: string; name: string; type: string; balanceMinor: number }[];
  parts: GoalPart[];
};

export type LoanCommitments = {
  monthlyMinor: number;
  monthlyInterestMinor: number;
  dueThisMonthMinor: number;
  paidThisMonthMinor: number;
  releases: { accountId: string; name: string; fromMonth: string; amountMinor: number }[];
};

export type PlanData = {
  currency: string;
  startMonth: string;
  goals: Goal[];
  plannedMinor: number;
  basis: { source: "book" | "typical" | "none"; months: number; incomeMinor: number; spendMinor: number };
  loans: LoanCommitments;
  spareMinor: number | null;
};

export type Contribution = { id: string; date: string; amountMinor: number; note: string | null; memberName: string | null; transactionId: string | null; kind: "saved" | "paid" | "paid_from_saved" };

export type Today = {
  today: string;
  month: string;
  currency: string;
  payday: string;
  daysLeft: number;
  incomeMinor: number;
  incomeExpected: boolean;
  /** The part of the income still to come, when expected. */
  expectedPartMinor: number;
  incomeSource: "logged" | "recurring" | "usual" | "none";
  /** Months behind the usual figure (2 or more means the book's own average). */
  usualMonths: number;
  mode: "nothing" | "unplanned" | "expected" | "over" | "ok";
  spentMinor: number;
  goalsMinor: number;
  plannedMinor: number;
  movedMinor: number;
  loansMinor: number;
  /** Every-month bills not yet in the book, kept out of the day figure. */
  billsMinor: number;
  worth: { haveMinor: number; oweMinor: number; netMinor: number; accruedMinor: number };
  needsStart: boolean;
  everydayLeftMinor: number;
  perDayMinor: number;
  uncategorizedCount: number;
  envelopes: { categoryId: string; name: string; budgetMinor: number; spentMinor: number }[];
  bank: { accountId: string; name: string; type: AccountType; balanceMinor: number; lastLineDate: string | null; questions: number }[];
  bookMatchesThrough: string | null;
  decideCount: number;
  nextGoal: (Goal & { outcome: { doneMonth: string | null; lateMonths: number | null } | null }) | null;
  comingUp: { id: string; name: string; direction: "out" | "in"; amountMinor: number; due: string; state: RecurringState; daysUntil: number; accountId: string | null; transactionId: string | null }[];
};

export type DecideCard =
  | { kind: "recurring"; key: string; recurringId: string; name: string; direction: "out" | "in"; amountMinor: number; due: string; month: string; accountId: string | null; categoryId: string | null; note: string | null }
  | { kind: "forwarding"; key: string; statementId: string; code: string | null; link: string | null; requester: string | null; receivedAt: string }
  | {
      kind: "twin";
      key: string;
      lineId: string;
      line: { date: string | null; amountMinor: number | null; description: string | null; accountName: string | null; source: string | null };
      match: { id: string; date: string; amountMinor: number; direction: string; name: string | null; byName: string | null; source: string; confirmed: boolean; note: string | null };
    }
  | {
      kind: "balance";
      key: string;
      accountId: string;
      accountName: string;
      bankMinor: number;
      bookMinor: number;
      asOf: string;
      suspects: { id: string; date: string; amountMinor: number; direction: string; name: string | null; byName: string | null }[];
    }
  | { kind: "category"; key: string; lineIds: string[]; description: string; count: number; totalMinor: number; firstDate: string | null; lastDate: string | null; accountName: string | null; suggestedCategoryId: string | null }
  | { kind: "plan"; key: string; goalId: string; goalName: string; suggestMinor: number; fromMonth: string | null; toMonth: string | null; wantedBy: string | null; onTime: boolean; spareMinor: number }
  | {
      kind: "maturity";
      key: string;
      accountId: string;
      name: string;
      institution: string | null;
      maturity: string;
      balanceMinor: number;
      interestMinor: number;
      payout: string;
      termMonths: number;
      settleAccountId: string | null;
      goalName: string | null;
    }
  | { kind: "installment"; key: string; accountId: string; name: string; institution: string | null; due: string; installmentMinor: number; interestMinor: number; settleAccountId: string | null; owedMinor: number };

export type LogHints = {
  /** This month's bills and income not yet in the book. */
  recurring: { id: string; name: string; direction: "out" | "in"; amountMinor: number; categoryId: string | null; accountId: string | null; due: string; state: RecurringState }[];
  repeats: { name: string; amountMinor: number; direction: "out" | "in"; accountId: string; categoryId: string | null; count: number; last: string }[];
  merchants: { name: string; amountMinor: number; direction: "out" | "in"; accountId: string; categoryId: string | null; last: string }[];
};

export type NewGoalBody = {
  name: string;
  kind: PlanGoalKind;
  target?: string;
  wantedBy?: string;
  monthly?: string;
  saved?: string;
  paid?: string;
  note?: string;
  linkedAccountId?: string | null;
  parts?: { name: string; amount: string }[];
};

const h = (id: string) => `/api/households/${id}`;

/** The API's reads by path, for the page cache (useQuery) and the api functions alike. */
export const paths = {
  me: "/api/me",
  household: (id: string) => h(id),
  members: (id: string) => `${h(id)}/members`,
  accounts: (id: string) => `${h(id)}/accounts`,
  entries: (id: string, accountId: string) => `${h(id)}/accounts/${accountId}/entries`,
  categories: (id: string) => `${h(id)}/categories`,
  transactions: (id: string, month: string) => `${h(id)}/transactions?month=${month}`,
  months: (id: string, count = 6) => `${h(id)}/months?count=${count}`,
  today: (id: string) => `${h(id)}/today`,
  decide: (id: string) => `${h(id)}/decide`,
  recurring: (id: string) => `${h(id)}/recurring`,
  plan: (id: string) => `${h(id)}/plan`,
  goals: (id: string) => `${h(id)}/goals`,
  contributions: (id: string, goalId: string) => `${h(id)}/goals/${goalId}/contributions`,
};

export const get = <T,>(path: string) => request<T>("GET", path);

export const api = {
  requestMagicLink: (email: string) => request<{ ok: true }>("POST", "/api/auth/magic-link", { email }),
  logout: () => request<{ ok: true }>("POST", "/api/auth/logout"),
  me: () => request<Me>("GET", "/api/me"),
  createHousehold: (body: { name: string; currency: string; timezone: string; memberName: string }) => request<{ id: string }>("POST", "/api/households", body),
  household: (id: string) => request<Household>("GET", h(id)),

  members: (id: string) => request<Member[]>("GET", `${h(id)}/members`),
  inviteMember: (id: string, body: { email: string; name: string; role: Role }) => request<Member>("POST", `${h(id)}/members`, body),

  accounts: (id: string) => request<Account[]>("GET", `${h(id)}/accounts`),
  createAccount: (id: string, body: AccountBody) => request<{ id: string }>("POST", `${h(id)}/accounts`, body),
  updateAccount: (id: string, accountId: string, body: AccountBody) => request<{ ok: true }>("PATCH", `${h(id)}/accounts/${accountId}`, body),
  repayment: (id: string, accountId: string, body: { amount: string; date: string; otherAccountId: string; note?: string }) =>
    request<{ principalMinor: number; interestMinor: number }>("POST", `${h(id)}/accounts/${accountId}/repayment`, body),
  renewDeposit: (id: string, accountId: string, body: { interest?: string; termMonths?: number; rate?: string }) =>
    request<{ ok: true; startDate: string; endDate: string; principalMinor: number }>("POST", `${h(id)}/accounts/${accountId}/renew`, body),
  closeAccount: (id: string, accountId: string, body: { interest?: string; toAccountId?: string | null; date?: string }) =>
    request<{ ok: true; movedMinor: number }>("POST", `${h(id)}/accounts/${accountId}/close`, body),
  entries: (id: string, accountId: string) => request<ContactLedger>("GET", `${h(id)}/accounts/${accountId}/entries`),
  addEntry: (id: string, accountId: string, body: ContactEntryBody) => request<{ id: string }>("POST", `${h(id)}/accounts/${accountId}/entries`, body),
  saveCsvMapping: (id: string, accountId: string, mapping: CsvMapping) => request<{ ok: true }>("PUT", `${h(id)}/accounts/${accountId}/csv-mapping`, { mapping }),
  importCsv: (id: string, accountId: string, body: { csv: string; filename: string; mapping: CsvMapping; saveMapping: boolean }) =>
    request<ImportResult>("POST", `${h(id)}/accounts/${accountId}/import-csv`, body),

  categories: (id: string) => request<Category[]>("GET", `${h(id)}/categories`),
  createCategory: (id: string, body: { name: string; parentId: string | null; kind: CategoryKind }) => request<Category>("POST", `${h(id)}/categories`, body),

  transactions: (id: string, month: string) => request<Transaction[]>("GET", `${h(id)}/transactions?month=${month}`),
  addTransaction: (
    id: string,
    body: {
      date: string;
      amount: string;
      direction: "out" | "in";
      accountId: string;
      categoryId: string | null;
      description: string;
      note: string;
      isPersonal: boolean;
      paidByMemberId?: string | null;
      recurringId?: string | null;
      force?: boolean;
    },
  ) => request<{ id: string; categoryId: string | null; recurringId: string | null }>("POST", `${h(id)}/transactions`, body),
  updateTransaction: (id: string, txId: string, body: Partial<{ categoryId: string | null; note: string; isPersonal: boolean; date: string; amount: string; description: string; recurringId: string | null }>) =>
    request<{ ok: true }>("PATCH", `${h(id)}/transactions/${txId}`, body),
  voidTransaction: (id: string, txId: string) => request<{ ok: true }>("DELETE", `${h(id)}/transactions/${txId}`),
  addTransfer: (id: string, body: { fromAccountId: string; toAccountId: string; amount: string; date: string; note: string }) =>
    request<{ pairId: string }>("POST", `${h(id)}/transfers`, body),

  summary: (id: string, month: string) => request<Summary>("GET", `${h(id)}/summary?month=${month}`),
  months: (id: string, count = 6) => request<{ month: string; incomeMinor: number; spentMinor: number; savedMinor: number }[]>("GET", `${h(id)}/months?count=${count}`),
  budgets: (id: string, month: string) => request<Budget[]>("GET", `${h(id)}/budgets?month=${month}`),
  setBudget: (id: string, body: { month: string; categoryId: string; amount: string }) => request<{ ok: true }>("PUT", `${h(id)}/budgets`, body),
  copyBudgets: (id: string, month: string, fromMonth: string) => request<{ copied: number }>("POST", `${h(id)}/budgets/copy-previous`, { month, fromMonth }),
  exportUrl: (id: string, from: string, to: string) => `${h(id)}/export.csv?from=${from}&to=${to}`,

  statements: (id: string) => request<Statement[]>("GET", `${h(id)}/statements`),
  releaseStatement: (id: string, statementId: string, accountId: string | null) =>
    request<{ ok: true }>("POST", `${h(id)}/statements/${statementId}/release`, { accountId }),

  review: (id: string) => request<ReviewLine[]>("GET", `${h(id)}/review`),
  decide: (
    id: string,
    lineId: string,
    action: "accept" | "reject" | "same",
    categoryId?: string | null,
    overrides: { description?: string; note?: string; paidByMemberId?: string | null } = {},
  ) => request<{ ok: true; transactionId: string | null }>("POST", `${h(id)}/review/${lineId}`, { action, categoryId: categoryId ?? null, ...overrides }),
  acceptSuggested: (id: string) => request<{ accepted: number }>("POST", `${h(id)}/review/accept-suggested`),
  acceptMany: (id: string, lineIds: string[], categoryId: string | null) => request<{ accepted: number }>("POST", `${h(id)}/review/accept-many`, { lineIds, categoryId }),

  updateHousehold: (id: string, body: { name?: string; payDay?: number; typicalIncome?: string; typicalSpend?: string }) => request<{ ok: true }>("PATCH", h(id), body),
  today: (id: string) => request<Today>("GET", `${h(id)}/today`),
  decideCards: (id: string) => request<DecideCard[]>("GET", `${h(id)}/decide`),
  snooze: (id: string, key: string, title: string) => request<{ ok: true; until: string }>("POST", `${h(id)}/decide/snooze`, { key, title }),
  logHints: (id: string) => request<LogHints>("GET", `${h(id)}/log-hints`),

  recurring: (id: string, month?: string) => request<RecurringRow[]>("GET", `${h(id)}/recurring${month ? `?month=${month}` : ""}`),
  createRecurring: (id: string, body: RecurringBody) => request<{ id: string }>("POST", `${h(id)}/recurring`, body),
  updateRecurring: (id: string, itemId: string, body: RecurringBody) => request<{ ok: true }>("PATCH", `${h(id)}/recurring/${itemId}`, body),
  removeRecurring: (id: string, itemId: string) => request<{ ok: true }>("DELETE", `${h(id)}/recurring/${itemId}`),
  postRecurring: (id: string, itemId: string, body: { date?: string; accountId?: string; amount?: string; note?: string }) => request<{ id: string; categoryId: string | null }>("POST", `${h(id)}/recurring/${itemId}/post`, body),
  skipRecurring: (id: string, itemId: string, body: { month?: string }) => request<{ ok: true }>("POST", `${h(id)}/recurring/${itemId}/skip`, body),
  doneRecurring: (id: string, itemId: string, body: { month?: string; transactionId?: string }) => request<{ ok: true }>("POST", `${h(id)}/recurring/${itemId}/done`, body),
  undoRecurring: (id: string, itemId: string, body: { month?: string }) => request<{ ok: true }>("POST", `${h(id)}/recurring/${itemId}/undo`, body),
  recurringCandidates: (id: string, itemId: string, month?: string) => request<RecurringCandidate[]>("GET", `${h(id)}/recurring/${itemId}/candidates${month ? `?month=${month}` : ""}`),
  dismissStatement: (id: string, statementId: string) => request<{ ok: true }>("POST", `${h(id)}/statements/${statementId}/dismiss`),

  bankBalance: (id: string, accountId: string, body: { amount: string; date: string; startBook?: boolean }) =>
    request<{ bankMinor: number; bookMinor: number | null; matches: boolean; startedBook: boolean }>("POST", `${h(id)}/accounts/${accountId}/bank-balance`, body),
  snoozeBalance: (id: string, accountId: string) => request<{ ok: true }>("POST", `${h(id)}/accounts/${accountId}/balance-snooze`),
  correctBalance: (id: string, accountId: string) => request<{ ok: true; diffMinor: number }>("POST", `${h(id)}/accounts/${accountId}/balance-correction`),

  plan: (id: string) => request<PlanData>("GET", `${h(id)}/plan`),
  goals: (id: string) => request<Goal[]>("GET", `${h(id)}/goals`),
  createGoal: (id: string, body: NewGoalBody) => request<{ id: string }>("POST", `${h(id)}/goals`, body),
  updateGoal: (id: string, goalId: string, body: Partial<{ name: string; kind: PlanGoalKind; target: string; wantedBy: string | null; monthly: string; note: string; linkedAccountId: string | null; completed: boolean }>) =>
    request<{ ok: true }>("PATCH", `${h(id)}/goals/${goalId}`, body),
  archiveGoal: (id: string, goalId: string) => request<{ ok: true }>("DELETE", `${h(id)}/goals/${goalId}`),
  orderGoals: (id: string, ids: string[]) => request<{ ok: true }>("PUT", `${h(id)}/goals/order`, { ids }),
  addPart: (id: string, goalId: string, body: { name: string; amount: string }) => request<{ id: string }>("POST", `${h(id)}/goals/${goalId}/parts`, body),
  updatePart: (id: string, partId: string, body: Partial<{ name: string; amount: string; done: boolean }>) => request<{ ok: true }>("PATCH", `${h(id)}/goal-parts/${partId}`, body),
  removePart: (id: string, partId: string) => request<{ ok: true }>("DELETE", `${h(id)}/goal-parts/${partId}`),
  contributions: (id: string, goalId: string) => request<Contribution[]>("GET", `${h(id)}/goals/${goalId}/contributions`),
  addContribution: (id: string, goalId: string, body: { amount: string; date: string; note?: string; fromAccountId?: string | null; kind?: "saved" | "paid"; fromSaved?: boolean }) =>
    request<{ id: string }>("POST", `${h(id)}/goals/${goalId}/contributions`, body),
  removeContribution: (id: string, contributionId: string) => request<{ ok: true }>("DELETE", `${h(id)}/goal-contributions/${contributionId}`),
};
