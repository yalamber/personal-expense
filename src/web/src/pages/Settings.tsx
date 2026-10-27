import { useEffect, useState, type ReactNode } from "react";
import { monthRange, todayIn } from "../../../shared/dates";
import { api, ApiError, type Household, type Member, type Statement } from "../api";
import { onLinkClick } from "../router";
import { useInstall } from "../pwa";
import { Icon } from "../ui";
import { Inbox } from "./Inbox";

/**
 * Settings: the people, the accounts and the plumbing that keeps the book filling itself. Six
 * entries, each a thing a family would name; the pages reached from inside one (the people, the
 * starting point, the inbox) stay under it rather than crowding the menu. On a wide screen the
 * menu sits on the left with the chosen section beside it; on a phone the menu is the page, and
 * each section opens with a way back.
 */

export type SettingsSection = "household" | "people" | "accounts" | "start" | "every-month" | "envelopes" | "statements" | "inbox" | "app";

export const SETTINGS_MENU: { id: SettingsSection; title: string; text: string; children?: { id: SettingsSection; title: string }[] }[] = [
  { id: "household", title: "Household", text: "Payday, the people, AI help, your data", children: [{ id: "people", title: "People" }] },
  { id: "accounts", title: "Accounts", text: "Bank, savings, FDs, loans and cards, and where the book starts", children: [{ id: "start", title: "Starting point" }] },
  { id: "every-month", title: "Every month", text: "Rent, fees and the salary, as they come and go" },
  { id: "envelopes", title: "Envelopes", text: "A monthly limit for the categories you watch" },
  { id: "statements", title: "Statements", text: "The address banks write to, and every email that arrived", children: [{ id: "inbox", title: "Inbox" }] },
  { id: "app", title: "The app", text: "On the home screen, without a signal, updates" },
];

const SECTIONS = new Set<string>(SETTINGS_MENU.flatMap((i) => [i.id, ...(i.children ?? []).map((c) => c.id)]));
/** The menu entry a section sits under: itself, or its parent for a page reached from inside one. */
const PARENT: Partial<Record<SettingsSection, SettingsSection>> = Object.fromEntries(SETTINGS_MENU.flatMap((i) => (i.children ?? []).map((c) => [c.id, i.id])));

/** The section a /settings path points at, or null for the menu itself. */
export function sectionOf(sub: string): SettingsSection | null {
  const rest = sub.startsWith("/settings/") ? sub.slice("/settings/".length) : "";
  return SECTIONS.has(rest) ? (rest as SettingsSection) : null;
}

/** True on a phone-sized screen, where the menu and a section cannot share the width. */
export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 760px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 760px)");
    const fn = () => setNarrow(mq.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);
  return narrow;
}

export function SettingsLayout({ household, section, narrow, children }: { household: Household; section: SettingsSection | null; narrow: boolean; children: ReactNode }) {
  const base = `/h/${household.id}/settings`;
  const parent = section ? PARENT[section] : undefined;
  const entry = (id: SettingsSection | undefined) => SETTINGS_MENU.find((i) => i.id === id);
  if (narrow && !section) {
    return (
      <>
        <div className="stack" style={{ gap: 4 }}>
          <span className="eyebrow">{household.name}</span>
          <h1>Settings</h1>
        </div>
        <section className="card settings-menu" aria-label="Settings sections">
          {SETTINGS_MENU.map((i) => (
            <a key={i.id} href={`${base}/${i.id}`} onClick={onLinkClick}>
              <span className="stack" style={{ gap: 1, minWidth: 0 }}>
                <strong>{i.title}</strong>
                <span className="small muted">{i.text}</span>
              </span>
              <Icon.next />
            </a>
          ))}
        </section>
      </>
    );
  }
  if (narrow) {
    // A page reached from inside a section goes back to that section, not to the menu.
    return (
      <>
        <a className="back" href={parent ? `${base}/${parent}` : base} onClick={onLinkClick}>
          <Icon.back /> {parent ? entry(parent)?.title : "Settings"}
        </a>
        {children}
      </>
    );
  }
  return (
    <div className="settings">
      <nav className="settings-nav" aria-label="Settings sections">
        {SETTINGS_MENU.map((i) => {
          const open = section === i.id || parent === i.id;
          return (
            <div key={i.id} className="group">
              <a href={`${base}/${i.id}`} aria-current={section === i.id ? "page" : undefined} onClick={onLinkClick}>
                {i.title}
              </a>
              {open &&
                (i.children ?? []).map((c) => (
                  <a key={c.id} className="child" href={`${base}/${c.id}`} aria-current={section === c.id ? "page" : undefined} onClick={onLinkClick}>
                    {c.title}
                  </a>
                ))}
            </div>
          );
        })}
      </nav>
      <div className="settings-body">{children}</div>
    </div>
  );
}

