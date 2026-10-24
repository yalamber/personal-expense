// Seeds a household with three months of everyday money, goals, an FD, a loan, a khata and the
// month's bills, so the browser suites have something to look at. Prints {hh, cookie, ram}.
import { BASE, LOG, addDays, addMonths, iso, newClient, ok, sleep } from "./lib.mjs";

const { call, signIn, state } = newClient(`rich-${Date.now()}@example.com`);
await signIn();
ok(state.cookie.length > 0, "signed in");

const hh = (await call("POST", "/api/households", { name: "The Subbas", currency: "NPR", timezone: "UTC", memberName: "Asha" }, 201)).data.id;
const H = `/api/households/${hh}`;
const today = iso(new Date());
const salary = (await call("POST", `${H}/accounts`, { name: "Salary account", type: "checking", institution: "Nabil", balance: "212,400", balanceDate: addDays(today, -95) }, 201)).data.id;
const cash = (await call("POST", `${H}/accounts`, { name: "Cash at home", type: "cash", balance: "18,000", balanceDate: addDays(today, -95) }, 201)).data.id;
const savings = (await call("POST", `${H}/accounts`, { name: "Land savings", type: "savings", balance: "1,050,000", balanceDate: addDays(today, -95) }, 201)).data.id;
const card = (await call("POST", `${H}/accounts`, { name: "Joint card", type: "credit", balance: "14,500", balanceDate: addDays(today, -95) }, 201)).data.id;
await call("POST", `${H}/accounts`, { name: "Land FD", type: "deposit", institution: "NIC Asia", principal: "500000", rate: "8.5", startDate: addDays(addMonths(today, -12), 40), termMonths: 12 }, 201);
await call("POST", `${H}/accounts`, { name: "Home loan", type: "loan", institution: "Global IME", balance: "2,388,000", principal: "2,400,000", rate: "10", installment: "32000", installmentDay: 25, settleAccountId: salary }, 201);
await call("POST", `${H}/accounts`, { name: "Loan to Ram", type: "lent", balance: "30,000" }, 201);
await call("PATCH", H, { typicalIncome: "150000", typicalSpend: "90000" }, 200);

const cats = (await call("GET", `${H}/categories`, null, 200)).data;
const cat = (re) => cats.find((c) => re.test(c.name)).id;
const groceries = cat(/^Groceries/), eating = cat(/^Eating out/), fuel = cat(/^Fuel/), rent = cat(/^Rent/), utilities = cat(/^Utilities/), pharmacy = cat(/^Pharmacy/), coffee = cat(/^Coffee/), salaryCat = cats.find((c) => c.kind === "income").id;

// Three months of a believable book: salary on the 1st, rent, bills, and small daily spending.
const tx = (date, amount, direction, accountId, categoryId, description) => call("POST", `${H}/transactions`, { date, amount: String(amount), direction, accountId, categoryId, description, note: "", isPersonal: false, force: true }, 201);
let seedRand = 7;
const rnd = () => { seedRand = (seedRand * 9301 + 49297) % 233280; return seedRand / 233280; };
for (let m = 2; m >= 0; m--) {
  const first = `${addMonths(today, -m).slice(0, 7)}-01`;
  if (first > today) continue;
  await tx(first, 150000, "in", salary, salaryCat, "Salary");
  await tx(addDays(first, 2), 25000, "out", salary, rent, "House rent");
  await tx(addDays(first, 5), 3800 + Math.round(rnd() * 800), "out", salary, utilities, "NEA electricity");
  const days = m === 0 ? Math.min(28, Number(today.slice(8, 10))) : 28;
  for (let d = 1; d <= days; d++) {
    const date = addDays(first, d - 1);
    if (date > today) break;
    if (rnd() < 0.55) await tx(date, 600 + Math.round(rnd() * 2200), "out", rnd() < 0.5 ? cash : card, groceries, ["Bhatbhateni", "Salesberry", "Local kirana"][Math.floor(rnd() * 3)]);
    if (rnd() < 0.25) await tx(date, 900 + Math.round(rnd() * 2400), "out", card, eating, ["Momo House", "Roadhouse", "Bota"][Math.floor(rnd() * 3)]);
    if (rnd() < 0.2) await tx(date, 2500 + Math.round(rnd() * 1500), "out", card, fuel, "Sajha fuel");
    if (rnd() < 0.15) await tx(date, 200 + Math.round(rnd() * 400), "out", cash, coffee, "Himalayan Java");
    if (rnd() < 0.08) await tx(date, 400 + Math.round(rnd() * 1200), "out", cash, pharmacy, "Pharmacy");
  }
}

