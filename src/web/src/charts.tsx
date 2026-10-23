/**
 * Small charts in the passbook's own hand: thin marks, hairline grids, numbers in mono, every
 * value also readable as text. SVG where a shape needs drawing, plain HTML where bars will do.
 *
 * Colours: a single series takes --series-1; several take the slots in order (validated for
 * colour-blind separation); good / warning / over use the app's status colours.
 */
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { minorDigits } from "../../shared/money";

export const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)", "var(--series-5)"] as const;
export const TONES = { good: "var(--green)", warning: "var(--marigold-deep)", serious: "var(--rust)" } as const;
export type Tone = keyof typeof TONES;

/** Money for an axis: 2.5K, 12L, 1.2Cr where lakhs are spoken; K and M elsewhere. */
export function compact(minor: number, currency: string): string {
  const u = Math.abs(minor) / 10 ** minorDigits(currency);
  const sign = minor < 0 ? "−" : "";
  const f = (v: number, d: number) => v.toFixed(d).replace(/\.0$/, "");
  if (currency === "NPR" || currency === "INR") {
    if (u >= 1e7) return `${sign}${f(u / 1e7, u >= 1e8 ? 0 : 1)}Cr`;
    if (u >= 1e5) return `${sign}${f(u / 1e5, u >= 1e6 ? 0 : 1)}L`;
  } else if (u >= 1e6) return `${sign}${f(u / 1e6, u >= 1e7 ? 0 : 1)}M`;
  if (u >= 1e3) return `${sign}${f(u / 1e3, u >= 1e4 ? 0 : 1)}K`;
  return `${sign}${Math.round(u)}`;
}

/** The width of a block, kept current, so SVG draws at pixel size and text stays crisp. */
export function useWidth(): [(el: HTMLDivElement | null) => void, number] {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => setWidth(Math.round(entries[0]?.contentRect.width ?? 0)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, width];
}

/** A round number at or above v: 1, 2, 2.5, 5 × a power of ten. */
function niceMax(v: number): number {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const r = v / p;
  return (r <= 1 ? 1 : r <= 2 ? 2 : r <= 2.5 ? 2.5 : r <= 5 ? 5 : 10) * p;
}

type Tip = { x: number; y: number; title: string; rows: { color?: string; label: string; value: string }[] };

function Tooltip({ tip, width }: { tip: Tip | null; width: number }) {
  if (!tip) return null;
  const flip = tip.x > width - 160;
  return (
    <div className="chart-tip" style={{ left: flip ? undefined : tip.x + 12, right: flip ? Math.max(0, width - tip.x + 12) : undefined, top: Math.max(0, tip.y - 8) }} role="status">
      <div>{tip.title}</div>
      {tip.rows.map((r, i) => (
        <div key={i} className="row">
          <span>
            {r.color && <span className="key" style={{ background: r.color }} />}
            {r.label}
          </span>
          <strong>{r.value}</strong>
        </div>
      ))}
    </div>
  );
}

