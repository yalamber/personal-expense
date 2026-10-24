// The pages in a browser: Settings at both widths, skeletons while the API is slow, the warm
// return to a page, Today's headline arithmetic, Every month, Decide. Needs the seeded household.
import { BASE, SKIP, cookieFor, launch, ok, suiteArgs } from "./lib.mjs";

const { json, out } = suiteArgs();
const [{ hh, cookie }, every] = json;
const shot = (page, name, opts) => (out ? page.screenshot({ path: `${out}/${name}.png`, ...opts }) : Promise.resolve());
const browser = await launch();
if (!browser) {
  console.log("skip: no browser (install playwright and a chromium)");
  process.exit(SKIP);
}
const errors = [];
const cookies = cookieFor(cookie);

// Desktop: the settings sidebar, the app section, skeletons, the warm return.
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addCookies(cookies);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`desktop: ${e.message}`));
  await page.goto(`${BASE}/h/${hh}/settings`, { waitUntil: "networkidle" });
  ok((await page.locator('.settings-nav a[aria-current="page"]').innerText()) === "Household", "settings opens on Household with the menu beside it");
  await shot(page, "settings-desktop", { fullPage: true });
  await page.getByRole("link", { name: "The app" }).click();
  await page.waitForSelector("text=Check now");
  await shot(page, "settings-app-desktop", { fullPage: true });
  await page.getByRole("link", { name: "Accounts", exact: true }).first().click();
  await page.waitForSelector("h1:has-text('Accounts')");
  ok((await page.locator('.settings-nav a[aria-current="page"]').innerText()) === "Accounts", "the menu follows the section");

  const manifest = await (await page.request.get(`${BASE}/manifest.webmanifest`)).json();
  ok(manifest.shortcuts?.length === 2 && manifest.icons?.length === 3, "manifest has icons and shortcuts");
  const html = await (await page.request.get(`${BASE}/`)).text();
  ok(/fonts\.googleapis\.com[^>]*media="print"/.test(html), "fonts load without blocking the first paint");

  // Warm return: Today was seen, Plan opened, back to Today: no skeleton, data at once.
  await page.goto(`${BASE}/h/${hh}`, { waitUntil: "networkidle" });
  await page.getByRole("link", { name: "Plan", exact: true }).first().click();
  await page.waitForSelector(".road");
  const t0 = Date.now();
  await page.getByRole("link", { name: "Today", exact: true }).first().click();
  await page.waitForSelector(".hero h1");
  const ms = Date.now() - t0;
  const skNow = await page.locator(".sk").count();
  ok(skNow === 0 && ms < 400, `back to Today in ${ms}ms with no skeleton (${skNow} placeholders)`);
  await ctx.close();
}

// Skeletons: a slow API and nothing saved yet shows the page's shape, not a spinner. (With the
// worker's store in play the page would paint from it instead, so the worker is kept out here.)
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  await ctx.addCookies(cookies);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`skeleton: ${e.message}`));
  await page.route(/\/api\/households\/[^/?]+(\/today|\/plan|\/accounts)?$/, async (route) => {
    await new Promise((r) => setTimeout(r, 2500));
    await route.continue();
  });
  for (const [name, path] of [["today", ""], ["plan", "/plan"], ["settings", "/settings"]]) {
    await page.goto(`${BASE}/h/${hh}${path}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".sk", { timeout: 5000 });
    await page.waitForTimeout(250);
    const n = await page.locator(".sk").count();
    ok(n > 5, `${name}: ${n} placeholders in the page's own shape while the API is slow`);
    await shot(page, `skeleton-${name}`);
  }
  await ctx.close();
}

// Phone: the menu is the page; a section opens with a way back.
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await ctx.addCookies(cookies);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`phone: ${e.message}`));
  await page.goto(`${BASE}/h/${hh}/settings`, { waitUntil: "networkidle" });
  ok((await page.locator(".settings-menu").count()) === 4 && (await page.locator(".settings-nav").isVisible().catch(() => false)) === false, "phone shows the menu as the page");
  await shot(page, "settings-phone", { fullPage: true });
  await page.getByRole("link", { name: /Accounts/ }).click();
  await page.waitForSelector("h1:has-text('Accounts')");
  ok(await page.locator("a.back").isVisible(), "a section on the phone has a way back to Settings");
  await shot(page, "settings-accounts-phone", { fullPage: false });
  for (const [name, path] of [["today", ""], ["plan", "/plan"], ["khata", "/khata"], ["app", "/settings/app"]]) {
    await page.goto(`${BASE}/h/${hh}${path}`, { waitUntil: "networkidle" });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 0) errors.push(`phone ${name}: overflow ${overflow}px`);
  }
  await shot(page, "settings-app-phone", { fullPage: true });
  await ctx.close();
}

// Today explains its headline; Every month has its own page in Settings; Decide asks on the day.
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addCookies(cookies);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`every-month: ${e.message}`));
  await page.goto(`${BASE}/h/${hh}`, { waitUntil: "networkidle" });
  await page.locator(".how summary").click();
  const lines = (await page.locator(".how .sum > span").count()) / 2;
  ok(lines >= 5, `the headline opens into its arithmetic (${lines} lines)`);
  const card = await page.locator("section[aria-labelledby='coming-h']").innerText();
  ok(/Rent/.test(card) && /Salary/.test(card), "Today lists this month's bills and income");
  await shot(page, "today-how", { fullPage: true });
  await page.goto(`${BASE}/h/${hh}/settings/every-month`, { waitUntil: "networkidle" });
  await page.waitForSelector("h1:has-text('Every month')");
  ok((await page.locator('.settings-nav a[aria-current="page"]').innerText()) === "Every month", "Every month sits in the Settings menu");
  ok((await page.locator("text=Goes out").count()) > 0 && (await page.locator("text=Comes in").count()) > 0, "the page groups what goes out and what comes in");
  await shot(page, "every-month", { fullPage: true });
  await page.goto(`${BASE}/h/${hh}/decide`, { waitUntil: "networkidle" });
  ok((await page.locator("h1").first().innerText()) === "Decide", "Decide opens for the seeded household");
  await ctx.close();
}

// Decide asks about a bill past its day; one tap logs it, and Today then shows it in the book.
if (every) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addCookies(cookieFor(every.cookie));
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`decide: ${e.message}`));
  await page.goto(`${BASE}/h/${every.hh}/decide`, { waitUntil: "networkidle" });
  const card = page.locator(".decide-card").first();
  const text = await card.innerText();
  ok(/every month/i.test(text) && /Rent/.test(text) && /go out/.test(text), `Decide asks: ${text.split("\n")[1]}`);
  await shot(page, "decide-every-month", { fullPage: true });
  await card.getByRole("button", { name: /^Yes, log/ }).click();
  await page.waitForFunction(() => { const c = document.querySelector(".decide-card"); return !c || c.classList.contains("settled") || !c.innerText.includes("Rent"); }, null, { timeout: 10000 });
  ok(true, "one tap logs it and Decide moves on");
  await page.goto(`${BASE}/h/${every.hh}`, { waitUntil: "networkidle" });
  const coming = (await page.locator("section[aria-labelledby='coming-h']").innerText()).replace(/\s+/g, " ");
  ok(/Rent in the book/.test(coming), "and Today shows the rent in the book");
  await ctx.close();
}

await browser.close();
if (errors.length) throw new Error("page errors:\n" + errors.join("\n"));
console.log("\nPages: all good.");
