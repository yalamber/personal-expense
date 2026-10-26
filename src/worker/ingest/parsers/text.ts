const ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  ndash: "–",
  mdash: "—",
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
  hellip: "…",
  zwnj: "",
  zwj: "",
  shy: "",
};

/** Named, decimal and hex entities ("&nbsp;", "&#8377;", "&#x20B9;"). */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * The readable text of an HTML part: block ends become line breaks, tags go, entities are decoded.
 * Line breaks in the HTML source are only spaces, as a browser shows them, so a table cell and its
 * neighbour stay on one line however the bank's template was indented.
 */
export function plainText(html: string): string {
  if (!html) return "";
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<(style|script|head|title)\b[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/\s+/g, " ")
      .replace(/<\s*(?:br|\/p|\/div|\/tr|\/li|\/h[1-6]|\/table)\b[^>]*>/gi, "\n")
      .replace(/<\s*(?:td|th)\b[^>]*>/gi, " ")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[​-‍⁠﻿­]/g, "")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The rows of the innermost tables, each a list of cell texts: [["Transaction Type", "Debit"], …]. */
export function tableRows(html: string): string[][] {
  if (!html) return [];
  const clean = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(style|script|head)\b[\s\S]*?<\/\1\s*>/gi, "");
  const rows: string[][] = [];
  // A row with no row inside it: layout tables wrap the real ones, so only the innermost rows count.
  for (const tr of clean.matchAll(/<tr\b[^>]*>((?:(?!<tr\b|<\/tr)[\s\S])*)<\/tr\s*>/gi)) {
    const cells = [...tr[1]!.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]\s*>/gi)].map((m) => plainText(m[1]!).replace(/\s+/g, " ").trim());
    if (cells.some(Boolean)) rows.push(cells);
  }
  return rows;
}

const COLUMN = /\b(date|debit|credit|withdraw\w*|deposit|amount|amt|dr|cr|description|particulars|remarks|narration|details)\b/i;

/**
 * Table rows as "label: value" lines. Two cells are a label and its value; a header row over rows
 * of values (Date | Description | Debit | Credit | Balance) pairs each value with its column.
 */
export function tableLines(rows: string[][]): string[] {
  const out: string[] = [];
  const label = (s: string) => s.replace(/[:\-–\s]+$/, "");
  const value = (s: string) => s.replace(/^[:\-–\s]+/, "");
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const isHeader = row.length >= 3 && row.every((c) => !/\d/.test(c)) && row.filter((c) => COLUMN.test(c)).length >= 2;
    if (isHeader && rows[i + 1]?.length === row.length && rows[i + 1]!.some((c) => /\d/.test(c))) {
      let j = i + 1;
      while (rows[j] && rows[j]!.length === row.length && rows[j]!.some((c) => /\d/.test(c))) {
        row.forEach((h, k) => {
          const v = value(rows[j]![k] ?? "");
          if (h && v) out.push(`${label(h)}: ${v}`);
        });
        j++;
      }
      i = j - 1;
      continue;
    }
    const filled = row.filter((c) => c && !/^[:\-–]$/.test(c));
    if (filled.length === 2 && !/\d/.test(filled[0]!)) out.push(`${label(filled[0]!)}: ${value(filled[1]!)}`);
    else if (filled.length) out.push(filled.join(" "));
  }
  return out;
}
