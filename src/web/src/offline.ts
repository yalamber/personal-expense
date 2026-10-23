/**
 * Offline wiring for the web app: the outbox in localStorage, online/offline events, replay,
 * and a store the pages read with useOffline().
 */
import { useSyncExternalStore } from "react";
import { drain, householdOf, keepBoth as keepBothItem, type OutboxItem } from "./offline/core";

export type Queued = { queued: true; id: string };
export const isQueued = (r: unknown): r is Queued => typeof r === "object" && r !== null && (r as Queued).queued === true;
export const QUEUED_NOTE = "Saved on this phone. It goes into the book as soon as you're back online.";

export type OfflineState = {
  online: boolean;
  /** When the figures on screen were saved, if the last read came from the phone's store. */
  staleAt: string | null;
  items: OutboxItem[];
  syncing: boolean;
  /** The session is gone: sign in again and the outbox resumes. */
  signedOut: boolean;
};

const KEY = "fm:outbox";
const listeners = new Set<() => void>();
let state: OfflineState = { online: typeof navigator === "undefined" ? true : navigator.onLine, staleAt: null, items: load(), syncing: false, signedOut: false };

function load(): OutboxItem[] {
  try {
    const raw = localStorage.getItem(KEY);
    const items = raw ? (JSON.parse(raw) as OutboxItem[]) : [];
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

function set(patch: Partial<OfflineState>) {
  state = { ...state, ...patch };
  if (patch.items) {
    try {
      localStorage.setItem(KEY, JSON.stringify(state.items));
    } catch {
      // storage full or blocked: the outbox then lives only until the page closes
    }
  }
  for (const fn of listeners) fn();
}

export function useOffline(): OfflineState {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state,
  );
}

export function getOfflineState(): OfflineState {
  return state;
}

export function markStale(at: string | null) {
  if (state.staleAt !== at) set({ staleAt: at });
}

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Keeps a write on the phone; the caller gets a Queued answer in place of the server's. */
export function enqueue(method: string, path: string, body: unknown): Queued {
  const item: OutboxItem = { id: newId(), householdId: householdOf(path), method, path, body, createdAt: new Date().toISOString(), state: "queued" };
  set({ items: [...state.items, item] });
  return { queued: true, id: item.id };
}

export function removeItem(id: string) {
  set({ items: state.items.filter((i) => i.id !== id) });
}

export function keepBoth(id: string) {
  set({ items: state.items.map((i) => (i.id === id ? keepBothItem(i) : i)) });
  void sync();
}

export function clearOutbox() {
  set({ items: [] });
}

let running: Promise<void> | null = null;

/** Replays the outbox, oldest first. Safe to call often; runs one at a time. */
export function sync(): Promise<void> {
  if (running) return running;
  if (!state.items.some((i) => i.state === "queued")) return Promise.resolve();
  running = (async () => {
    set({ syncing: true });
    try {
      const result = await drain(state.items, (path, init) => fetch(path, { ...init, credentials: "same-origin" }));
      set({ items: result.items, syncing: false, online: result.stopped === "network" ? navigator.onLine : true, signedOut: result.stopped === "signed-out" });
      if (result.synced > 0) window.dispatchEvent(new CustomEvent("fm:synced", { detail: { synced: result.synced } }));
    } catch {
      set({ syncing: false });
    } finally {
      running = null;
    }
  })();
  return running;
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    set({ online: true });
    void sync();
  });
  window.addEventListener("offline", () => set({ online: false }));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && navigator.onLine) void sync();
  });
  // Anything left from last time goes out as soon as the app opens.
  setTimeout(() => {
    if (navigator.onLine) void sync();
  }, 500);
}
