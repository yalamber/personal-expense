import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type Me } from "./api";
import { Login } from "./pages/Login";
import { NewHousehold } from "./pages/NewHousehold";
import { Shell } from "./pages/Shell";
import { navigate, usePath } from "./router";

type Session = { state: "loading" } | { state: "anonymous" } | { state: "ready"; me: Me };

export function App() {
  const path = usePath();
  const [session, setSession] = useState<Session>({ state: "loading" });

  const reload = useCallback(async () => {
    try {
      const me = await api.me();
      setSession({ state: "ready", me });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setSession({ state: "anonymous" });
      else setSession({ state: "anonymous" });
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (session.state === "loading") return <main className="auth muted">Loading…</main>;

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
  if (!match) navigate(`/h/${householdId}`);

  return (
    <Shell
      me={me}
      householdId={householdId}
      sub={sub}
      onLogout={async () => {
        await api.logout();
        setSession({ state: "anonymous" });
        navigate("/");
      }}
    />
  );
}