/** Who is in the household, in a line each, with the page that changes it. */
function PeopleCard({ household }: { household: Household }) {
  const [rows, setRows] = useState<Member[] | null>(null);
  useEffect(() => {
    api.members(household.id).then(setRows).catch(() => setRows([]));
  }, [household.id]);
  return (
    <section className="card stack" aria-labelledby="people-h" style={{ gap: 8 }}>
      <div className="row between">
        <h2 id="people-h">People</h2>
        <a className="small" href={`/h/${household.id}/settings/people`} onClick={onLinkClick}>
          {household.me.role === "admin" ? "Invite or change roles" : "All people"}
        </a>
      </div>
      {rows === null && <span className="small muted">…</span>}
      {rows?.map((m) => (
        <div key={m.id} className="kv small">
          <span>
            <strong>{m.name}</strong>
            {m.id === household.me.id ? " (you)" : ""}
          </span>
          <span className="muted">
            {m.role}
            {m.joinedAt ? "" : " · invited"}
          </span>
        </div>
      ))}
      <span className="small muted">Admins change settings and link emails; members log money; viewers only look.</span>
    </section>
  );
}

/** The household itself: payday, the data, signing out. */
export function HouseholdSettings({ household, onLogout, onChanged }: { household: Household; onLogout: () => void; onChanged: () => void }) {
  const isAdmin = household.me.role === "admin";
  const [payDay, setPayDay] = useState(household.monthStartDay);
  const [aiOn, setAiOn] = useState(household.aiEnabled !== false);
  const [aiNote, setAiNote] = useState<string | null>(null);
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

  async function saveAi(on: boolean) {
    setAiOn(on);
    setAiNote(null);
    try {
      await api.updateHousehold(household.id, { aiEnabled: on });
      setAiNote(on ? "AI help is on." : "AI help is off. Emails are read by the built-in readers alone.");
      onChanged();
    } catch (e) {
      setAiOn(!on);
      setAiNote(e instanceof ApiError ? e.message : "Could not save");
    }
  }

  return (
    <>
      <div className="stack" style={{ gap: 4 }}>
        <span className="eyebrow">Household</span>
        <h1>{household.name}</h1>
        <span className="muted">
          {household.currency} · {household.timezone} · you are {household.me.name}, {household.me.role === "admin" ? "an admin" : household.me.role === "member" ? "a member" : "a viewer"}
        </span>
      </div>
      <section className="card stack" aria-labelledby="pay-h">
        <h2 id="pay-h">Payday</h2>
        <label style={{ maxWidth: 320 }}>
          The day salary usually arrives
          <select value={payDay} disabled={!isAdmin} onChange={(e) => savePayDay(Number(e.target.value))}>
            {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>
                {ordinal(d)} of the month
              </option>
            ))}
          </select>
        </label>
        <span className="small muted">Today's "a day" number counts the days until then.{isAdmin ? "" : " Only an admin can change it."}</span>
        {notice && <div className="ok">{notice}</div>}
        {error && <div className="error">{error}</div>}
      </section>
      <PeopleCard household={household} />
      <section className="card stack" aria-labelledby="ai-h">
        <h2 id="ai-h">AI help</h2>
        <label className="check">
          <input type="checkbox" checked={aiOn} disabled={!isAdmin || household.aiAvailable === false} onChange={(e) => saveAi(e.target.checked)} />
          <span>Read bank emails the app's own readers can't, and suggest a category for new payments</span>
        </label>
        <span className="small muted">
          The email's text goes to an AI model on Cloudflare, where the app already runs; Cloudflare keeps no copy and does not train on it. Every payment it reads, and every category it
          suggests, waits in Decide for you to check. Once you file a name, the app remembers it without asking the AI again.
          {household.aiAvailable === false ? " This copy of the app has no AI set up." : isAdmin ? "" : " Only an admin can change it."}
        </span>
        {aiNote && <div className="ok">{aiNote}</div>}
      </section>
      <section className="card stack" aria-labelledby="data-h">
        <h2 id="data-h">Your data</h2>
        <span className="small muted">A CSV of this month's book, for a spreadsheet or for safekeeping.</span>
        <div className="row">
          <a className="button secondary" href={api.exportUrl(household.id, from, to)} download>
            Export this month as CSV
          </a>
        </div>
      </section>
      <section className="card stack" aria-labelledby="out-h">
        <h2 id="out-h">Signing out</h2>
        <span className="small muted">Signing out clears what this phone keeps of the book. Entries not yet synced would be lost, so the app asks first.</span>
        <div className="row">
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

