import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Emits the service worker next to the built app with this build's file list and a version
 * hashed from it, so each deploy installs a fresh shell cache and the old one is dropped.
 */
function serviceWorker(): Plugin {
  return {
    name: "family-money-service-worker",
    apply: "build",
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle)
        .filter((f) => /\.(js|css)$/.test(f))
        .sort();
      const version = createHash("sha1").update(files.join(",")).digest("hex").slice(0, 12);
      const source = readFileSync(resolve(__dirname, "src/web/sw.js"), "utf8")
        .replaceAll("__VERSION__", version)
        .replaceAll("__ASSETS__", JSON.stringify(files.map((f) => `/${f}`)));
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

// Builds the React web app into dist/client, which wrangler serves as static assets.
export default defineConfig({
  root: "src/web",
  plugins: [react(), serviceWorker()],
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
  test: {
    root: ".",
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
