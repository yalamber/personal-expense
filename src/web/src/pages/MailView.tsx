/**
 * An email that arrived at the statements address, shown so a person can decide what it is:
 * who sent it and who forwarded it, what the app can read from it, the email itself, and which
 * account it belongs to. Used by the Decide card and by Settings › Inbox.
 */
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type AccountType, type Household, type MailPreview } from "../api";
import { onLinkClick } from "../router";
import { Sk, SkLines } from "../skeleton";
import { amountInput, formatMoney, shortDate } from "../ui";

export function useMailPreview(householdId: string, statementId: string) {
  const [data, setData] = useState<MailPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setError(null);
      setData(await api.statementPreview(householdId, statementId));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not open the email");
    }
  }, [householdId, statementId]);
  useEffect(() => {
    void load();
  }, [load]);
  return { data, error, reload: load };
}

/** "Sun 26 Oct, 07:21" in the viewer's own clock. */
export function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

const TYPE_LABEL: Partial<Record<AccountType, string>> = { checking: "bank account", savings: "savings", credit: "card", wallet: "wallet" };

/** Who to name for the email: the bank behind any forward, by its display name if it has one. */
export function senderTitle(p: MailPreview): string {
  if (p.from?.name && p.sender && p.from.address === p.sender) return p.from.name;
  return p.sender ?? p.from?.name ?? p.from?.address ?? "an unknown sender";
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function MailSkeleton() {
  return (
    <div className="stack" style={{ gap: 12 }} aria-busy="true" aria-label="Opening the email">
      <Sk h={120} r={12} />
      <Sk h={64} r={12} />
      <SkLines n={4} />
    </div>
  );
}

/** Where it came from, what can be read from it, and the email itself. */
export function MailDetails({ preview: p, household, open = true }: { preview: MailPreview; household: Household; open?: boolean }) {
  const [all, setAll] = useState(false);
  const cur = household.currency;
  const handForward = p.from && p.sender && p.from.address !== p.sender;
  return (
    <>
      <section className="mail-section" aria-label="Where it came from">
        <span className="eyebrow">Where it came from</span>
        <dl className="mail-meta">
          <dt>From</dt>
          <dd>
            {p.from ? (
              <>
                {p.from.name && <strong>{p.from.name}</strong>}
                <span className="addr">{p.from.address}</span>
              </>
            ) : (
              <span className="muted">not in the email</span>
            )}
          </dd>
          {handForward && (
            <>
              <dt>Originally from</dt>
              <dd>
                <span className="addr">{p.sender}</span>
              </dd>
            </>
          )}
          {p.forwardedBy && (
            <>
              <dt>Forwarded by</dt>
              <dd>
                <span className="addr">{p.forwardedBy}</span>
                {p.forwardedVia && <span className="small muted">through {p.forwardedVia}</span>}
              </dd>
            </>
          )}
          <dt>Subject</dt>
          <dd>{p.subject ?? <span className="muted">(none)</span>}</dd>
          {p.sentAt && Math.abs(Date.parse(p.receivedAt) - Date.parse(p.sentAt)) < 5 * 60_000 ? (
            <>
              <dt>Sent</dt>
              <dd>{when(p.sentAt)}, and arrived the same minute</dd>
            </>
          ) : (
            <>
              <dt>Sent</dt>
              <dd>{p.sentAt ? when(p.sentAt) : <span className="muted">not given</span>}</dd>
              <dt>Arrived</dt>
              <dd>{when(p.receivedAt)}</dd>
            </>
          )}
          <dt>Attached</dt>
          <dd>
            {p.attachments.length === 0
              ? "nothing"
              : p.attachments.map((a) => (
                  <span key={a.filename} className="addr">
                    {a.filename} · {bytes(a.size)}
                  </span>
                ))}
          </dd>
        </dl>
      </section>

      <section className="mail-section" aria-label="What the app can read">
        <span className="eyebrow">What the app can read from it</span>
        {p.reading.lines.length > 0 ? (
          <>
            {p.reading.lines.map((l, i) => (
              <div key={i} className="mail-line">
                <div className="top">
                  <strong style={{ minWidth: 0, overflowWrap: "anywhere" }}>{l.description}</strong>
                  <span className={`amt ${l.kind === "in" ? "amount-in" : ""}`}>
                    {l.kind === "in" ? "+" : "−"}
                    {formatMoney(l.amountMinor, cur)}
                  </span>
                </div>
                <span className="small muted">
                  {l.kind === "in" ? "Money in" : "Money out"} on {shortDate(l.date)}
                </span>
                <span className="mail-quote">{l.rawText}</span>
              </div>
            ))}
            <span className="small muted">
              {p.reading.parserKey === "ai"
                ? "Read by the AI reader, so each line waits in Decide for you to check before it counts."
                : p.reading.parserKey === "by-hand"
                  ? "Filled in by hand from the email."
                  : p.reading.lines.some((l) => l.confidence < 80)
                    ? "Read by the general alert reader, so each line is shown in Decide before it counts."
                    : "Read by this bank's own reader."}
            </span>
          </>
        ) : p.missing ? (
          <span className="small muted">The original is no longer stored (emails are kept for 90 days), so nothing more can be read from it.</span>
        ) : (p.reading.why ?? (p.status === "unparsed" ? p.error : null)) ? (
          <span className="small" style={{ color: "var(--ink-soft)" }}>
            Not read. {p.reading.why ?? p.error}
          </span>
        ) : p.reading.parserKey ? (
          <span className="small" style={{ color: "var(--ink-soft)" }}>
            Nothing in it reads like a transaction: no amount next to "debited" or "credited". A statement, an offer or a password email lands here too.
          </span>
        ) : (
          <span className="small" style={{ color: "var(--ink-soft)" }}>
            The app has no reader for this kind of email yet. Linked to an account it stays with that account, and a reader for this bank can be written from one sample.
          </span>
        )}
      </section>

      {p.text && (
        <details className="mail-body" open={open}>
          <summary>The email</summary>
          <div className={`mail-text ${all ? "all" : ""}`}>{p.text}</div>
          <div className="row" style={{ gap: 12, marginTop: 4 }}>
            {!all && p.text.length > 600 && (
              <button type="button" className="link small" onClick={() => setAll(true)}>
                Show all of it
              </button>
            )}
            {p.truncated && <span className="small muted">Long email: the rest is in the download.</span>}
          </div>
        </details>
      )}
    </>
  );
}

/** Why the email waits for a person, said before anything else on the card. */
export function WhyHeld({ preview: p }: { preview: MailPreview }) {
  const listedOn = p.accounts.find((a) => a.level === 3);
  return (
    <div className={`why ${p.held === "forwarded" ? "calm" : ""}`} role="note">
      {p.held === "forwarded" && listedOn ? (
        <>
          <strong>{p.sender}</strong> is already on {listedOn.name}'s list. This one was held only because {p.forwardedVia ? `${p.forwardedVia} passed it on` : "a forwarder passed it on"} under its own address. The app now looks past that, so the next one goes straight in.
        </>
      ) : p.sender ? (
        <>
          Emails are read on their own only when the sender is on an account's list. <strong>{p.sender}</strong> is not on any list yet. Say which account it is about and the app reads it now and, if you say so, every one after it.
        </>
      ) : (
        <>Only a forwarder's address is known for this email, so the app cannot tell which bank sent it. Choose the account it is about.</>
      )}
    </div>
  );
}

/**
 * Link the email to an account (an admin's call), or set it aside as not a statement. The likely
 * account is chosen already, with the reason; "remember" adds the sender to that account's list.
 */
export function LinkAccount({
  household,
  preview: p,
  busy,
  onLink,
  onDismiss,
  onLater,
}: {
  household: Household;
  preview: MailPreview;
  busy: boolean;
  onLink: (accountId: string, accountName: string, remember: boolean) => void;
  onDismiss: () => void;
  onLater?: () => void;
}) {
  const best = p.accounts[0];
  const [account, setAccount] = useState(best?.id ?? "");
  const [remember, setRemember] = useState(true);
  const isAdmin = household.me.role === "admin";
  const canWrite = household.me.role !== "viewer";
  const chosen = p.accounts.find((a) => a.id === account);
  const listed = Boolean(chosen && p.sender && chosen.level === 3);
  const first = p.reading.lines[0];

  return (
    <>

      {isAdmin ? (
        <>
          {p.accounts.length > 0 ? (
            <fieldset className="pick-list">
              <legend>Which account is it about?</legend>
              {p.accounts.map((a, i) => (
                <label key={a.id} className="pick">
                  <input type="radio" name={`acct-${p.id}`} value={a.id} checked={account === a.id} onChange={() => setAccount(a.id)} />
                  <span className="pick-main">
                    <span className="row" style={{ gap: 6 }}>
                      <strong>{a.name}</strong>
                      <span className="pill grey">{TYPE_LABEL[a.type] ?? a.type}</span>
                      {i === 0 && a.level > 0 && <span className="pill green">likely</span>}
                    </span>
                    {a.reason && <span className="small" style={{ color: "var(--green-deep)" }}>{a.reason[0]!.toUpperCase() + a.reason.slice(1)}.</span>}
                    <span className="addr">{a.senders.length ? `Reads mail from ${a.senders.join(", ")}` : "No senders on its list yet"}</span>
                  </span>
                </label>
              ))}
              <span className="small muted">
                Not here?{" "}
                <a href={`/h/${household.id}/settings/accounts`} onClick={onLinkClick}>
                  Add the account
                </a>{" "}
                with this sender, and the email can be read for it.
              </span>
            </fieldset>
          ) : (
            <div className="stack" style={{ gap: 6 }}>
              <strong>No account takes statements yet.</strong>
              <span className="small muted">
                <a href={`/h/${household.id}/settings/accounts`} onClick={onLinkClick}>
                  Add the bank account
                </a>{" "}
                {p.sender ? `with ${p.sender} as its sender` : ""}, then come back to this email.
              </span>
            </div>
          )}

          {chosen && p.sender && !listed && (
            <label className="check">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              <span>
                Remember <span className="mono">{p.sender}</span> for {chosen.name}: the next email from it goes straight in
              </span>
            </label>
          )}

          {chosen && (
            <span className="small muted">
              {first
                ? `${chosen.name} gets this email. ${p.reading.lines.length === 1 ? `The ${formatMoney(first.amountMinor, household.currency)} ${first.kind === "in" ? "credit" : "debit"}` : `Its ${p.reading.lines.length} lines`} ${p.reading.lines.length === 1 ? "comes" : "come"} back here in Decide for a category, then ${p.reading.lines.length === 1 ? "goes" : "go"} into the book, checked against what the family already logged.`
                : `${chosen.name} keeps this email. Nothing in it becomes an entry.`}
            </span>
          )}

          <div className="actions">
            <button type="button" disabled={busy || !chosen} onClick={() => chosen && onLink(chosen.id, chosen.name, remember && !listed && Boolean(p.sender))}>
              {chosen ? `Read it for ${chosen.name}` : "Choose an account"}
            </button>
            <button type="button" className="quiet" disabled={busy} onClick={onDismiss}>
              Not a bank email: set it aside
            </button>
            {onLater && (
              <button type="button" className="quiet" onClick={onLater}>
                Later
              </button>
            )}
          </div>
          <a className="small" href={api.rawStatementUrl(household.id, p.id)} download style={{ alignSelf: "flex-start" }}>
            Download the original email (.eml)
          </a>
        </>
      ) : (
        <>
          <span className="small muted">An admin of the household links emails to accounts. You can set it aside if it is not a bank email.</span>
          {canWrite && (
            <div className="actions">
              <button type="button" className="quiet" disabled={busy} onClick={onDismiss}>
                Not a bank email: set it aside
              </button>
              {onLater && (
                <button type="button" className="quiet" onClick={onLater}>
                  Later
                </button>
              )}
            </div>
          )}
        </>
      )}
    </>
  );
}

export type FillBody = { amount: string; direction: "out" | "in"; date: string; description: string };

/** The day an email was sent, on the viewer's own calendar. */
const localDay = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : d.toLocaleDateString("en-CA");
};

