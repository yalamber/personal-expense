// Planning in a browser: the Plan's road with a part-borrowed goal and money moments, a goal's ways
// to get there and how it is paid for, and "what if we pay more" on a loan. Needs the household
// from api-plan (and the seeded one for the loan).
import { BASE, SKIP, cookieFor, launch, ok, suiteArgs } from "./lib.mjs";

const { json, out } = suiteArgs();
const [plan, rich] = json;
if (!plan) {
  console.log("skip: needs the household from api-plan");
  process.exit(SKIP);
}
const shot = (page, name, opts) => (out ? page.screenshot({ path: `${out}/${name}.png`, ...opts }) : Promise.resolve());
const browser = await launch();
if (!browser) {
  console.log("skip: no browser (install playwright and a chromium)");
  process.exit(SKIP);
}
const errors = [];

for (const [label, viewport] of [["desktop", { width: 1280, height: 900 }], ["phone", { width: 390, height: 844 }]]) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: label === "phone" ? 2 : 1 });
  await ctx.addCookies(cookieFor(plan.cookie));
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${label}: ${e.message}`));

  await page.goto(`${BASE}/h/${plan.hh}/plan`, { waitUntil: "networkidle" });
  await page.locator(".road").waitFor({ timeout: 10000 });
  const road = (await page.locator(".road").innerText()).replace(/\s+/g, " ");
  ok(/Scooter: bought, Rs 1,50,000 borrowed|Scooter: bought, Rs 150,000 borrowed/.test(road), `${label}: the road shows the scooter bought with its loan`);
  ok(/Scooter loan repaid/.test(road), `${label}: and when that loan is repaid`);
  ok(/Dashain bonus/.test(road) && /Sister's wedding/.test(road), `${label}: money moments are on the road`);
  ok((await page.locator("a.banner").filter({ hasText: "Ways to get Land there" }).count()) === 1, `${label}: a late goal offers ways to get there`);
  const moments = await page.locator("section[aria-labelledby='moments-h']").innerText();
  ok(/Dashain bonus/.test(moments) && /every/.test(moments) && /650,000|6,50,000/.test(moments), `${label}: the money moments card lists them`);
  ok(/If our income rises/.test(await page.locator("body").innerText()), `${label}: pay rises can be tried`);
  let overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok(overflow <= 0, `${label}: the plan fits the screen`);
  await shot(page, `plan-${label}`, { fullPage: true });

  await page.goto(`${BASE}/h/${plan.hh}/plan/goals/${plan.land}`, { waitUntil: "networkidle" });
  await page.locator("#ways-h").waitFor({ timeout: 10000 });
  const ways = (await page.locator("section[aria-labelledby='ways-h']").innerText()).replace(/\s+/g, " ");
  ok(/Save more each month/.test(ways) && /Put the spare money in/.test(ways) && /Borrow what is missing/.test(ways), `${label}: the goal shows three ways to get there`);
  const pay = (await page.locator("#how-we-pay").innerText()).replace(/\s+/g, " ");
  ok(/Installment/.test(pay) && /Save first/.test(pay) && /Of a usual month's income/.test(pay), `${label}: how it is paid for shows the installment and its share of income`);
  overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok(overflow <= 0, `${label}: the goal page fits the screen`);
  await shot(page, `goal-ways-${label}`, { fullPage: true });
  if (label === "phone") {
    await page.getByRole("button", { name: "Plan the loan" }).click();
    await page.waitForTimeout(400);
    const amount = await page.locator("#loan-amount").inputValue();
    ok(amount.length > 0 && amount !== "6000000", `phone: "Plan the loan" fills in what is missing (${amount})`);
    await shot(page, "goal-borrow-phone", { fullPage: true });
    await page.goto(`${BASE}/h/${plan.hh}/plan`, { waitUntil: "networkidle" });
    await page.locator("section[aria-labelledby='moments-h']").getByRole("button", { name: "Add one" }).click();
    await page.locator(".sheet").waitFor({ timeout: 5000 });
    ok((await page.locator(".sheet").innerText()).includes("Money comes in"), "phone: a money moment opens in a sheet");
    await shot(page, "moment-sheet-phone");
  }
  await ctx.close();
}

if (rich) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addCookies(cookieFor(rich.cookie));
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`loan: ${e.message}`));
  await page.goto(`${BASE}/h/${rich.hh}/settings/accounts`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "What if we pay more?" }).first().click();
  await page.getByLabel("Extra each month").fill("10000");
  const panel = (await page.locator("dl.terms").first().innerText()).replace(/\s+/g, " ");
  ok(/As it is/.test(panel) && /sooner/.test(panel) && /less interest/.test(panel), "paying Rs 10,000 more on the home loan shows the months and interest saved");
  await shot(page, "loan-pay-more", { fullPage: true });
  await ctx.close();
}

await browser.close();
if (errors.length) throw new Error("page errors:\n" + errors.join("\n"));
console.log("\nPlanning in the browser: all good.");
