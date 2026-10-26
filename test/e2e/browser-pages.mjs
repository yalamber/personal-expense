// The pages in a browser: Settings at both widths, skeletons while the API is slow, the warm
// return to a page, Today's headline arithmetic, Every month, Decide. Needs the seeded household.
import { BASE, SKIP, cookieFor, launch, ok, sqlLocal, suiteArgs } from "./lib.mjs";

const { json, out } = suiteArgs();
const [{ hh, cookie, hari }, every] = json;
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

// Terms in the khata: the list says when, the contact's page shows the interest, Decide reminds.
if (hari) {
  for (const [label, viewport] of [["desktop", { width: 1280, height: 900 }], ["phone", { width: 390, height: 844 }]]) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: label === "phone" ? 2 : 1 });
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(`terms ${label}: ${e.message}`));
    await page.goto(`${BASE}/h/${hh}/khata`, { waitUntil: "networkidle" });
    const row = page.locator("a.khata-row").filter({ hasText: "Hari dai" });
    const due = await row.locator(".due").innerText();
    ok(/pay back by .*in 5 days/.test(due) && /1\.5% a month/.test(due), `${label}: the khata list says when and at what rate (${due})`);
    await shot(page, `khata-terms-${label}`, { fullPage: true });
    await row.click();
    await page.locator("dl.terms").waitFor({ timeout: 10000 });
    const terms = (await page.locator("section[aria-labelledby='terms-h']").innerText()).replace(/\s+/g, " ");
    ok(/Pay back by/.test(terms) && /1\.5% a month/.test(terms) && /Interest so far/.test(terms) && /To settle on/.test(terms), `${label}: the contact's page shows the terms and the interest`);
    ok((await page.getByRole("button", { name: /interest to the khata/ }).count()) === 1, `${label}: with a way to add the interest to the khata`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok(overflow <= 0, `${label}: nothing runs off the side`);
    await shot(page, `khata-contact-terms-${label}`, { fullPage: true });
    if (label === "phone") {
      await page.getByRole("button", { name: "Edit" }).click();
      await page.locator(".terms-editor").waitFor({ timeout: 5000 });
      ok((await page.locator(".terms-editor input[type=date]").first().inputValue()).length === 10, "phone: the edit sheet opens with the terms filled in");
      await shot(page, "khata-edit-terms-phone");
      await page.keyboard.press("Escape");
      await page.goto(`${BASE}/h/${hh}/decide`, { waitUntil: "networkidle" });
      let found = false;
      for (let i = 0; i < 8 && !found; i++) {
        const card = page.locator(".decide-card").first();
        if ((await card.getAttribute("aria-label")) === "Money to settle") {
          found = true;
          const text = await card.innerText();
          ok(/Pay Hari dai back/.test(text) && /interest/.test(text), "phone: Decide asks to pay Hari dai back, with the interest");
          await shot(page, "decide-settle-phone", { fullPage: true });
          break;
        }
        const skip = card.getByRole("button", { name: /^(Later|Not yet|Leave it for later)$/ });
        if (!(await skip.count())) break;
        await skip.first().click();
      }
      ok(found, "phone: the settle card is among the decisions");
    }
    await ctx.close();
  }
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

