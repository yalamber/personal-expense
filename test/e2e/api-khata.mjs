// End to end: baina and payments toward a goal, the khata (what we owe each person and they owe
// us), and offline replay with Idempotency-Key. Runs against the Worker from run.mjs.
import { BASE, LOG, addDays, addMonths, iso, newClient, ok, sleep } from "./lib.mjs";

const { call, signIn, state } = newClient(`khata-${Date.now()}@example.com`);
await signIn();
ok(state.cookie.length > 0, "signed in");

const hh = (await call("POST", "/api/households", { name: "Khata family", currency: "NPR", timezone: "UTC", memberName: "Tester" }, 201)).data.id;
const H = `/api/households/${hh}`;
const today = iso(new Date());
const salary = (await call("POST", `${H}/accounts`, { name: "Salary account", type: "checking", balance: "250000", balanceDate: addDays(today, -5) }, 201)).data.id;
const savings = (await call("POST", `${H}/accounts`, { name: "Land savings", type: "savings", balance: "1000000" }, 201)).data.id;
const bal = async (id) => (await call("GET", `${H}/accounts`, null, 200)).data.find((a) => a.id === id).balanceMinor;
const goalOf = async (id) => (await call("GET", `${H}/goals`, null, 200)).data.find((g) => g.id === id);

// --- Baina toward the land ---
const land = (await call("POST", `${H}/goals`, { name: "Land", kind: "purchase", target: "2500000", monthly: "20000", paid: "300000" }, 201)).data.id;
let g = await goalOf(land);
ok(g.paidMinor === 30_000_000 && g.heldMinor === 0 && g.savedMinor === 30_000_000, "a baina given before the book counts toward Land as paid, not held");
const p1 = (await call("POST", `${H}/goals/${land}/contributions`, { amount: "200000", date: today, kind: "paid", fromAccountId: salary, note: "Second baina" }, 201)).data;
ok(p1.kind === "paid" && (await bal(salary)) === 5_000_000, "a payment from the salary account takes the money out of it");
let t = (await call("GET", `${H}/today`, null, 200)).data;
ok(t.spentMinor === 0, "paying toward a goal is not everyday spending");
await call("POST", `${H}/goals/${land}/contributions`, { amount: "100000", date: today, note: "Kept at home" }, 201);
await call("POST", `${H}/goals/${land}/contributions`, { amount: "60000", date: today, kind: "paid", fromSaved: true }, 201);
g = await goalOf(land);
ok(g.paidMinor === 56_000_000 && g.heldMinor === 4_000_000 && g.savedMinor === 60_000_000, `paid out of saved money moves it: paid ${g.paidMinor / 100}, held ${g.heldMinor / 100}`);
const tooMuch = await call("POST", `${H}/goals/${land}/contributions`, { amount: "50000", date: today, kind: "paid", fromSaved: true });
ok(tooMuch.status === 400, `cannot pay more than is saved (${tooMuch.data.error})`);
await call("PATCH", `${H}/accounts/${savings}`, { goalId: land }, 200);
g = await goalOf(land);
ok(g.savedFrom === "accounts" && g.heldMinor === 100_000_000 && g.paidMinor === 56_000_000, "with an account holding the money, held is its balance and payments still count");
const hist = (await call("GET", `${H}/goals/${land}/contributions`, null, 200)).data;
ok(hist.filter((c) => c.kind !== "saved").length === 3, "the history marks the three payments");
await call("DELETE", `${H}/goal-contributions/${p1.id}`, null, 200);
g = await goalOf(land);
ok(g.paidMinor === 36_000_000 && (await bal(salary)) === 25_000_000, "removing a payment puts the money back in the account");

