import { useCallback, useEffect, useState } from "react";
import { api, type Account, type Category, type Goal, type Household, type Me, type Member } from "../api";
import { navigate, onLinkClick } from "../router";
import { Icon } from "../ui";
import { Accounts } from "./Accounts";
import { Budgets } from "./Budgets";
import { ContactDetail, Contacts } from "./Contacts";
import { Decide } from "./Decide";
import { Family, Forwarding } from "./Family";
import { GoalDetail } from "./GoalDetail";
import { Inbox } from "./Inbox";
import { Log } from "./Log";
import { Members } from "./Members";
import { NewGoal } from "./NewGoal";
import { Plan } from "./Plan";
import { StartingPoint } from "./StartingPoint";
import { Today } from "./Today";

/** Old addresses from the first version keep working. */
const LEGACY: Record<string, string> = { "/review": "/decide", "/budgets": "/family/envelopes", "/inbox": "/family/inbox", "/accounts": "/family/accounts", "/members": "/family/people" };

type Space = "today" | "plan" | "decide" | "family";

function spaceOf(sub: string): Space {
  if (sub.startsWith("/plan")) return "plan";
  if (sub.startsWith("/decide")) return "decide";
  if (sub.startsWith("/family")) return "family";
  return "today";
}

/**
 * Three spaces instead of seven tabs: Today (how are we doing), Plan (are we getting there),
 * Decide (what needs a call from us), with Family for people and plumbing, and Log on every screen.
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

  const space = spaceOf(sub);
  const base = `/h/${householdId}`;
  const goalMatch = sub.match(/^\/plan\/goals\/([^/]+)$/);
  const contactMatch = sub.match(/^\/family\/contacts\/([^/]+)$/);
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
            <a href={`${base}/decide`} aria-current={tab("decide")} onClick={onLinkClick}>
              Decide {decideCount > 0 && <span className="count">{decideCount}</span>}
            </a>
            <a href={`${base}/family`} aria-current={tab("family")} onClick={onLinkClick}>
              Family
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
        {household && sub === "/family" && <Family household={household} onLogout={onLogout} onChanged={changed} />}
        {household && sub === "/family/forwarding" && <Forwarding household={household} />}
        {household && contactMatch && <ContactDetail household={household} contactId={contactMatch[1]!} categories={categories} onChanged={changed} />}
        {household && sub.startsWith("/family/") && sub !== "/family/forwarding" && !contactMatch && (
          <>
            <a className="back" href={`${base}/family`} onClick={onLinkClick}>
              <Icon.back /> Family
            </a>
            {sub === "/family/start" && <StartingPoint household={household} onChanged={changed} />}
            {sub === "/family/accounts" && <Accounts household={household} />}
            {sub === "/family/contacts" && <Contacts household={household} />}
            {sub === "/family/people" && <Members household={household} />}
            {sub === "/family/envelopes" && <Budgets household={household} />}
            {sub === "/family/inbox" && <Inbox household={household} />}
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
        <a href={`${base}/decide`} aria-current={tab("decide")} onClick={onLinkClick}>
          {decideCount > 0 && <span className="badge">{decideCount}</span>}
          <Icon.decide />
          Decide
        </a>
        <a href={`${base}/family`} aria-current={tab("family")} onClick={onLinkClick}>
          <Icon.family />
          Family
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
