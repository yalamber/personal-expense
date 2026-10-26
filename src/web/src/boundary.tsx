/**
 * A page that fails to draw (most often from a copy of the data saved by an older version) does
 * not leave a blank screen: the saved copies are dropped and the page is drawn again from fresh
 * data. If it fails a second time, it says so with a way to reload.
 */
import { Component, type ReactNode } from "react";
import { clearQueries } from "./query";

type Props = { children: ReactNode; onReset: () => void };
type State = { error: Error | null; retried: boolean };

export class PageBoundary extends Component<Props, State> {
  state: State = { error: null, retried: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("[page]", error);
    if (this.state.retried) return;
    // Drop what was saved on this phone and read everything fresh, once.
    clearQueries();
    navigator.serviceWorker?.controller?.postMessage({ type: "clear-api" });
    this.props.onReset();
    this.setState({ error: null, retried: true });
  }

  render() {
    if (this.state.error && this.state.retried) {
      return (
        <section className="card stack" role="alert" style={{ maxWidth: 560 }}>
          <strong>This page could not be shown.</strong>
          <span className="small muted">Something in it did not load properly. Reloading the app usually fixes it.</span>
          <div>
            <button type="button" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        </section>
      );
    }
    return this.props.children;
  }
}