// --- Contacts and their khata ---
const ram = (await call("POST", `${H}/accounts`, { name: "Ram Kirana", type: "person", phone: "9800000000", note: "Shop near the chowk", balance: "5000", weOwe: true }, 201)).data.id;
const hari = (await call("POST", `${H}/accounts`, { name: "Hari dai", type: "person" }, 201)).data.id;
const tenant = (await call("POST", `${H}/accounts`, { name: "Tenant", type: "person" }, 201)).data.id;
ok((await bal(ram)) === -500_000, "Ram Kirana starts with 5,000 we owe");
const cats = (await call("GET", `${H}/categories`, null, 200)).data;
const groceries = cats.find((c) => /grocer/i.test(c.name));
await call("POST", `${H}/accounts/${ram}/entries`, { kind: "credit", amount: "3200", date: today, categoryId: groceries.id, description: "Rice and oil" }, 201);
await call("POST", `${H}/accounts/${ram}/entries`, { kind: "gave", amount: "6000", date: today, otherAccountId: salary }, 201);
let k = (await call("GET", `${H}/accounts/${ram}/entries`, null, 200)).data;
ok(k.openingMinor === -500_000 && k.entries.length === 2 && k.entries[0].balanceMinor === -820_000 && k.entries[1].balanceMinor === -220_000 && k.balanceMinor === -220_000, "Ram's khata: 5,000 + 3,200 on credit − 6,000 paid = 2,200 we owe");
ok(k.entries[1].otherAccountName === "Salary account" && k.entries[1].description === "Paid Ram Kirana", "the payment shows where it came from");
await call("POST", `${H}/accounts/${hari}/entries`, { kind: "got", amount: "50000", date: today, otherAccountId: savings }, 201);
await call("POST", `${H}/accounts/${hari}/entries`, { kind: "gave", amount: "20000", date: today, otherAccountId: salary }, 201);
await call("POST", `${H}/accounts/${tenant}/entries`, { kind: "charge", amount: "15000", date: today, description: "October rent" }, 201);
ok((await bal(hari)) === -3_000_000 && (await bal(tenant)) === 1_500_000, "Hari: we owe 30,000; the tenant owes us 15,000");
const ramView = (await call("GET", `${H}/accounts`, null, 200)).data.find((a) => a.id === ram);
ok(ramView.lastEntry && ramView.lastEntry.description === "Paid Ram Kirana" && ramView.lastEntry.transferPairId, "the list knows the last thing that happened with Ram");
const wrong = await call("POST", `${H}/accounts/${hari}/entries`, { kind: "gave", amount: "100", date: today, otherAccountId: ram });
ok(wrong.status === 400, "paying one contact from another is refused");
const notContact = await call("POST", `${H}/accounts/${salary}/entries`, { kind: "credit", amount: "100", date: today });
ok(notContact.status === 404, "entries only go on contacts");

t = (await call("GET", `${H}/today`, null, 200)).data;
ok(t.spentMinor === 320_000, `buying on credit is this month's spending (${t.spentMinor / 100})`);
ok(t.worth.oweMinor === 220_000 + 3_000_000 && t.bank.every((b) => b.type !== "person"), `Today: owed to people ${t.worth.oweMinor / 100}; contacts are not bank accounts`);
const salaryNow = await bal(salary);
ok(salaryNow === 25_000_000 - 600_000 - 2_000_000, "salary account paid Ram and Hari");

// Removing an entry undoes it.
k = (await call("GET", `${H}/accounts/${ram}/entries`, null, 200)).data;
await call("DELETE", `${H}/transactions/${k.entries[1].id}`, null, 200);
ok((await bal(ram)) === -820_000 && (await bal(salary)) === salaryNow + 600_000, "removing the payment puts both sides back");

// Replaying a write with the same Idempotency-Key never posts twice.
const key = `k-${Date.now()}`;
const idem = async () => {
  const res = await fetch(`${BASE}${H}/transactions`, { method: "POST", headers: { "content-type": "application/json", cookie: state.cookie, "idempotency-key": key }, body: JSON.stringify({ date: today, amount: "450", direction: "out", accountId: salary, categoryId: groceries.id, description: "Replayed tea", note: "", isPersonal: false }) });
  return { status: res.status, replay: res.headers.get("x-idempotent-replay"), data: await res.json() };
};
const first = await idem();
const second = await idem();
ok(first.status === 201 && second.status === 201 && second.replay === "1" && first.data.id === second.data.id, "a replayed write gets the first answer back");
const teas = (await call("GET", `${H}/transactions?month=${today.slice(0, 7)}`, null, 200)).data.filter((x) => x.description === "Replayed tea");
ok(teas.length === 1, "and the book has it once");
const badKey = await fetch(`${BASE}${H}/transactions`, { method: "POST", headers: { "content-type": "application/json", cookie: state.cookie, "idempotency-key": "no spaces allowed" }, body: "{}" });
ok(badKey.status === 400, "a malformed key is refused");

