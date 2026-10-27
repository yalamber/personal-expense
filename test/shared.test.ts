import { describe, expect, it } from "vitest";
import { parseCsv, toCsv, detectDelimiter } from "../src/shared/csv";
import { applyMapping, guessMapping, isCsvMapping, type CsvMapping } from "../src/shared/csv-mapping";
import { addDays, guessDateFormat, monthRange, parseDate, payPeriods, shiftMonth } from "../src/shared/dates";
import { normalizeMerchant } from "../src/shared/merchant";
import { formatMinor, minorDigits, minorToDecimal, parseAmountToMinor } from "../src/shared/money";

describe("money", () => {
  it("knows currency decimals", () => {
    expect(minorDigits("USD")).toBe(2);
    expect(minorDigits("JPY")).toBe(0);
    expect(minorDigits("NPR")).toBe(2);
  });

  it("parses common amount shapes", () => {
    expect(parseAmountToMinor("1,234.56", "USD")).toBe(123456);
    expect(parseAmountToMinor("-42.5", "USD")).toBe(-4250);
    expect(parseAmountToMinor("(12.00)", "USD")).toBe(-1200);
    expect(parseAmountToMinor("$ 12", "USD")).toBe(1200);
    expect(parseAmountToMinor("12.00 DR", "USD")).toBe(-1200);
    expect(parseAmountToMinor("12.00 CR", "USD")).toBe(1200);
    expect(parseAmountToMinor("12.00-", "USD")).toBe(-1200);
    expect(parseAmountToMinor("1.234,56", "EUR", ",")).toBe(123456);
    expect(parseAmountToMinor("1500", "JPY")).toBe(1500);
    expect(parseAmountToMinor("0.125", "USD")).toBe(13);
  });

  it("rejects text that is not a number", () => {
    expect(parseAmountToMinor("", "USD")).toBeNull();
    expect(parseAmountToMinor("n/a", "USD")).toBeNull();
    expect(parseAmountToMinor("1.2.3", "USD")).toBeNull();
  });

  it("formats and exports", () => {
    expect(formatMinor(123456, "USD", "en-US")).toBe("$1,234.56");
    expect(minorToDecimal(-4250, "USD")).toBe("-42.50");
    expect(minorToDecimal(5, "USD")).toBe("0.05");
    expect(minorToDecimal(1500, "JPY")).toBe("1500");
  });
});

