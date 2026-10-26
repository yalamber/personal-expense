import PostalMime from "postal-mime";
import { describe, expect, it } from "vitest";
import { alertParser, findDate, readAlert, readAll, whyUnread } from "../src/worker/ingest/parsers/alerts";
import { plainText, tableLines, tableRows } from "../src/worker/ingest/parsers/text";
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

describe("alerts laid out as a table or label lines", () => {
  it("reads a table: type, amount in its own cell, date and remarks", async () => {
    const html = "<html><body><p>Dear Customer,</p><p>A transaction has been made on your account.</p><table><tr><td>Account Number</td><td>01010XXXXXX89</td></tr><tr><td>Transaction Type</td><td>Debit</td></tr><tr><td>Amount (NPR)</td><td>1,500.00</td></tr><tr><td>Transaction Date</td><td>26-Oct-2026 14:03</td></tr><tr><td>Remarks</td><td>ESEWA LOAD 9841XXXXXX</td></tr><tr><td>Available Balance (NPR)</td><td>1,23,456.78</td></tr></table></body></html>";
    const lines = await parse(base, html, "text/html");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: "out", amountMinor: 150_000, date: "2026-10-26", description: "ESEWA LOAD 9841XXXXXX" });
  });

  it("reads label lines with Dr/Cr and a slash date", async () => {
    const lines = await parse({ ...base, Subject: "Account Activity" }, "Txn Amount: NPR 25,000.00 Cr\r\nTxn Date: 2026/10/07\r\nNarration: SALARY OCT\r\nBalance: NPR 2,10,000.00");
    expect(lines[0]).toMatchObject({ kind: "in", amountMinor: 2_500_000, date: "2026-10-07", description: "SALARY OCT" });
  });

  it("knows a withdrawal amount is money out without a type line", async () => {
    const lines = await parse(base, "Withdrawal Amount: Rs. 5,000\r\nDate: 2026-10-20\r\nDetails: ATM KATHMANDU");
    expect(lines[0]).toMatchObject({ kind: "out", amountMinor: 500_000, description: "ATM KATHMANDU" });
  });

  it("does not take a balance or a card offer for a transaction", async () => {
    expect(await parse(base, "Available Balance: NPR 50,000.00\r\nApply for our credit card today.")).toEqual([]);
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

/** A bank template the way it really arrives: indented source, layout tables around the real one. */
const template = (rows: string) => `<!DOCTYPE html>
<html>
  <head>
    <title>Transaction Alert</title>
    <style>td { font-family: Arial; }</style>
  </head>
  <body>
    <table width="100%" cellpadding="0">
      <tr>
        <td align="center">
          <table width="600">
            <tr>
              <td>
                <p>Dear Customer,</p>
                <p>
                  The following transaction has been
                  made on your account.
                </p>
              </td>
            </tr>
            <tr>
              <td>
                <table border="1">
${rows}
                </table>
              </td>
            </tr>
            <tr>
              <td>
                <p>If you have received this email in error, please delete it. Never share your PIN or OTP.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
const row = (a: string, b: string) => `                  <tr>\n                    <td>\n                      ${a}\n                    </td>\n                    <td>\n                      ${b}\n                    </td>\n                  </tr>`;

describe("alerts as banks really send them", () => {
  it("reads an indented table whose labels and values sit on separate source lines", async () => {
    const html = template(
      [row("Account Number", "0101XXXXXXX89"), row("Transaction Date", "26-Oct-2026 14:03:11"), row("Transaction Amount", "NPR 1,500.00"), row("Transaction Type", "DR"), row("Remarks", "ESEWA LOAD 9841XXXXXX"), row("Available Balance", "NPR 1,23,456.78")].join("\n"),
    );
    const lines = await parse(base, html, "text/html");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: "out", amountMinor: 150_000, date: "2026-10-26", description: "ESEWA LOAD 9841XXXXXX", confidence: 70 });
  });

  it("reads cells that wrap their text in paragraphs and spans", async () => {
    const html = template(
      [row("<p><b>Amount (NPR)</b></p>", "<p><span>25,000.00</span></p>"), row("<p>Debit/Credit</p>", "<p>Credit</p>"), row("<p>Narration</p>", "<p>SALARY OCT&#x2F;2026</p>"), row("<p>Value Date</p>", "<p>07/10/2026</p>")].join("\n"),
    );
    const lines = await parse(base, html, "text/html");
    expect(lines[0]).toMatchObject({ kind: "in", amountMinor: 2_500_000, date: "2026-10-07", description: "SALARY OCT/2026" });
  });

  it("reads a header row over a row of values, taking the column that has the amount", async () => {
    const html = template(
      `<tr><th>Date</th><th>Description</th><th>Debit</th><th>Credit</th><th>Balance</th></tr>\n<tr><td>25/10/2026</td><td>POS BHATBHATENI</td><td>3,240.50</td><td></td><td>50,000.00</td></tr>`,
    );
    const lines = await parse(base, html, "text/html");
    expect(lines[0]).toMatchObject({ kind: "out", amountMinor: 324_050, date: "2026-10-25", description: "POS BHATBHATENI" });
  });

  it("skips a zero in the other column", async () => {
    const html = template([row("Credit Amount", "0.00"), row("Debit Amount", "NPR 800.00"), row("Particulars", "NTC TOPUP")].join("\n"));
    expect((await parse(base, html, "text/html"))[0]).toMatchObject({ kind: "out", amountMinor: 80_000, description: "NTC TOPUP" });
  });

  it("pairs a label line with the value on the next line in plain text", async () => {
    const text = "Dear Customer,\r\n\r\nTransaction Amount\r\nNPR 4,000.00\r\nTransaction Type\r\nWithdrawal\r\nTransaction Date\r\n24-OCT-26\r\nRemarks\r\nATM NEW ROAD\r\n";
    expect((await parse(base, text))[0]).toMatchObject({ kind: "out", amountMinor: 400_000, date: "2026-10-24", description: "ATM NEW ROAD" });
  });

  it("falls back to the one amount and the only direction named, with a lower confidence", async () => {
    const lines = await parse(base, "Dear Customer, NPR. 2,000.00 DR from your account ending 89. Ref 7781. If you have received this email in error, delete it.");
    expect(lines[0]).toMatchObject({ kind: "out", amountMinor: 200_000, confidence: 55 });
  });

  it("does not let a footer's 'received' or a credit card advert decide the direction", () => {
    expect(readAll("Amount: NPR 900.00\nType: Debit\nApply for a Nabil Credit Card. If you received this in error, ignore it.")).toMatchObject({ kind: "out", amountMinor: 90_000 });
  });

  it("says why nothing was read, and what it found", () => {
    expect(whyUnread("Your OTP is 482913.", null).why).toMatch(/No amount/);
    expect(whyUnread("Available balance NPR 5,000.00", null).why).toMatch(/balance/);
    const one = whyUnread("Amount NPR 1,500.00 on 26/10/2026. Remarks: ESEWA LOAD", null);
    expect(one.why).toMatch(/1,500\.00.*went out or came in/);
    expect(one.guess).toMatchObject({ amountMinor: 150_000, date: "2026-10-26", description: "ESEWA LOAD" });
  });

  it("explains through the parser when parse finds nothing", async () => {
    const email = await new PostalMime().parse(mime(base, "Fund transfer of NPR 7,500.00 to RAM BAHADUR, ref 991.\r\nIf you have received this email in error, delete it."));
    expect(await alertParser.parse(email, [])).toEqual([]);
    expect(alertParser.explain!(email)).toMatchObject({ guess: { amountMinor: 750_000 } });
  });
});

describe("HTML to text", () => {
  it("treats source line breaks as spaces and decodes every kind of entity", () => {
    expect(plainText("<td>\n  Transaction\n  Amount\n</td><td>&#8377;&nbsp;1,500&#x2E;00</td>")).toBe("Transaction Amount ₹ 1,500.00");
    expect(plainText("<head><title>Alert</title></head><body><!-- x --><p>Hi</p></body>")).toBe("Hi");
  });
  it("finds the innermost table rows and pairs labels with values", () => {
    const rows = tableRows("<table><tr><td><table><tr><td>Amount</td><td>:</td><td>NPR 5.00</td></tr></table></td></tr></table>");
    expect(rows).toEqual([["Amount", ":", "NPR 5.00"]]);
    expect(tableLines(rows)).toEqual(["Amount: NPR 5.00"]);
  });
});
