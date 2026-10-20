import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type Account, type Household } from "../api";
import { CsvImport } from "./CsvImport";

export function Accounts({ household }: { household: Household }) {
  const [rows, setRows] = useState<Account[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [type, setType] = useState<Account["type"]>("checking");
  const [pattern, setPattern] = useState("");
  const [isShared, setIsShared] = useState(true);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState<Account | null>(null);
  const canWrite = household.me.role !== "viewer";

  const load = useCallback(() => api.accounts(household.id).then(setRows).catch((e) => setError(String(e))), [household.id]);
  useEffect(() => {
    void load();
  }, [load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createAccount(household.id, { name, type, statementSenderPattern: pattern, isShared });
      setName("");
      setPattern("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add the account");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Accounts</h1>
      {error && <div className="error">{error}</div>}
      <div className="card table-scroll">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Shared</th>
              <th>Statement senders</th>
              <th>CSV format</th>
              {canWrite && <th />}
            </tr>
          </thead>
          <tbody>
            {rows?.map((a) => (
              <tr key={a.id}>
                <td>{a.name}</td>
                <td>{a.type}</td>
                <td>{a.isShared ? "yes" : "personal"}</td>
                <td className="mono">{a.statementSenderPattern ?? <span className="muted">none, mail will be quarantined</span>}</td>
                <td className="muted">{a.csvMapping ? "mapped" : "not mapped yet"}</td>
                {canWrite && (
                  <td>
                    <button type="button" className="secondary" onClick={() => setImporting(a)}>
                      Import CSV
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {rows?.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No accounts yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {importing && (
        <CsvImport
          household={household}
          account={importing}
          onCancel={() => setImporting(null)}
          onDone={() => {
            setImporting(null);
            void load();
          }}
        />
      )}

      {canWrite && !importing && (
        <form className="card stack" onSubmit={submit}>
          <h2>Add an account</h2>
          <div className="row">
            <label style={{ flex: 2 }}>
              Name
              <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Joint checking" />
            </label>
            <label style={{ flex: 1 }}>
              Type
              <select value={type} onChange={(e) => setType(e.target.value as Account["type"])}>
                <option value="checking">Checking</option>
                <option value="credit">Credit card</option>
                <option value="savings">Savings</option>
                <option value="cash">Cash</option>
              </select>
            </label>
          </div>
          <label>
            Statement sender addresses
            <input
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              placeholder="alerts@bank.example, @statements.bank.example"
            />
            <span className="muted" style={{ fontWeight: 400 }}>
              Comma separated. A full address matches exactly; an entry starting with @ matches that domain and its subdomains.
            </span>
          </label>
          <label className="row" style={{ flexDirection: "row" }}>
            <input type="checkbox" checked={isShared} onChange={(e) => setIsShared(e.target.checked)} style={{ minHeight: 0 }} />
            Shared household account
          </label>
          <div>
            <button type="submit" disabled={busy}>
              {busy ? "Adding…" : "Add account"}
            </button>
          </div>
        </form>
      )}
    </>
  );
}
