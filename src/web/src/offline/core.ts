/**
 * The outbox: writes made with no connection, kept on the phone and replayed in order when it
 * returns. Pure, so it can be tested without a browser; the wiring (storage, events, React) is
 * in ../offline.ts.
 */

export type OutboxState = "queued" | "twin" | "failed";

export type Twin = { id: string; name: string | null; amountMinor: number; date: string; byName?: string | null };

export type OutboxItem = {
  /** Also the Idempotency-Key, so a replay whose reply was lost never posts twice. */
  id: string;
  householdId: string;
  method: string;
  path: string;
  body: unknown;
  createdAt: string;
  state: OutboxState;
  /** Why it did not go through (failed), or what it may be a copy of (twin). */
  error?: string;
  twins?: Twin[];
};

/** The writes a phone may make while offline: money logged, moved, paid, and small edits. */
const QUEUEABLE: { method: string; pattern: RegExp }[] = [
  { method: "POST", pattern: /\/transactions$/ },
  { method: "PATCH", pattern: /\/transactions\/[^/]+$/ },
  { method: "DELETE", pattern: /\/transactions\/[^/]+$/ },
  { method: "POST", pattern: /\/transfers$/ },
  { method: "POST", pattern: /\/goals\/[^/]+\/contributions$/ },
  { method: "POST", pattern: /\/accounts\/[^/]+\/entries$/ },
  { method: "POST", pattern: /\/accounts\/[^/]+\/repayment$/ },
];

export function queueable(method: string, path: string): boolean {
  const p = path.split("?")[0]!;
  return QUEUEABLE.some((q) => q.method === method && q.pattern.test(p));
}

export function householdOf(path: string): string {
  return path.match(/\/households\/([^/]+)/)?.[1] ?? "";
}

export type Described = {
  kind: "spend" | "income" | "move" | "goal" | "khata" | "loan" | "edit" | "remove";
  title: string;
  /** The amount as typed, with its sign for the book. */
  amount: string | null;
  sign: "+" | "−" | "";
  date: string | null;
  accountId: string | null;
  goalId: string | null;
  contactId: string | null;
};

/** One line for the book, from the request alone (names are looked up by the page). */
export function describe(method: string, path: string, body: unknown): Described {
  const b = (body ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof b[k] === "string" && (b[k] as string).trim() ? (b[k] as string).trim() : null);
  const base: Described = { kind: "edit", title: "A change", amount: str("amount"), sign: "", date: str("date"), accountId: str("accountId"), goalId: null, contactId: null };
  const p = path.split("?")[0]!;
  if (method === "POST" && /\/transactions$/.test(p)) {
    const income = b.direction === "in";
    return { ...base, kind: income ? "income" : "spend", title: str("description") ?? (income ? "Money in" : "A payment"), sign: income ? "+" : "−" };
  }
  if (/\/transactions\/[^/]+$/.test(p)) return { ...base, kind: method === "DELETE" ? "remove" : "edit", title: method === "DELETE" ? "Removed an entry" : "Changed an entry" };
  if (/\/transfers$/.test(p)) return { ...base, kind: "move", title: "Moved between accounts", accountId: str("fromAccountId") };
  const goal = p.match(/\/goals\/([^/]+)\/contributions$/);
  if (goal) return { ...base, kind: "goal", title: b.kind === "paid" ? "Paid toward a goal" : "Put toward a goal", goalId: goal[1]!, accountId: str("fromAccountId") };
  const entry = p.match(/\/accounts\/([^/]+)\/entries$/);
  if (entry) {
    const titles: Record<string, string> = { gave: "Paid", got: "Got money from", credit: "Bought on credit from", charge: "Owed to us by" };
    return { ...base, kind: "khata", title: titles[String(b.kind)] ?? "Khata entry", sign: b.kind === "gave" || b.kind === "charge" ? "−" : "+", contactId: entry[1]!, accountId: str("otherAccountId") };
  }
  const loan = p.match(/\/accounts\/([^/]+)\/repayment$/);
  if (loan) return { ...base, kind: "loan", title: "Loan payment", sign: "−", contactId: loan[1]!, accountId: str("otherAccountId") };
  return base;
}

export type FetchLike = (path: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; json: () => Promise<unknown> }>;

export type DrainResult = {
  items: OutboxItem[];
  /** Why the run stopped early, if it did: no network, or the session is gone. */
  stopped: "network" | "signed-out" | null;
  synced: number;
};

/**
 * Replays queued items oldest first. A twin answer (409) or a refusal (4xx) marks the item and
 * moves on; no network, a server error or a lost session stops the run so later items wait.
 */
export async function drain(items: OutboxItem[], fetchFn: FetchLike): Promise<DrainResult> {
  const out: OutboxItem[] = [];
  let stopped: DrainResult["stopped"] = null;
  let synced = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (item.state !== "queued" || stopped) {
      out.push(item);
      continue;
    }
    let status: number;
    let data: Record<string, unknown> = {};
    try {
      const res = await fetchFn(item.path, {
        method: item.method,
        headers: { "idempotency-key": item.id, ...(item.body !== undefined ? { "content-type": "application/json" } : {}) },
        body: item.body !== undefined ? JSON.stringify(item.body) : undefined,
      });
      status = res.status;
      data = ((await res.json().catch(() => ({}))) as Record<string, unknown>) ?? {};
    } catch {
      stopped = "network";
      out.push(item);
      continue;
    }
    if (status >= 200 && status < 300) {
      synced++;
      continue;
    }
    if (status === 401) {
      stopped = "signed-out";
      out.push(item);
      continue;
    }
    if (status >= 500) {
      stopped = "network";
      out.push(item);
      continue;
    }
    if (status === 409 && Array.isArray(data.twins)) {
      out.push({ ...item, state: "twin", twins: data.twins as Twin[], error: undefined });
      continue;
    }
    out.push({ ...item, state: "failed", error: typeof data.error === "string" ? data.error : `refused (${status})` });
  }
  return { items: out, stopped, synced };
}

/** The item sent again with the same payment allowed to stand beside its twin. */
export function keepBoth(item: OutboxItem): OutboxItem {
  return { ...item, state: "queued", twins: undefined, error: undefined, body: { ...((item.body ?? {}) as Record<string, unknown>), force: true } };
}
