import { useCallback, useEffect, useState } from "react";
import { paths, type Account, type Category, type DecideCard, type Goal, type Household, type Me, type Member } from "../api";
import { useUpdate } from "../pwa";
import { useQuery } from "../query";
import { PageSkeleton } from "../skeleton";
import { navigate, onLinkClick } from "../router";
import { Icon } from "../ui";
import { Accounts } from "./Accounts";
import { Budgets } from "./Budgets";
import { Khata, KhataPage } from "./Khata";
import { Decide } from "./Decide";
import { EveryMonth } from "./EveryMonth";
import { AppSettings, Forwarding, HouseholdSettings, SettingsLayout, sectionOf, useNarrow } from "./Settings";
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
  const [version, setVersion] = useState(0);
  const [logging, setLogging] = useState(false);
  // What every page shares, from the cache first and then fresh; a bump of `version` rereads it all.
  const hq = useQuery<Household>(paths.household(householdId), [version]);
  const aq = useQuery<Account[]>(paths.accounts(householdId), [version]);
  const cq = useQuery<Category[]>(paths.categories(householdId), [version]);
  const mq = useQuery<Member[]>(paths.members(householdId), [version]);
  const gq = useQuery<Goal[]>(paths.goals(householdId), [version]);
  const dq = useQuery<DecideCard[]>(paths.decide(householdId), [version, sub]);
  const household = hq.data ?? null;
  const accounts = aq.data ?? [];
  const categories = cq.data ?? [];
  const members = mq.data ?? [];
  const goals = gq.data ?? [];
  const decideCount = dq.data?.length ?? 0;
  const error = hq.error;
  const update = useUpdate();
  // Settings: a menu beside the section on a wide screen; on a phone the menu is its own page.
  const narrow = useNarrow();
  const section = spaceOf(sub) === "settings" ? (sectionOf(sub) ?? (narrow ? null : "household")) : null;

  // The "Log money" shortcut on the home screen opens the sheet straight away.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("log") === "1") {
      setLogging(true);
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  useEffect(() => {
    if (LEGACY[sub]) navigate(`/h/${householdId}${LEGACY[sub]}`);
    else if (sub === "/family" || sub.startsWith("/family/")) navigate(`/h/${householdId}/settings${sub.slice("/family".length)}`);
    else if (sub.startsWith("/settings/contacts/")) navigate(`/h/${householdId}/khata/${sub.slice("/settings/contacts/".length)}`);
  }, [sub, householdId]);

  const changed = useCallback(() => setVersion((v) => v + 1), []);

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
      {update.ready && (
        <div className="netbar" role="status">
          <span>A new version of the app is ready.</span>
          <button type="button" className="link" onClick={update.reload}>
            Reload
          </button>
        </div>
      )}

      <main className="app">
        {error && <div className="error">{error}</div>}
        {!household && !error && <PageSkeleton kind={space} />}
        {household && space === "today" && (
          <Today household={household} accounts={accounts} categories={categories} goals={goals} version={version} onChanged={changed} onLog={() => setLogging(true)} />
        )}
        {household && sub === "/plan" && <Plan household={household} version={version} onChanged={changed} />}
        {household && sub === "/plan/new" && <NewGoal household={household} accounts={accounts} />}
        {household && goalMatch && <GoalDetail household={household} accounts={accounts} goalId={goalMatch[1]!} onChanged={changed} />}
        {household && space === "decide" && <Decide household={household} accounts={accounts} categories={categories} version={version} onChanged={changed} />}
        {household && space === "settings" && (
          <SettingsLayout household={household} section={section} narrow={narrow}>
            {section === "household" && <HouseholdSettings household={household} onLogout={onLogout} onChanged={changed} />}
            {section === "people" && <Members household={household} />}
            {section === "start" && <StartingPoint household={household} onChanged={changed} />}
            {section === "accounts" && <Accounts household={household} version={version} onChanged={changed} />}
            {section === "every-month" && <EveryMonth household={household} accounts={accounts} categories={categories} version={version} onChanged={changed} />}
            {section === "envelopes" && <Budgets household={household} />}
            {section === "forwarding" && <Forwarding household={household} />}
            {section === "inbox" && <Inbox household={household} />}
            {section === "app" && <AppSettings />}
          </SettingsLayout>
        )}
        {household && sub === "/khata" && <Khata household={household} version={version} onChanged={changed} />}
        {household && contactMatch && <KhataPage household={household} contactId={contactMatch[1]!} categories={categories} version={version} onChanged={changed} />}
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
