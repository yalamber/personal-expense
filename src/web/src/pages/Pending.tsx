import type { Account, Goal, Household } from "../api";
import { describe, type OutboxItem } from "../offline/core";
import { keepBoth, removeItem, sync, useOffline } from "../offline";
import { formatMoney, shortDate } from "../ui";

/**
 * Entries made with no connection: on this phone, not in the book yet. Shown at the top of the
 * book with a hollow mark, each with what will happen to it, and the two calls a twin needs.
 */
export function Pending({ household, accounts, goals, filter }: { household: Household; accounts: Account[]; goals: Goal[]; filter?: (item: OutboxItem) => boolean }) {
  const { items, online, syncing } = useOffline();
  const mine = items.filter((i) => i.householdId === household.id).filter(filter ?? (() => true));
  if (!mine.length) return null;
  const cur = household.currency;
  const name = (id: string | null) => (id ? accounts.find((a) => a.id === id)?.name ?? null : null);
  const goalName = (id: string | null) => (id ? goals.find((g) => g.id === id)?.name ?? null : null);

  return (
    <div className="pending" aria-label="Waiting to sync">
      <div className="day-head" style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
        <span>On this phone · {mine.length}</span>
        {online && !syncing && mine.some((i) => i.state === "queued") && (
          <button type="button" className="link small" style={{ minHeight: 0, padding: 0, letterSpacing: 0, textTransform: "none" }} onClick={() => void sync()}>
            Sync now
          </button>
        )}
      </div>
      {mine.map((item) => {
        const d = describe(item.method, item.path, item.body);
        const who = d.kind === "khata" || d.kind === "loan" ? name(d.contactId) : null;
        const title = who ? `${d.title} ${who}` : d.kind === "goal" && goalName(d.goalId) ? `${d.title.replace("a goal", goalName(d.goalId)!)}` : d.title;
        const meta = [d.date ? shortDate(d.date) : null, name(d.accountId), statusText(item, cur)].filter(Boolean).join(" · ");
        return (
          <div key={item.id} className="book-row pending-row" style={{ cursor: "default" }}>
            <span className="avatar" aria-hidden="true" style={{ background: "transparent", border: "1.5px dashed var(--line)", color: "var(--muted)" }}>
              ○
            </span>
            <span className="what">
              <strong>{title}</strong>
              <span style={{ whiteSpace: "normal" }}>{meta}</span>
              {item.state !== "queued" && (
                <span className="row" style={{ gap: 4, marginTop: 4, whiteSpace: "normal" }}>
                  {item.state === "twin" && (
                    <button type="button" className="link small" onClick={() => keepBoth(item.id)}>
                      Keep both
                    </button>
                  )}
                  <button type="button" className="link small" onClick={() => removeItem(item.id)}>
                    {item.state === "twin" ? "Drop it, same payment" : "Remove"}
                  </button>
                </span>
              )}
            </span>
            <span className="amount">
              <span style={{ color: item.state === "failed" ? "var(--rust)" : "var(--muted)" }}>
                {d.sign}
                {d.amount ?? ""}
              </span>
              <span className="small muted" style={{ fontFamily: "var(--font-sans)" }}>
                {item.state === "queued" ? (syncing ? "syncing…" : "not synced") : item.state === "twin" ? "needs a look" : "refused"}
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

function statusText(item: OutboxItem, cur: string): string {
  if (item.state === "twin") {
    const t = item.twins?.[0];
    return t ? `The book already has ${t.name ?? "a payment"} for ${formatMoney(t.amountMinor, cur)} on ${shortDate(t.date)}${t.byName ? `, logged by ${t.byName}` : ""}. Same payment?` : "The book already has something like this. Same payment?";
  }
  if (item.state === "failed") return `Not accepted: ${item.error ?? "unknown reason"}`;
  return "goes into the book when you're back online";
}
