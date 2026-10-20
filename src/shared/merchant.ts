/**
 * Turns a raw bank description into a stable merchant key and a readable name.
 *
 *   "POS 1234 SQ *BLUE BOTTLE COFFEE #0042 SAN FRANCISCO CA" -> key "BLUE BOTTLE COFFEE"
 *
 * The key is what merchant memory matches on, so the same shop with a different store number,
 * card suffix or payment processor prefix maps to one merchant.
 */

const PREFIXES = [
  /^(POS|EFTPOS|DEBIT CARD|CREDIT CARD|CARD|VISA|MASTERCARD|PURCHASE|PAYMENT TO|PAYMENT|ACH|DD|SO|BILL PAYMENT|ONLINE|CONTACTLESS|RECURRING)\b[\s:-]*/,
  /^(SQ|SQU|TST|SP|PP|PAYPAL|ZETTLE|IZ|SUMUP|STRIPE|GOOGLE|APPLE PAY|GPAY)\s*\*\s*/,
  /^\d{3,}[\s/-]?\d*\s+/, // terminal or card numbers left after a POS prefix
];

const NOISE = [
  /\b(CARD|ENDING|XX+)\s*\d{2,}\b/g,
  /#\s*\d+/g,
  /\*+\d*/g,
  /\b\d{4,}\b/g, // reference numbers, store numbers
  /\b\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?\b/g, // embedded dates
  /\bREF\b.*$/,
  /\b(INC|LLC|LTD|PVT|PTY|CO|CORP|GMBH)\b\.?/g,
  /\bWWW\.|\.COM\b|\.NET\b|\.ORG\b/g,
];

// Trailing two-letter region codes ("SAN FRANCISCO CA") are noisy but city names are too varied
// to strip reliably, so only a trailing state/country code is removed.
const TRAILING_REGION = /\s+[A-Z]{2}$/;

export function normalizeMerchant(description: string): { key: string; display: string } {
  let s = description.toUpperCase().replace(/\s+/g, " ").trim();
  for (let pass = 0; pass < 3; pass++) {
    for (const p of PREFIXES) s = s.replace(p, "");
  }
  for (const n of NOISE) s = s.replace(n, " ");
  s = s.replace(/[^A-Z0-9&' ]+/g, " ").replace(/\s+/g, " ").trim();
  // Trailing bare numbers are store or terminal numbers ("GROCER STORE 123").
  s = s.replace(/(\s+\d+)+$/, "").trim();
  if (s.split(" ").length > 2) s = s.replace(TRAILING_REGION, "");
  // Keep the first few words; trailing words are usually location.
  const words = s.split(" ").filter(Boolean).slice(0, 4);
  const key = words.join(" ") || description.trim().toUpperCase().slice(0, 40) || "UNKNOWN";
  const display = key
    .toLowerCase()
    .replace(/\b([a-z])/g, (c) => c.toUpperCase())
    .replace(/\b(Atm|Usa|Uk|Nz)\b/g, (w) => w.toUpperCase());
  return { key, display };
}
