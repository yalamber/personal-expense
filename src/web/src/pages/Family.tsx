import { useEffect, useState } from "react";
import { monthRange, todayIn } from "../../../shared/dates";
import { api, ApiError, type Household, type Statement } from "../api";
import { onLinkClick } from "../router";
import { Icon } from "../ui";

/** Family: the people, the accounts and the plumbing that keeps the book filling itself. */
export function Family({ household, onLogout, onChanged }: { household: Household; onLogout: () => void; onChanged: () => void }) {
  const base = `/h/${household.id}/family`;
  const isAdmin = household.me.role === "admin";
  const [payDay, setPayDay] = useState(household.monthStartDay);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { from, to } = monthRange(todayIn(household.timezone).slice(0, 7));

  async function savePayDay(day: number) {
    setPayDay(day);
    setError(null);
    try {
      await api.updateHousehold(household.id, { payDay: day });
      setNotice(`Payday set to the ${ordinal(day)} of each month.`);
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save");
    }
  }

  const links = [
    { href: `${base}/forwarding`, title: "Statements by email", text: "Your forwarding address, Gmail setup and confirmation codes." },
    { href: `${base}/accounts`, title: "Accounts", text: "Bank, card, wallet and cash; their statement senders, CSV imports and balance checks." },
    { href: `${base}/people`, title: "People", text: "Who can see and log money, and who can only look." },
    { href: `${base}/envelopes`, title: "Envelopes", text: "Monthly amounts for the categories you want to watch." },
    { href: `${base}/inbox`, title: "Inbox", text: "Every email and file that has arrived, and what happened to it." },
  ];

  return (
    <>
      <div className="stack" style={{ gap: 4 }}>
        <span className="eyebrow">{household.name}</span>
        <h1>Family</h1>
      </div>
      <div className="hub">
        {links.map((l) => (
          <a key={l.href} className="card" href={l.href} onClick={onLinkClick}>
            <strong className="row between" style={{ flexWrap: "nowrap" }}>
              {l.title} <Icon.next />
            </strong>
            <span className="small muted">{l.text}</span>
          </a>
        ))}
      </div>
      <section className="card stack" aria-labelledby="settings-h">
        <h2 id="settings-h">Household</h2>
        <label style={{ maxWidth: 320 }}>
          Payday, the day salary usually arrives
          <select value={payDay} disabled={!isAdmin} onChange={(e) => savePayDay(Number(e.target.value))}>
            {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>
                {ordinal(d)} of the month
              </option>
            ))}
          </select>
        </label>
        <span className="small muted">Today's "a day" number counts the days until then.</span>
        {notice && <div className="ok">{notice}</div>}
        {error && <div className="error">{error}</div>}
        <div className="row">
          <a className="button secondary" href={api.exportUrl(household.id, from, to)} download>
            Export this month as CSV
          </a>
          <button type="button" className="secondary signout-inline" onClick={onLogout}>
            Sign out
          </button>
        </div>
      </section>
    </>
  );
}

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  return `${n}${s}`;
}

/** Statements by email: the address, how to point Gmail at it, and any confirmation codes waiting. */
export function Forwarding({ household }: { household: Household }) {
  const [rows, setRows] = useState<Statement[] | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const load = () => api.statements(household.id).then(setRows).catch(() => setRows([]));
    void load();
    const t = window.setInterval(load, 15_000);
    return () => window.clearInterval(t);
  }, [household.id]);

  const checks = (rows ?? []).filter((r) => r.status === "forwarding" && r.verifyCode);
  const quarantinedGmail = (rows ?? []).filter((r) => r.status === "quarantined" && /forwarding-noreply@google\.com/i.test(r.fromAddress));

  return (
    <>
      <a className="back" href={`/h/${household.id}/family`} onClick={onLinkClick}>
        <Icon.back /> Family
      </a>
      <div className="stack" style={{ gap: 6 }}>
        <h1>Statements by email</h1>
        <p className="muted" style={{ margin: 0, maxWidth: 640 }}>
          Bank alerts and statements sent here are read into the book and checked against what the family logged. Only the odd ones ask for you in Decide.
        </p>
      </div>

      <section className="card stack" aria-labelledby="addr-h">
        <h2 id="addr-h">Your household's address</h2>
        <div className="row">
          <code className="mono" style={{ fontSize: 15, background: "var(--paper)", padding: "10px 12px", borderRadius: 10, wordBreak: "break-all" }}>
            {household.inboundAddress}
          </code>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              void navigator.clipboard?.writeText(household.inboundAddress);
              setCopied(true);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <span className="small muted">Keep it private: anyone with it can send mail into your inbox, though unknown senders are held back until an admin looks.</span>
      </section>

      {(checks.length > 0 || quarantinedGmail.length > 0) && (
        <section className="card stack" aria-labelledby="codes-h" style={{ borderColor: "var(--marigold)" }}>
          <h2 id="codes-h">Gmail confirmation waiting</h2>
          {checks.map((r) => (
            <div key={r.id} className="stack" style={{ gap: 6 }}>
              <span className="small muted">
                {r.verifyCode?.requester ? `For ${r.verifyCode.requester} · ` : ""}
                {new Date(r.receivedAt).toLocaleString()}
              </span>
              {r.verifyCode?.code && <div className="code">{r.verifyCode.code}</div>}
              {r.verifyCode?.link && (
                <a href={r.verifyCode.link} target="_blank" rel="noopener noreferrer">
                  Or open Gmail's confirmation link
                </a>
              )}
            </div>
          ))}
          {quarantinedGmail.map((r) => (
            <span key={r.id} className="small">
              From before this page knew about Gmail: <span className="mono">{r.subject}</span>
            </span>
          ))}
        </section>
      )}

      <section className="card stack" aria-labelledby="gmail-h">
        <h2 id="gmail-h">Forward from Gmail</h2>
        <ol className="plain" style={{ color: "var(--ink-soft)" }}>
          <li>
            In Gmail on a computer: Settings (the gear) › See all settings › <strong>Forwarding and POP/IMAP</strong> › Add a forwarding address. Paste the address above.
          </li>
          <li>Gmail sends a confirmation code here. It appears on this page and as the first card in Decide within a minute.</li>
          <li>Back in Gmail, type the code next to the address and choose <strong>Verify</strong>. Leave forwarding itself off.</li>
          <li>
            Make a filter instead, so only bank mail is forwarded: search <span className="mono">from:(alerts@yourbank.example)</span>, choose Create filter, tick <strong>Forward it to</strong> and pick the address.
          </li>
          <li>In Family › Accounts, put the bank's sender address on the account, so its mail is read rather than held back.</li>
        </ol>
      </section>

      <section className="card stack" aria-labelledby="other-h">
        <h2 id="other-h">Other mail apps</h2>
        <span className="small" style={{ color: "var(--ink-soft)" }}>
          Outlook and most others forward without a code: add a rule that forwards your bank's emails to the address. Bank CSV exports can also be uploaded on the Accounts page.
        </span>
      </section>
    </>
  );
}
