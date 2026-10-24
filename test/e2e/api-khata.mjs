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

console.log(`\nAll good. Household ${hh}`);
console.log(JSON.stringify({ hh, cookie: state.cookie, ram }));