// --- Terms: a date to settle by, and interest or none ---
const accountsNow = async () => (await call("GET", `${H}/accounts`, null, 200)).data;
// Simple interest, rounded to whole rupees as the khata shows it.
const yearly = (minor, days, bp) => Math.round((minor * days * bp) / 10_000 / 365 / 100) * 100;
const uncle = (await call("POST", `${H}/accounts`, { name: "Uncle Bir", type: "person", balance: "100000", weOwe: true, endDate: addDays(today, 5), rate: "2", ratePer: "month", startDate: addDays(today, -30) }, 201)).data.id;
let u = (await accountsNow()).find((a) => a.id === uncle);
ok(u.rateBp === 2400 && u.ratePer === "month" && u.endDate === addDays(today, 5), "2% a month is kept as 24% a year, with the month remembered for showing");
ok(u.terms && u.terms.from === addDays(today, -30) && u.terms.settleBy === addDays(today, 5), "the terms carry the start and the settle-by date");
ok(u.terms.interestMinor === -yearly(10_000_000, 30, 2400), `30 days of 2% a month on Rs 1,00,000 is ${-u.terms.interestMinor / 100} owed by us`);
ok(u.terms.interestBySettleMinor === -yearly(10_000_000, 35, 2400), `and ${-u.terms.interestBySettleMinor / 100} by the settle-by date`);
let decideNow = (await call("GET", `${H}/decide`, null, 200)).data;
let sc = decideNow.find((c) => c.kind === "settle" && c.accountId === uncle);
ok(sc && sc.days === 5 && sc.balanceMinor === -10_000_000 && sc.interestMinor === u.terms.interestMinor, "Decide reminds us a week before the date, with the interest");
await call("PATCH", `${H}/accounts/${uncle}`, { endDate: addDays(today, 40) }, 200);
decideNow = (await call("GET", `${H}/decide`, null, 200)).data;
ok(!decideNow.some((c) => c.kind === "settle" && c.accountId === uncle), "moving the date a month on clears the reminder");
ok((await call("PATCH", `${H}/accounts/${uncle}`, { ratePer: "week" })).status === 400, "a rate is a month or a year");

// A friendly loan to family, past its date, settled from the card's way of doing it.
const sita = (await call("POST", `${H}/accounts`, { name: "Sita didi", type: "person", balance: "20000", weOwe: false, endDate: addDays(today, -2), rate: "0" }, 201)).data.id;
let si = (await accountsNow()).find((a) => a.id === sita);
ok(si.rateBp === 0 && si.terms && si.terms.interestMinor === 0 && si.terms.settleBy === addDays(today, -2), "a friendly loan has a date and no interest");
decideNow = (await call("GET", `${H}/decide`, null, 200)).data;
sc = decideNow.find((c) => c.kind === "settle" && c.accountId === sita);
ok(sc && sc.days === -2 && sc.balanceMinor === 2_000_000 && sc.interestMinor === 0, "two days past the date, Decide asks whether it came back");
await call("POST", `${H}/accounts/${sita}/entries`, { kind: "got", amount: "20000", date: today, otherAccountId: salary, description: "Got it back in full" }, 201);
decideNow = (await call("GET", `${H}/decide`, null, 200)).data;
ok(!decideNow.some((c) => c.kind === "settle" && c.accountId === sita), "settled, the reminder goes");

// Interest added to the khata restarts the count from that day.
const before = (await accountsNow()).find((a) => a.id === uncle).terms.interestMinor;
await call("POST", `${H}/accounts/${uncle}/entries`, { kind: "credit", amount: String(-before / 100), date: today, description: "Interest to today" }, 201);
await call("PATCH", `${H}/accounts/${uncle}`, { startDate: today }, 200);
u = (await accountsNow()).find((a) => a.id === uncle);
ok(u.balanceMinor === -10_000_000 + before && u.terms.interestMinor === 0 && u.terms.from === today, "interest added to the khata joins the balance, and the count starts again today");

// Money lent with interest and a date; terms clear when unset.
const lent = (await call("POST", `${H}/accounts`, { name: "Loan to Ramesh", type: "lent", balance: "50000", balanceDate: addDays(today, -73), rate: "12", ratePer: "year", endDate: addDays(today, 3) }, 201)).data.id;
const le = (await accountsNow()).find((a) => a.id === lent);
ok(le.terms.interestMinor === yearly(5_000_000, 73, 1200), `money lent at 12% a year for 73 days earns ${le.terms.interestMinor / 100}`);
decideNow = (await call("GET", `${H}/decide`, null, 200)).data;
ok(decideNow.some((c) => c.kind === "settle" && c.accountId === lent && c.type === "lent" && c.balanceMinor === 5_000_000), "and Decide asks about it three days before");
await call("PATCH", `${H}/accounts/${lent}`, { endDate: null, rate: "0", startDate: null }, 200);
ok((await accountsNow()).find((a) => a.id === lent).terms === null, "clearing the date and the rate clears the terms");

console.log(`\nAll good. Household ${hh}`);
console.log(JSON.stringify({ hh, cookie: state.cookie, ram }));
