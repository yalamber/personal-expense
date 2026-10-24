import { useState } from "react";
import { todayIn } from "../../../shared/dates";
import { monthName } from "../../../shared/plan";
import { api, ApiError, isQueued, paths, QUEUED_NOTE, type Account, type Category, type ContactEntry, type ContactEntryBody, type ContactLedger, type Household } from "../api";
import { useQuery } from "../query";
import { PageSkeleton } from "../skeleton";
import { navigate, onLinkClick } from "../router";
import { CategorySelect, Icon, Sheet, amountInput, categoryLabel, formatMoney, shortDate } from "../ui";
import { Pending } from "./Pending";
import { Diverging, Lines, SERIES } from "../charts";

/**
 * Khata: the family's tabs with shops, relatives and friends. Each contact has a page like the
 * shopkeeper's book, oldest entry first with the running balance, and one sentence at the top
 * that says where things stand.
 */

type Side = "owe" | "owed" | "settled";
const sideOf = (balance: number): Side => (balance < 0 ? "owe" : balance > 0 ? "owed" : "settled");
const tone = (side: Side) => (side === "owe" ? "var(--rust)" : side === "owed" ? "var(--green-deep)" : "var(--muted)");

/** What an entry was, from our side of the book. */
function entryKind(e: { direction: string; transferPairId: string | null }): { label: string; kind: ContactEntryBody["kind"] } {
  if (e.direction === "in") return e.transferPairId ? { label: "we paid", kind: "gave" } : { label: "they owe us", kind: "charge" };
  return e.transferPairId ? { label: "we got", kind: "got" } : { label: "on credit", kind: "credit" };
}

const ENTRY_KINDS: { kind: ContactEntryBody["kind"]; label: string; hint: string }[] = [
  { kind: "credit", label: "Bought on credit", hint: "Goods or a service taken on credit (udharo). Counts as spending now; paying later is not spending again." },
  { kind: "gave", label: "We paid them", hint: "Paid the tab, paid them back, or lent them money, from one of our accounts." },
  { kind: "got", label: "We got from them", hint: "They lent us money, or paid us back, into one of our accounts." },
  { kind: "charge", label: "They owe us for", hint: "Rent due, something we sold them, their share of a cost." },
];

