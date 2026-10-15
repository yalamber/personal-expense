/**
 * Parser registry. A parser claims a statement email by sender and subject and turns it
 * into import lines. Phase 0 ships the registry with no parsers; Phase 1 adds the first
 * bank-specific ones, each with fixture emails under test/fixtures.
 */
import type { Email } from "postal-mime";

export type ParsedLine = {
  rawText: string;
  date: string; // YYYY-MM-DD
  amountMinor: number; // positive; direction decided by `kind`
  kind: "out" | "in";
  description: string;
  confidence: number; // 0..100
};

export type StatementParser = {
  key: string;
  /** Returns true when this parser understands the message. */
  matches(input: { from: string; subject: string }): boolean;
  parse(email: Email, attachments: { filename: string; mimeType: string; bytes: Uint8Array }[]): Promise<ParsedLine[]>;
};

const parsers: StatementParser[] = [];

export function registerParser(parser: StatementParser): void {
  parsers.push(parser);
}

export function findParser(input: { from: string; subject: string }): StatementParser | undefined {
  return parsers.find((p) => p.matches(input));
}
