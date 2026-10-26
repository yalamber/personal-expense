import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type Household, type Statement, type StatementStatus } from "../api";
import { PageSkeleton } from "../skeleton";
import { FillByHand, LinkAccount, MailDetails, MailSkeleton, ReadyToAdd, WhyHeld, filledMessage, useMailPreview, when } from "./MailView";

/** What each status means to the family, and whether it waits on them. */
const STATUS: Record<StatementStatus, { label: string; tone: "amber" | "teal" | "grey"; waits: boolean }> = {
  quarantined: { label: "needs an account", tone: "amber", waits: true },
  unparsed: { label: "not read", tone: "grey", waits: false },
  failed: { label: "could not read", tone: "amber", waits: false },
  received: { label: "reading", tone: "grey", waits: false },
  review: { label: "lines in Decide", tone: "amber", waits: true },
  parsed: { label: "in the book", tone: "teal", waits: false },
  done: { label: "done", tone: "teal", waits: false },
  forwarding: { label: "forwarding code", tone: "amber", waits: true },
};

/**
 * Settings › Inbox: every email that arrived at the statements address, newest first. Open one to
 * see where it came from, what the app read from it and the email itself; one from a new sender
 * can be linked to its account right here.
 */
export function Inbox({ household }: { household: Household }) {
  const [rows, setRows] = useState<Statement[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await api.statements(household.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the inbox");
    }
  }, [household.id]);

  useEffect(() => {
    void load();
    const t = window.setInterval(load, 15_000);
    return () => window.clearInterval(t);
  }, [load]);

  const waiting = (rows ?? []).filter((r) => STATUS[r.status].waits);

  return (
    <>
      <div className="stack" style={{ gap: 6 }}>
        <h1>Inbox</h1>
        <span className="muted">Every email that arrived at your statements address. Open one to see where it came from, what the app read, and the email itself.</span>
        <div className="row" style={{ gap: 8 }}>
          <span className="mono small" style={{ overflowWrap: "anywhere" }}>{household.inboundAddress}</span>
          <button
            type="button"
            className="link small"
            onClick={() => {
              void navigator.clipboard?.writeText(household.inboundAddress);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {!rows && !error && <PageSkeleton kind="list" />}

      {rows && rows.length === 0 && (
        <div className="card stack">
          <strong>Nothing has arrived yet.</strong>
          <span className="muted">
            Add the bank's sender address to the account in Accounts, then forward one alert email to the address above. Mail from a sender no account lists waits here and in Decide
            until an admin says which account it is about.
          </span>
        </div>
      )}

      {rows && rows.length > 0 && (
        <section className="card" aria-label="Emails" style={{ paddingTop: 6, paddingBottom: 6 }}>
          {waiting.length > 0 && (
            <div className="small" style={{ padding: "8px 6px", color: "var(--marigold-deep)" }}>
              {waiting.length} {waiting.length === 1 ? "email waits" : "emails wait"} on you.
            </div>
          )}
          <div className="mail-list">
            {rows.map((st) => {
              const s = STATUS[st.status];
              const isOpen = open === st.id;
              return (
                <div key={st.id}>
                  <button type="button" className="mail-row" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : st.id)}>
                    <span className={`mail-dot ${s.tone}`} aria-hidden="true" />
                    <span className="what">
                      <strong>{st.subject ?? "(no subject)"}</strong>
                      <span className="small muted">
                        {st.fromAddress} · {when(st.receivedAt)}
                      </span>
                    </span>
                    <span className="end">
                      <span className={`pill ${s.tone}`}>{s.label}</span>
                      <span className="small muted">{st.accountName ?? (st.status === "quarantined" ? "no account yet" : "")}</span>
                    </span>
                  </button>
                  {isOpen && <InboxDetail household={household} statement={st} onChanged={load} />}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </>
  );
}

function InboxDetail({ household, statement: st, onChanged }: { household: Household; statement: Statement; onChanged: () => void }) {
  const { data, error, reload } = useMailPreview(household.id, st.id);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const isAdmin = household.me.role === "admin";
  const unread = (st.status === "unparsed" || st.status === "failed") && Boolean(st.accountId) && household.me.role !== "viewer" && !done;

  async function run<T>(fn: () => Promise<T>, message: string | ((result: T) => string)) {
    setBusy(true);
    setFailure(null);
    try {
      const result = await fn();
      setDone(typeof message === "function" ? message(result) : message);
      onChanged();
      void reload();
    } catch (e) {
      setFailure(e instanceof ApiError ? e.message : "Could not do that");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mail-open">
      {error && <div className="error small">{error}</div>}
      {!data && !error && <MailSkeleton />}
      {data && (
        <>
          {st.error && st.status !== "quarantined" && st.status !== "unparsed" && (
            <div className="why" role="note">
              {st.error}
            </div>
          )}
          {st.verifyCode?.code && (
            <div className="why calm" role="note">
              Gmail's confirmation code: <strong className="mono">{st.verifyCode.code}</strong>
            </div>
          )}
          {st.status === "quarantined" && !done && <WhyHeld preview={data} />}
          <MailDetails preview={data} household={household} open={st.status === "quarantined"} />
          {done && <div className="ok small">{done}</div>}
          {failure && <div className="error small">{failure}</div>}
          {st.status === "quarantined" && !done ? (
            <LinkAccount
              household={household}
              preview={data}
              busy={busy}
              onLink={(accountId, name, remember) => run(() => api.releaseStatement(household.id, st.id, accountId, remember), `Reading it for ${name}. Any lines it finds wait in Decide.`)}
              onDismiss={() => run(() => api.dismissStatement(household.id, st.id), "Set aside: not a statement.")}
            />
          ) : (
            <div className="row" style={{ gap: 12 }}>
              {unread && !data.reading.lines.length && (
                <button type="button" className="secondary" disabled={busy} onClick={() => run(() => api.rereadStatement(household.id, st.id), "Reading it again, with the AI reader if the others find nothing. Any lines it finds wait in Decide.")}>
                  Read it again
                </button>
              )}
              {isAdmin && (
                <a className="small" href={api.rawStatementUrl(household.id, st.id)} download>
                  Download the original email (.eml)
                </a>
              )}
            </div>
          )}
          {unread && !data.missing && data.reading.lines.length > 0 && !changing && (
            <ReadyToAdd
              household={household}
              preview={data}
              busy={busy}
              onAdd={() => run(() => api.rereadStatement(household.id, st.id), "Added. It waits in Decide with a suggested category: file it there, or leave it out.")}
              onChange={() => setChanging(true)}
              onDismiss={() => run(() => api.dismissStatement(household.id, st.id), "Set aside: not a payment.")}
            />
          )}
          {unread && !data.missing && (!data.reading.lines.length || changing) && (
            <FillByHand
              household={household}
              preview={data}
              busy={busy}
              onSubmit={(body) => void run(() => api.fillStatement(household.id, st.id, body), filledMessage)}
              onDismiss={() => run(() => api.dismissStatement(household.id, st.id), "Set aside: not a payment.")}
            />
          )}
        </>
      )}
    </div>
  );
}