/**
 * Say what an email the app could not read is about, starting from whatever the reader did find.
 * The line goes through the same checks as a read alert: an entry already in the book is confirmed
 * rather than doubled.
 */
export function FillByHand({ household, preview: p, busy, onSubmit }: { household: Household; preview: MailPreview; busy: boolean; onSubmit: (body: FillBody) => void }) {
  const cur = household.currency;
  const g = p.reading.guess ?? null;
  const [direction, setDirection] = useState<"out" | "in" | null>(g?.kind ?? null);
  const [amount, setAmount] = useState(g?.amountMinor ? amountInput(g.amountMinor, cur) : "");
  const [date, setDate] = useState(g?.date ?? localDay(p.sentAt ?? p.receivedAt));
  const [description, setDescription] = useState(g?.description ?? "");
  return (
    <form
      className="fill-by-hand stack"
      aria-label="Say what the email is about"
      onSubmit={(e) => {
        e.preventDefault();
        if (direction && amount.trim()) onSubmit({ amount, direction, date, description });
      }}
    >
      <span className="eyebrow">Say what it is</span>
      <span className="small" style={{ color: "var(--ink-soft)" }}>
        {g?.amountMinor ? `It mentions ${formatMoney(g.amountMinor, cur)}; say which way it went and check the rest.` : "Put in what the email says."} If the same payment is already in the book, it is confirmed, not added twice.
      </span>
      <div className="seg" role="group" aria-label="Direction">
        <button type="button" aria-pressed={direction === "out"} onClick={() => setDirection("out")}>
          Money out
        </button>
        <button type="button" className="in" aria-pressed={direction === "in"} onClick={() => setDirection("in")}>
          Money in
        </button>
      </div>
      <div className="row" style={{ alignItems: "flex-end" }}>
        <label style={{ flex: "1 1 130px" }}>
          Amount
          <input required inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
        </label>
        <label style={{ flex: "1 1 150px" }}>
          Date
          <input required type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      </div>
      <label>
        What for
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="The remarks in the email" maxLength={200} />
      </label>
      <div className="actions">
        <button type="submit" disabled={busy || !direction || !amount.trim() || !date}>
          {direction ? `Add it as money ${direction}` : "Choose money out or in"}
        </button>
      </div>
    </form>
  );
}

/** What happened to a line filled in by hand, in words. */
export function filledMessage(r: { autoPosted: number; confirmed: number; duplicates: number; alreadyQueued: number }): string {
  if (r.confirmed) return "It matched an entry already in the book, which is now marked as confirmed by the bank.";
  if (r.autoPosted) return "In the book, under the category this name is remembered by.";
  if (r.duplicates) return "It waits in Decide beside an entry that looks the same, so it is not counted twice.";
  if (r.alreadyQueued) return "The same line is already waiting in Decide.";
  return "It waits in Decide for a category.";
}
