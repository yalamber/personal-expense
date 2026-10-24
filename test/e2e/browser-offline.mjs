// Offline end to end: the app opens with no connection, money logged offline waits on the phone,
// and goes into the book when the connection returns. Needs the khata household from api-khata.
import { BASE, SKIP, cookieFor, launch, ok, suiteArgs } from "./lib.mjs";

const { json, out } = suiteArgs();
const [{ hh, cookie }] = json;
const shot = (page, name, opts) => (out ? page.screenshot({ path: `${out}/${name}.png`, ...opts }) : Promise.resolve());
const browser = await launch();
if (!browser) {
  console.log("skip: no browser (install playwright and a chromium)");
  process.exit(SKIP);
}
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addCookies(cookieFor(cookie));
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
// Console noise while offline (failed fetches, 503 from the worker, the 409 twin) is expected; only script errors count.
try {

// First visit online: the worker installs and takes over; the second load fills its store.
await page.goto(`${BASE}/h/${hh}`, { waitUntil: "networkidle" });
await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller !== null, null, { timeout: 20000 });
ok(true, "service worker installed and controlling the page");
await page.reload({ waitUntil: "networkidle" });
const cached = await page.evaluate(async () => {
  const c = await caches.open("api-v1");
  return (await c.keys()).map((r) => new URL(r.url).pathname);
});
ok(cached.some((p) => p.endsWith("/today")) && cached.some((p) => p === "/api/me"), `API reads kept on the phone (${cached.length} of them)`);
const shells = await page.evaluate(async () => (await caches.keys()).filter((k) => k.startsWith("shell-")));
ok(shells.length === 1, `one shell cache for this build (${shells[0]})`);

// No connection: the app still opens, says so, and shows the saved figures.
await ctx.setOffline(true);
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector(".netbar", { timeout: 15000 });
const bar = await page.locator(".netbar").innerText();
ok(/Offline|saved/.test(bar), `the bar says: ${bar}`);
const headline = await page.locator("h1").first().innerText();
ok(headline.length > 10, `Today still has its headline: ${headline.slice(0, 60)}`);
await shot(page, "offline-today");

// Log a payment offline.
await page.getByRole("button", { name: "Log it" }).click();
await page.fill("#log-amount", "1860");
await page.fill('input[list="log-merchants"]', "Momo House");
await page.locator(".sheet-foot button.wide").click();
await page.waitForSelector("text=Saved on this phone", { timeout: 10000 });
ok(true, "the sheet says it is saved on the phone");
await shot(page, "offline-logged");
await page.keyboard.press("Escape");
await page.waitForSelector("text=On this phone", { timeout: 10000 });
const pending = await page.locator(".pending").innerText();
ok(pending.includes("Momo House") && pending.includes("1860"), "the book shows it at the top, not synced");
const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("fm:outbox") ?? "[]"));
ok(stored.length === 1 && stored[0].state === "queued", "one entry in the outbox");
await shot(page, "offline-pending", { fullPage: true });

// A second one, so the order matters.
await page.getByRole("button", { name: "Log it" }).click();
await page.fill("#log-amount", "250");
await page.fill('input[list="log-merchants"]', "Tea stall");
await page.locator(".sheet-foot button.wide").click();
await page.waitForSelector("text=Saved on this phone", { timeout: 10000 });
await page.keyboard.press("Escape");

// Back online: the outbox drains on its own.
await ctx.setOffline(false);
await page.waitForFunction(() => JSON.parse(localStorage.getItem("fm:outbox") ?? "[]").length === 0, null, { timeout: 20000 });
ok(true, "the outbox emptied when the connection returned");
const res = await page.request.get(`${BASE}/api/households/${hh}/transactions?month=${new Date().toISOString().slice(0, 7)}`);
const txs = await res.json();
const momo = txs.filter((t) => t.description === "Momo House");
const tea = txs.filter((t) => t.description === "Tea Stall" || t.description === "Tea stall");
ok(momo.length === 1 && momo[0].amountMinor === 186000 && tea.length === 1, "both payments are in the book, once each");
await page.waitForFunction(() => !document.querySelector(".pending"), null, { timeout: 15000 });
ok(true, "the book no longer shows them as pending");
await page.waitForFunction(() => !document.querySelector(".netbar"), null, { timeout: 15000 });
ok(true, "the bar is gone");
await shot(page, "online-synced", { fullPage: true });

// Offline again: a twin on replay waits for the family's call.
await ctx.setOffline(true);
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector(".netbar", { timeout: 15000 });
await page.getByRole("button", { name: "Log it" }).click();
await page.fill("#log-amount", "1860");
await page.fill('input[list="log-merchants"]', "Momo House");
await page.locator(".sheet-foot button.wide").click();
await page.waitForSelector("text=Saved on this phone", { timeout: 10000 });
await page.keyboard.press("Escape");
await ctx.setOffline(false);
await page.waitForSelector("text=Keep both", { timeout: 20000 });
ok(true, "a replayed double entry waits with Keep both / Drop it");
await shot(page, "twin-pending", { fullPage: true });
await page.getByRole("button", { name: /Drop it/ }).click();
await page.waitForFunction(() => !document.querySelector(".pending"), null, { timeout: 10000 });
const after = await (await page.request.get(`${BASE}/api/households/${hh}/transactions?month=${new Date().toISOString().slice(0, 7)}`)).json();
ok(after.filter((t) => t.description === "Momo House").length === 1, "dropping it leaves the book with one Momo House");

} catch (e) {
  await shot(page, "fail", { fullPage: true }).catch(() => undefined);
  console.log("sheet:", await page.locator(".sheet").innerText().catch(() => "(no sheet)"));
  console.log("errors:", errors.join(" | "));
  throw e;
}
await browser.close();
if (errors.length) throw new Error("page errors:\n" + errors.join("\n"));
console.log("\nOffline: all good.");
