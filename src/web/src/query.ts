/**
 * The page cache: every read is remembered, so a page that was on screen a moment ago paints at
 * once from memory and then refreshes quietly. On a cold start the phone's store (kept by the
 * service worker) seeds the first paint the same way. One request serves every reader of a path.
 */
import { useEffect, useState } from "react";
import { get } from "./api";

type Entry = { data: unknown; at: number; fromStore: boolean };

const memory = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();
const listeners = new Map<string, Set<() => void>>();
const API_CACHE = "api-v1";

function notify(path: string) {
  for (const fn of listeners.get(path) ?? []) fn();
}

export function setCached<T>(path: string, data: T, fromStore = false) {
  memory.set(path, { data, at: Date.now(), fromStore });
  notify(path);
}

export function peek<T>(path: string): T | undefined {
  return memory.get(path)?.data as T | undefined;
}

/** Forgets everything (sign-out). */
export function clearQueries() {
  const paths = [...memory.keys()];
  memory.clear();
  for (const p of paths) notify(p);
}

/** The service worker's copy of a read, if it has one, as the first thing on screen. */
export async function seed<T>(path: string): Promise<T | undefined> {
  if (memory.has(path)) return peek<T>(path);
  if (typeof caches === "undefined") return undefined;
  try {
    const hit = await (await caches.open(API_CACHE)).match(path, { ignoreVary: true });
    if (!hit) return undefined;
    const data = (await hit.json()) as T;
    if (!memory.has(path)) setCached(path, data, true);
    return data;
  } catch {
    return undefined;
  }
}

/** Fetches a read, sharing one request between concurrent callers, and remembers the answer. */
export function fetchQuery<T>(path: string): Promise<T> {
  const running = inflight.get(path);
  if (running) return running as Promise<T>;
  const p = get<T>(path)
    .then((data) => {
      setCached(path, data);
      return data;
    })
    .finally(() => inflight.delete(path));
  inflight.set(path, p);
  return p;
}

export type Query<T> = {
  data: T | undefined;
  /** Nothing to show yet. */
  loading: boolean;
  /** Something is on screen and a fresh copy is on its way. */
  refreshing: boolean;
  /** Only when there is nothing to show; with data on screen a failed refresh stays quiet. */
  error: string | null;
  reload: () => Promise<void>;
};

/**
 * A read for a page: what is known now, then the network's answer. Pass null to read nothing;
 * change `deps` (a version counter, usually) to read again.
 */
export function useQuery<T>(path: string | null, deps: unknown[] = []): Query<T> {
  const [, bump] = useState(0);
  const [fetching, setFetching] = useState<string | null>(path);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!path) return;
    const fn = () => bump((n) => n + 1);
    const set = listeners.get(path) ?? new Set<() => void>();
    set.add(fn);
    listeners.set(path, set);
    return () => {
      set.delete(fn);
      if (!set.size) listeners.delete(path);
    };
  }, [path]);

  useEffect(() => {
    if (!path) return;
    let alive = true;
    setFetching(path);
    setError(null);
    void (async () => {
      await seed(path);
      try {
        await fetchQuery(path);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "Could not load");
      } finally {
        if (alive) setFetching(null);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);

  const entry = path ? memory.get(path) : undefined;
  return {
    data: entry?.data as T | undefined,
    loading: Boolean(path) && !entry && !error,
    refreshing: Boolean(entry) && fetching === path,
    error: entry ? null : error,
    reload: async () => {
      if (!path) return;
      try {
        await fetchQuery(path);
      } catch {
        // the page keeps what it has; the bar under the header says why
      }
    },
  };
}
