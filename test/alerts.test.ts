import PostalMime from "postal-mime";
import { describe, expect, it } from "vitest";
import { alertParser, findDate, readAlert } from "../src/worker/ingest/parsers/alerts";
import { plainText } from "../src/worker/ingest/parsers/text";
import { findParser } from "../src/worker/ingest/parsers";

const mime = (headers: Record<string, string>, body: string, type = "text/plain") =>
  `${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\nMIME-Version: 1.0\r\nContent-Type: ${type}; charset=utf-8\r\n\r\n${body}`;
const parse = async (headers: Record<string, string>, body: string, type?: string) => alertParser.parse(await new PostalMime().parse(mime(headers, body, type)), []);
const base = { From: "Nabil Bank <txn-alert@nabilbank.com>", To: "stmt+abc123def456@statements.example", Subject: "Transaction Alert", Date: "Sun, 26 Oct 2026 09:30:00 +0545" };

describe("the generic alert parser", () => {
  it("is the parser of last resort for anything that reads like an alert", () => {
    expect(findParser({ from: "txn-alert@nabilbank.com", subject: "Transaction Alert" })?.key).toBe("alert-text");
    expect(findParser({ from: "forwarding-noreply@google.com", subject: "(#123) Gmail Forwarding Confirmation" })).toBeUndefined();
    expect(findParser({ from: "friend@example.com", subject: "Dashain plans" })).toBeUndefined();
  });

  it("reads a debit with its remarks and date from a plain-text alert", async () => {
    const lines = await parse(base, "Dear Customer,\r\n\r\nYour account 01010XXXXXX89 has been debited by NPR 1,500.00 on 26/10/2026 14:03:11.\r\nRemarks: ESEWA LOAD 9841XXXXXX\r\nAvailable Balance: NPR 1,23,456.78\r\n\r\nThank you for banking with us.");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: "out", amountMinor: 150_000, date: "2026-10-26", description: "ESEWA LOAD 9841XXXXXX", confidence: 70 });
    expect(lines[0]!.rawText).toContain("debited by NPR 1,500.00");
  });

  it("reads a credit from an HTML-only alert and leaves the balance alone", async () => {
    const html = "<html><body><table><tr><td>Dear Customer,</td></tr><tr><td>Rs. 90,000.00 has been credited to your A/C XXXX1234 on 07-10-2026.</td></tr><tr><td><b>Particulars:</b> SALARY OCT</td></tr><tr><td>Available balance Rs. 2,10,000.00</td></tr></table></body></html>";
    const lines = await parse({ ...base, Subject: "Credit Alert" }, html, "text/html");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: "in", amountMinor: 9_000_000, date: "2026-10-07", description: "SALARY OCT" });
  });

  it("skips a Bikram Sambat date and falls back to the email's own date, with lower confidence", async () => {
    const lines = await parse(base, "Your account has been debited by NPR 500.00 on 2083-07-09. Remarks: MOBILE TOPUP");
    expect(lines[0]).toMatchObject({ kind: "out", amountMinor: 50_000, date: "2026-10-26", confidence: 60 });
  });

  it("picks the transaction amount when the balance comes first, and the merchant after 'at'", async () => {
    const lines = await parse(base, "Available balance NPR 50,000.00. Your account has been debited by NPR 1,200.00 at BHATBHATENI SUPERMARKET on 25 Oct 2026. Thank you.");
    expect(lines[0]).toMatchObject({ kind: "out", amountMinor: 120_000, date: "2026-10-25", description: "BHATBHATENI SUPERMARKET" });
  });

  it("names the line after the subject when the alert has no remarks", async () => {
    const lines = await parse({ ...base, Subject: "Fwd: eSewa payment" }, "NPR 350.00 paid on 2026-10-20. Ref 88812.");
    expect(lines[0]).toMatchObject({ kind: "out", amountMinor: 35_000, date: "2026-10-20", description: "eSewa payment" });
  });

  it("returns nothing when no amount sits next to a debit or credit word", async () => {
    expect(await parse(base, "Your one time password is 482913. It is valid for 5 minutes.")).toEqual([]);
    expect(await parse(base, "Dear Customer, your statement for October is attached.")).toEqual([]);
  });
});

describe("findDate and readAlert", () => {
  it("prefers ISO, then day-first, then written months", () => {
    expect(findDate("on 2026-10-26 at 14:03")?.date).toBe("2026-10-26");
    expect(findDate("on 26/10/2026")?.date).toBe("2026-10-26");
    expect(findDate("on 26.10.2026")?.date).toBe("2026-10-26");
    expect(findDate("dated 5th Oct 2026")?.date).toBe("2026-10-05");
    expect(findDate("on October 5, 2026")?.date).toBe("2026-10-05");
    expect(findDate("on 2083-07-09", new Date("2026-10-26T04:00:00Z"))).toEqual({ date: "2026-10-26", fromText: false });
    expect(findDate("no date here", null)).toBeNull();
  });
  it("reads amounts written with lakh separators and a currency after the number", () => {
    expect(readAlert("Credited with 1,23,456.78 NPR on 2026-10-01")).toMatchObject({ kind: "in", amountMinor: 12_345_678 });
    expect(readAlert("Rs 2000 has been debited")).toMatchObject({ kind: "out", amountMinor: 200_000 });
  });
  it("turns HTML into lines of text", () => {
    expect(plainText("<p>Dear&nbsp;Customer,</p><div>NPR 1,500.00 debited</div><br>Bye &amp; thanks")).toBe("Dear Customer,\nNPR 1,500.00 debited\n\nBye & thanks");
  });
});
