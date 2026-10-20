/**
 * Column mapping for bank CSV files. Saved per account, so a bank's export is mapped once and
 * every later file (uploaded or arriving as an email attachment) imports automatically.
 */
import { parseAmountToMinor } from "./money";
import { guessDateFormat, parseDate, type DateFormat } from "./dates";

export type CsvMapping = {
  hasHeader: boolean;
  dateColumn: number;
  descriptionColumn: number;
  /** One signed amount column, or separate debit (money out) and credit (money in) columns. */
  amountMode: "single" | "split";
  amountColumn?: number;
  debitColumn?: number;
  creditColumn?: number;
  /** For a single amount column: true when money out is shown as negative (most banks). */
  negativeIsOut: boolean;
  dateFormat: DateFormat;
  decimalSeparator: "." | ",";
};

export type MappedRow = {
  line: number;
  raw: string;
  date: string;
  description: string;
  /** Always positive. */
  amountMinor: number;
  direction: "out" | "in";
};

export type MappingResult = { rows: MappedRow[]; errors: { line: number; raw: string; reason: string }[] };

export function applyMapping(table: string[][], mapping: CsvMapping, currency: string): MappingResult {
  const rows: MappedRow[] = [];
  const errors: MappingResult["errors"] = [];
  const start = mapping.hasHeader ? 1 : 0;

  for (let i = start; i < table.length; i++) {
    const cells = table[i]!;
    const raw = cells.join(" | ");
    const line = i + 1;
    const date = parseDate(cells[mapping.dateColumn] ?? "", mapping.dateFormat);
    if (!date) {
      errors.push({ line, raw, reason: `could not read date "${cells[mapping.dateColumn] ?? ""}"` });
      continue;
    }
    const description = (cells[mapping.descriptionColumn] ?? "").trim();

    let signed: number | null = null;
    if (mapping.amountMode === "single") {
      const v = parseAmountToMinor(cells[mapping.amountColumn ?? -1] ?? "", currency, mapping.decimalSeparator);
      if (v !== null) signed = mapping.negativeIsOut ? v : -v;
    } else {
      const debit = parseAmountToMinor(cells[mapping.debitColumn ?? -1] ?? "", currency, mapping.decimalSeparator);
      const credit = parseAmountToMinor(cells[mapping.creditColumn ?? -1] ?? "", currency, mapping.decimalSeparator);
      if (debit) signed = -Math.abs(debit);
      else if (credit) signed = Math.abs(credit);
      else if (debit === 0 || credit === 0) signed = 0;
    }
    if (signed === null) {
      errors.push({ line, raw, reason: "could not read amount" });
      continue;
    }
    if (signed === 0) continue; // zero-value rows (balance lines, holds) carry no money
    rows.push({ line, raw, date, description: description || "(no description)", amountMinor: Math.abs(signed), direction: signed < 0 ? "out" : "in" });
  }
  return { rows, errors };
}

const DATE_HEADERS = /^(transaction |posted |posting |value |booking )?date$|^date\b/i;
const DESC_HEADERS = /description|details|narrative|memo|payee|merchant|particulars|reference|transaction$/i;
const AMOUNT_HEADERS = /^amount|^value$|^sum$/i;
const DEBIT_HEADERS = /debit|withdrawal|money out|paid out|^out$/i;
const CREDIT_HEADERS = /credit|deposit|money in|paid in|^in$/i;

/** Best-effort first guess at a mapping from a header row and sample rows. The user confirms it. */
export function guessMapping(table: string[][]): CsvMapping {
  const header = table[0] ?? [];
  const hasHeader = header.some((h) => /[A-Za-z]{3,}/.test(h)) && !header.some((h) => /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$/.test(h));
  const body = table.slice(hasHeader ? 1 : 0, (hasHeader ? 1 : 0) + 30);
  const find = (re: RegExp) => (hasHeader ? header.findIndex((h) => re.test(h.trim())) : -1);

  let dateColumn = find(DATE_HEADERS);
  if (dateColumn < 0) dateColumn = Math.max(0, header.findIndex((_, i) => guessDateFormat(body.map((r) => r[i] ?? "")) !== null));
  let descriptionColumn = find(DESC_HEADERS);
  const debitColumn = find(DEBIT_HEADERS);
  const creditColumn = find(CREDIT_HEADERS);
  let amountColumn = find(AMOUNT_HEADERS);
  const amountMode: CsvMapping["amountMode"] = amountColumn < 0 && debitColumn >= 0 && creditColumn >= 0 ? "split" : "single";
  if (amountMode === "single" && amountColumn < 0) {
    amountColumn = (table[0] ?? []).findIndex((_, i) => i !== dateColumn && body.length > 0 && body.every((r) => parseAmountToMinor(r[i] ?? "", "USD") !== null));
    if (amountColumn < 0) amountColumn = Math.min(2, (table[0]?.length ?? 1) - 1);
  }
  if (descriptionColumn < 0) {
    descriptionColumn = (table[0] ?? []).findIndex((_, i) => i !== dateColumn && i !== amountColumn && body.some((r) => /[A-Za-z]{3,}/.test(r[i] ?? "")));
    if (descriptionColumn < 0) descriptionColumn = 1;
  }
  const dateFormat = guessDateFormat(body.map((r) => r[dateColumn] ?? "")) ?? "YYYY-MM-DD";
  const decimalSeparator: "." | "," = body.some((r) => /^\(?-?\d{1,3}(\.\d{3})*,\d{2}\)?$/.test((r[amountMode === "single" ? amountColumn : debitColumn] ?? "").trim())) ? "," : ".";

  return {
    hasHeader,
    dateColumn,
    descriptionColumn,
    amountMode,
    amountColumn: amountMode === "single" ? amountColumn : undefined,
    debitColumn: amountMode === "split" ? debitColumn : undefined,
    creditColumn: amountMode === "split" ? creditColumn : undefined,
    negativeIsOut: true,
    dateFormat,
    decimalSeparator,
  };
}

/** Validates an untrusted mapping object from a request or the database. */
export function isCsvMapping(value: unknown): value is CsvMapping {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  const col = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 200;
  if (typeof m.hasHeader !== "boolean" || typeof m.negativeIsOut !== "boolean") return false;
  if (!col(m.dateColumn) || !col(m.descriptionColumn)) return false;
  if (m.decimalSeparator !== "." && m.decimalSeparator !== ",") return false;
  if (typeof m.dateFormat !== "string") return false;
  if (m.amountMode === "single") return col(m.amountColumn);
  if (m.amountMode === "split") return col(m.debitColumn) && col(m.creditColumn);
  return false;
}
