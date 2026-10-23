import { onLinkClick } from "../router";
import { sync, useOffline } from "../offline";

/** One line under the header when the book and the phone are not the same thing. */
export function NetBar({ householdId }: { householdId: string }) {
  const s = useOffline();
  const mine = s.items.filter((i) => i.householdId === householdId);
  const queued = mine.filter((i) => i.state === "queued").length;
  const look = mine.length - queued;
  const when = s.staleAt && s.staleAt !== "unknown" ? new Date(s.staleAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
  const saved = s.staleAt ? (when ? `Showing what was saved at ${when}.` : "Showing what was saved earlier.") : "";
  const n = (count: number) => `${count} ${count === 1 ? "entry" : "entries"}`;

  let text: string | null = null;
  let action: React.ReactNode = null;
  if (!s.online) {
    text = `Offline. ${saved}${queued ? ` ${n(queued)} on this phone, not in the book yet.` : ""}`.trim();
  } else if (s.signedOut && mine.length) {
    text = `${n(mine.length)} waiting on this phone: sign in again and they go into the book.`;
  } else if (s.syncing) {
    text = `Syncing ${n(queued)}…`;
  } else if (look) {
    text = `${n(look)} on this phone ${look === 1 ? "needs" : "need"} a look before going into the book.`;
    action = (
      <a href={`/h/${householdId}`} onClick={onLinkClick}>
        See them on Today
      </a>
    );
  } else if (queued) {
    text = `${n(queued)} on this phone, waiting to sync.`;
    action = (
      <button type="button" className="link" onClick={() => void sync()}>
        Sync now
      </button>
    );
  } else if (s.staleAt) {
    text = `Can't reach the book right now. ${saved}`;
    action = (
      <button type="button" className="link" onClick={() => window.dispatchEvent(new CustomEvent("fm:synced"))}>
        Try again
      </button>
    );
  }
  if (!text) return null;
  return (
    <div className="netbar" role="status">
      <span>{text}</span>
      {action}
    </div>
  );
}
