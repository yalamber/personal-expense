import { useCallback, useEffect, useState } from "react";
import { todayIn } from "../../../shared/dates";
import { api, ApiError, type Account, type Category, type ContactEntryBody, type ContactLedger, type Household } from "../api";
import { onLinkClick } from "../router";
import { CategorySelect, Icon, amountInput, categoryLabel, formatMoney, shortDate } from "../ui";

/** "We owe Rs 5,000", "Owes us Rs 2,000", "Settled": a contact's balance from our side. */
function standing(balance: number, cur: string): { text: string; tone: string } {
  if (balance < 0) return { text: `We owe ${formatMoney(-balance, cur)}`, tone: "var(--rust)" };
  if (balance > 0) return { text: `Owes us ${formatMoney(balance, cur)}`, tone: "var(--green-deep)" };
  return { text: "Settled", tone: "var(--ink-soft)" };
}

/** Contacts: shops, relatives and friends, each with a khata of what we owe them and they owe us. */
export function Contacts({ household }: { household: Household }) {
  const cur = household.currency;
  const canWrite = household.me.role !== "viewer";
  const [rows, setRows] = useState<Account[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [showSettled, setShowSettled] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows((await api.accounts(household.id)).filter((a) => a.type === "person"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load contacts");
    }
  }, [household.id]);
  useEffect(() => {
    void load();
  }, [load]);

  const live = (rows ?? []).filter((a) => !a.closedAt);
  const weOwe = live.reduce((s, a) => s + Math.max(0, -a.balanceMinor), 0);
  const theyOwe = live.reduce((s, a) => s + Math.max(0, a.balanceMinor), 0);
  const q = query.trim().toLowerCase();
  const shown = live
    .filter((a) => !q || a.name.toLowerCase().includes(q) || (a.phone ?? "").includes(q))
    .filter((a) => showSettled || a.balanceMinor !== 0)
    .sort((a, b) => Math.abs(b.balanceMinor) - Math.abs(a.balanceMinor) || a.name.localeCompare(b.name));

  return (
    <>
      <div className="row between" style={{ alignItems: "flex-end" }}>
        <div className="stack" style={{ gap: 4 }}>
          <h1>Contacts</h1>
          <span className="muted">Shops, relatives and friends: what we owe them, and what they owe us.</span>
        </div>
        {canWrite && !adding && (
          <button type="button" onClick={() => setAdding(true)}>
            <Icon.plus /> Add a contact
          </button>
        )}
      </div>
      {error && <div className="error">{error}</div>}

      {live.length > 0 && (
        <dl className="ledger-sum" style={{ maxWidth: 520 }}>
          <div>
            <dt>We owe</dt>
            <dd style={{ color: weOwe ? "var(--rust)" : undefined }}>{formatMoney(weOwe, cur)}</dd>
          </div>
          <div>
            <dt>Owed to us</dt>
            <dd style={{ color: theyOwe ? "var(--green-deep)" : undefined }}>{formatMoney(theyOwe, cur)}</dd>
          </div>
        </dl>
      )}

      {adding && (
        <ContactForm
          household={household}
          onCancel={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            void load();
          }}
        />
      )}

      {rows && live.length === 0 && !adding && (
        <div className="card stack">
          <strong>No contacts yet.</strong>
          <span className="muted">Add the kirana you buy from on credit, a relative who lent you money, or a friend you split costs with. Then add entries as money goes back and forth.</span>
        </div>
      )}

      {live.length > 0 && (
        <section className="card" aria-label="Contacts">
          {live.length > 6 && (
            <div className="row" style={{ paddingBottom: 8 }}>
              <label className="sr-only" htmlFor="contact-search">Find a contact</label>
              <input id="contact-search" placeholder="Find a contact" value={query} onChange={(e) => setQuery(e.target.value)} style={{ flex: "1 1 200px" }} />
              <button type="button" className="chip" aria-pressed={!showSettled} onClick={() => setShowSettled((v) => !v)}>
                Hide settled
              </button>
            </div>
          )}
          {shown.map((a) => {
            const st = standing(a.balanceMinor, cur);
            return (
              <a key={a.id} className="book-row" href={`/h/${household.id}/family/contacts/${a.id}`} onClick={onLinkClick} style={{ textDecoration: "none", color: "inherit" }}>
                <span className={`avatar ${a.balanceMinor > 0 ? "in" : ""}`} aria-hidden="true">
                  {a.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="what">
                  <strong>{a.name}</strong>
                  <span>{[a.phone, a.note].filter(Boolean).join(" · ") || "No details"}</span>
                </span>
                <span className="amount" style={{ color: st.tone, fontWeight: 600, whiteSpace: "nowrap" }}>
                  {st.text}
                </span>
              </a>
            );
          })}
          {shown.length === 0 && <span className="small muted">No one matches.</span>}
        </section>
      )}
    </>
  );
}

