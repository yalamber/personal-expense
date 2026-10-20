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
