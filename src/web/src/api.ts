export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
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
  if (!res.ok) throw new ApiError(res.status, data.error ?? `request failed (${res.status})`);
  return data;
}

export type Me = {
  user: { id: string; email: string };
  households: { householdId: string; name: string; currency: string; role: Role; memberId: string }[];
};
export type Role = "admin" | "member" | "viewer";

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
  lastStatementBalanceMinor: number | null;
  lastStatementAt: string | null;
};

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

export const api = {
  requestMagicLink: (email: string) => request<{ ok: true }>("POST", "/api/auth/magic-link", { email }),
  logout: () => request<{ ok: true }>("POST", "/api/auth/logout"),
  me: () => request<Me>("GET", "/api/me"),
  createHousehold: (body: { name: string; currency: string; timezone: string; memberName: string }) =>
    request<{ id: string }>("POST", "/api/households", body),
  household: (id: string) => request<Household>("GET", `/api/households/${id}`),
  members: (id: string) => request<Member[]>("GET", `/api/households/${id}/members`),
  inviteMember: (id: string, body: { email: string; name: string; role: Role }) =>
    request<Member>("POST", `/api/households/${id}/members`, body),
  accounts: (id: string) => request<Account[]>("GET", `/api/households/${id}/accounts`),
  createAccount: (id: string, body: { name: string; type: Account["type"]; statementSenderPattern: string; isShared: boolean }) =>
    request<Account>("POST", `/api/households/${id}/accounts`, body),
  statements: (id: string) => request<Statement[]>("GET", `/api/households/${id}/statements`),
  releaseStatement: (id: string, statementId: string, accountId: string | null) =>
    request<{ ok: true }>("POST", `/api/households/${id}/statements/${statementId}/release`, { accountId }),
};
