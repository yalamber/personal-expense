/**
 * Money helpers shared by the Worker and the web app.
 * Amounts are integers in minor units (cents); the number of decimals follows the currency.
 */

const digitsCache = new Map<string, number>();

/** Decimal places used by a currency: 2 for USD/EUR/NPR, 0 for JPY, 3 for KWD. */
export function minorDigits(currency: string): number {
  const cached = digitsCache.get(currency);
  if (cached !== undefined) return cached;
  let digits = 2;
  try {
    digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    digits = 2;
  }
  digitsCache.set(currency, digits);
  return digits;
}

/**
 * Parses text such as "1,234.56", "-12.00", "(12.00)", "$ 12", "12.00 DR" or "1.234,56"
 * (with decimalSeparator ",") into signed minor units. Returns null when there is no number.
 * "(x)", a leading "-", a trailing "-" or a "DR" suffix make the result negative; "CR" keeps it positive.
 */
export function parseAmountToMinor(input: string, currency: string, decimalSeparator: "." | "," = "."): number | null {
  let s = input.trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (/\bDR\.?$/i.test(s)) {
    negative = true;
    s = s.replace(/\bDR\.?$/i, "");
  }
  s = s.replace(/\bCR\.?$/i, "");
  s = s.trim();
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.endsWith("-")) {
    negative = !negative;
    s = s.slice(0, -1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  // Drop currency symbols, codes and spaces.
  s = s.replace(/[^\d.,'\s]/g, "").replace(/[\s']/g, "");
  if (decimalSeparator === ",") s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  if (!/^\d*\.?\d*$/.test(s) || !/\d/.test(s)) return null;

  const digits = minorDigits(currency);
  const [whole = "0", frac = ""] = s.split(".");
  const fracPadded = (frac + "0".repeat(digits)).slice(0, digits);
  // Round half up on the first dropped digit.
  const roundUp = frac.length > digits && Number(frac[digits]) >= 5 ? 1 : 0;
  const minor = Number(whole || "0") * 10 ** digits + Number(fracPadded || "0") + roundUp;
  if (!Number.isFinite(minor)) return null;
  return negative ? -minor : minor;
}

/** Formats minor units for display, e.g. 123456 USD -> "$1,234.56". */
export function formatMinor(minor: number, currency: string, locale?: string): string {
  const digits = minorDigits(currency);
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency }).format(minor / 10 ** digits);
  } catch {
    return `${(minor / 10 ** digits).toFixed(digits)} ${currency}`;
  }
}

/** Minor units to a plain decimal string for CSV export, e.g. -4250 -> "-42.50". */
export function minorToDecimal(minor: number, currency: string): string {
  const digits = minorDigits(currency);
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  if (digits === 0) return `${sign}${abs}`;
  const whole = Math.floor(abs / 10 ** digits);
  const frac = String(abs % 10 ** digits).padStart(digits, "0");
  return `${sign}${whole}.${frac}`;
}
