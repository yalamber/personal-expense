import { useEffect, useRef } from "react";
/** Small shared UI pieces. */
import { formatMinor } from "../../shared/money";
import { shiftMonth } from "../../shared/dates";
import type { Category } from "./api";

export function Money({ minor, currency, signed }: { minor: number; currency: string; signed?: "in" | "out" | "transfer" }) {
  const text = formatMinor(Math.abs(minor), currency);
  if (signed === "in") return <span className="mono amount in">+{text}</span>;
  if (signed === "out") return <span className="mono amount">−{text}</span>;
  return <span className="mono amount">{minor < 0 ? `−${text}` : text}</span>;
}

/** Category picker grouped by top-level category. */
export function CategorySelect({
  categories,
  value,
  onChange,
  label,
  allowNone = true,
  filter,
}: {
  categories: Category[];
  value: string | null;
  onChange: (id: string | null) => void;
  label: string;
  allowNone?: boolean;
  filter?: (c: Category) => boolean;
}) {
  const tops = categories.filter((c) => !c.parentId && (!filter || filter(c)));
  return (
    <select aria-label={label} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
      {allowNone && <option value="">Uncategorised</option>}
      {tops.map((top) => {
        const children = categories.filter((c) => c.parentId === top.id);
        return (
          <optgroup key={top.id} label={top.name}>
            <option value={top.id}>{top.name} (general)</option>
            {children.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </optgroup>
        );
      })}
    </select>
  );
}

export function categoryLabel(categories: Category[], id: string | null): string {
  if (!id) return "Uncategorised";
  const c = categories.find((x) => x.id === id);
  if (!c) return "Uncategorised";
  const parent = c.parentId ? categories.find((x) => x.id === c.parentId) : null;
  return parent ? `${parent.name} › ${c.name}` : c.name;
}

export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
}

export function MonthSwitcher({ month, onChange }: { month: string; onChange: (m: string) => void }) {
  return (
    <div className="row" role="group" aria-label="Month">
      <button type="button" className="secondary" aria-label="Previous month" onClick={() => onChange(shiftMonth(month, -1))}>
        ‹
      </button>
      <strong style={{ minWidth: 150, textAlign: "center" }}>{monthLabel(month)}</strong>
      <button type="button" className="secondary" aria-label="Next month" onClick={() => onChange(shiftMonth(month, 1))}>
        ›
      </button>
    </div>
  );
}

export function currentMonth(today: string): string {
  return today.slice(0, 7);
}

// ---------------------------------------------------------------------------
// Fable design pieces
// ---------------------------------------------------------------------------

const SYMBOLS: Record<string, string> = { NPR: "Rs", INR: "₹", USD: "$", EUR: "€", GBP: "£", AUD: "A$", CAD: "C$", JPY: "¥" };

/** "Rs 1,240" — whole numbers when there are no cents, symbol first. */
export function formatMoney(minor: number, currency: string, opts: { sign?: boolean; symbol?: boolean } = {}): string {
  const digits = minorDigitsOf(currency);
  const abs = Math.abs(minor);
  const value = abs / 10 ** digits;
  const hasCents = digits > 0 && abs % 10 ** digits !== 0;
  const number = value.toLocaleString("en-US", { minimumFractionDigits: hasCents ? digits : 0, maximumFractionDigits: hasCents ? digits : 0 });
  const sign = minor < 0 ? "−" : opts.sign && minor > 0 ? "+" : "";
  if (opts.symbol === false) return `${sign}${number}`;
  const symbol = SYMBOLS[currency] ?? currency;
  return symbol.length > 1 && /^[A-Za-z]+$/.test(symbol) ? `${sign}${symbol} ${number}` : `${sign}${symbol}${number}`;
}

