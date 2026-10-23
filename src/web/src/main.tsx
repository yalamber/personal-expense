import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./offline";

createRoot(document.getElementById("root")!).render(<App />);

// The service worker keeps the app and its last figures on the phone (see src/web/sw.js).
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch(() => undefined);
  });
}