/** The app on this phone: the home screen, no signal, updates. */
export function AppSettings() {
  const { canInstall, standalone, ios, install } = useInstall();
  const [checked, setChecked] = useState<string | null>(null);

  async function checkForUpdate() {
    setChecked("Checking…");
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      await reg?.update();
      setChecked("Checked. When a new version is found, a bar at the top offers a reload.");
    } catch {
      setChecked("Could not check right now.");
    }
  }

  return (
    <>
      <div className="stack" style={{ gap: 4 }}>
        <span className="eyebrow">This phone</span>
        <h1>The app</h1>
      </div>
      <section className="card stack" aria-labelledby="install-h">
        <h2 id="install-h">On the home screen</h2>
        {standalone ? (
          <span className="ok">Installed. It opens full screen from the home screen.</span>
        ) : (
          <>
            <span className="small muted">Installed, the app opens from the home screen like any other, full screen, and works without a signal.</span>
            {canInstall ? (
              <div>
                <button type="button" onClick={() => void install()}>
                  Add to Home Screen
                </button>
              </div>
            ) : ios ? (
              <span className="small">
                In Safari, tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>.
              </span>
            ) : (
              <span className="small">
                In your browser's menu, choose <strong>Install app</strong> or <strong>Add to Home Screen</strong>.
              </span>
            )}
          </>
        )}
      </section>
      <section className="card stack" aria-labelledby="offline-h">
        <h2 id="offline-h">Without a signal</h2>
        <span className="small muted">
          The app keeps the last figures it saw and opens with them. Money logged, moved or paid while offline waits on this phone and goes into the book when the
          connection returns; the bar under the header says what is happening.
        </span>
      </section>
      <section className="card stack" aria-labelledby="update-h">
        <h2 id="update-h">Updates</h2>
        <span className="small muted">New versions arrive on their own when the app is opened with a connection. A bar at the top offers a reload when one is ready.</span>
        <div className="row" style={{ alignItems: "center" }}>
          <button type="button" className="secondary" onClick={() => void checkForUpdate()}>
            Check now
          </button>
          {checked && <span className="small muted">{checked}</span>}
        </div>
      </section>
    </>
  );
}

/** Statements: the address banks write to, how to point Gmail at it, any confirmation codes waiting, and what has arrived. */
export function Statements({ household }: { household: Household }) {
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
      <div className="stack" style={{ gap: 6 }}>
        <span className="eyebrow">{household.name}</span>
        <h1>Statements</h1>
        <p className="muted" style={{ margin: 0, maxWidth: 640 }}>
          Bank alerts and statements sent to this address are read into the book and checked against what the family logged. Only the odd ones ask for you in Decide.
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
          <li>In Settings › Accounts, put the bank's sender address on the account, so its mail is read rather than held back.</li>
        </ol>
      </section>

      <section className="card stack" aria-labelledby="other-h">
        <h2 id="other-h">Other mail apps</h2>
        <span className="small" style={{ color: "var(--ink-soft)" }}>
          Outlook and most others forward without a code: add a rule that forwards your bank's emails to the address. Bank CSV exports can also be uploaded on the Accounts page.
        </span>
      </section>

      <Inbox household={household} embedded limit={6} />
    </>
  );
}