function minorDigitsOf(currency: string): number {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** Typed amount for an input: "1240" or "1240.50", from minor units. */
export function amountInput(minor: number, currency: string): string {
  const digits = minorDigitsOf(currency);
  const hasCents = digits > 0 && minor % 10 ** digits !== 0;
  return (minor / 10 ** digits).toFixed(hasCents ? digits : 0);
}

/** "Today, Wed 22 Oct", "Yesterday, Tue 21 Oct", "Mon 20 Oct". */
export function dayLabel(date: string, today: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const base = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  if (date === today) return `Today, ${base}`;
  const y = new Date(`${today}T00:00:00Z`);
  y.setUTCDate(y.getUTCDate() - 1);
  if (date === y.toISOString().slice(0, 10)) return `Yesterday, ${base}`;
  return base;
}

export function shortDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

type IconProps = { size?: number };
const svg = (size: number, children: React.ReactNode, strokeWidth = 2) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const Icon = {
  home: ({ size = 17 }: IconProps) => svg(size, <><path d="M4 18V9l8-5 8 5v9" /><path d="M9 18v-5h6v5" /></>),
  today: ({ size = 22 }: IconProps) => svg(size, <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>),
  plan: ({ size = 22 }: IconProps) => svg(size, <path d="M5 21V5a2 2 0 0 1 2-2h10l-3 4 3 4H7" />),
  decide: ({ size = 22 }: IconProps) => svg(size, <><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M8.5 12.5l2.5 3 4.5-6" /></>),
  family: ({ size = 22 }: IconProps) => svg(size, <><circle cx="9" cy="8.5" r="3" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0" /><circle cx="16.5" cy="9.5" r="2.4" /><path d="M16 14.6a4.8 4.8 0 0 1 4.5 4.4" /></>),
  plus: ({ size = 18 }: IconProps) => svg(size, <path d="M12 5v14M5 12h14" />, 2.3),
  close: ({ size = 22 }: IconProps) => svg(size, <path d="M6 6l12 12M18 6L6 18" />),
  back: ({ size = 20 }: IconProps) => svg(size, <path d="M15 6l-6 6 6 6" />),
  next: ({ size = 18 }: IconProps) => svg(size, <path d="M9 6l6 6-6 6" />),
  note: ({ size = 18 }: IconProps) => svg(size, <path d="M4 20h4L19 9l-4-4L4 16z" />),
  safety: ({ size = 17 }: IconProps) => svg(size, <path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6z" />),
  purchase: ({ size = 17 }: IconProps) => svg(size, <><path d="M3 17l6-3 6 3 6-3" /><path d="M3 21l6-3 6 3 6-3" /><path d="M12 3v7" /><path d="M9 7l3 3 3-3" /></>),
  build: ({ size = 17 }: IconProps) => svg(size, <><rect x="3" y="13" width="8" height="5" /><rect x="13" y="13" width="8" height="5" /><rect x="8" y="6" width="8" height="5" /></>),
  house: ({ size = 17 }: IconProps) => svg(size, <><path d="M4 18V9l8-5 8 5v9" /><path d="M9 18v-5h6v5" /></>),
  education: ({ size = 17 }: IconProps) => svg(size, <><path d="M2 9l10-4 10 4-10 4z" /><path d="M6 11v5c0 1.5 2.7 3 6 3s6-1.5 6-3v-5" /></>),
  other: ({ size = 17 }: IconProps) => svg(size, <path d="M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7z" />),
};

/** ✓ logged by the family, ✓✓ confirmed by the bank. */
export function Checks({ confirmed, size = 1 }: { confirmed: boolean; size?: number }) {
  return confirmed ? (
    <span>
      <svg width={17 * size} height={10 * size} viewBox="0 0 20 12" fill="none" stroke="var(--green)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M1 6.5l3.2 3.8L10.5 2" />
        <path d="M8.5 6.5l3.2 3.8L18 2" />
      </svg>
      <span className="sr-only">confirmed by the bank</span>
    </span>
  ) : (
    <span>
      <svg width={13 * size} height={10 * size} viewBox="0 0 13 12" fill="none" stroke="#8a958c" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M1 6.5l3.2 3.8L11 2" />
      </svg>
      <span className="sr-only">logged, waiting for the bank</span>
    </span>
  );
}

/** A dialog that covers the page: centred on desktop, full screen on a phone. Escape closes it. */
export function Sheet({ title, onClose, children, footer }: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>("input, select, textarea, button:not(.icon-button)");
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      previous?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="sheet-head">
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
            <Icon.close />
          </button>
          <h2 style={{ fontSize: 16 }}>{title}</h2>
          <span style={{ width: 44 }} />
        </div>
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </div>
  );
}
