/**
 * Pure aggregation for a month, shared by the Worker (Today, the summary) and the web app (the
 * charts on Today). Rules:
 *  - transfers (a transfer pair, the transfer direction, or a transfer category) count for nothing
 *  - money out in a saving category is "saved", not spent
 *  - money in to a need/want category is a refund and reduces that category's spend
 *  - other money in is income
 * Totals roll up to top-level categories.
 */
export type SummaryCategory = { id: string; parentId: string | null; kind: string; [extra: string]: unknown };
export type SummaryTx = { amountMinor: number; direction: "out" | "in" | "transfer"; categoryId: string | null; transferPairId?: string | null };

export function summarize(txs: SummaryTx[], categories: SummaryCategory[]) {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const topOf = (id: string | null): SummaryCategory | null => {
    let cat = id ? byId.get(id) ?? null : null;
    while (cat?.parentId && byId.get(cat.parentId)) cat = byId.get(cat.parentId)!;
    return cat;
  };
  let spent = 0;
  let income = 0;
  let saved = 0;
  let uncategorized = 0;
  const perTop = new Map<string | null, number>();
  for (const t of txs) {
    const cat = t.categoryId ? byId.get(t.categoryId) ?? null : null;
    if (t.direction === "transfer" || t.transferPairId || cat?.kind === "transfer") continue;
    if (!cat) uncategorized++;
    const top = topOf(t.categoryId);
    const key = top?.id ?? null;
    if (t.direction === "out") {
      if (cat?.kind === "saving") {
        saved += t.amountMinor;
        continue;
      }
      spent += t.amountMinor;
      perTop.set(key, (perTop.get(key) ?? 0) + t.amountMinor);
    } else if (cat && (cat.kind === "need" || cat.kind === "want")) {
      spent -= t.amountMinor;
      perTop.set(key, (perTop.get(key) ?? 0) - t.amountMinor);
    } else {
      income += t.amountMinor;
    }
  }
  return { spent, income, saved, uncategorized, perTop };
}

/** One entry's share of the month's spending, by the same rules (a refund counts against it). */
export function spendOf(t: SummaryTx, categories: SummaryCategory[]): number {
  return summarize([t], categories).spent;
}