/** Add a contact, with what was owed either way before today. */
function ContactForm({ household, initial, onSaved, onCancel }: { household: Household; initial?: Account; onSaved: () => void; onCancel: () => void }) {
  const cur = household.currency;
  const [name, setName] = useState(initial?.name ?? "");
  const [phone, setPhone] = useState(initial?.phone ?? "");
  const [note, setNote] = useState(initial?.note ?? "");
  const [balance, setBalance] = useState(initial && initial.openingBalanceMinor ? amountInput(Math.abs(initial.openingBalanceMinor), cur) : "");
  const [weOwe, setWeOwe] = useState(initial ? (initial.openingBalanceMinor ?? 0) < 0 : true);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      // Only a real amount sets a starting figure; without one, every entry counts, back-dated ones too.
      const starting = initial ? touched : Boolean(balance.trim()) && balance.trim() !== "0";
      const body = { name: name.trim(), phone, note, ...(starting ? { balance: balance.trim() || "0", weOwe, balanceDate: todayIn(household.timezone) } : {}) };
      if (initial) await api.updateAccount(household.id, initial.id, body);
      else await api.createAccount(household.id, { ...body, type: "person" });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the contact");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card stack" onSubmit={submit} aria-label={initial ? `Edit ${initial.name}` : "Add a contact"}>
      <div className="row" style={{ alignItems: "flex-end" }}>
        <label style={{ flex: "2 1 200px" }}>
          Name
          <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Ram Kirana, Hari dai" />
        </label>
        <label style={{ flex: "1 1 150px" }}>
          Phone (optional)
          <input inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </label>
      </div>
      <label>
        Note (optional)
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Shop near the chowk, monthly tab" />
      </label>
      <div className="stack" style={{ gap: 6 }}>
        <span className="small" style={{ fontWeight: 500 }}>{initial ? "Balance up to today" : "Owed before today (optional)"}</span>
        <div className="row" style={{ alignItems: "center" }}>
          <div className="chips" role="group" aria-label="Who owes">
            <button type="button" className="chip" aria-pressed={weOwe} onClick={() => { setWeOwe(true); setTouched(true); }}>
              We owe them
            </button>
            <button type="button" className="chip" aria-pressed={!weOwe} onClick={() => { setWeOwe(false); setTouched(true); }}>
              They owe us
            </button>
          </div>
          <label className="sr-only" htmlFor="contact-balance">Amount</label>
          <input id="contact-balance" inputMode="decimal" placeholder="0" value={balance} onChange={(e) => { setBalance(e.target.value); setTouched(true); }} style={{ flex: "1 1 140px" }} />
        </div>
        {initial && <span className="small muted">Changing this resets the starting figure to today; entries already in the khata stay.</span>}
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      <div className="row">
        <button type="submit" disabled={busy}>
          {busy ? "Saving…" : initial ? "Save changes" : "Add the contact"}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

type Kind = ContactEntryBody["kind"];
const KINDS: { kind: Kind; label: string; hint: string }[] = [
  { kind: "gave", label: "We paid them", hint: "Paid back, paid the tab, or lent them money" },
  { kind: "got", label: "We got from them", hint: "They lent us money, or paid us back" },
  { kind: "credit", label: "Bought on credit", hint: "Goods or a service taken on credit (udharo)" },
  { kind: "charge", label: "They owe us for", hint: "Rent due, something we sold them" },
];

/** One contact's khata: entries in order with debit, credit and the running balance. */
export function ContactDetail({ household, contactId, categories, onChanged }: { household: Household; contactId: string; categories: Category[]; onChanged: () => void }) {
  const cur = household.currency;
  const today = todayIn(household.timezone);
  const canWrite = household.me.role !== "viewer";
  const [contact, setContact] = useState<Account | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [ledger, setLedger] = useState<ContactLedger | null>(null);
  const [editing, setEditing] = useState(false);
  const [kind, setKind] = useState<Kind>("credit");
  const [amount, setAmount] = useState("");
  const [other, setOther] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [what, setWhat] = useState("");
  const [date, setDate] = useState(today);
  const [note, setNote] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [all, l] = await Promise.all([api.accounts(household.id), api.entries(household.id, contactId)]);
      setContact(all.find((a) => a.id === contactId) ?? null);
      const own = all.filter((a) => !a.closedAt && ["checking", "savings", "cash", "wallet", "credit"].includes(a.type));
      setAccounts(own);
      setOther((o) => o || own[0]?.id || "");
      setLedger(l);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the contact");
    }
  }, [household.id, contactId]);
  useEffect(() => {
    void load();
  }, [load]);

  if (error && !ledger) return <div className="error">{error}</div>;
  if (!ledger || !contact) return <p className="muted">Opening the khata…</p>;

  const st = standing(ledger.balanceMinor, cur);
  const needsAccount = kind === "gave" || kind === "got";
  const otherName = (id: string) => accounts.find((a) => a.id === id)?.name ?? "the account";

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      await api.addEntry(household.id, contactId, { kind, amount, date, otherAccountId: needsAccount ? other : undefined, categoryId: kind === "credit" ? categoryId : null, description: what, note });
      setNotice(
        kind === "gave" ? `Paid ${contact!.name} from ${otherName(other)}.` : kind === "got" ? `Got money from ${contact!.name} into ${otherName(other)}.` : kind === "credit" ? `Added to the tab with ${contact!.name}.` : `${contact!.name} owes us for it now.`,
      );
      setAmount("");
      setWhat("");
      setNote("");
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the entry");
    }
  }

  async function remove(id: string, label: string) {
    if (!window.confirm(`Remove "${label}" from the khata? It stays in the history as removed.`)) return;
    try {
      await api.voidTransaction(household.id, id);
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not remove it");
    }
  }

  return (
    <>
      <a className="back" href={`/h/${household.id}/family/contacts`} onClick={onLinkClick}>
        <Icon.back /> Contacts
      </a>
      <section className="stack" style={{ gap: 6 }}>
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
        <h1>{contact.name}</h1>
        <span className="display" style={{ fontSize: 26, color: st.tone }}>
          {ledger.balanceMinor < 0 ? `We owe ${contact.name} ${formatMoney(-ledger.balanceMinor, cur)}.` : ledger.balanceMinor > 0 ? `${contact.name} owes us ${formatMoney(ledger.balanceMinor, cur)}.` : `All settled with ${contact.name}.`}
        </span>
        {canWrite && (
          <div className="row" style={{ gap: 4 }}>
            <button type="button" className="link small" onClick={() => setEditing((v) => !v)}>
              Edit contact
            </button>
            {ledger.balanceMinor === 0 && (
              <button
                type="button"
                className="link small"
                onClick={async () => {
                  if (!window.confirm(`Archive ${contact.name}? The khata is kept.`)) return;
                  await api.updateAccount(household.id, contact.id, { closed: true });
                  window.history.back();
                }}
              >
                Archive
              </button>
            )}
          </div>
        )}
      </section>
      {editing && (
        <ContactForm
          household={household}
          initial={contact}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void load();
            onChanged();
          }}
        />
      )}

      <div className="columns">
        <div className="main">
          <section className="card stack" aria-labelledby="khata-h">
            <div className="row between">
              <h2 id="khata-h">Khata</h2>
              <span className="mono small muted">Debit = we gave · Credit = we got</span>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Details</th>
                    <th className="right">Debit</th>
                    <th className="right">Credit</th>
                    <th className="right">Balance</th>
                    {canWrite && (
                      <th>
                        <span className="sr-only">Actions</span>
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {(ledger.openingDate || ledger.openingMinor !== 0) && (
                    <tr>
                      <td className="mono small">{ledger.openingDate ? shortDate(ledger.openingDate) : ""}</td>
                      <td>
                        <strong style={{ fontWeight: 600 }}>Brought forward</strong>
                      </td>
                      <td className="right mono">{ledger.openingMinor > 0 ? formatMoney(ledger.openingMinor, cur, { symbol: false }) : ""}</td>
                      <td className="right mono">{ledger.openingMinor < 0 ? formatMoney(-ledger.openingMinor, cur, { symbol: false }) : ""}</td>
                      <td className="right mono small">{balanceCell(ledger.openingMinor, cur)}</td>
                      {canWrite && <td />}
                    </tr>
                  )}
                  {ledger.entries.map((e) => {
                    const label = e.description ?? (e.direction === "in" ? "We gave" : "We got");
                    const meta = [e.otherAccountName ? (e.direction === "in" ? `from ${e.otherAccountName}` : `into ${e.otherAccountName}`) : e.categoryId ? categoryLabel(categories, e.categoryId) : null, e.note, e.byName].filter(Boolean).join(" · ");
                    return (
                      <tr key={e.id} style={{ opacity: e.counted ? 1 : 0.55 }}>
                        <td className="mono small">{shortDate(e.date)}</td>
                        <td>
                          <span className="stack" style={{ gap: 0 }}>
                            <strong style={{ fontWeight: 600 }}>{label}</strong>
                            {meta && <span className="small muted">{meta}</span>}
                            {!e.counted && <span className="small muted">Before the starting figure, so not counted</span>}
                          </span>
                        </td>
                        <td className="right mono">{e.direction === "in" ? formatMoney(e.amountMinor, cur, { symbol: false }) : ""}</td>
                        <td className="right mono">{e.direction === "out" ? formatMoney(e.amountMinor, cur, { symbol: false }) : ""}</td>
                        <td className="right mono small">{balanceCell(e.balanceMinor, cur)}</td>
                        {canWrite && (
                          <td className="right">
                            <button type="button" className="icon-button" aria-label={`Remove ${label}`} onClick={() => remove(e.id, label)}>
                              <Icon.close size={16} />
                            </button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                  {ledger.entries.length === 0 && !ledger.openingMinor && (
                    <tr>
                      <td colSpan={canWrite ? 6 : 5} className="muted small">
                        Nothing in the khata yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <aside className="side">
          {canWrite && (
            <form className="card stack" onSubmit={save} aria-labelledby="entry-h">
              <h2 id="entry-h">Add an entry</h2>
              <div className="chips" role="group" aria-label="What happened">
                {KINDS.map((k) => (
                  <button key={k.kind} type="button" className="chip" aria-pressed={kind === k.kind} onClick={() => setKind(k.kind)}>
                    {k.label}
                  </button>
                ))}
              </div>
              <span className="small muted">{KINDS.find((k) => k.kind === kind)!.hint}</span>
              <label>
                Amount
                <input required inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
              </label>
              {needsAccount && (
                <label>
                  {kind === "gave" ? "Paid from" : "Into"}
                  <select required value={other} onChange={(e) => setOther(e.target.value)}>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {kind === "credit" && (
                <label>
                  Category
                  <CategorySelect categories={categories} value={categoryId} onChange={setCategoryId} label="Category" filter={(c) => c.kind === "need" || c.kind === "want"} />
                </label>
              )}
              <label>
                What for (optional)
                <input value={what} onChange={(e) => setWhat(e.target.value)} placeholder={kind === "credit" ? "Rice, oil, monthly groceries" : kind === "charge" ? "October rent" : ""} />
              </label>
              <label>
                Date
                <input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} />
              </label>
              <label>
                Note (optional)
                <input value={note} onChange={(e) => setNote(e.target.value)} />
              </label>
              <button type="submit">Add to the khata</button>
              {kind === "credit" && <span className="small muted">Counts as this month's spending; paying the tab later is a move, not spending again.</span>}
            </form>
          )}
          {notice && <div className="ok">{notice}</div>}
          {error && <div className="error">{error}</div>}
        </aside>
      </div>
    </>
  );
}

function balanceCell(balance: number, cur: string): string {
  if (balance === 0) return "settled";
  return `${formatMoney(Math.abs(balance), cur, { symbol: false })} ${balance < 0 ? "we owe" : "owed to us"}`;
}
