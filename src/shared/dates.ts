/** Date helpers shared by the Worker and the web app. All dates are plain YYYY-MM-DD strings. */

export const DATE_FORMATS = ["YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY", "DD-MM-YYYY", "DD.MM.YYYY", "DD MMM YYYY", "MMM DD YYYY"] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function valid(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

function monthIndex(name: string): number {
  return MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;
}

/** Parses a date in the given format into YYYY-MM-DD, or null. Time parts after the date are ignored. */
export function parseDate(input: string, format: DateFormat): string | null {
  const s = input.trim();
  let m: RegExpMatchArray | null;
  switch (format) {
    case "YYYY-MM-DD":
      m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
      return m ? valid(+m[1]!, +m[2]!, +m[3]!) : null;
    case "DD/MM/YYYY":
      m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
      return m ? valid(+m[3]!, +m[2]!, +m[1]!) : null;
    case "MM/DD/YYYY":
      m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
      return m ? valid(+m[3]!, +m[1]!, +m[2]!) : null;
    case "DD-MM-YYYY":
      m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{2,4})/);
      return m ? valid(+m[3]!, +m[2]!, +m[1]!) : null;
    case "DD.MM.YYYY":
      m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
      return m ? valid(+m[3]!, +m[2]!, +m[1]!) : null;
    case "DD MMM YYYY":
      m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3,9})[\s-,]*(\d{2,4})/);
      return m ? valid(+m[3]!, monthIndex(m[2]!), +m[1]!) : null;
    case "MMM DD YYYY":
      m = s.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{2,4})/);
      return m ? valid(+m[3]!, monthIndex(m[1]!), +m[2]!) : null;
  }
}

/**
 * Picks the format that parses every sample. When DD/MM and MM/DD both fit (all days <= 12),
 * prefers DD/MM unless `preferUs` is set.
 */
export function guessDateFormat(samples: string[], preferUs = false): DateFormat | null {
  const usable = samples.map((s) => s.trim()).filter(Boolean).slice(0, 50);
  if (!usable.length) return null;
  const fits = DATE_FORMATS.filter((f) => usable.every((s) => parseDate(s, f) !== null));
  if (!fits.length) return null;
  if (fits.includes("DD/MM/YYYY") && fits.includes("MM/DD/YYYY")) return preferUs ? "MM/DD/YYYY" : "DD/MM/YYYY";
  return fits[0]!;
}

/** First and last day of a YYYY-MM month. */
export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(last)}` };
}

export function isMonth(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

export function isDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && parseDate(value, "YYYY-MM-DD") === value;
}

/** Adds days to a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

/** Today's date in a time zone, as YYYY-MM-DD. */
export function todayIn(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/**
 * The pay period a day falls in: from the last payday to the day before the next one. With payday
 * on the 1st it is the calendar month. Paydays after the 28th count as the 28th, as everywhere else.
 */
export function payPeriod(today: string, payDay: number): { from: string; to: string } {
  const d = String(Math.min(Math.max(1, Math.round(payDay)), 28)).padStart(2, "0");
  const month = today.slice(0, 7);
  const thisPay = `${month}-${d}`;
  const start = today >= thisPay ? thisPay : `${shiftMonth(month, -1)}-${d}`;
  return { from: start, to: addDays(`${shiftMonth(start.slice(0, 7), 1)}-${d}`, -1) };
}
