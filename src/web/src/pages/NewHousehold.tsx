import { useState } from "react";
import { api, ApiError, type Me } from "../api";

export function NewHousehold({ me, onCreated }: { me: Me; onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [memberName, setMemberName] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { id } = await api.createHousehold({ name, currency, timezone, memberName });
      onCreated(id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the household");
      setBusy(false);
    }
  }

  return (
    <main className="auth stack">
      <div className="eyebrow">Signed in as {me.user.email}</div>
      <h1>Set up your household</h1>
      <form className="card stack" onSubmit={submit}>
        <label>
          Household name
          <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="The Smiths" />
        </label>
        <label>
          Your name
          <input required value={memberName} onChange={(e) => setMemberName(e.target.value)} />
        </label>
        <div className="row">
          <label style={{ flex: 1 }}>
            Currency
            <input required maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
          </label>
          <label style={{ flex: 2 }}>
            Time zone
            <input required value={timezone} onChange={(e) => setTimezone(e.target.value)} />
          </label>
        </div>
        {error && <div className="error">{error}</div>}
        <button type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create household"}
        </button>
      </form>
    </main>
  );
}
