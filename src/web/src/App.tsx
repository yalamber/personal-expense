import { useCallback, useEffect, useState } from "react";
import { api, ApiError, paths, type Me } from "./api";
import { clearOutbox, getOfflineState } from "./offline";
import { clearQueries, seed, setCached } from "./query";
import { AppSkeleton } from "./skeleton";
import { Login } from "./pages/Login";
import { NewHousehold } from "./pages/NewHousehold";
import { Shell } from "./pages/Shell";
import { navigate, usePath } from "./router";

type Session = { state: "loading" } | { state: "anonymous" } | { state: "ready"; me: Me };

export function App() {
  const path = usePath();
  const [session, setSession] = useState<Session>({ state: "loading" });

  const reload = useCallback(async () => {
    // What the phone knows opens the app at once; the network then confirms or signs out.
    const known = await seed<Me>(paths.me);
    if (known) setSession({ state: "ready", me: known });
    try {
      const me = await api.me();
      setCached(paths.me, me);
      setSession({ state: "ready", me });
    } catch (err) {
      if (!known || (err instanceof ApiError && err.status === 401)) setSession({ state: "anonymous" });
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (session.state === "loading") return <AppSkeleton />;

  if (session.state === "anonymous") {
    return <Login />;
  }

  const { me } = session;
  const first = me.households[0];

  if (path.startsWith("/households/new") || !first) {
    return (
      <NewHousehold
        me={me}
        onCreated={async (id) => {
          await reload();
          navigate(`/h/${id}`);
        }}
      />
    );
  }

  const match = path.match(/^\/h\/([^/]+)(\/.*)?$/);
  const householdId = match?.[1] ?? first.householdId;
  const sub = match?.[2] ?? "/";
  // The home-screen shortcuts land on "/" with a hint of where to go.
  const hint = new URLSearchParams(window.location.search);
  if (hint.get("go") === "khata") navigate(`/h/${householdId}/khata`);
  else if (!match) navigate(`/h/${householdId}${window.location.search}`);

  return (
    <Shell
      me={me}
      householdId={householdId}
      sub={sub}
      onLogout={async () => {
        const waiting = getOfflineState().items.length;
        if (waiting && !window.confirm(`${waiting} ${waiting === 1 ? "entry" : "entries"} on this phone ${waiting === 1 ? "has" : "have"} not reached the book yet. Sign out anyway and lose ${waiting === 1 ? "it" : "them"}?`)) return;
        try {
          await api.logout();
        } catch (err) {
          if (err instanceof ApiError && err.status === 0) {
            window.alert("You're offline. Sign out once you're back online.");
            return;
          }
        }
        clearOutbox();
        clearQueries();
        navigator.serviceWorker?.controller?.postMessage({ type: "clear-api" });
        setSession({ state: "anonymous" });
        navigate("/");
      }}
    />
  );
}
