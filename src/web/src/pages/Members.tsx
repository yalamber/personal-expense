import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type Household, type Member, type Role } from "../api";

export function Members({ household }: { household: Household }) {
  const [rows, setRows] = useState<Member[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [busy, setBusy] = useState(false);
  const isAdmin = household.me.role === "admin";

  const load = useCallback(() => api.members(household.id).then(setRows).catch((e) => setError(String(e))), [household.id]);
  useEffect(() => {
    void load();
  }, [load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.inviteMember(household.id, { email, name, role });
      setEmail("");
      setName("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not invite");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>People</h1>
      {error && <div className="error">{error}</div>}
      <div className="card table-scroll">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows?.map((m) => (
              <tr key={m.id}>
                <td>{m.name}</td>
                <td>{m.email}</td>
                <td>{m.role}</td>
                <td>{m.joinedAt ? <span className="pill teal">joined</span> : <span className="pill grey">invited</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {isAdmin && (
        <form className="card stack" onSubmit={submit}>
          <h2>Invite someone</h2>
          <span className="muted">They sign in with this email and are added automatically. No invitation email is sent yet.</span>
          <div className="row">
            <label style={{ flex: 2 }}>
              Email
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label style={{ flex: 2 }}>
              Name
              <input required value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label style={{ flex: 1 }}>
              Role
              <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
                <option value="admin">Admin</option>
                <option value="member">Member</option>
                <option value="viewer">Viewer</option>
              </select>
            </label>
          </div>
          <div>
            <button type="submit" disabled={busy}>
              {busy ? "Inviting…" : "Invite"}
            </button>
          </div>
        </form>
      )}
    </>
  );
}
