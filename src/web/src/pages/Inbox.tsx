import { useCallback, useEffect, useState } from "react";
import { api, type Account, type Household, type Statement, type StatementStatus } from "../api";

const statusPill: Record<StatementStatus, { label: string; tone: string }> = {
  received: { label: "queued", tone: "grey" },
  quarantined: { label: "quarantined", tone: "amber" },
  unparsed: { label: "no parser yet", tone: "grey" },
  parsed: { label: "parsed", tone: "teal" },
  review: { label: "needs review", tone: "amber" },
  done: { label: "done", tone: "teal" },
  failed: { label: "failed", tone: "amber" },
  forwarding: { label: "forwarding check", tone: "amber" },
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function Inbox({ household }: { household: Household }) {
  const [rows, setRows] = useState<Statement[] | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [error, setError] = useState<string | null>(null);
  const isAdmin = household.me.role === "admin";

  const load = useCallback(async () => {
    try {
      const [s, a] = await Promise.all([api.statements(household.id), api.accounts(household.id)]);
      setRows(s);
      setAccounts(a);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the inbox");
    }
  }, [household.id]);

  useEffect(() => {
    void load();
    const t = window.setInterval(load, 15_000);
    return () => window.clearInterval(t);
  }, [load]);

  async function release(st: Statement, accountId: string) {
    try {
      await api.releaseStatement(household.id, st.id, accountId || null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not release the email");
    }
  }

  return (
    <>
      <div className="stack" style={{ gap: 4 }}>
        <h1>Inbox</h1>
        <div className="muted">
          Forward bank emails to <span className="mono">{household.inboundAddress}</span>. They show up here within a minute.
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {rows && rows.length === 0 && (
        <div className="card stack">
          <strong>Nothing has arrived yet.</strong>
          <span className="muted">
            Add an account with the bank's sender address first, then forward one statement or alert email to the address above.
            Mail from senders not on any account's list lands here as quarantined so an admin can decide.
          </span>
        </div>
      )}

      {rows && rows.length > 0 && (
        <div className="card table-scroll">
          <table>
            <thead>
              <tr>
                <th>Received</th>
                <th>From</th>
                <th>Subject</th>
                <th>Account</th>
                <th>Attachments</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((st) => {
                const pill = statusPill[st.status];
                return (
                  <tr key={st.id}>
                    <td className="mono" style={{ whiteSpace: "nowrap" }}>
                      {new Date(st.receivedAt).toLocaleString()}
                    </td>
                    <td>{st.fromAddress}</td>
                    <td>
                      {st.subject ?? <span className="muted">(no subject)</span>}
                      <div className="muted mono">{formatBytes(st.rawSize)}</div>
                    </td>
                    <td>
                      {st.accountName ?? <span className="muted">none</span>}
                      {st.status === "quarantined" && isAdmin && accounts.length > 0 && (
                        <div className="row" style={{ marginTop: 6 }}>
                          <select aria-label="Attach to account" defaultValue="" onChange={(e) => e.target.value && release(st, e.target.value)}>
                            <option value="">Attach and process…</option>
                            {accounts.filter((a) => ["checking", "savings", "credit", "wallet"].includes(a.type) && !a.closedAt).map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.name}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                    </td>
                    <td>
                      {st.attachments.length === 0 ? (
                        <span className="muted">—</span>
                      ) : (
                        st.attachments.map((a) => (
                          <div key={a.filename} className="mono">
                            {a.filename} <span className="muted">{formatBytes(a.size)}</span>
                          </div>
                        ))
                      )}
                    </td>
                    <td>
                      <span className={`pill ${pill.tone}`}>{pill.label}</span>
                      {st.error && <div className="muted" style={{ marginTop: 4, fontSize: 13 }}>{st.error}</div>}
                      {st.verifyCode?.code && <div className="mono" style={{ marginTop: 4, fontSize: 13 }}>code {st.verifyCode.code}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
