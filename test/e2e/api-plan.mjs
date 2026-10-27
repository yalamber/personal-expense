// Planning big purchases end to end: a goal part-borrowed (only the down payment saved), money
// moments (a yearly bonus, a wedding), and how the plan and Today see them. Runs against the Worker
// started by run.mjs.
import { addMonths, iso, newClient, ok } from "./lib.mjs";

const { call, signIn, state } = newClient(`plan-${Date.now()}@example.com`);
await signIn();
ok(state.cookie.length > 0, "signed in");
const hh = (await call("POST", "/api/households", { name: "Plan family", currency: "NPR", timezone: "UTC", memberName: "Tester" }, 201)).data.id;
const H = `/api/households/${hh}`;
const today = iso(new Date());
const month = (n) => addMonths(today, n).slice(0, 7);
const rs = (n) => n * 100;

await call("PATCH", H, { typicalIncome: "1900000", typicalSpend: "250000" }, 200);
await call("POST", `${H}/accounts`, { name: "Nabil savings", type: "savings", balance: "500000" }, 201);
const land = (await call("POST", `${H}/goals`, { name: "Land", kind: "purchase", target: "14,015,000", saved: "4,000,000", wantedBy: month(4) }, 201)).data.id;

let plan = (await call("GET", `${H}/plan`, null, 200)).data;
let g = plan.goals.find((x) => x.id === land);
ok(g.loan === null && Array.isArray(plan.events) && plan.events.length === 0, "a new goal is saved for in full, with no money moments yet");
ok(plan.spareMinor === rs(1_650_000), `a usual month leaves ${plan.spareMinor / 100} spare for the plan`);

// --- Save part, borrow the rest ---
ok((await call("PATCH", `${H}/goals/${land}`, { loan: { amount: "15,000,000", rate: "11", years: 10 } })).status === 400, "a loan bigger than the price is refused");
ok((await call("PATCH", `${H}/goals/${land}`, { loan: { amount: "6000000", rate: "abc", years: 10 } })).status === 400, "a rate has to be a number");
ok((await call("PATCH", `${H}/goals/${land}`, { loan: { amount: "6000000", rate: "11", years: 0 } })).status === 400, "and the term at least a month");
await call("PATCH", `${H}/goals/${land}`, { loan: { amount: "6,000,000", rate: "11", years: 10 } }, 200);
plan = (await call("GET", `${H}/plan`, null, 200)).data;
g = plan.goals.find((x) => x.id === land);
ok(g.loan && g.loan.amountMinor === rs(6_000_000) && g.loan.rateBp === 1100 && g.loan.months === 120, "the loan plan is kept: Rs 60,00,000 at 11% over 10 years");
const t = (await call("GET", `${H}/today`, null, 200)).data;
ok(t.nextGoal && t.nextGoal.id === land, "Today still shows Land as next on the road");
await call("PATCH", `${H}/goals/${land}`, { loan: null }, 200);
ok((await call("GET", `${H}/goals`, null, 200)).data.find((x) => x.id === land).loan === null, "and can be cleared");
await call("PATCH", `${H}/goals/${land}`, { loan: { amount: "6000000", rate: "0", years: 5 } }, 200);
ok((await call("GET", `${H}/goals`, null, 200)).data.find((x) => x.id === land).loan.rateBp === 0, "a loan from family at no interest is fine too");
const car = (await call("POST", `${H}/goals`, { name: "Scooter", kind: "purchase", target: "300000", monthly: "10000", loan: { amount: "150000", rate: "13", years: 2 } }, 201)).data.id;

// What actually came in against the plan: this pay period on each goal, and the usual month once a period has finished.
await call("POST", `${H}/goals/${car}/contributions`, { amount: "4,000", date: iso(new Date()), kind: "saved" }, 201);
plan = (await call("GET", `${H}/plan`, null, 200)).data;
g = plan.goals.find((x) => x.id === car);
ok(plan.period && plan.period.from <= plan.today && plan.today <= plan.period.to, `the plan says which pay period its figures cover (${plan.period.from} to ${plan.period.to})`);
ok(g.inPeriodMinor === rs(4000) && g.monthlyPlanMinor === rs(10000), "a goal says what came in this pay period against its monthly plan");
ok(g.usualMonthlyMinor === null && g.usualPeriods === 0, "and has no usual month until a pay period has finished since it began");
ok(plan.goals.find((x) => x.id === land).inPeriodMinor === 0, "a goal nothing went into says so");
ok((await call("GET", `${H}/goals`, null, 200)).data.find((x) => x.id === car).loan.months === 24, "a goal can be created with its loan");

// --- Money moments ---
ok((await call("POST", `${H}/plan-events`, { name: "", direction: "in", amount: "1000", month: month(1) })).status === 400, "a moment needs a name");
ok((await call("POST", `${H}/plan-events`, { name: "Bonus", direction: "in", amount: "0", month: month(1) })).status === 400, "and an amount");
ok((await call("POST", `${H}/plan-events`, { name: "Bonus", direction: "in", amount: "1000", month: "2027-13" })).status === 400, "and a real month");
const bonus = (await call("POST", `${H}/plan-events`, { name: "Dashain bonus", direction: "in", amount: "2,00,000", month: month(2), yearly: true }, 201)).data.id;
const wedding = (await call("POST", `${H}/plan-events`, { name: "Sister's wedding", direction: "out", amount: "500000", month: month(6) }, 201)).data.id;
const gift = (await call("POST", `${H}/plan-events`, { name: "Gift from Ba", direction: "in", amount: "100000", month: month(1), goalId: land }, 201)).data.id;
plan = (await call("GET", `${H}/plan`, null, 200)).data;
const ev = (id) => plan.events.find((e) => e.id === id);
ok(ev(bonus).amountMinor === rs(200_000) && ev(bonus).yearly === true, "money in is kept positive, yearly");
ok(ev(wedding).amountMinor === -rs(500_000) && ev(wedding).yearly === false, "money out is kept negative");
ok(ev(gift).goalId === land, "money in can be meant for one goal");
ok(plan.events.map((e) => e.id).join() === [gift, bonus, wedding].join(), "moments come back in month order");
await call("PATCH", `${H}/plan-events/${wedding}`, { direction: "in" }, 200);
plan = (await call("GET", `${H}/plan`, null, 200)).data;
ok(ev(wedding).amountMinor === rs(500_000), "flipping the direction keeps the amount");
await call("PATCH", `${H}/plan-events/${wedding}`, { direction: "out", amount: "650000", untilMonth: null }, 200);
plan = (await call("GET", `${H}/plan`, null, 200)).data;
ok(ev(wedding).amountMinor === -rs(650_000), "and the amount can change with it");
ok((await call("POST", `${H}/plan-events`, { name: "X", direction: "in", amount: "1", month: month(1), goalId: "nope" })).status === 400, "an unknown goal is refused");
await call("DELETE", `${H}/plan-events/${gift}`, null, 200);
plan = (await call("GET", `${H}/plan`, null, 200)).data;
ok(!plan.events.some((e) => e.id === gift) && plan.events.length === 2, "a moment can be taken off the plan");
ok((await call("DELETE", `${H}/plan-events/${gift}`)).status === 404, "once");
ok((await call("GET", `${H}/today`, null, 200)).data.nextGoal.id === land, "Today runs the plan with the moments in it");

console.log(`\nPlanning: all good. Household ${hh}`);
console.log(JSON.stringify({ hh, cookie: state.cookie, land }));