// Goals, with money already in place.
const land = (await call("POST", `${H}/goals`, { name: "Land in Bhaktapur", kind: "purchase", target: "4,500,000", monthly: "25000", paid: "300000", wantedBy: addMonths(today, 48).slice(0, 7), linkedAccountId: savings }, 201)).data.id;
await call("POST", `${H}/goals`, { name: "Rainy-day fund", kind: "safety", target: "450,000", monthly: "10000", saved: "120000" }, 201);
await call("POST", `${H}/goals`, { name: "Aarav's college", kind: "education", target: "2,000,000", monthly: "8000", wantedBy: addMonths(today, 120).slice(0, 7) }, 201);
void land;

// A khata.
const ram = (await call("POST", `${H}/accounts`, { name: "Ram Kirana", type: "person", phone: "9800000000", note: "Shop near the chowk", }, 201)).data.id;
const hari = (await call("POST", `${H}/accounts`, { name: "Hari dai", type: "person" }, 201)).data.id;
const tenant = (await call("POST", `${H}/accounts`, { name: "Tenant upstairs", type: "person" }, 201)).data.id;
const sita = (await call("POST", `${H}/accounts`, { name: "Sita bhauju", type: "person" }, 201)).data.id;
await call("POST", `${H}/accounts/${ram}/entries`, { kind: "credit", amount: "3200", date: addDays(today, -20), categoryId: groceries, description: "Rice and oil" }, 201);
await call("POST", `${H}/accounts/${ram}/entries`, { kind: "gave", amount: "6000", date: addDays(today, -12), otherAccountId: cash }, 201);
await call("POST", `${H}/accounts/${ram}/entries`, { kind: "credit", amount: "2750", date: addDays(today, -6), categoryId: groceries, description: "Dal, sugar, tea" }, 201);
await call("POST", `${H}/accounts/${ram}/entries`, { kind: "credit", amount: "1900", date: addDays(today, -1), categoryId: groceries, description: "Vegetables" }, 201);
await call("POST", `${H}/accounts/${hari}/entries`, { kind: "got", amount: "50000", date: addDays(today, -40), otherAccountId: savings }, 201);
await call("POST", `${H}/accounts/${hari}/entries`, { kind: "gave", amount: "20000", date: addDays(today, -10), otherAccountId: salary }, 201);
await call("POST", `${H}/accounts/${tenant}/entries`, { kind: "charge", amount: "15000", date: addDays(today, -3), description: "This month's rent" }, 201);
await call("POST", `${H}/accounts/${sita}/entries`, { kind: "gave", amount: "8000", date: addDays(today, -15), otherAccountId: cash, description: "For the puja" }, 201);

// The month's bills and income, so Today has something to set aside and expect.
await call("POST", `${H}/recurring`, { name: "Rent", direction: "out", amount: "25000", dayOfMonth: 1, categoryId: rent, accountId: salary }, 201);
await call("POST", `${H}/recurring`, { name: "Salary", direction: "in", amount: "90000", dayOfMonth: 7, categoryId: salaryCat, accountId: salary }, 201);
await call("POST", `${H}/recurring`, { name: "Internet", direction: "out", amount: "1500", dayOfMonth: 28, categoryId: utilities, accountId: salary }, 201);

console.log(JSON.stringify({ hh, cookie: state.cookie, ram }));
