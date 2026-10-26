// Every month, end to end: items, where each stands in the month, what Today sets aside and
// expects, Decide's question on the day, logging, "already in the book", skipping, pausing, and
// the headline's modes. Runs against the local Worker started by run.mjs.
import { BASE, addDays, iso, newClient, ok } from "./lib.mjs";

const { call, signIn, state } = newClient(`every-${Date.now()}@example.com`);
await signIn();
ok(state.cookie.length > 0, "signed in");

const hh = (await call("POST", "/api/households", { name: "Every month family", currency: "NPR", timezone: "UTC", memberName: "Tester" }, 201)).data.id;
const H = `/api/households/${hh}`;
const today = iso(new Date());
const month = today.slice(0, 7);
const dom = Number(today.slice(8));
const rs = (n) => n * 100;
const wholeRupees = (minor, days) => Math.floor(Math.max(0, minor) / days / 100) * 100;

const salary = (await call("POST", `${H}/accounts`, { name: "Salary account", type: "checking", balance: "250000", balanceDate: addDays(today, -5) }, 201)).data.id;
const cats = (await call("GET", `${H}/categories`, null, 200)).data;
const housing = cats.find((c) => !c.parentId && c.name === "Housing")?.id ?? cats.find((c) => c.kind === "need")?.id;
const incomeCat = cats.find((c) => c.kind === "income" && c.parentId)?.id ?? cats.find((c) => c.kind === "income")?.id;

// --- Setting up ---
ok((await call("POST", `${H}/recurring`, { name: "", direction: "out", amount: "100", dayOfMonth: 1 })).status === 400, "an item needs a name");
ok((await call("POST", `${H}/recurring`, { name: "Rent", direction: "out", amount: "0", dayOfMonth: 1 })).status === 400, "and an amount");
ok((await call("POST", `${H}/recurring`, { name: "Rent", direction: "out", amount: "25000", dayOfMonth: 31 })).status === 400, "and a day every month has");
const rent = (await call("POST", `${H}/recurring`, { name: "Rent", direction: "out", amount: "25,000", dayOfMonth: 1, categoryId: housing, accountId: salary }, 201)).data.id;
const pay = (await call("POST", `${H}/recurring`, { name: "Salary", direction: "in", amount: "90000", dayOfMonth: 7, categoryId: incomeCat }, 201)).data.id;
const net = (await call("POST", `${H}/recurring`, { name: "Internet", direction: "out", amount: "1500", dayOfMonth: 28, accountId: salary }, 201)).data.id;
const expectState = (day) => (day <= dom ? "due" : "upcoming");

let list = (await call("GET", `${H}/recurring`, null, 200)).data;
ok(list.map((r) => r.name).join(",") === "Rent,Salary,Internet", "items come back in the order of the month");
ok(list[0].status.state === expectState(1) && list[0].status.due === `${month}-01`, `Rent is ${expectState(1)} on the 1st`);
ok(list[1].status.state === expectState(7) && list[2].status.state === expectState(28), `Salary is ${expectState(7)}, Internet ${expectState(28)}`);
ok((await call("GET", `${H}/recurring?month=nope`)).status === 400, "a bad month is refused");

// --- Today sets bills aside; income still to come is shown, not counted ---
let t = (await call("GET", `${H}/today`, null, 200)).data;
ok(t.billsMinor === rs(26_500), `bills still to come: ${t.billsMinor / 100} (rent and internet)`);
ok(t.incomeMinor === 0 && t.expectedLaterMinor === rs(90_000), "the salary still to come is shown as expected, not counted");
ok(t.mode === "waiting" && t.perDayMinor === 0 && t.everydayLeftMinor === -rs(26_500), "with nothing in yet, the headline waits and the day figure is nil");
ok(t.comingUp.length === 3 && t.comingUp.every((r) => r.state === expectState(r.due.slice(8) * 1)), "Today lists all three for its card");

const hints = (await call("GET", `${H}/log-hints`, null, 200)).data;
ok(hints.recurring.length === 3 && hints.recurring[0].name === "Rent", "the Log sheet gets the open items as chips");

let cards = (await call("GET", `${H}/decide`, null, 200)).data.filter((c) => c.kind === "recurring");
const dueNow = [1, 7, 28].filter((d) => d <= dom).length;
ok(cards.length === dueNow, `Decide asks about the ${dueNow} past their day`);
if (dueNow) ok(cards[0].key === `recurring:${rent}:${month}` && cards[0].accountId === salary && cards[0].due === `${month}-01`, "the rent card carries its account and day");