// An email from a new sender: Decide shows where it came from, what it says, and the likely account.
if (every) {
  const hhInfo = await (await fetch(`${BASE}/api/households/${every.hh}`, { headers: { cookie: every.cookie } })).json();
  const to = hhInfo.inboundAddress;
  const eml = [
    "From: Nabil Bank <txn-alert@nabilbank.com>",
    `To: ${to}`,
    "Subject: Transaction Alert",
    `Date: ${new Date().toUTCString()}`,
    "Message-ID: <browser-held-1@e2e.example>",
    "X-Forwarded-For: family@example.com " + to,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Dear Customer,",
    "",
    "Your account 01010XXXXXX89 has been debited by NPR 1,500.00 on 26/10/2026 14:03:11.",
    "Remarks: ESEWA LOAD 9841XXXXXX",
    "Available Balance: NPR 1,23,456.78",
  ].join("\r\n");
  const r = await fetch(`${BASE}/cdn-cgi/handler/email?from=${encodeURIComponent("postmaster@mail-wr1-x436.google.com")}&to=${encodeURIComponent(to)}`, { method: "POST", body: eml });
  ok(r.status < 300, "a forwarded alert from a new sender arrives");
  await new Promise((res) => setTimeout(res, 1200));

  for (const [label, viewport] of [["desktop", { width: 1280, height: 900 }], ["phone", { width: 390, height: 844 }]]) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: label === "phone" ? 2 : 1 });
    await ctx.addCookies(cookieFor(every.cookie));
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(`mail ${label}: ${e.message}`));
    await page.goto(`${BASE}/h/${every.hh}/decide`, { waitUntil: "networkidle" });
    const card = page.locator(".decide-card").first();
    await card.locator(".mail-meta").waitFor({ timeout: 10000 });
    const text = await card.innerText();
    ok(/Transaction Alert from Nabil Bank/.test(text) && /Which account is it about/.test(text), `${label}: the card names the email and its sender`);
    ok(/txn-alert@nabilbank\.com/.test(text) && /Forwarded by/.test(text) && /family@example\.com/.test(text), `${label}: where it came from and who forwarded it`);
    ok(/ESEWA LOAD/.test(text) && /1,500/.test(text) && /Money out/.test(text), `${label}: what the app can read from it`);
    ok((await card.locator(".mail-text").innerText()).includes("Available Balance"), `${label}: the email itself`);
    ok((await card.locator("label.pick").count()) >= 1 && /Remember/.test(text), `${label}: the accounts to choose from, and remembering the sender`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok(overflow <= 0, `${label}: nothing runs off the side`);
    await shot(page, `decide-mail-${label}`, { fullPage: true });
    if (label === "phone") {
      await card.getByRole("button", { name: /^Read it for / }).click();
      await page.waitForFunction(() => !document.querySelector(".decide-card .mail-meta"), null, { timeout: 10000 });
      ok(true, "phone: one tap links it and Decide moves on");
      await page.goto(`${BASE}/h/${every.hh}/settings/inbox`, { waitUntil: "networkidle" });
      const row = page.locator("button.mail-row").filter({ hasText: "Transaction Alert" }).first();
      const rowText = (await row.innerText()).replace(/\s+/g, " ");
      ok(/lines in decide|in the book/i.test(rowText), `the Inbox shows it read: ${rowText}`);
      await row.click();
      await page.locator(".mail-open .mail-meta").waitFor({ timeout: 10000 });
      ok(/ESEWA LOAD/.test(await page.locator(".mail-open").innerText()), "and opens to the same details");
      await shot(page, "inbox-open-phone", { fullPage: true });

      // One the readers cannot place: the Inbox says why and lets a person say what it is.
      const vague = eml.replace("browser-held-1", "browser-vague-1").replace(/Dear Customer,[\s\S]*$/, "Dear Customer, fund transfer of NPR 7,500.00 to RAM BAHADUR on 25/10/2026.");
      await fetch(`${BASE}/cdn-cgi/handler/email?from=${encodeURIComponent("postmaster@mail-wr1-x436.google.com")}&to=${encodeURIComponent(to)}`, { method: "POST", body: vague });
      await new Promise((res) => setTimeout(res, 1500));
      await page.reload({ waitUntil: "networkidle" });
      const unread = page.locator("button.mail-row").filter({ hasText: "not read" }).first();
      await unread.click();
      const form = page.locator("form.fill-by-hand");
      await form.waitFor({ timeout: 10000 });
      const open = (await page.locator(".mail-open").innerText()).replace(/\s+/g, " ");
      ok(/Not read\. It has an amount, 7,500\.00/.test(open), "phone: an unread email says why");
      ok((await form.locator("input[inputmode=decimal]").inputValue()) === "7500" && (await form.locator("input[type=date]").inputValue()) === "2026-10-25", "phone: the form starts from the amount and date it found");
      ok(await form.getByRole("button", { name: "Choose money out or in" }).isDisabled(), "phone: it asks which way the money went");
      await form.getByRole("button", { name: "Money out", exact: true }).click();
      await form.locator("input").last().fill("Ram Bahadur");
      await shot(page, "inbox-fill-phone", { fullPage: true });
      await form.getByRole("button", { name: "Add it as money out" }).click();
      await page.locator(".mail-open .ok").waitFor({ timeout: 10000 });
      ok(/waits in Decide/.test(await page.locator(".mail-open .ok").innerText()), "phone: filled in, it waits in Decide");
      const overflow2 = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      ok(overflow2 <= 0, "phone: the form fits the screen");

      // One stored as unread that today's readers can read: the Inbox asks only "is this right?".
      const readable = eml.replace("browser-held-1", "browser-ready-1").replace("NPR 1,500.00", "NPR 2,200.00").replace("ESEWA LOAD 9841XXXXXX", "KHALTI LOAD");
      await fetch(`${BASE}/cdn-cgi/handler/email?from=${encodeURIComponent("postmaster@mail-wr1-x436.google.com")}&to=${encodeURIComponent(to)}`, { method: "POST", body: readable });
      await new Promise((res) => setTimeout(res, 2000));
      sqlLocal(`DELETE FROM import_lines WHERE statement_email_id IN (SELECT id FROM statement_emails WHERE message_id LIKE '%browser-ready-1%'); UPDATE statement_emails SET status = 'unparsed', error = 'read by an older reader', processed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE message_id LIKE '%browser-ready-1%'`);
      await page.reload({ waitUntil: "networkidle" });
      await page.locator("button.mail-row").filter({ hasText: "not read" }).first().click();
      const ready = page.locator("section[aria-label='Ready to add']");
      await ready.waitFor({ timeout: 10000 });
      const readyText = (await ready.innerText()).replace(/\s+/g, " ");
      ok(/KHALTI LOAD/.test(readyText) && /2,200/.test(readyText) && /Money out/.test(readyText), `phone: it shows what it read, money out and the amount (${readyText.slice(0, 80)})`);
      ok((await page.locator("form.fill-by-hand").count()) === 0, "phone: and does not ask to fill anything in");
      await shot(page, "inbox-ready-phone", { fullPage: true });
      await ready.getByRole("button", { name: "Yes, add it" }).click();
      await page.locator(".mail-open .ok").waitFor({ timeout: 10000 });
      ok(/waits in Decide/.test(await page.locator(".mail-open .ok").innerText()), "phone: one tap adds it");

      await page.goto(`${BASE}/h/${every.hh}/settings/household`, { waitUntil: "networkidle" });
      const aiCard = page.locator("section[aria-labelledby=ai-h]");
      ok(/AI help/.test(await aiCard.innerText()) && (await aiCard.locator("input[type=checkbox]").isChecked()), "phone: AI help is in Settings, on");
    }
    await ctx.close();
  }
}

await browser.close();
if (errors.length) throw new Error("page errors:\n" + errors.join("\n"));
console.log("\nPages: all good.");