describe("csv", () => {
  it("parses quotes, embedded commas, newlines and CRLF", () => {
    const text = '\uFEFFDate,Description,Amount\r\n2026-10-01,"Shop, ""Main"" St",-12.50\r\n2026-10-02,"Line\nbreak",3\r\n\r\n';
    expect(parseCsv(text)).toEqual([
      ["Date", "Description", "Amount"],
      ["2026-10-01", 'Shop, "Main" St', "-12.50"],
      ["2026-10-02", "Line\nbreak", "3"],
    ]);
  });

  it("detects semicolon and tab files", () => {
    expect(detectDelimiter("a;b;c\n1;2;3")).toBe(";");
    expect(detectDelimiter("a\tb\tc")).toBe("\t");
    expect(parseCsv("a;b\n1;2")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("writes CSV and neutralises formulas", () => {
    expect(toCsv([["a,b", 'q"t', "=SUM(A1)", "-12.50", null]])).toBe('"a,b","q""t",\'=SUM(A1),-12.50,\r\n');
  });
});

describe("dates", () => {
  it("parses each format", () => {
    expect(parseDate("2026-10-05", "YYYY-MM-DD")).toBe("2026-10-05");
    expect(parseDate("05/10/2026", "DD/MM/YYYY")).toBe("2026-10-05");
    expect(parseDate("10/05/2026", "MM/DD/YYYY")).toBe("2026-10-05");
    expect(parseDate("5-10-26", "DD-MM-YYYY")).toBe("2026-10-05");
    expect(parseDate("05.10.2026", "DD.MM.YYYY")).toBe("2026-10-05");
    expect(parseDate("5 Oct 2026", "DD MMM YYYY")).toBe("2026-10-05");
    expect(parseDate("Oct 5, 2026", "MMM DD YYYY")).toBe("2026-10-05");
    expect(parseDate("2026-02-30", "YYYY-MM-DD")).toBeNull();
  });

  it("guesses formats from samples", () => {
    expect(guessDateFormat(["2026-10-01", "2026-10-15"])).toBe("YYYY-MM-DD");
    expect(guessDateFormat(["13/10/2026", "01/10/2026"])).toBe("DD/MM/YYYY");
    expect(guessDateFormat(["10/13/2026", "10/01/2026"])).toBe("MM/DD/YYYY");
    expect(guessDateFormat(["01/02/2026"])).toBe("DD/MM/YYYY");
    expect(guessDateFormat(["01/02/2026"], true)).toBe("MM/DD/YYYY");
  });

  it("does month arithmetic", () => {
    expect(monthRange("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(addDays("2026-10-31", 2)).toBe("2026-11-02");
  });
});

describe("normalizeMerchant", () => {
  it("strips processor prefixes, store numbers and card suffixes", () => {
    expect(normalizeMerchant("POS 1234 SQ *BLUE BOTTLE COFFEE #0042").key).toBe("BLUE BOTTLE COFFEE");
    expect(normalizeMerchant("PAYPAL *NETFLIX.COM 4029357733").key).toBe("NETFLIX");
    expect(normalizeMerchant("GROCER STORE 123").key).toBe("GROCER STORE");
    expect(normalizeMerchant("Grocer Store #0456").key).toBe("GROCER STORE");
    expect(normalizeMerchant("24 HOUR FITNESS 0193").key).toBe("24 HOUR FITNESS");
    expect(normalizeMerchant("7-ELEVEN 33012").key).toBe("7 ELEVEN");
    expect(normalizeMerchant("CARD 4821 GROCER STORE 15/10").key).toBe("GROCER STORE");
  });

  it("maps variants of one shop to the same key", () => {
    const a = normalizeMerchant("SQ *BLUE BOTTLE COFFEE #0042 SAN FRANCISCO CA").key;
    const b = normalizeMerchant("SQ * BLUE BOTTLE COFFEE #0107").key;
    expect(a.startsWith("BLUE BOTTLE COFFEE")).toBe(true);
    expect(b).toBe("BLUE BOTTLE COFFEE");
  });

  it("produces a readable display name", () => {
    expect(normalizeMerchant("BLUE BOTTLE COFFEE").display).toBe("Blue Bottle Coffee");
  });
});

describe("csv mapping", () => {
  const table = parseCsv("Date,Description,Amount\n15/10/2026,GROCER STORE 123,-42.50\n16/10/2026,SALARY ACME,3000.00\n17/10/2026,Opening balance,0");

  it("guesses columns and date format", () => {
    const m = guessMapping(table);
    expect(m).toMatchObject({ hasHeader: true, dateColumn: 0, descriptionColumn: 1, amountMode: "single", amountColumn: 2, dateFormat: "DD/MM/YYYY" });
    expect(isCsvMapping(m)).toBe(true);
  });

  it("applies a single-column mapping and skips zero rows", () => {
    const { rows, errors } = applyMapping(table, guessMapping(table), "USD");
    expect(errors).toEqual([]);
    expect(rows.map((r) => [r.date, r.direction, r.amountMinor])).toEqual([
      ["2026-10-15", "out", 4250],
      ["2026-10-16", "in", 300000],
    ]);
  });

  it("applies split debit/credit columns and reports bad rows", () => {
    const t = parseCsv("Date,Details,Debit,Credit\n2026-10-01,Rent,1500.00,\n2026-10-02,Refund,,25.00\nnot a date,X,1,");
    const m = guessMapping(t);
    expect(m.amountMode).toBe("split");
    const { rows, errors } = applyMapping(t, m, "USD");
    expect(rows.map((r) => [r.description, r.direction, r.amountMinor])).toEqual([
      ["Rent", "out", 150000],
      ["Refund", "in", 2500],
    ]);
    expect(errors).toHaveLength(1);
  });

  it("supports banks that show money out as positive", () => {
    const m: CsvMapping = { ...guessMapping(table), negativeIsOut: false };
    const { rows } = applyMapping(table, m, "USD");
    expect(rows[0]!.direction).toBe("in");
  });

  it("rejects malformed mappings", () => {
    expect(isCsvMapping({ hasHeader: true })).toBe(false);
    expect(isCsvMapping(null)).toBe(false);
  });
});

describe("pay periods", () => {
  it("runs payday to the day before the next, newest first", () => {
    expect(payPeriods("2026-10-27", 7, 3)).toEqual([
      { from: "2026-10-07", to: "2026-11-06" },
      { from: "2026-09-07", to: "2026-10-06" },
      { from: "2026-08-07", to: "2026-09-06" },
    ]);
    expect(payPeriods("2026-10-03", 7, 2)).toEqual([
      { from: "2026-09-07", to: "2026-10-06" },
      { from: "2026-08-07", to: "2026-09-06" },
    ]);
  });
  it("is the calendar month when payday is the 1st", () => {
    expect(payPeriods("2026-03-15", 1, 2)).toEqual([
      { from: "2026-03-01", to: "2026-03-31" },
      { from: "2026-02-01", to: "2026-02-28" },
    ]);
  });
});
