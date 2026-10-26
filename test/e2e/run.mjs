#!/usr/bin/env node
// End to end: builds the app, starts a local Worker on a fresh database, runs the suites against
// it and tears everything down. `npm run test:e2e [suite…]`. Env: E2E_PORT (8788), E2E_SKIP_BUILD,
// E2E_SHOTS=<dir> to keep screenshots, E2E_KEEP to keep the Worker's state and log.
import { execSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const port = Number(process.env.E2E_PORT ?? 8788);
const BASE = `http://localhost:${port}`;
const wanted = new Set(process.argv.slice(2));
const state = mkdtempSync(join(tmpdir(), "family-money-e2e-"));
const log = join(state, "wrangler.log");
const shots = process.env.E2E_SHOTS ?? null;
const env = { ...process.env, E2E_BASE: BASE, E2E_LOG: log };

const sh = (cmd) => execSync(cmd, { cwd: root, stdio: "inherit" });
if (!process.env.E2E_SKIP_BUILD) sh("npm run build");
sh(`npx wrangler d1 migrations apply personal-expense --local --persist-to "${state}"`);

const out = openSync(log, "a");
const dev = spawn("npx", ["wrangler", "dev", "--port", String(port), "--persist-to", state, "--var", "MAILER:log", "--var", `APP_ORIGIN:${BASE}`], { cwd: root, stdio: ["ignore", out, out], detached: true, env });
const stop = () => {
  try {
    process.kill(-dev.pid, "SIGTERM");
  } catch {
    // already gone
  }
};
process.on("exit", stop);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));

// Wait for the Worker: /api/me answers 401 once it is up.
let up = false;
for (let i = 0; i < 120 && !up; i++) {
  try {
    up = (await fetch(`${BASE}/api/me`)).status === 401;
  } catch {
    await new Promise((r) => setTimeout(r, 500));
  }
}
if (!up) {
  console.error(`The Worker did not come up on ${BASE}; see ${log}`);
  process.exit(1);
}
console.log(`Worker up on ${BASE} (state in ${state})\n`);

// Each suite prints "ok  …" lines and throws on the first failure. One that ends with a JSON line
// hands that line (a household and cookie) to the suites that come after it.
const handoff = {};
const suites = [
  { name: "api-core", file: "api-core.mjs" },
  { name: "api-start", file: "api-start.mjs" },
  { name: "api-khata", file: "api-khata.mjs", keep: "khata" },
  { name: "api-recurring", file: "api-recurring.mjs", keep: "every" },
  { name: "api-plan", file: "api-plan.mjs", keep: "plan" },
  { name: "api-accuracy", file: "api-accuracy.mjs" },
  { name: "seed", file: "seed.mjs", keep: "rich" },
  { name: "browser-offline", file: "browser-offline.mjs", browser: true, args: () => [JSON.stringify(handoff.khata)] },
  { name: "browser-pages", file: "browser-pages.mjs", browser: true, args: () => [JSON.stringify(handoff.rich), ...(handoff.every ? [JSON.stringify(handoff.every)] : [])] },
  { name: "browser-plan", file: "browser-plan.mjs", browser: true, args: () => [JSON.stringify(handoff.plan ?? null), JSON.stringify(handoff.rich ?? null)] },
];

const results = [];
for (const s of suites) {
  // A named run still seeds what its browser suites need.
  const feeds = s.keep && [...wanted].some((w) => suites.find((x) => x.name === w)?.browser);
  if (wanted.size && !wanted.has(s.name) && !feeds) continue;
  const args = s.args ? s.args() : [];
  if (s.browser && args.some((a) => a === undefined || a === "undefined")) {
    results.push({ name: s.name, status: "skipped", note: "needs a household from an earlier suite" });
    continue;
  }
  const started = Date.now();
  console.log(`── ${s.name}`);
  const r = spawnSync(process.execPath, [join(here, s.file), ...args, ...(s.browser && shots ? [shots] : [])], { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  process.stdout.write(r.stdout);
  if (r.status !== 0 && r.status !== 3) process.stderr.write(r.stderr);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (r.status === 0) {
    const last = r.stdout.trim().split("\n").pop() ?? "";
    if (s.keep && last.startsWith("{")) handoff[s.keep] = JSON.parse(last);
    results.push({ name: s.name, status: "passed", note: `${(r.stdout.match(/^ok {2}/gm) ?? []).length} checks · ${seconds}s` });
  } else if (r.status === 3) {
    results.push({ name: s.name, status: "skipped", note: r.stdout.trim().split("\n").pop() ?? "" });
  } else {
    const said = r.stderr.match(/^(?:\w*Error: )?FAILED: .*$|^\w*Error: .*$/gm) ?? [];
    results.push({ name: s.name, status: "failed", note: said[said.length - 1] ?? `exit ${r.status}` });
    break;
  }
  console.log("");
}

stop();
console.log("Summary");
for (const r of results) console.log(`  ${r.status.padEnd(7)} ${r.name.padEnd(16)} ${r.note}`);
const failed = results.some((r) => r.status === "failed");
if (failed) console.log(`\nWorker log: ${log}`);
else if (!process.env.E2E_KEEP) rmSync(state, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
