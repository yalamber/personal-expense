import { describe, expect, it, vi } from "vitest";
import { clearQueries, fetchQuery, peek, setCached } from "../src/web/src/query";

const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("page cache", () => {
  it("remembers an answer and sends one request for readers asking at the same time", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return answer({ ok: 1 });
    }) as unknown as typeof fetch;
    const [a, b] = await Promise.all([fetchQuery<{ ok: number }>("/api/x"), fetchQuery<{ ok: number }>("/api/x")]);
    expect(calls).toBe(1);
    expect(a).toEqual({ ok: 1 });
    expect(b).toEqual({ ok: 1 });
    expect(peek("/api/x")).toEqual({ ok: 1 });
  });

  it("forgets everything on sign-out", () => {
    setCached("/api/y", 5);
    expect(peek("/api/y")).toBe(5);
    clearQueries();
    expect(peek("/api/x")).toBeUndefined();
    expect(peek("/api/y")).toBeUndefined();
  });

  it("passes a refusal on without remembering it", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    await expect(fetchQuery("/api/missing")).rejects.toThrow("not found");
    expect(peek("/api/missing")).toBeUndefined();
  });
});
