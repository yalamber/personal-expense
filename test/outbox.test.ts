import { describe as suite, expect, it } from "vitest";
import { describe, drain, householdOf, keepBoth, queueable, type OutboxItem } from "../src/web/src/offline/core";

const H = "/api/households/h1";
const item = (n: number, path = `${H}/transactions`, body: unknown = { amount: "100", direction: "out", description: `Shop ${n}`, date: "2026-10-23" }): OutboxItem => ({
  id: `k${n}`,
  householdId: "h1",
  method: "POST",
  path,
  body,
  createdAt: "2026-10-23T10:00:00Z",
  state: "queued",
});

const answer = (status: number, data: unknown = {}) => ({ status, json: async () => data });

suite("outbox", () => {
  it("queues money logged, moved and paid, but not settings or imports", () => {
    expect(queueable("POST", `${H}/transactions`)).toBe(true);
    expect(queueable("DELETE", `${H}/transactions/t1`)).toBe(true);
    expect(queueable("POST", `${H}/accounts/a1/entries`)).toBe(true);
    expect(queueable("POST", `${H}/goals/g1/contributions`)).toBe(true);
    expect(queueable("POST", `${H}/accounts/a1/repayment`)).toBe(true);
    expect(queueable("POST", `${H}/accounts`)).toBe(false);
    expect(queueable("PATCH", H)).toBe(false);
    expect(queueable("POST", `${H}/accounts/a1/import-csv`)).toBe(false);
    expect(householdOf(`${H}/transactions`)).toBe("h1");
  });

  it("describes a request for the book without names", () => {
    const spend = describe("POST", `${H}/transactions`, { amount: "1,860", direction: "out", description: "Momo House", date: "2026-10-23", accountId: "a1" });
    expect(spend).toMatchObject({ kind: "spend", title: "Momo House", amount: "1,860", sign: "−", date: "2026-10-23", accountId: "a1" });
    const credit = describe("POST", `${H}/accounts/c1/entries`, { kind: "credit", amount: "3200", date: "2026-10-23" });
    expect(credit).toMatchObject({ kind: "khata", title: "Bought on credit from", contactId: "c1", sign: "+" });
    expect(describe("POST", `${H}/goals/g1/contributions`, { amount: "5000", kind: "paid" })).toMatchObject({ kind: "goal", goalId: "g1", title: "Paid toward a goal" });
    expect(describe("DELETE", `${H}/transactions/t1`, undefined)).toMatchObject({ kind: "remove" });
  });

  it("replays in order, sends the idempotency key, and drops what went through", async () => {
    const sent: { path: string; key: string }[] = [];
    const r = await drain([item(1), item(2)], async (path, init) => {
      sent.push({ path, key: init.headers["idempotency-key"]! });
      return answer(201, { id: "t" });
    });
    expect(sent.map((s) => s.key)).toEqual(["k1", "k2"]);
    expect(r).toMatchObject({ synced: 2, stopped: null, items: [] });
  });

  it("stops at the first network failure and keeps the rest for later", async () => {
    let calls = 0;
    const r = await drain([item(1), item(2), item(3)], async () => {
      calls++;
      if (calls === 2) throw new TypeError("Failed to fetch");
      return answer(201);
    });
    expect(calls).toBe(2);
    expect(r.synced).toBe(1);
    expect(r.stopped).toBe("network");
    expect(r.items.map((i) => i.id)).toEqual(["k2", "k3"]);
    expect(r.items.every((i) => i.state === "queued")).toBe(true);
  });

  it("marks a twin for the family to decide, and keep-both sends it with force", async () => {
    const twins = [{ id: "t9", name: "Momo House", amountMinor: 186000, date: "2026-10-22" }];
    const r = await drain([item(1), item(2)], async (path, init) => (init.body?.includes("Shop 1") ? answer(409, { error: "twin", twins }) : answer(201)));
    expect(r.synced).toBe(1);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ id: "k1", state: "twin", twins });
    const again = keepBoth(r.items[0]!);
    expect(again.state).toBe("queued");
    expect((again.body as { force: boolean }).force).toBe(true);
  });

  it("keeps a refused item with the reason, and stops when the session is gone", async () => {
    const r = await drain([item(1), item(2)], async (path, init) => (init.body?.includes("Shop 1") ? answer(400, { error: "enter the amount" }) : answer(401, { error: "unauthenticated" })));
    expect(r.items[0]).toMatchObject({ id: "k1", state: "failed", error: "enter the amount" });
    expect(r.items[1]).toMatchObject({ id: "k2", state: "queued" });
    expect(r.stopped).toBe("signed-out");
  });

  it("treats a server error as something to retry, not a refusal", async () => {
    const r = await drain([item(1)], async () => answer(500, { error: "internal error" }));
    expect(r.items[0]!.state).toBe("queued");
    expect(r.stopped).toBe("network");
  });
});