/** The table twin: the same numbers as text, for screen readers and anyone who prefers them. */
export function ChartTable({ caption, head, rows }: { caption: string; head: string[]; rows: ReactNode[][] }) {
  return (
    <details className="chart-table">
      <summary>{caption}</summary>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {head.map((h, i) => (
                <th key={i} className={i ? "right" : ""}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {r.map((c, j) => (
                  <td key={j} className={j ? "right mono" : ""}>
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// HTML charts
// ---------------------------------------------------------------------------

/** A single ratio against a limit: the fill carries the state, a tick marks where "now" is. */
export function Meter({ value, max, tone = "good", marker, markerLabel, left, right, compact: small }: { value: number; max: number; tone?: Tone; marker?: number; markerLabel?: string; left?: string; right?: string; compact?: boolean }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div className={`meter ${small ? "compact" : ""} ${markerLabel ? "has-tick" : ""}`} role="img" aria-label={[left, right, markerLabel].filter(Boolean).join(" · ")}>
      {(left || right) && (
        <div className="labels">
          <span>{left}</span>
          <span>{right}</span>
        </div>
      )}
      <div className="track">
        <div className={`fill ${pct >= 100 ? "full" : ""}`} style={{ width: `${pct}%`, background: TONES[tone] }} />
        {marker !== undefined && (
          <>
            <div className="tick" style={{ left: `${Math.min(100, Math.max(0, marker * 100))}%` }} />
            {markerLabel && (
              <span className="tick-label" style={{ left: `${Math.min(100, Math.max(0, marker * 100))}%` }}>
                {markerLabel}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Magnitudes side by side, one hue, the value at each tip. */
export function Bars({ rows, format, color = SERIES[0] }: { rows: { label: string; value: number }[]; format: (v: number) => string; color?: string }) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <div className="bars" role="img" aria-label={rows.map((r) => `${r.label} ${format(r.value)}`).join(", ")}>
      {rows.map((r, i) => (
        <Fragment key={i}>
          <span className="label" title={r.label}>
            {r.label}
          </span>
          <div className="track">
            <div className="fill" style={{ width: `${(Math.max(0, r.value) / max) * 100}%`, background: color }} />
          </div>
          <span className="value">{format(r.value)}</span>
        </Fragment>
      ))}
    </div>
  );
}

/** Either side of zero: what we owe to the left, what we are owed to the right. */
export function Diverging({ rows, format, negative, positive }: { rows: { label: string; value: number }[]; format: (v: number) => string; negative: { label: string; color: string }; positive: { label: string; color: string } }) {
  const max = Math.max(...rows.map((r) => Math.abs(r.value)), 1);
  return (
    <div className="diverge" role="img" aria-label={rows.map((r) => `${r.label}: ${r.value < 0 ? negative.label : positive.label} ${format(Math.abs(r.value))}`).join(", ")}>
      <div className="legend">
        <span>
          <span className="key rect" style={{ background: negative.color }} />
          {negative.label}
        </span>
        <span>
          <span className="key rect" style={{ background: positive.color }} />
          {positive.label}
        </span>
      </div>
      {rows.map((r, i) => {
        const pct = (Math.abs(r.value) / max) * 50;
        return (
          <Fragment key={i}>
            <span className="label" title={r.label}>
              {r.label}
            </span>
            <div className="track">
              {r.value < 0 && <span className="neg" style={{ width: `${pct}%`, background: negative.color }} />}
              {r.value > 0 && <span className="pos" style={{ width: `${pct}%`, background: positive.color }} />}
            </div>
            <span className="value">
              {r.value === 0 ? "settled" : format(Math.abs(r.value))}
              {r.value !== 0 && <span className="side"> {r.value < 0 ? negative.label.toLowerCase() : positive.label.toLowerCase()}</span>}
            </span>
          </Fragment>
        );
      })}
    </div>
  );
}

/** Part-to-whole in one bar, a 2px gap between parts, the parts listed below with their values. */
export function Stacked({ segments, format, empty = "Nothing here yet." }: { segments: { label: string; value: number; color: string }[]; format: (v: number) => string; empty?: string }) {
  const shown = segments.filter((s) => s.value > 0);
  const total = shown.reduce((s, x) => s + x.value, 0);
  if (!total) return <span className="small muted">{empty}</span>;
  return (
    <div className="stack" role="img" aria-label={shown.map((s) => `${s.label} ${format(s.value)}`).join(", ")}>
      <div className="stack-bar">
        {shown.map((s, i) => (
          <span key={i} style={{ width: `${(s.value / total) * 100}%`, background: s.color }} title={`${s.label}: ${format(s.value)}`} />
        ))}
      </div>
      <div className="stack-legend">
        {shown.map((s, i) => (
          <Fragment key={i}>
            <span className="key rect legend" style={{ background: s.color, display: "inline-block", width: 10, height: 10, borderRadius: 2 }} />
            <span>{s.label}</span>
            <span className="mono">{format(s.value)}</span>
          </Fragment>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SVG charts
// ---------------------------------------------------------------------------

export type LineSeries = { name: string; color: string; values: (number | null)[] };

/**
 * One or more series over the same steps. A crosshair finds the step; the tooltip lists every
 * series there. Two or more series get a legend; up to four get labels at their ends when they
 * don't collide.
 */
export function Lines({ series, labels, format, currency, markers = [], height = 200, step = false, area = false, caption = "Show as a table", head = "Month" }: { series: LineSeries[]; labels: string[]; format: (v: number) => string; currency: string; markers?: { index: number; label: string; short?: string; series?: number }[]; height?: number; step?: boolean; area?: boolean; caption?: string; head?: string }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const n = labels.length;
  // End labels need room on the right and a plot wide enough to be worth it; the legend carries
  // identity regardless.
  const endLabels = width >= 560 && series.length > 1 && series.length <= 4;
  const padR = endLabels ? Math.min(140, Math.max(...series.map((s) => s.name.length)) * 6.5 + 14) : 12;
  const padL = 44;
  const plotW = Math.max(0, width - padL - padR);
  // Marker labels sit above the plot, the short form on a narrow one; when two would overlap,
  // the later one moves up a row, up to three rows.
  const markerText = (m: { label: string; short?: string }) => (width < 560 && m.short ? m.short : m.label);
  const textW = (t: string) => t.length * 6.3;
  const px = (i: number) => padL + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);
  const extent = (m: { index: number; label: string; short?: string }): [number, number] => {
    const at = px(m.index);
    const tw = textW(markerText(m));
    const anchor = m.index > n * 0.8 ? "end" : m.index < n * 0.2 ? "start" : "middle";
    return anchor === "end" ? [at - tw, at] : anchor === "start" ? [at, at + tw] : [at - tw / 2, at + tw / 2];
  };
  const markerRows = new Map<number, number>();
  const lastOnRow = [-Infinity, -Infinity, -Infinity];
  for (const m of [...markers].sort((a, b) => a.index - b.index)) {
    const [from, to] = extent(m);
    const free = lastOnRow.findIndex((end) => from > end + 8);
    const row = free >= 0 ? free : 0;
    markerRows.set(m.index, row);
    lastOnRow[row] = Math.max(lastOnRow[row]!, to);
  }
  const rows = markers.length ? Math.max(...markerRows.values()) + 1 : 0;
  const pad = { l: padL, r: padR, t: 10 + rows * 14, b: 20 };
  const w = plotW;
  const h = height - pad.t - pad.b;
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const hi = niceMax(Math.max(...all, 1) * 1.05);
  const minV = Math.min(...all, 0);
  const lo = minV < 0 ? -niceMax(-minV * 1.05) : 0;
  const y = (v: number) => pad.t + h - ((v - lo) / (hi - lo)) * h;
  const x = (i: number) => pad.l + (n > 1 ? (i / (n - 1)) * w : w / 2);
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(w / 84))));
  // Regular labels, plus the last one; a regular label too close to the last gives way.
  const showLabel = (i: number) => i === n - 1 || (i % every === 0 && n - 1 - i >= every);

  const path = (values: (number | null)[]) => {
    let d = "";
    let prev: { x: number; y: number } | null = null;
    values.forEach((v, i) => {
      if (v === null) {
        prev = null;
        return;
      }
      const px = x(i);
      const py = y(v);
      if (!prev) d += `M${px},${py}`;
      else if (step) d += ` H${px} V${py}`;
      else d += ` L${px},${py}`;
      prev = { x: px, y: py };
    });
    return d;
  };
  const lastIndex = (values: (number | null)[]) => {
    for (let i = values.length - 1; i >= 0; i--) if (values[i] !== null) return i;
    return -1;
  };
  // End labels only when they keep clear of each other; the legend carries identity regardless.
  const ends = series.map((s) => ({ i: lastIndex(s.values), s })).filter((e) => e.i >= 0);
  const endYs = ends.map((e) => y(e.s.values[e.i]!)).sort((a, b) => a - b);
  const showEnds = endLabels && endYs.every((v, i) => i === 0 || v - endYs[i - 1]! >= 13);

  const ticks = lo < 0 ? [lo, 0, hi] : [0, hi / 2, hi];
  const tip: Tip | null =
    hover !== null
      ? {
          x: x(hover),
          y: pad.t,
          title: labels[hover] ?? "",
          rows: series.map((s) => ({ color: s.color, label: s.name, value: s.values[hover] === null || s.values[hover] === undefined ? "—" : format(s.values[hover]!) })),
        }
      : null;

  function onMove(e: React.PointerEvent<SVGRectElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    setHover(Math.max(0, Math.min(n - 1, Math.round((px / Math.max(1, rect.width)) * (n - 1)))));
  }

  return (
    <div className="chart" ref={ref}>
      {series.length > 1 && (
        <div className="legend" style={{ marginBottom: 6 }}>
          {series.map((s, i) => (
            <span key={i}>
              <span className="key" style={{ background: s.color }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
      {width > 0 && n > 0 && (
        <svg width={width} height={height} role="img" aria-label={series.map((s) => s.name).join(", ")}>
          {ticks.map((t) => (
            <g key={t}>
              <line className={t === 0 && lo < 0 ? "axis" : "grid"} x1={pad.l} x2={pad.l + w} y1={y(t)} y2={y(t)} />
              <text x={pad.l - 6} y={y(t) + 4} textAnchor="end">
                {compact(t, currency)}
              </text>
            </g>
          ))}
          {labels.map((l, i) =>
            showLabel(i) ? (
              <text key={i} x={x(i)} y={height - 4} textAnchor={i === n - 1 && n > 1 ? "end" : i === 0 ? "start" : "middle"}>
                {l}
              </text>
            ) : null,
          )}
          {area && series.length === 1 && series[0]!.values.some((v) => v !== null) && (
            <path d={`${path(series[0]!.values)} V${y(Math.max(lo, 0))} H${x(series[0]!.values.findIndex((v) => v !== null))} Z`} fill={series[0]!.color} opacity={0.1} />
          )}
          {series.map((s, i) => (
            <path key={i} d={path(s.values)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {markers.map((m, i) => {
            const s = series[m.series ?? 0];
            const v = s?.values[m.index];
            if (!s || v === null || v === undefined) return null;
            return (
              <g key={i}>
                <line className="grid" x1={x(m.index)} x2={x(m.index)} y1={pad.t} y2={pad.t + h} />
                <circle cx={x(m.index)} cy={y(v)} r={4} fill={s.color} stroke="var(--sheet)" strokeWidth={2} />
                <text className="soft" x={x(m.index)} y={pad.t - 6 - (markerRows.get(m.index) ?? 0) * 14} textAnchor={m.index > n * 0.8 ? "end" : m.index < n * 0.2 ? "start" : "middle"}>
                  {markerText(m)}
                </text>
              </g>
            );
          })}
          {showEnds &&
            ends.map((e, i) => (
              <text key={i} className="soft" x={x(e.i) + 8} y={y(e.s.values[e.i]!) + 4}>
                {e.s.name}
              </text>
            ))}
          {hover !== null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + h} stroke="var(--ink)" strokeWidth={1} opacity={0.5} />
              {series.map((s, i) => {
                const v = s.values[hover];
                return v === null || v === undefined ? null : <circle key={i} cx={x(hover)} cy={y(v)} r={4} fill={s.color} stroke="var(--sheet)" strokeWidth={2} />;
              })}
            </g>
          )}
          <rect className="hit" x={pad.l} y={pad.t} width={Math.max(1, w)} height={h + pad.b} onPointerMove={onMove} onPointerLeave={() => setHover(null)} tabIndex={0} onFocus={() => setHover(n - 1)} onBlur={() => setHover(null)} onKeyDown={(e) => { if (e.key === "ArrowLeft") setHover((v) => Math.max(0, (v ?? n - 1) - 1)); if (e.key === "ArrowRight") setHover((v) => Math.min(n - 1, (v ?? -1) + 1)); }} />
        </svg>
      )}
      <Tooltip tip={tip} width={width} />
      <ChartTable caption={caption} head={[head, ...series.map((s) => s.name)]} rows={labels.map((l, i) => [l, ...series.map((s) => (s.values[i] === null || s.values[i] === undefined ? "—" : format(s.values[i]!)))])} />
    </div>
  );
}