// --- Logging the rent from Decide ---
const posted = (await call("POST", `${H}/recurring/${rent}/post`, {}, 201)).data;
let txs = (await call("GET", `${H}/transactions?month=${month}`, null, 200)).data;
const rentTx = txs.find((x) => x.id === posted.id);
ok(rentTx && rentTx.source === "recurring" && rentTx.recurringId === rent && rentTx.amountMinor === rs(25_000) && rentTx.categoryId === housing && rentTx.accountId === salary, "the rent is in the book as this month's instance, with its category and account");
ok((await call("POST", `${H}/recurring/${rent}/post`, {})).status === 409, "it cannot be logged twice in a month");
list = (await call("GET", `${H}/recurring`, null, 200)).data;
ok(list[0].status.state === "posted" && list[0].status.transactionId === posted.id, "the list shows the rent as posted");
t = (await call("GET", `${H}/today`, null, 200)).data;
ok(t.billsMinor === rs(1_500) && t.spentMinor === rs(25_000), "paid, it moves from bills to come into spent");
ok(t.incomeMinor === 0 && t.perDayMinor === 0 && t.mode === "waiting", "still nothing in, so still no day figure");

// --- The salary needs an account when the item has none ---
const noAcct = await call("POST", `${H}/recurring/${pay}/post`, {});
ok(noAcct.status === 400 && /account/.test(noAcct.data.error), "income with no account set asks for one");
await call("POST", `${H}/recurring/${pay}/post`, { accountId: salary, date: today }, 201);
t = (await call("GET", `${H}/today`, null, 200)).data;
ok(t.incomeMinor === rs(90_000) && t.expectedLaterMinor === 0 && t.mode === "ok", "once the salary is in the book it counts, and the headline is plain");
ok(t.perDayMinor === wholeRupees(rs(90_000) - rs(25_000) - rs(1_500), t.daysLeft), `${t.perDayMinor / 100} a day: (90,000 − 25,000 − 1,500) over ${t.daysLeft} days, whole rupees`);

// --- Skip, undo, handled outside the book ---
await call("POST", `${H}/recurring/${net}/skip`, {}, 200);
list = (await call("GET", `${H}/recurring`, null, 200)).data;
ok(list[2].status.state === "skipped", "Internet skipped this month");
t = (await call("GET", `${H}/today`, null, 200)).data;
ok(t.billsMinor === 0, "a skipped bill is not set aside");
await call("POST", `${H}/recurring/${net}/undo`, {}, 200);
list = (await call("GET", `${H}/recurring`, null, 200)).data;
ok(list[2].status.state === expectState(28), "undo brings it back");
await call("POST", `${H}/recurring/${net}/done`, {}, 200);
ok((await call("GET", `${H}/recurring`, null, 200)).data[2].status.state === "done", "or it can be marked handled outside the book");
await call("POST", `${H}/recurring/${net}/undo`, {}, 200);

// --- "It is already in the book": a manual entry becomes the instance ---
const manual = (await call("POST", `${H}/transactions`, { date: today, amount: "1,480", direction: "out", accountId: salary, categoryId: null, description: "Worldlink", force: true }, 201)).data;
ok(manual.recurringId === null, "a close but different amount is not linked on its own");
const cands = (await call("GET", `${H}/recurring/${net}/candidates`, null, 200)).data;
ok(cands.some((c) => c.id === manual.id), "but it is offered as a candidate (within a tenth of the amount)");
await call("POST", `${H}/recurring/${net}/done`, { transactionId: manual.id }, 200);
txs = (await call("GET", `${H}/transactions?month=${month}`, null, 200)).data;
ok(txs.find((x) => x.id === manual.id).recurringId === net, "picking it links the entry");
ok((await call("GET", `${H}/recurring`, null, 200)).data[2].status.state === "posted", "and Internet counts as posted");
ok((await call("POST", `${H}/recurring/${net}/post`, {})).status === 409, "so it cannot be posted again");
const other = (await call("POST", `${H}/recurring`, { name: "Water", direction: "out", amount: "600", dayOfMonth: 5 }, 201)).data.id;
ok((await call("POST", `${H}/recurring/${other}/done`, { transactionId: manual.id })).status === 409, "an entry stands for one item only");

// --- The Log sheet: a chip sets recurringId; the same name and amount links on its own ---
const gym = (await call("POST", `${H}/recurring`, { name: "Gym", direction: "out", amount: "3000", dayOfMonth: 5, accountId: salary }, 201)).data.id;
const viaChip = (await call("POST", `${H}/transactions`, { date: today, amount: "3000", direction: "out", accountId: salary, categoryId: null, description: "Gym", recurringId: gym }, 201)).data;
ok(viaChip.recurringId === gym, "logging with the chip links it");
const school = (await call("POST", `${H}/recurring`, { name: "School fees", direction: "out", amount: "12000", dayOfMonth: 10 }, 201)).data.id;
const auto = (await call("POST", `${H}/transactions`, { date: today, amount: "12000", direction: "out", accountId: salary, categoryId: null, description: "school fees" }, 201)).data;
ok(auto.recurringId === school, "the same name and amount, logged without the chip, is linked on its own");
ok((await call("POST", `${H}/transactions`, { date: today, amount: "1", direction: "out", accountId: salary, categoryId: null, description: "x", recurringId: "nope" })).status === 404, "an unknown item is refused");

