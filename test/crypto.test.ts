import { describe, expect, it } from "vitest";
import { sha256Hex, sign, verify } from "../src/worker/lib/crypto";

describe("sign/verify", () => {
  it("round-trips a payload", async () => {
    const signed = await sign("secret", "session-123");
    expect(await verify("secret", signed)).toBe("session-123");
  });

  it("rejects a tampered payload or wrong secret", async () => {
    const signed = await sign("secret", "session-123");
    expect(await verify("other", signed)).toBeNull();
    expect(await verify("secret", signed.replace("session-123", "session-124"))).toBeNull();
    expect(await verify("secret", "garbage")).toBeNull();
  });
});

describe("sha256Hex", () => {
  it("hashes deterministically", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
