import { useCallback, useEffect, useState } from "react";
import { api, type Account, type Category, type Goal, type Household, type Me, type Member } from "../api";
import { navigate, onLinkClick } from "../router";
import { Icon } from "../ui";
import { Accounts } from "./Accounts";
import { Budgets } from "./Budgets";
import { Khata, KhataPage } from "./Khata";
import { Decide } from "./Decide";
import { Forwarding, Settings } from "./Settings";
import { GoalDetail } from "./GoalDetail";
import { Inbox } from "./Inbox";
import { Log } from "./Log";
import { Members } from "./Members";
import { NetBar } from "./NetBar";
import { NewGoal } from "./NewGoal";
import { Plan } from "./Plan";
import { StartingPoint } from "./StartingPoint";
import { Today } from "./Today";

/** Old addresses from the first version keep working. */
const LEGACY: Record<string, string> = { "/review": "/decide", "/budgets": "/settings/envelopes", "/inbox": "/settings/inbox", "/accounts": "/settings/accounts", "/members": "/settings/people", "/settings/contacts": "/khata" };

type Space = "today" | "plan" | "khata" | "decide" | "settings";

function spaceOf(sub: string): Space {
  if (sub.startsWith("/plan")) return "plan";
  if (sub.startsWith("/khata")) return "khata";
  if (sub.startsWith("/decide")) return "decide";
  if (sub.startsWith("/settings")) return "settings";
  return "today";
}

/**
 * Three spaces instead of seven tabs: Today (how are we doing), Plan (are we getting there),
 * Decide (what needs a call from us), Khata (who owes whom), with Settings for people and plumbing, and Log on every screen.
 */
