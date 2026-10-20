import { useEffect, useState } from "react";
import { api, type Household, type Me } from "../api";
import { onLinkClick } from "../router";
import { Accounts } from "./Accounts";
import { Budgets } from "./Budgets";
import { Inbox } from "./Inbox";
import { Members } from "./Members";
import { Month } from "./Month";
import { Review } from "./Review";

const tabs = [
  { path: "/", label: "Month" },
  { path: "/review", label: "Review" },
  { path: "/budgets", label: "Budgets" },
  { path: "/inbox", label: "Inbox" },
  { path: "/accounts", label: "Accounts" },
  { path: "/members", label: "Members" },
];

export function Shell({ me, householdId, sub, onLogout }: { me: Me; householdId: string; sub: string; onLogout: () => void }) {
  const [household, setHousehold] = useState<Household | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(0);

  const refreshPending = () => {
    api
      .review(householdId)
      .then((l) => setPending(l.length))
      .catch(() => undefined);
  };

  useEffect(refreshPending, [householdId, sub]);

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
                  {t.path === "/review" && pending > 0 && <span className="count">{pending}</span>}
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
        {household && sub === "/" && <Month household={household} />}
        {household && sub === "/review" && <Review household={household} onChanged={refreshPending} />}
        {household && sub === "/budgets" && <Budgets household={household} />}
        {household && sub === "/inbox" && <Inbox household={household} />}
        {household && sub === "/accounts" && <Accounts household={household} />}
        {household && sub === "/members" && <Members household={household} />}
        {household && !tabs.some((t) => t.path === sub) && <div className="muted">Nothing here yet.</div>}
      </main>
    </>
  );
}
