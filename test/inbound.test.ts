import { describe, expect, it } from "vitest";
import {
  extractEmail,
  inboundAddressFor,
  isBlockedAttachment,
  parseInboundAddress,
  rawMailKeys,
  safeFilename,
  senderMatches,
  forwardingCheck,
} from "../src/worker/lib/inbound";

describe("parseInboundAddress", () => {
  it("parses local part, token and domain", () => {
    expect(parseInboundAddress("stmt+abc123def456@example.com")).toEqual({
      localPart: "stmt",
      token: "abc123def456",
      domain: "example.com",
    });
  });

  it("is case-insensitive and tolerates a display name", () => {
    expect(parseInboundAddress("Money <STMT+ABC123DEF456@Example.com>")?.token).toBe("abc123def456");
  });

  it("rejects addresses without a plus token or with a short token", () => {
    expect(parseInboundAddress("stmt@example.com")).toBeNull();
    expect(parseInboundAddress("stmt+ab@example.com")).toBeNull();
    expect(parseInboundAddress("not an email")).toBeNull();
  });

  it("round-trips with inboundAddressFor", () => {
    const addr = inboundAddressFor("stmt", "k7m2p9q4r1s8t3u6", "money.example");
    expect(parseInboundAddress(addr)).toEqual({ localPart: "stmt", token: "k7m2p9q4r1s8t3u6", domain: "money.example" });
  });
});

describe("senderMatches", () => {
  it("matches an exact address", () => {
    expect(senderMatches("alerts@bank.example", "alerts@bank.example")).toBe(true);
    expect(senderMatches("alerts@bank.example", "other@bank.example")).toBe(false);
  });

  it("matches a domain pattern including subdomains", () => {
    expect(senderMatches("@bank.example", "no-reply@mail.bank.example")).toBe(true);
    expect(senderMatches("@bank.example", "x@notbank.example")).toBe(false);
  });

  it("accepts comma-separated patterns and display names", () => {
    expect(senderMatches("a@one.example, @two.example", "Two Bank <stmt@two.example>")).toBe(true);
  });

  it("never matches when there is no pattern", () => {
    expect(senderMatches(null, "a@b.c")).toBe(false);
    expect(senderMatches("", "a@b.c")).toBe(false);
  });
});

describe("helpers", () => {
  it("extractEmail pulls the address from a display name", () => {
    expect(extractEmail("Bank Alerts <alerts@bank.example>")).toBe("alerts@bank.example");
    expect(extractEmail("  plain@bank.example ")).toBe("plain@bank.example");
  });

  it("safeFilename strips unsafe characters", () => {
    expect(safeFilename("Statement 2026/10 (final).pdf")).toBe("Statement_2026_10_final_.pdf");
    expect(safeFilename("///")).toBe("attachment");
  });

  it("rawMailKeys keeps everything under one prefix", () => {
    const k = rawMailKeys("h1", "s1");
    expect(k.raw).toBe("households/h1/mail/s1/raw.eml");
    expect(k.attachment(0, "a b.csv")).toBe("households/h1/mail/s1/attachments/0-a_b.csv");
  });

  it("blocks executable attachments", () => {
    expect(isBlockedAttachment("evil.exe", "application/octet-stream")).toBe(true);
    expect(isBlockedAttachment("statement.pdf", "application/pdf")).toBe(false);
    expect(isBlockedAttachment("x.bin", "application/x-msdownload")).toBe(true);
  });
});

describe("forwardingCheck", () => {
  it("reads Gmail's confirmation code and requester from the subject", () => {
    const r = forwardingCheck("Gmail Team <forwarding-noreply@google.com>", "(#572612094) Gmail Forwarding Confirmation - Receive Mail from asha.k@gmail.com");
    expect(r).toEqual({ provider: "gmail", code: "572612094", link: null, requester: "asha.k@gmail.com" });
  });

  it("finds the code and link in the body when the subject is translated", () => {
    const body = "Confirmation code: 572612094\nTo allow this, click https://mail-settings.google.com/mail/vf-%5BANGjdJ8x%5D-abc123 to confirm.";
    const r = forwardingCheck("forwarding-noreply@google.com", "Confirmación de reenvío de Gmail", body);
    expect(r?.code).toBe("572612094");
    expect(r?.link).toBe("https://mail-settings.google.com/mail/vf-%5BANGjdJ8x%5D-abc123");
  });

  it("ignores everyone else", () => {
    expect(forwardingCheck("alerts@bank.example", "(#572612094) Gmail Forwarding Confirmation")).toBeNull();
  });
});
