import { describe, expect, it } from "vitest";
import {
  extractEmail,
  inboundAddressFor,
  isBlockedAttachment,
  parseInboundAddress,
  rawMailKeys,
  safeFilename,
  baseDomain,
  looksLikeForwarder,
  pickSender,
  rankAccounts,
  senderCandidates,
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

describe("senderCandidates", () => {
  it("puts the From header before a forwarder's envelope sender", () => {
    const headers = new Headers({ from: "Nabil Bank <txn-alert@nabilbank.com>" });
    expect(senderCandidates("postmaster@mail-wr1-x436.google.com", headers)).toEqual(["txn-alert@nabilbank.com", "postmaster@mail-wr1-x436.google.com"]);
  });
  it("reads the original sender a forwarder kept in its own headers", () => {
    const headers = new Headers({ from: "Me <me@gmail.com>", "x-original-sender": "alerts@nicasiabank.com" });
    expect(senderCandidates("me@gmail.com", headers)).toEqual(["me@gmail.com", "alerts@nicasiabank.com"]);
  });
  it("finds the bank in the quoted block of a message forwarded by hand", () => {
    const headers = new Headers({ from: "Me <me@gmail.com>" });
    const body = "FYI\n\n---------- Forwarded message ---------\nFrom: Nabil Bank <txn-alert@nabilbank.com>\nDate: Sun, 26 Oct 2026 at 07:21\nSubject: Transaction Alert\n\nDear Customer...";
    expect(senderCandidates("me@gmail.com", headers, body)).toEqual(["me@gmail.com", "txn-alert@nabilbank.com"]);
  });
  it("does not repeat an address or invent one", () => {
    const headers = new Headers({ from: "alerts@bank.example" });
    expect(senderCandidates("alerts@bank.example", headers, "From: nobody here")).toEqual(["alerts@bank.example"]);
  });
});

describe("looksLikeForwarder", () => {
  it("knows a mail system's envelope address from a sender's", () => {
    expect(looksLikeForwarder("postmaster@mail-wr1-x436.google.com")).toBe(true);
    expect(looksLikeForwarder("MAILER-DAEMON@example.com")).toBe(true);
    expect(looksLikeForwarder("SRS0=abcd=XY=nabilbank.com=txn-alert@forwarder.example")).toBe(true);
    expect(looksLikeForwarder("bounces+12345@mail.example")).toBe(true);
    expect(looksLikeForwarder("txn-alert@nabilbank.com")).toBe(false);
    expect(looksLikeForwarder("noreply@nicasiabank.com")).toBe(false);
    expect(looksLikeForwarder("me@gmail.com")).toBe(false);
  });
});

describe("pickSender", () => {
  it("looks past forwarders and the family's own mailboxes", () => {
    const own = new Set(["yalamber@mundhum.com"]);
    expect(pickSender(["postmaster@mail-wr1-x436.google.com", "txn-alert@nabilbank.com"], own)).toBe("txn-alert@nabilbank.com");
    expect(pickSender(["yalamber@mundhum.com", "txn-alert@nabilbank.com"], own)).toBe("txn-alert@nabilbank.com");
    expect(pickSender(["postmaster@mail.google.com", "yalamber@mundhum.com"], own)).toBeNull();
  });
});

describe("baseDomain", () => {
  it("keeps the registrable part", () => {
    expect(baseDomain("alerts.mail.nabilbank.com")).toBe("nabilbank.com");
    expect(baseDomain("nabilbank.com")).toBe("nabilbank.com");
    expect(baseDomain("ebanking.sbl.com.np")).toBe("sbl.com.np");
    expect(baseDomain("bank.co.in")).toBe("bank.co.in");
  });
});

describe("rankAccounts", () => {
  const accounts = [
    { id: "cash", name: "Cash at home", type: "cash", institution: null, statementSenderPattern: null },
    { id: "nic", name: "NIC Asia salary", type: "checking", institution: "NIC Asia", statementSenderPattern: "alerts@nicasiabank.com" },
    { id: "nabil", name: "Nabil Bank Saving Account", type: "savings", institution: null, statementSenderPattern: "txn-alert@nabilbank.com" },
    { id: "esewa", name: "eSewa", type: "wallet", institution: null, statementSenderPattern: null },
  ];
  it("puts the account that already lists the sender first", () => {
    const r = rankAccounts(accounts, "txn-alert@nabilbank.com", "Transaction Alert");
    expect(r[0]).toEqual({ id: "nabil", level: 3, reason: "already reads mail from this sender" });
  });
  it("then one that reads other mail from the same bank's domain", () => {
    const r = rankAccounts(accounts, "statements@mail.nicasiabank.com", "Monthly statement");
    expect(r[0]).toMatchObject({ id: "nic", level: 2, reason: "it already reads mail from nicasiabank.com" });
  });
  it("then a distinctive word of the account's name in the sender", () => {
    const r = rankAccounts(accounts, "noreply@esewa.com.np", "Payment successful");
    expect(r[0]).toMatchObject({ id: "esewa", level: 1 });
    expect(r[0]!.reason).toContain("Esewa");
    // "Bank", "Saving" and "Account" are too common to count.
    expect(rankAccounts(accounts, "info@otherbank.com", "Saving account offer")[0]!.level).toBe(0);
  });
  it("keeps the given order when nothing points anywhere", () => {
    expect(rankAccounts(accounts, null, "").map((r) => r.id)).toEqual(["cash", "nic", "nabil", "esewa"]);
  });
});