function balanceLine(balance: number, cur: string): string {
  if (balance === 0) return "settled";
  return `${balance < 0 ? "we owe" : "owes us"} ${formatMoney(Math.abs(balance), cur, { symbol: false })}`;
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export function Khata({ household, version, onChanged }: { household: Household; version: number; onChanged: () => void }) {
  const cur = household.currency;
  const canWrite = household.me.role !== "viewer";
  const aq = useQuery<Account[]>(paths.accounts(household.id), [version]);
  const rows = aq.data ? aq.data.filter((a) => a.type === "person" && !a.closedAt) : null;
  const error = aq.error;
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [showSettled, setShowSettled] = useState(false);

  if (error && !rows) return <div className="error">{error}</div>;
  if (!rows) return <PageSkeleton kind="khata" />;

  const q = query.trim().toLowerCase();
  const matches = (a: Account) => !q || a.name.toLowerCase().includes(q) || (a.phone ?? "").includes(q) || (a.note ?? "").toLowerCase().includes(q);
  const owe = rows.filter((a) => a.balanceMinor < 0 && matches(a)).sort((a, b) => a.balanceMinor - b.balanceMinor);
  const owed = rows.filter((a) => a.balanceMinor > 0 && matches(a)).sort((a, b) => b.balanceMinor - a.balanceMinor);
  const settled = rows.filter((a) => a.balanceMinor === 0 && matches(a)).sort((a, b) => a.name.localeCompare(b.name));
  const weOwe = owe.reduce((s, a) => s - a.balanceMinor, 0);
  const theyOwe = owed.reduce((s, a) => s + a.balanceMinor, 0);

  const headline = !rows.length
    ? "No khata yet."
    : weOwe && theyOwe
      ? `We owe ${formatMoney(weOwe, cur)}, and are owed ${formatMoney(theyOwe, cur)}.`
      : weOwe
        ? owe.length === 1
          ? `We owe ${owe[0]!.name} ${formatMoney(weOwe, cur)}.`
          : `We owe ${formatMoney(weOwe, cur)} to ${owe.length} people.`
        : theyOwe
          ? owed.length === 1
            ? `${owed[0]!.name} owes us ${formatMoney(theyOwe, cur)}.`
            : `We are owed ${formatMoney(theyOwe, cur)} by ${owed.length} people.`
          : "Every khata is settled.";

  const lastLine = (a: Account) => {
    if (!a.lastEntry) return [a.phone, a.note].filter(Boolean).join(" · ") || "Nothing in the khata yet";
    const k = entryKind(a.lastEntry);
    const what = a.lastEntry.description && !/^(Paid|From|On credit from) /.test(a.lastEntry.description) ? a.lastEntry.description : k.label;
    return `${shortDate(a.lastEntry.date)} · ${what} ${formatMoney(a.lastEntry.amountMinor, cur, { symbol: false })}`;
  };

  const group = (title: string, list: Account[], side: Side, total: number) => (
    <>
      <div className="day-head">
        <span>
          {title} · {list.length}
        </span>
        {total > 0 && <span style={{ color: tone(side), letterSpacing: 0 }}>{formatMoney(total, cur, { symbol: false })}</span>}
      </div>
      {list.map((a) => (
        <a key={a.id} className="khata-row" href={`/h/${household.id}/khata/${a.id}`} onClick={onLinkClick}>
          <span className={`avatar ${side}`} aria-hidden="true">
            {a.name.slice(0, 1).toUpperCase()}
          </span>
          <span className="what">
            <strong>{a.name}</strong>
            <span>{lastLine(a)}</span>
          </span>
          <span className="amount">
            <span style={{ color: tone(side) }}>{side === "settled" ? "—" : formatMoney(Math.abs(a.balanceMinor), cur, { symbol: false })}</span>
            <span className="bal">{side === "owe" ? "we owe" : side === "owed" ? "owes us" : "settled"}</span>
          </span>
        </a>
      ))}
    </>
  );

  return (
    <>
      <section className="hero" aria-label="The khata at a glance">
        <div className="headline">
          <span className="eyebrow">
            Khata · {rows.length} {rows.length === 1 ? "contact" : "contacts"}
          </span>
          <h1>{headline}</h1>
          <span className="muted">Shops, relatives and friends we run a tab with. Open a name for its book.</span>
          {canWrite && (
            <div className="row">
              <button type="button" onClick={() => setAdding(true)}>
                <Icon.plus /> Add a contact
              </button>
            </div>
          )}
        </div>
        {rows.length > 0 && (
          <dl className="ledger-sum">
            <div>
              <dt>We owe</dt>
              <dd style={{ color: weOwe ? "var(--rust)" : undefined }}>{formatMoney(weOwe, cur, { symbol: false })}</dd>
            </div>
            <div>
              <dt>Owed to us</dt>
              <dd style={{ color: theyOwe ? "var(--green-deep)" : undefined }}>{formatMoney(theyOwe, cur, { symbol: false })}</dd>
            </div>
            <div>
              <dt>All told</dt>
              <dd>{formatMoney(theyOwe - weOwe, cur, { sign: true, symbol: false })}</dd>
            </div>
          </dl>
        )}
      </section>
      {error && <div className="error">{error}</div>}

      {rows.filter((a) => a.balanceMinor !== 0).length >= 2 && (
        <section className="card stack" aria-labelledby="whom-h" style={{ maxWidth: 760 }}>
          <h2 id="whom-h">Who owes whom</h2>
          <Diverging
            rows={[...rows]
              .filter((a) => a.balanceMinor !== 0)
              .sort((a, b) => Math.abs(b.balanceMinor) - Math.abs(a.balanceMinor))
              .slice(0, 8)
              .map((a) => ({ label: a.name, value: a.balanceMinor }))}
            format={(v) => formatMoney(v, cur, { symbol: false })}
            negative={{ label: "We owe", color: SERIES[4] }}
            positive={{ label: "Owed to us", color: SERIES[0] }}
          />
        </section>
      )}

      {rows.length === 0 && (
        <section className="card night stack" style={{ gap: 10, maxWidth: 560 }}>
          <h2 className="display" style={{ fontSize: 21 }}>
            The shopkeeper's book, for the family.
          </h2>
          <span className="small muted">
            Add the kirana you buy from on credit, the relative who lent you money, the tenant who pays rent. Each one gets a khata: what you gave, what you got, and
            what is owed either way, with nothing to add up by hand.
          </span>
        </section>
      )}

      {rows.length > 0 && (
        <section className="card book khata" aria-label="Contacts" style={{ paddingTop: 6, maxWidth: 760 }}>
          {rows.length > 6 && (
            <div className="row" style={{ padding: "10px 0 4px" }}>
              <label className="sr-only" htmlFor="khata-search">
                Find a contact
              </label>
              <input id="khata-search" placeholder="Find a contact" value={query} onChange={(e) => setQuery(e.target.value)} style={{ flex: "1 1 200px" }} />
            </div>
          )}
          {owe.length > 0 && group("We owe", owe, "owe", weOwe)}
          {owed.length > 0 && group("Owed to us", owed, "owed", theyOwe)}
          {settled.length > 0 && (
            <>
              {showSettled && group("Settled", settled, "settled", 0)}
              <div style={{ padding: "12px 0 6px" }}>
                <button type="button" className="link small" onClick={() => setShowSettled((v) => !v)}>
                  {showSettled ? "Hide" : "Show"} {settled.length} settled
                </button>
              </div>
            </>
          )}
          {!owe.length && !owed.length && !settled.length && <p className="small muted">No one matches.</p>}
        </section>
      )}

      {adding && (
        <ContactSheet
          household={household}
          onClose={() => setAdding(false)}
          onSaved={(id) => {
            setAdding(false);
            onChanged();
            navigate(`/h/${household.id}/khata/${id}`);
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// One contact's book
// ---------------------------------------------------------------------------

const SHOWN = 30;

export function KhataPage({ household, contactId, categories, version, onChanged }: { household: Household; contactId: string; categories: Category[]; version: number; onChanged: () => void }) {
  const cur = household.currency;
  const canWrite = household.me.role !== "viewer";
  const aq = useQuery<Account[]>(paths.accounts(household.id), [version]);
  const lq = useQuery<ContactLedger>(paths.entries(household.id, contactId), [version]);
  const contact = aq.data?.find((a) => a.id === contactId) ?? null;
  const accounts = (aq.data ?? []).filter((a) => !a.closedAt && ["checking", "savings", "cash", "wallet", "credit"].includes(a.type));
  const ledger = lq.data ?? null;
  const [sheet, setSheet] = useState<{ kind: ContactEntryBody["kind"]; amount?: string } | "edit" | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (lq.error && !ledger) return <div className="error">{lq.error}</div>;
  if (!ledger || !contact) return <PageSkeleton kind="khata" />;

  const balance = ledger.balanceMinor;
  const side = sideOf(balance);
  const counted = ledger.entries.filter((e) => e.counted);
  const gave = counted.filter((e) => e.direction === "in").reduce((s, e) => s + e.amountMinor, 0);
  const got = counted.filter((e) => e.direction === "out").reduce((s, e) => s + e.amountMinor, 0);
  const entries = showAll ? ledger.entries : ledger.entries.slice(-SHOWN);
  const hidden = ledger.entries.length - entries.length;

  // Month headings, like the book on Today.
  const byMonth: { month: string; rows: ContactEntry[] }[] = [];
  for (const e of entries) {
    const m = e.date.slice(0, 7);
    const last = byMonth[byMonth.length - 1];
    if (last && last.month === m) last.rows.push(e);
    else byMonth.push({ month: m, rows: [e] });
  }

  async function remove(e: ContactEntry) {
    const label = e.description ?? entryKind(e).label;
    if (!window.confirm(`Remove "${label}" from the khata?${e.transferPairId ? " The other side of the move goes too." : ""}`)) return;
    setError(null);
    try {
      await api.voidTransaction(household.id, e.id);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not remove it");
    }
  }

  async function archive() {
    if (!window.confirm(`Archive ${contact!.name}? The khata is kept.`)) return;
    try {
      await api.updateAccount(household.id, contact!.id, { closed: true });
      onChanged();
      navigate(`/h/${household.id}/khata`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not archive");
    }
  }

  return (
    <>
      <a className="back" href={`/h/${household.id}/khata`} onClick={onLinkClick}>
        <Icon.back /> Khata
      </a>
      <section className="hero" aria-label={`${contact.name} at a glance`}>
        <div className="headline">
          <span className="eyebrow">
            {contact.phone ? (
              <a href={`tel:${contact.phone}`} style={{ color: "inherit" }}>
                {contact.phone}
              </a>
            ) : (
              "Contact"
            )}
            {contact.note ? ` · ${contact.note}` : ""}
          </span>
          <h1 style={{ color: side === "settled" ? undefined : tone(side) }}>
            {side === "owe" ? `We owe ${contact.name} ${formatMoney(-balance, cur)}.` : side === "owed" ? `${contact.name} owes us ${formatMoney(balance, cur)}.` : `All settled with ${contact.name}.`}
          </h1>
          {canWrite && (
            <div className="row">
              <button type="button" onClick={() => setSheet({ kind: side === "owed" ? "got" : "credit" })}>
                <Icon.plus /> Add an entry
              </button>
              {side === "owe" && (
                <button type="button" className="secondary" onClick={() => setSheet({ kind: "gave", amount: amountInput(-balance, cur) })}>
                  Paid {formatMoney(-balance, cur)} in full
                </button>
              )}
              {side === "owed" && (
                <button type="button" className="secondary" onClick={() => setSheet({ kind: "got", amount: amountInput(balance, cur) })}>
                  Got {formatMoney(balance, cur)} back
                </button>
              )}
              <button type="button" className="quiet" onClick={() => setSheet("edit")}>
                Edit
              </button>
            </div>
          )}
        </div>
        <dl className="ledger-sum">
          {(ledger.openingMinor !== 0 || ledger.openingDate) && (
            <div>
              <dt>Brought forward{ledger.openingDate ? `, ${shortDate(ledger.openingDate)}` : ""}</dt>
              <dd>{balanceLine(ledger.openingMinor, cur)}</dd>
            </div>
          )}
          <div>
            <dt>We gave</dt>
            <dd className="amount-in">{formatMoney(gave, cur, { symbol: false })}</dd>
          </div>
          <div>
            <dt>We got, or took on credit</dt>
            <dd style={{ color: got ? "var(--rust)" : undefined }}>{formatMoney(got, cur, { symbol: false })}</dd>
          </div>
        </dl>
      </section>
      {counted.length >= 2 && (
        <section className="card stack" aria-labelledby="moved-h" style={{ maxWidth: 760 }}>
          <div className="row between">
            <h2 id="moved-h">How the tab moved</h2>
            <span className="small muted">above the line they owe us · below, we owe</span>
          </div>
          <Lines
            series={[{ name: "Balance", color: SERIES[0], values: [ledger.openingMinor, ...counted.map((e) => e.balanceMinor)] }]}
            labels={[ledger.openingDate ? shortDate(ledger.openingDate) : "start", ...counted.map((e) => shortDate(e.date))]}
            currency={cur}
            format={(v) => balanceLine(v, cur)}
            step
            area
            height={170}
            head="After"
          />
        </section>
      )}
      {notice && <div className="ok">{notice}</div>}
      {error && <div className="error">{error}</div>}

      <section className="card book khata" aria-label="The khata" style={{ paddingTop: 6, maxWidth: 760 }}>
        <div className="row between" style={{ padding: "12px 0 4px" }}>
          <h2>The book</h2>
          <span className="mono small muted">oldest first · balance after each line</span>
        </div>
        <Pending household={household} accounts={[...accounts, contact]} goals={[]} filter={(i) => i.path.includes(`/accounts/${contactId}/entries`)} />
        {hidden > 0 && (
          <div style={{ padding: "8px 0" }}>
            <button type="button" className="link small" onClick={() => setShowAll(true)}>
              Show {hidden} earlier {hidden === 1 ? "entry" : "entries"}
            </button>
          </div>
        )}
        {ledger.entries.length === 0 && (
          <p className="small muted" style={{ padding: "14px 0" }}>
            Nothing in the book yet.{canWrite ? " Add the first entry above." : ""}
          </p>
        )}
        {byMonth.map((g) => (
          <div key={g.month}>
            <div className="day-head">
              <span>{monthName(g.month)}</span>
            </div>
            {g.rows.map((e) => {
              const k = entryKind(e);
              const label = e.description ?? k.label;
              const meta = [
                shortDate(e.date),
                e.otherAccountName ? (e.direction === "in" ? `from ${e.otherAccountName}` : `into ${e.otherAccountName}`) : e.categoryId ? categoryLabel(categories, e.categoryId) : null,
                e.note,
                e.byName,
                e.counted ? null : "before the brought-forward figure, not counted",
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <div key={e.id} className="khata-row" style={{ opacity: e.counted ? 1 : 0.55 }}>
                  <span className={`avatar ${e.direction === "in" ? "owed" : "owe"}`} aria-hidden="true">
                    {e.direction === "in" ? "↑" : "↓"}
                  </span>
                  <span className="what">
                    <strong>{label}</strong>
                    <span>
                      {k.label} · {meta}
                    </span>
                  </span>
                  <span className="amount">
                    <span style={{ color: e.direction === "in" ? "var(--green-deep)" : "var(--rust)" }}>
                      {e.direction === "in" ? "−" : "+"}
                      {formatMoney(e.amountMinor, cur, { symbol: false })}
                    </span>
                    <span className="bal">{balanceLine(e.balanceMinor, cur)}</span>
                  </span>
                  {canWrite && (
                    <button type="button" className="icon-button" aria-label={`Remove ${label}`} onClick={() => remove(e)}>
                      <Icon.close size={16} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ))}
        {canWrite && side === "settled" && ledger.entries.length > 0 && (
          <div className="row between" style={{ paddingTop: 12 }}>
            <span className="small muted">Settled up. Done with {contact.name}?</span>
            <button type="button" className="link small" onClick={archive}>
              Archive the khata
            </button>
          </div>
        )}
      </section>

      {sheet && sheet !== "edit" && (
        <EntrySheet
          household={household}
          contact={contact}
          accounts={accounts}
          categories={categories}
          initial={sheet}
          onClose={() => setSheet(null)}
          onSaved={(message) => {
            setSheet(null);
            setNotice(message);
            onChanged();
          }}
        />
      )}
      {sheet === "edit" && (
        <ContactSheet
          household={household}
          initial={contact}
          onClose={() => setSheet(null)}
          onSaved={() => {
            setSheet(null);
            onChanged();
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

/** One line in the book: what happened, how much, from or into which account. */
function EntrySheet({
  household,
  contact,
  accounts,
  categories,
  initial,
  onClose,
  onSaved,
}: {
  household: Household;
  contact: Account;
  accounts: Account[];
  categories: Category[];
  initial: { kind: ContactEntryBody["kind"]; amount?: string };
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const cur = household.currency;
  const today = todayIn(household.timezone);
  const [kind, setKind] = useState(initial.kind);
  const [amount, setAmount] = useState(initial.amount ?? "");
  const [other, setOther] = useState(accounts.find((a) => a.type !== "credit")?.id ?? accounts[0]?.id ?? "");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [what, setWhat] = useState("");
  const [date, setDate] = useState(today);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsAccount = kind === "gave" || kind === "got";
  const otherName = accounts.find((a) => a.id === other)?.name ?? "the account";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (needsAccount && !other) return setError(kind === "gave" ? "Which account was it paid from?" : "Which account did it come into?");
    setBusy(true);
    try {
      const r = await api.addEntry(household.id, contact.id, { kind, amount, date, otherAccountId: needsAccount ? other : undefined, categoryId: kind === "credit" || kind === "charge" ? categoryId : null, description: what, note });
      if (isQueued(r)) return onSaved(QUEUED_NOTE);
      const money = formatMoney(Math.abs(Number(amount.replace(/[^\d.-]/g, "")) || 0), cur).replace(/\.00$/, "");
      onSaved(
        kind === "gave" ? `Paid ${contact.name} ${money} from ${otherName}.` : kind === "got" ? `Got ${money} from ${contact.name} into ${otherName}.` : kind === "credit" ? `${money} added to the tab with ${contact.name}.` : `${contact.name} owes us ${money} more.`,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the entry");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title={`${contact.name}'s khata`} onClose={onClose}>
      <form className="stack khata-sheet" onSubmit={submit} style={{ gap: 14 }}>
        <div className="chips" role="group" aria-label="What happened">
          {ENTRY_KINDS.map((k) => (
            <button key={k.kind} type="button" className="chip" aria-pressed={kind === k.kind} onClick={() => setKind(k.kind)}>
              {k.label}
            </button>
          ))}
        </div>
        <span className="small muted">{ENTRY_KINDS.find((k) => k.kind === kind)!.hint}</span>
        <label>
          Amount
          <input required inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus={!initial.amount} />
        </label>
        {needsAccount && (
          <label>
            {kind === "gave" ? "Paid from" : "Into"}
            <select required value={other} onChange={(e) => setOther(e.target.value)}>
              <option value="">Choose an account</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {(kind === "credit" || kind === "charge") && (
          <label>
            Category
            <CategorySelect categories={categories} value={categoryId} onChange={setCategoryId} label="Category" filter={(c) => (kind === "credit" ? c.kind === "need" || c.kind === "want" : c.kind === "income")} />
          </label>
        )}
        <label>
          What for (optional)
          <input value={what} onChange={(e) => setWhat(e.target.value)} placeholder={kind === "credit" ? "Rice, oil, this month's groceries" : kind === "charge" ? "October rent" : kind === "gave" ? "Cleared the tab" : "Lent for the wedding"} />
        </label>
        <div className="row" style={{ alignItems: "flex-end" }}>
          <label style={{ flex: "1 1 150px" }}>
            Date
            <input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label style={{ flex: "2 1 200px" }}>
            Note (optional)
            <input value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        </div>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Add to the khata"}
        </button>
      </form>
    </Sheet>
  );
}

/** A contact: who they are, and what was owed either way before the book started. */
function ContactSheet({ household, initial, onClose, onSaved }: { household: Household; initial?: Account; onClose: () => void; onSaved: (id: string) => void }) {
  const cur = household.currency;
  const [name, setName] = useState(initial?.name ?? "");
  const [phone, setPhone] = useState(initial?.phone ?? "");
  const [note, setNote] = useState(initial?.note ?? "");
  const [balance, setBalance] = useState(initial?.openingBalanceMinor ? amountInput(Math.abs(initial.openingBalanceMinor), cur) : "");
  const [weOwe, setWeOwe] = useState(initial ? (initial.openingBalanceMinor ?? 0) < 0 : true);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      // Only a real amount sets a brought-forward figure; without one, every entry counts, back-dated ones too.
      const starting = initial ? touched : Boolean(balance.trim()) && balance.trim() !== "0";
      const body = { name: name.trim(), phone, note, ...(starting ? { balance: balance.trim() || "0", weOwe, balanceDate: todayIn(household.timezone) } : {}) };
      if (initial) {
        await api.updateAccount(household.id, initial.id, body);
        onSaved(initial.id);
      } else {
        const r = await api.createAccount(household.id, { ...body, type: "person" });
        onSaved(r.id);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the contact");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title={initial ? `Edit ${initial.name}` : "A new contact"} onClose={onClose}>
      <form className="stack khata-sheet" onSubmit={submit} style={{ gap: 14 }}>
        <label>
          Name
          <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Ram Kirana, Hari dai, the tenant" />
        </label>
        {!initial && (
          <span className="small muted">
            A running tab with a shop, or money between people. A bank loan or an EMI belongs in{" "}
            <a href={`/h/${household.id}/settings/accounts`} onClick={(e) => { onClose(); onLinkClick(e); }}>
              Accounts
            </a>{" "}
            as a loan, so its installments are known.
          </span>
        )}
        <div className="row" style={{ alignItems: "flex-end" }}>
          <label style={{ flex: "1 1 150px" }}>
            Phone (optional)
            <input inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </label>
          <label style={{ flex: "2 1 200px" }}>
            Note (optional)
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Shop near the chowk" />
          </label>
        </div>
        <div className="stack" style={{ gap: 6 }}>
          <span className="small" style={{ fontWeight: 500 }}>
            {initial ? "Brought forward, as of today" : "Owed before today (optional)"}
          </span>
          <div className="chips" role="group" aria-label="Who owes">
            <button type="button" className="chip" aria-pressed={weOwe} onClick={() => { setWeOwe(true); setTouched(true); }}>
              We owe them
            </button>
            <button type="button" className="chip" aria-pressed={!weOwe} onClick={() => { setWeOwe(false); setTouched(true); }}>
              They owe us
            </button>
          </div>
          <label className="sr-only" htmlFor="contact-balance">
            Amount
          </label>
          <input id="contact-balance" inputMode="decimal" placeholder="0" value={balance} onChange={(e) => { setBalance(e.target.value); setTouched(true); }} />
          <span className="small muted">
            {initial ? "Changing this resets the brought-forward figure to today; entries already in the book stay." : "The figure the book starts from. Entries you add after count on top of it."}
          </span>
        </div>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <button type="submit" disabled={busy}>
          {busy ? "Saving…" : initial ? "Save changes" : "Add the contact"}
        </button>
      </form>
    </Sheet>
  );
}
