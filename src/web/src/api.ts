import type { CsvMapping } from "../../shared/csv-mapping";

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

export type StatementStatus = "received" | "quarantined" | "unparsed" | "parsed" | "review" | "done" | "failed";

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
  needsReview: number;
  duplicates: number;
  alreadyQueued: number;
  skipped: number;
  errors: { line: number; raw: string; reason: string }[];
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
    body: { date: string; amount: string; direction: "out" | "in"; accountId: string; categoryId: string | null; description: string; note: string; isPersonal: boolean },
  ) => request<{ id: string; categoryId: string | null }>("POST", `${h(id)}/transactions`, body),
  updateTransaction: (id: string, txId: string, body: Partial<{ categoryId: string | null; note: string; isPersonal: boolean }>) =>
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
  decide: (id: string, lineId: string, action: "accept" | "reject", categoryId?: string | null) =>
    request<{ ok: true }>("POST", `${h(id)}/review/${lineId}`, { action, categoryId: categoryId ?? null }),
  acceptSuggested: (id: string) => request<{ accepted: number }>("POST", `${h(id)}/review/accept-suggested`),
};