export function Shell({ me, householdId, sub, onLogout }: { me: Me; householdId: string; sub: string; onLogout: () => void }) {
  const [household, setHousehold] = useState<Household | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [decideCount, setDecideCount] = useState(0);
  const [version, setVersion] = useState(0);
  const [logging, setLogging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (LEGACY[sub]) navigate(`/h/${householdId}${LEGACY[sub]}`);
    else if (sub === "/family" || sub.startsWith("/family/")) navigate(`/h/${householdId}/settings${sub.slice("/family".length)}`);
    else if (sub.startsWith("/settings/contacts/")) navigate(`/h/${householdId}/khata/${sub.slice("/settings/contacts/".length)}`);
  }, [sub, householdId]);

  const loadBasics = useCallback(async () => {
    try {
      const [h, a, c, m, g] = await Promise.all([api.household(householdId), api.accounts(householdId), api.categories(householdId), api.members(householdId), api.goals(householdId)]);
      setHousehold(h);
      setAccounts(a);
      setCategories(c);
      setMembers(m);
      setGoals(g);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the household");
    }
  }, [householdId]);

  useEffect(() => {
    setHousehold(null);
    void loadBasics();
  }, [loadBasics]);

  useEffect(() => {
    api
      .decideCards(householdId)
      .then((cards) => setDecideCount(cards.length))
      .catch(() => undefined);
  }, [householdId, sub, version]);

  const changed = useCallback(() => {
    setVersion((v) => v + 1);
    void loadBasics();
  }, [loadBasics]);

  // Entries that went out from the phone's outbox, or a retry after being offline: read again.
  useEffect(() => {
    window.addEventListener("fm:synced", changed);
    return () => window.removeEventListener("fm:synced", changed);
  }, [changed]);

  const space = spaceOf(sub);
  const base = `/h/${householdId}`;
  const goalMatch = sub.match(/^\/plan\/goals\/([^/]+)$/);
  const contactMatch = sub.match(/^\/khata\/([^/]+)$/);
  const canWrite = household ? household.me.role !== "viewer" : false;
  const tab = (s: Space) => (space === s ? ("page" as const) : undefined);

  return (
    <>
      <header className="topbar">
        <div className="inner">
          <a className="brand" href={base} onClick={onLinkClick}>
            <span className="brand-mark">
              <Icon.home />
            </span>
            <span>{household?.name ?? "Family Money"}</span>
          </a>
          <nav aria-label="Main">
            <a href={base} aria-current={tab("today")} onClick={onLinkClick}>
              Today
            </a>
            <a href={`${base}/plan`} aria-current={tab("plan")} onClick={onLinkClick}>
              Plan
            </a>
            <a href={`${base}/khata`} aria-current={tab("khata")} onClick={onLinkClick}>
              Khata
            </a>
            <a href={`${base}/decide`} aria-current={tab("decide")} onClick={onLinkClick}>
              Decide {decideCount > 0 && <span className="count">{decideCount}</span>}
            </a>
            <a href={`${base}/settings`} aria-current={tab("settings")} onClick={onLinkClick}>
              Settings
            </a>
          </nav>
          <span className="who">{me.user.email}</span>
          {canWrite && (
            <button type="button" className="log-button" onClick={() => setLogging(true)}>
              <Icon.plus /> Log it
            </button>
          )}
          <button type="button" className="quiet signout" onClick={onLogout}>
            Sign out
          </button>
        </div>
      </header>
      <NetBar householdId={householdId} />

      <main className="app">
        {error && <div className="error">{error}</div>}
        {!household && !error && <p className="muted">Opening the book…</p>}
        {household && space === "today" && (
          <Today household={household} accounts={accounts} categories={categories} goals={goals} version={version} onChanged={changed} onLog={() => setLogging(true)} />
        )}
        {household && sub === "/plan" && <Plan household={household} version={version} onChanged={changed} />}
        {household && sub === "/plan/new" && <NewGoal household={household} accounts={accounts} />}
        {household && goalMatch && <GoalDetail household={household} accounts={accounts} goalId={goalMatch[1]!} onChanged={changed} />}
        {household && space === "decide" && <Decide household={household} accounts={accounts} categories={categories} version={version} onChanged={changed} />}
        {household && sub === "/settings" && <Settings household={household} onLogout={onLogout} onChanged={changed} />}
        {household && sub === "/settings/forwarding" && <Forwarding household={household} />}
        {household && sub === "/khata" && <Khata household={household} onChanged={changed} />}
        {household && contactMatch && <KhataPage household={household} contactId={contactMatch[1]!} categories={categories} onChanged={changed} />}
        {household && sub.startsWith("/settings/") && sub !== "/settings/forwarding" && (
          <>
            <a className="back" href={`${base}/settings`} onClick={onLinkClick}>
              <Icon.back /> Settings
            </a>
            {sub === "/settings/start" && <StartingPoint household={household} onChanged={changed} />}
            {sub === "/settings/accounts" && <Accounts household={household} />}
            {sub === "/settings/people" && <Members household={household} />}
            {sub === "/settings/envelopes" && <Budgets household={household} />}
            {sub === "/settings/inbox" && <Inbox household={household} />}
          </>
        )}
      </main>

      <nav className="tabbar" aria-label="Main">
        <a href={base} aria-current={tab("today")} onClick={onLinkClick}>
          <Icon.today />
          Today
        </a>
        <a href={`${base}/plan`} aria-current={tab("plan")} onClick={onLinkClick}>
          <Icon.plan />
          Plan
        </a>
        {canWrite ? (
          <button type="button" className="fab" aria-label="Log money" onClick={() => setLogging(true)}>
            <Icon.plus size={26} />
          </button>
        ) : (
          <span />
        )}
        <a href={`${base}/khata`} aria-current={tab("khata")} onClick={onLinkClick}>
          <Icon.khata />
          Khata
        </a>
        <a href={`${base}/decide`} aria-current={tab("decide")} onClick={onLinkClick}>
          {decideCount > 0 && <span className="badge">{decideCount}</span>}
          <Icon.decide />
          Decide
        </a>
        <a href={`${base}/settings`} aria-current={tab("settings")} onClick={onLinkClick}>
          <Icon.settings />
          Settings
        </a>
      </nav>

      {logging && household && (
        <Log
          household={household}
          accounts={accounts}
          categories={categories}
          members={members}
          goals={goals.filter((g) => !g.completedAt)}
          onClose={() => setLogging(false)}
          onSaved={changed}
        />
      )}
    </>
  );
}
