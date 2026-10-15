import { useEffect, useState } from "react";
import { api, type Household, type Me } from "../api";
import { onLinkClick } from "../router";
import { Accounts } from "./Accounts";
import { Inbox } from "./Inbox";
import { Members } from "./Members";

const tabs = [
  { path: "/", label: "Inbox" },
  { path: "/accounts", label: "Accounts" },
  { path: "/members", label: "Members" },
];

export function Shell({ me, householdId, sub, onLogout }: { me: Me; householdId: string; sub: string; onLogout: () => void }) {
  const [household, setHousehold] = useState<Household | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setHousehold(null);
    api
      .household(householdId)
      .then(setHousehold)
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load household"));
  }, [householdId]);

  return (
    <>
      <header className="app">
        <div className="inner">
          <div className="row">
            <strong>{household?.name ?? "Family Money"}</strong>
            <nav aria-label="Main">
              {tabs.map((t) => (
                <a key={t.path} href={`/h/${householdId}${t.path === "/" ? "" : t.path}`} className={sub === t.path ? "active" : ""} onClick={onLinkClick}>
                  {t.label}
                </a>
              ))}
            </nav>
          </div>
          <div className="row">
            <span className="muted">{me.user.email}</span>
            <button type="button" className="secondary" onClick={onLogout}>
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="app">
        {error && <div className="error">{error}</div>}
        {household && sub === "/" && <Inbox household={household} />}
        {household && sub === "/accounts" && <Accounts household={household} />}
        {household && sub === "/members" && <Members household={household} />}
        {household && !tabs.some((t) => t.path === sub) && <div className="muted">Nothing here yet.</div>}
      </main>
    </>
  );
}
