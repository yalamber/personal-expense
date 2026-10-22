import type { CsvMapping } from "../../shared/csv-mapping";
import type { PlanGoalKind } from "../../shared/plan";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string } & T;
  if (!res.ok) throw new ApiError(res.status, data.error ?? `request failed (${res.status})`, data);
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
  inboundAddress: string;
  me: { id: string; role: Role; name: string };
};

export type Member = { id: string; name: string; email: string; role: Role; color: string; joinedAt: string | null; invitedAt: string };

export type Account = {
  id: string;
  name: string;
  type: "checking" | "credit" | "cash" | "savings";
  isShared: boolean;
  statementSenderPattern: string | null;
  csvMapping: CsvMapping | null;
  lastStatementBalanceMinor: number | null;
  lastStatementAt: string | null;
  openingBalanceMinor: number | null;
  openingBalanceDate: string | null;
};

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
};

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
  savedMinor: number;
  parts: GoalPart[];
};

export type PlanData = {
  currency: string;
  startMonth: string;
  goals: Goal[];
  plannedMinor: number;
  basis: { months: number; incomeMinor: number; spendMinor: number };
  spareMinor: number | null;
};

export type Contribution = { id: string; date: string; amountMinor: number; note: string | null; memberName: string | null; transactionId: string | null };

export type Today = {
  today: string;
  month: string;
  currency: string;
  payday: string;
  daysLeft: number;
  incomeMinor: number;
  incomeExpected: boolean;
  spentMinor: number;
  goalsMinor: number;
  plannedMinor: number;
  movedMinor: number;
  everydayLeftMinor: number;
  perDayMinor: number;
  uncategorizedCount: number;
  envelopes: { categoryId: string; name: string; budgetMinor: number; spentMinor: number }[];
  bank: { accountId: string; name: string; lastLineDate: string | null; questions: number }[];
  bookMatchesThrough: string | null;
  decideCount: number;
  nextGoal: (Goal & { outcome: { doneMonth: string | null; lateMonths: number | null } | null }) | null;
};

export type DecideCard =
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
  | { kind: "plan"; key: string; goalId: string; goalName: string; suggestMinor: number; fromMonth: string | null; toMonth: string | null; wantedBy: string | null; onTime: boolean; spareMinor: number };

export type LogHints = {
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
  note?: string;
  linkedAccountId?: string | null;
  parts?: { name: string; amount: string }[];
};

const h = (id: string) => `/api/households/${id}`;

export const api = {
  requestMagicLink: (email: string) => request<{ ok: true }>("POST", "/api/auth/magic-link", { email }),
  logout: () => request<{ ok: true }>("POST", "/api/auth/logout"),
  me: () => request<Me>("GET", "/api/me"),
  createHousehold: (body: { name: string; currency: string; timezone: string; memberName: string }) => request<{ id: string }>("POST", "/api/households", body),
  household: (id: string) => request<Household>("GET", h(id)),

  members: (id: string) => request<Member[]>("GET", `${h(id)}/members`),
  inviteMember: (id: string, body: { email: string; name: string; role: Role }) => request<Member>("POST", `${h(id)}/members`, body),

  accounts: (id: string) => request<Account[]>("GET", `${h(id)}/accounts`),
  createAccount: (id: string, body: { name: string; type: Account["type"]; statementSenderPattern: string; isShared: boolean }) =>
    request<Account>("POST", `${h(id)}/accounts`, body),
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
      force?: boolean;
    },
  ) => request<{ id: string; categoryId: string | null }>("POST", `${h(id)}/transactions`, body),
  updateTransaction: (id: string, txId: string, body: Partial<{ categoryId: string | null; note: string; isPersonal: boolean; date: string; amount: string; description: string }>) =>
    request<{ ok: true }>("PATCH", `${h(id)}/transactions/${txId}`, body),
  voidTransaction: (id: string, txId: string) => request<{ ok: true }>("DELETE", `${h(id)}/transactions/${txId}`),
  addTransfer: (id: string, body: { fromAccountId: string; toAccountId: string; amount: string; date: string; note: string }) =>
    request<{ pairId: string }>("POST", `${h(id)}/transfers`, body),

  summary: (id: string, month: string) => request<Summary>("GET", `${h(id)}/summary?month=${month}`),
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

  updateHousehold: (id: string, body: { name?: string; payDay?: number }) => request<{ ok: true }>("PATCH", h(id), body),
  today: (id: string) => request<Today>("GET", `${h(id)}/today`),
  decideCards: (id: string) => request<DecideCard[]>("GET", `${h(id)}/decide`),
  snooze: (id: string, key: string, title: string) => request<{ ok: true; until: string }>("POST", `${h(id)}/decide/snooze`, { key, title }),
  logHints: (id: string) => request<LogHints>("GET", `${h(id)}/log-hints`),
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
  addContribution: (id: string, goalId: string, body: { amount: string; date: string; note?: string; fromAccountId?: string | null }) =>
    request<{ id: string }>("POST", `${h(id)}/goals/${goalId}/contributions`, body),
  removeContribution: (id: string, contributionId: string) => request<{ ok: true }>("DELETE", `${h(id)}/goal-contributions/${contributionId}`),
};
