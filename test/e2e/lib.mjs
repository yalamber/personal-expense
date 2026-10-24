// Shared by the end-to-end suites: a signed-in API client against the local Worker, small date
// helpers, and a browser when one is installed. The runner (run.mjs) sets E2E_BASE and E2E_LOG.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

export const BASE = process.env.E2E_BASE ?? "http://localhost:8787";
/** The Worker's log: sign-in links are printed there (MAILER=log). */
export const LOG = process.env.E2E_LOG ?? "";
/** Exit code a browser suite uses when no browser can be launched; the runner reports it as skipped. */
export const SKIP = 3;

export const ok = (cond, msg) => {
  if (!cond) throw new Error("FAILED: " + msg);
  console.log("ok  " + msg);
};
export const iso = (d) => d.toISOString().slice(0, 10);
export const addDays = (s, n) => iso(new Date(Date.parse(s) + n * 86_400_000));
export const addMonths = (s, n) => {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return iso(d);
};
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const linksInLog = () => [...readFileSync(LOG, "utf8").matchAll(/(http:\/\/localhost:\d+\/api\/auth\/callback\?token=[^\s]+)/g)].map((m) => m[1]);

/** An API client that keeps its session cookie. `signIn` follows the magic link the Worker logs. */
export function newClient(email) {
  const state = { cookie: "" };
  async function call(method, path, body, expect) {
    const res = await fetch(BASE + path, {
      method,
      headers: { ...(body ? { "content-type": "application/json" } : {}), ...(state.cookie ? { cookie: state.cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "manual",
    });
    const set = res.headers.get("set-cookie");
    if (set) state.cookie = set.split(";")[0];
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    if (expect && res.status !== expect) throw new Error(`${method} ${path} -> ${res.status} (wanted ${expect}): ${text.slice(0, 300)}`);
    return { status: res.status, data, headers: res.headers };
  }
  async function signIn() {
    const before = linksInLog().length;
    await call("POST", "/api/auth/magic-link", { email }, 200);
    let links = [];
    for (let i = 0; i < 40 && links.length <= before; i++) {
      await sleep(250);
      links = linksInLog();
    }
    if (links.length <= before) throw new Error("no new sign-in link in the Worker log");
    await call("GET", links[links.length - 1].replace(/^http:\/\/localhost:\d+/, ""));
    if (!state.cookie) throw new Error("no session cookie after the sign-in link");
  }
  return { call, signIn, state };
}

/**
 * A headless Chromium through Playwright, or null when neither is installed. Playwright is looked
 * for in the project, then in NODE_PATH and the usual global folder; the browser is E2E_CHROMIUM,
 * the Playwright-installed one, or the system Chrome.
 */
export async function launch() {
  const require = createRequire(import.meta.url);
  const extra = [process.env.NODE_PATH, "/opt/node-tools/node_modules", "/usr/lib/node_modules", "/usr/local/lib/node_modules"].filter(Boolean);
  let pw = null;
  for (const name of ["playwright", "playwright-core"]) {
    try {
      pw = require(name);
      break;
    } catch {
      try {
        pw = require(require.resolve(name, { paths: extra }));
        break;
      } catch {
        // not there either
      }
    }
  }
  if (!pw) return null;
  const exe = process.env.E2E_CHROMIUM ?? (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : null);
  const attempts = exe ? [{ executablePath: exe }] : [{}, { channel: "chrome" }, { channel: "chromium" }];
  for (const opts of attempts) {
    try {
      return await pw.chromium.launch(opts);
    } catch {
      // try the next
    }
  }
  return null;
}

/** Cookie jar entry for Playwright from a "name=value" session cookie. */
export const cookieFor = (cookie) => [{ name: cookie.split("=")[0], value: cookie.split("=").slice(1).join("="), url: BASE }];

/** A browser suite's arguments: the JSON hand-offs from earlier suites, and a screenshot folder if any. */
export function suiteArgs() {
  const json = [];
  let out = null;
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("{")) json.push(JSON.parse(a));
    else out = a;
  }
  return { json, out };
}
