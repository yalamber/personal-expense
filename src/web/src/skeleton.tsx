/**
 * Skeletons: the shape of a page before its numbers arrive, so nothing jumps when they do.
 * Each one mirrors the layout it stands in for.
 */
import type { CSSProperties } from "react";

export function Sk({ w = "100%", h = 14, r = 6, style }: { w?: number | string; h?: number; r?: number; style?: CSSProperties }) {
  return <span className="sk" style={{ width: w, height: h, borderRadius: r, ...style }} aria-hidden="true" />;
}

export function SkLines({ n = 3, widths = ["92%", "70%", "48%", "80%", "60%"] }: { n?: number; widths?: string[] }) {
  return (
    <span className="stack" style={{ gap: 8 }} aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <Sk key={i} w={widths[i % widths.length]} h={12} />
      ))}
    </span>
  );
}

/** Rows like the book's: a round mark, two lines, a number on the right. */
export function SkRows({ n = 5 }: { n?: number }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="sk-row">
          <Sk w={36} h={36} r={999} />
          <span className="stack" style={{ flex: "1 1 auto", gap: 6 }}>
            <Sk w={`${50 + ((i * 17) % 30)}%`} h={13} />
            <Sk w={`${28 + ((i * 11) % 25)}%`} h={11} />
          </span>
          <Sk w={64} h={13} />
        </div>
      ))}
    </div>
  );
}

export function SkCard({ title = true, lines = 3, rows = 0, chart = 0 }: { title?: boolean; lines?: number; rows?: number; chart?: number }) {
  return (
    <section className="card stack" aria-hidden="true">
      {title && <Sk w={150} h={16} />}
      {lines > 0 && <SkLines n={lines} />}
      {chart > 0 && <Sk h={chart} r={10} />}
      {rows > 0 && <SkRows n={rows} />}
    </section>
  );
}

/** The top of Today, Khata and a contact's page: an eyebrow, a two-line headline, the tally. */
export function SkHero({ tally = 4 }: { tally?: number }) {
  return (
    <section className="hero" aria-hidden="true">
      <div className="headline" style={{ gap: 12 }}>
        <Sk w={170} h={11} />
        <Sk w="78%" h={34} r={8} />
        <Sk w="52%" h={34} r={8} />
        <Sk w={280} h={13} />
      </div>
      {tally > 0 && (
        <div className="ledger-sum" style={{ borderTopColor: "var(--line)" }}>
          {Array.from({ length: tally }, (_, i) => (
            <div key={i}>
              <Sk w={100} h={12} />
              <Sk w={70} h={12} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export type PageKind = "today" | "plan" | "khata" | "decide" | "settings" | "list";

export function PageSkeleton({ kind }: { kind: PageKind }) {
  if (kind === "today") {
    return (
      <div className="stack" style={{ gap: 24 }} aria-busy="true" aria-label="Loading">
        <SkHero />
        <div className="columns">
          <div className="main">
            <SkCard lines={0} chart={150} />
            <SkCard lines={0} rows={7} />
          </div>
          <aside className="side">
            <SkCard lines={4} />
            <SkCard lines={2} />
            <SkCard lines={3} />
          </aside>
        </div>
      </div>
    );
  }
  if (kind === "plan") {
    return (
      <div className="stack" style={{ gap: 24 }} aria-busy="true" aria-label="Loading">
        <SkHero tally={0} />
        <section className="card" aria-hidden="true">
          <span className="row" style={{ gap: 10 }}>
            <Sk w={170} h={14} />
            <Sk w={120} h={36} r={999} />
            <Sk w={90} h={36} r={999} />
            <Sk w={90} h={36} r={999} />
          </span>
        </section>
        <SkCard title={false} rows={4} />
        <SkCard lines={0} chart={200} />
      </div>
    );
  }
  if (kind === "khata") {
    return (
      <div className="stack" style={{ gap: 24 }} aria-busy="true" aria-label="Loading">
        <SkHero tally={3} />
        <SkCard title={false} rows={4} />
      </div>
    );
  }
  if (kind === "decide") {
    return (
      <div className="decide" aria-busy="true" aria-label="Loading">
        <div className="stack" style={{ gap: 2 }}>
          <Sk w={110} h={26} r={8} />
          <Sk w={220} h={12} />
        </div>
        <section className="decide-card" aria-hidden="true">
          <Sk w={140} h={11} />
          <Sk w="88%" h={26} r={8} />
          <Sk w="60%" h={26} r={8} />
          <SkLines n={2} />
          <Sk h={48} r={12} />
          <Sk h={48} r={12} />
        </section>
      </div>
    );
  }
  if (kind === "settings") {
    return (
      <div className="settings" aria-busy="true" aria-label="Loading">
        <div className="settings-nav" aria-hidden="true">
          {[2, 3, 2, 1].map((rows, g) => (
            <div key={g} className="group" style={{ gap: 6 }}>
              <Sk w={80} h={10} style={{ margin: "0 12px 4px" }} />
              {Array.from({ length: rows }, (_, i) => (
                <Sk key={i} h={36} r={10} />
              ))}
            </div>
          ))}
        </div>
        <div className="settings-body">
          <div className="stack" style={{ gap: 6 }}>
            <Sk w={120} h={11} />
            <Sk w={220} h={30} r={8} />
          </div>
          <SkCard lines={3} />
          <SkCard lines={2} />
        </div>
      </div>
    );
  }
  return (
    <div className="stack" style={{ gap: 24 }} aria-busy="true" aria-label="Loading">
      <div className="stack" style={{ gap: 6 }}>
        <Sk w={180} h={30} r={8} />
        <Sk w={300} h={13} />
      </div>
      <SkCard title={false} rows={5} />
    </div>
  );
}

/** Before the session is known: the frame of the app with Today's shape inside it. */
export function AppSkeleton() {
  return (
    <>
      <header className="topbar" aria-hidden="true">
        <div className="inner">
          <span className="brand">
            <span className="brand-mark" />
            <Sk w={120} h={16} />
          </span>
        </div>
      </header>
      <main className="app">
        <PageSkeleton kind="today" />
      </main>
    </>
  );
}
