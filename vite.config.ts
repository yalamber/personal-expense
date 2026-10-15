import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Builds the React web app into dist/client, which wrangler serves as static assets.
export default defineConfig({
  root: "src/web",
  plugins: [react()],
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