// --- Edit, pause, remove ---
await call("PATCH", `${H}/recurring/${other}`, { amount: "650", dayOfMonth: 6, name: "Water bill" }, 200);
list = (await call("GET", `${H}/recurring`, null, 200)).data;
const water = list.find((r) => r.id === other);
ok(water.name === "Water bill" && water.amountMinor === rs(650) && water.dayOfMonth === 6, "an item can be changed");
ok((await call("PATCH", `${H}/recurring/${other}`, { dayOfMonth: 29 })).status === 400, "but not onto a day some months lack");
await call("PATCH", `${H}/recurring/${other}`, { active: false }, 200);
list = (await call("GET", `${H}/recurring`, null, 200)).data;
ok(list.find((r) => r.id === other).status.state === "paused", "paused items say so");
t = (await call("GET", `${H}/today`, null, 200)).data;
ok(t.billsMinor === 0, "and are not set aside");
await call("DELETE", `${H}/recurring/${gym}`, null, 200);
list = (await call("GET", `${H}/recurring`, null, 200)).data;
ok(!list.some((r) => r.id === gym), "a removed item leaves the list");
txs = (await call("GET", `${H}/transactions?month=${month}`, null, 200)).data;
ok(txs.find((x) => x.id === viaChip.id).recurringId === gym, "its entries keep their link");
ok((await call("GET", `${H}/recurring/${gym}/candidates`)).status === 404, "and it cannot be acted on");

// --- Removing the entry from the book makes the month open again ---
await call("DELETE", `${H}/transactions/${posted.id}`, null, 200);
list = (await call("GET", `${H}/recurring`, null, 200)).data;
ok(list[0].status.state === expectState(1), "with the rent entry removed, the rent is open again");

// --- Correcting an entry: amount, date and name ---
await call("PATCH", `${H}/transactions/${viaChip.id}`, { amount: "3,200", date: addDays(today, -2), description: "Gym (annual)" }, 200);
txs = (await call("GET", `${H}/transactions?month=${month}`, null, 200)).data;
const fixed = txs.find((x) => x.id === viaChip.id);
ok(fixed.amountMinor === rs(3_200) && fixed.date === addDays(today, -2) && fixed.description === "Gym (annual)", "an entry's amount, date and name can be corrected");

// --- The headline's other modes: a usual month typed in is never counted as income ---
const b = (await call("POST", "/api/households", { name: "Usual family", currency: "NPR", timezone: "UTC", memberName: "Tester" }, 201)).data.id;
const B = `/api/households/${b}`;
await call("POST", `${B}/accounts`, { name: "Bank", type: "checking", balance: "100000" }, 201);
await call("PATCH", B, { typicalIncome: "1900000", typicalSpend: "0" }, 200);
t = (await call("GET", `${B}/today`, null, 200)).data;
ok(t.mode === "nothing" && t.incomeMinor === 0 && t.perDayMinor === 0, "a usual month of Rs 19,00,000 with nothing logged gives no day figure");
const bank = (await call("GET", `${B}/accounts`, null, 200)).data[0].id;
await call("POST", `${B}/transactions`, { date: today, amount: "120000", direction: "in", accountId: bank, categoryId: null, description: "Salary" }, 201);
t = (await call("GET", `${B}/today`, null, 200)).data;
ok(t.mode === "unplanned" && t.incomeMinor === rs(120_000) && t.perDayMinor === wholeRupees(rs(120_000), t.daysLeft), "income in and nothing set aside reads as 'unplanned'");
await call("POST", `${B}/goals`, { name: "Land", kind: "purchase", target: "2500000", monthly: "20000" }, 201);
t = (await call("GET", `${B}/today`, null, 200)).data;
ok(t.mode === "ok" && t.goalsMinor === rs(20_000) && t.perDayMinor === wholeRupees(rs(100_000), t.daysLeft), "a monthly amount for a goal turns it into a plan");
ok((await fetch(`${BASE}${B}/today`, { headers: { cookie: state.cookie } })).status === 200, "plain fetch with the cookie works too");

console.log(`\nEvery month: all good. Household ${hh}`);
console.log(JSON.stringify({ hh, cookie: state.cookie }));
