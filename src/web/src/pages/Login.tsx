import { useState } from "react";
import { api, ApiError } from "../api";

export function Login() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const expired = new URLSearchParams(window.location.search).get("error") === "expired";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.requestMagicLink(email);
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send the link");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth stack">
      <div className="eyebrow">Family Money</div>
      <h1>Sign in</h1>
      {expired && <div className="error">That link has expired or was already used. Request a new one.</div>}
      {sent ? (
        <div className="card stack">
          <strong>Check your inbox.</strong>
          <span className="muted">
            A sign-in link is on its way to {email}. It works for fifteen minutes. In local development the link is printed
            in the Worker log instead.
          </span>
        </div>
      ) : (
        <form className="card stack" onSubmit={submit}>
          <label>
            Email
            <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          {error && <div className="error">{error}</div>}
          <button type="submit" disabled={busy}>
            {busy ? "Sending…" : "Email me a sign-in link"}
          </button>
          <span className="muted">No passwords. The first person to sign in creates the household and invites the rest.</span>
        </form>
      )}
    </main>
  );
}
