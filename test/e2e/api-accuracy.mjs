// Accuracy end to end: the cases an audit of the money logic found, replayed against the Worker.
// Today runs payday to payday; a late installment for last month does not pay this month's; a
// friendly loan repaid is money out; a baina from a goal's own savings is not this month's money;
// saving outside the goals is set aside; interest on money lent is income; a balance started
// today counts today's entries.
import { addDays, addMonths, iso, newClient, ok } from "./lib.mjs";

const { call, signIn, state } = newClient(`acc-${Date.now()}@example.com`);
await signIn();
ok(state.cookie.length > 0, "signed in");
const today = iso(new Date());
const day = Number(today.slice(8));
const rs = (n) => n * 100;
const newHousehold = async (name) => {
  const hh = (await call("POST", "/api/households", { name, currency: "NPR", timezone: "UTC", memberName: "Tester" }, 201)).data.id;
  return `/api/households/${hh}`;
};
const tx = (H, body) => call("POST", `${H}/transactions`, { note: "", isPersonal: false, force: true, categoryId: null, ...body }, 201);

// --- Payday to payday ---
{
  const H = await newHousehold("Payday family");
  const bank = (await call("POST", `${H}/accounts`, { name: "Bank", type: "checking", balance: "10000", balanceDate: addDays(today, -60) }, 201)).data.id;
  if (day < 28) {
    // Payday tomorrow's day of the month: the period began on that day last month.
    const payDay = day + 1;
    await call("PATCH", H, { payDay }, 200);
    const start = `${addMonths(today, -1).slice(0, 7)}-${String(payDay).padStart(2, "0")}`;
    await tx(H, { date: start, amount: "100000", direction: "in", accountId: bank, description: "Salary" });
    await tx(H, { date: addDays(start, -1), amount: "7000", direction: "out", accountId: bank, description: "Before payday" });
    const t = (await call("GET", `${H}/today`, null, 200)).data;
    ok(t.period.from === start && t.period.to === today, `the period runs from payday (${start}) to the day before the next (${today})`);
    ok(t.incomeMinor === rs(100_000) && t.spentMinor === 0, "salary from last calendar month counts; spending before payday does not");
  } else {
    await call("PATCH", H, { payDay: 2 }, 200);
    await tx(H, { date: `${today.slice(0, 7)}-02`, amount: "100000", direction: "in", accountId: bank, description: "Salary" });
    await tx(H, { date: `${today.slice(0, 7)}-01`, amount: "7000", direction: "out", accountId: bank, description: "Before payday" });
    const t = (await call("GET", `${H}/today`, null, 200)).data;
    ok(t.period.from === `${today.slice(0, 7)}-02`, "the period starts on payday");
    ok(t.incomeMinor === rs(100_000) && t.spentMinor === 0, "salary counts; spending the day before payday does not");
  }
}

// --- Loans: a late installment, part payments, a friendly loan repaid ---
{
  const H = await newHousehold("Loan family");
  const bank = (await call("POST", `${H}/accounts`, { name: "Bank", type: "checking", balance: "500000", balanceDate: addDays(today, -60) }, 201)).data.id;
  const dueDay = Math.min(day, 28);
  const thisDue = `${today.slice(0, 7)}-${String(dueDay).padStart(2, "0")}`;
  const loan = (await call("POST", `${H}/accounts`, { name: "Bike loan", type: "loan", balance: "200000", balanceDate: addDays(today, -60), rate: "12", installment: "10000", installmentDay: dueDay }, 201)).data.id;
  // Last month's installment, paid three days late.
  const late = addDays(addMonths(thisDue, -1), 3);
  await call("POST", `${H}/accounts/${loan}/repayment`, { amount: "10000", date: late <= today ? late : today, otherAccountId: bank }, 201);
  let t = (await call("GET", `${H}/today`, null, 200)).data;
  let acct = (await call("GET", `${H}/accounts`, null, 200)).data.find((a) => a.id === loan);
  ok(acct.loan.settledThisMonth === false && acct.loan.dueThisMonthMinor === rs(10_000), "a late payment for last month does not pay this month's installment");
  // Now this month's, in two parts: interest first, then the rest.
  await call("POST", `${H}/accounts/${loan}/repayment`, { amount: "1500", date: today, otherAccountId: bank }, 201);
  acct = (await call("GET", `${H}/accounts`, null, 200)).data.find((a) => a.id === loan);
  ok(acct.loan.settledThisMonth === false && acct.loan.dueThisMonthMinor === rs(8_500), "a part payment leaves only the rest due, not the whole installment again");
  await call("POST", `${H}/accounts/${loan}/repayment`, { amount: "8500", date: today, otherAccountId: bank }, 201);
  acct = (await call("GET", `${H}/accounts`, null, 200)).data.find((a) => a.id === loan);
  t = (await call("GET", `${H}/today`, null, 200)).data;
  ok(acct.loan.settledThisMonth === true && acct.loan.dueThisMonthMinor === 0, "paid in full, this month is settled");

  const friend = (await call("POST", `${H}/accounts`, { name: "Loan from Hari", type: "loan", balance: "50000", balanceDate: addDays(today, -60), rate: "0" }, 201)).data.id;
  const before = (await call("GET", `${H}/today`, null, 200)).data.loansMinor;
  await call("POST", `${H}/accounts/${friend}/repayment`, { amount: "50000", date: today, otherAccountId: bank }, 201);
  t = (await call("GET", `${H}/today`, null, 200)).data;
  ok(t.loansMinor === before + rs(50_000), "a friendly loan repaid in one go is money out this month, even with no installment and nothing left owed");
}

// --- Goals: a baina from the goal's own savings; saving outside the goals ---
{
  const H = await newHousehold("Goal family");
  const salary = (await call("POST", `${H}/accounts`, { name: "Salary", type: "checking", balance: "100000", balanceDate: addDays(today, -60) }, 201)).data.id;
  const landSavings = (await call("POST", `${H}/accounts`, { name: "Land savings", type: "savings", balance: "500000", balanceDate: addDays(today, -60) }, 201)).data.id;
  const land = (await call("POST", `${H}/goals`, { name: "Land", kind: "purchase", target: "3000000", monthly: "10000", linkedAccountId: landSavings }, 201)).data.id;
  await tx(H, { date: today, amount: "100000", direction: "in", accountId: salary, description: "Salary" });
  await call("POST", `${H}/goals/${land}/contributions`, { amount: "200000", date: today, kind: "paid", fromAccountId: landSavings, note: "Baina" }, 201);
  let t = (await call("GET", `${H}/today`, null, 200)).data;
  ok(t.goalsMinor === rs(10_000) && t.mode !== "over", "a baina paid from the goal's own savings is not taken from this month's money");
  const cats = (await call("GET", `${H}/categories`, null, 200)).data;
  const investments = cats.find((c) => c.name === "Investments").id;
  await tx(H, { date: today, amount: "20000", direction: "out", accountId: salary, categoryId: investments, description: "NEPSE shares" });
  t = (await call("GET", `${H}/today`, null, 200)).data;
  ok(t.savedOtherMinor === rs(20_000) && t.everydayLeftMinor === rs(100_000) - rs(10_000) - rs(20_000), "shares bought are set aside, not left for everyday spending");
  await tx(H, { date: today, amount: "5000", direction: "in", accountId: salary, categoryId: investments, description: "Shares sold" });
  t = (await call("GET", `${H}/today`, null, 200)).data;
  ok(t.incomeMinor === rs(100_000) && t.savedOtherMinor === rs(15_000), "money back out of savings is not income");
}

// --- Money lent with interest; a balance started today ---
{
  const H = await newHousehold("Lent family");
  const bank = (await call("POST", `${H}/accounts`, { name: "Bank", type: "checking", balance: "200000", balanceDate: addDays(today, -400) }, 201)).data.id;
  const lent = (await call("POST", `${H}/accounts`, { name: "Loan to Ramesh", type: "lent", balance: "100000", balanceDate: addDays(today, -365), rate: "12", ratePer: "year" }, 201)).data.id;
  const r = (await call("POST", `${H}/accounts/${lent}/repayment`, { amount: "112000", date: today, otherAccountId: bank }, 201)).data;
  ok(r.principalMinor === rs(100_000) && r.interestMinor === rs(12_000), "Rs 1,12,000 back on Rs 1,00,000 lent is Rs 1,00,000 back and Rs 12,000 interest");
  const accts = (await call("GET", `${H}/accounts`, null, 200)).data;
  ok(accts.find((a) => a.id === lent).balanceMinor === 0, "the loan to Ramesh is settled, not owed the other way");
  const t = (await call("GET", `${H}/today`, null, 200)).data;
  ok(t.incomeMinor === rs(12_000), "and the interest is this month's income");

  const wallet = (await call("POST", `${H}/accounts`, { name: "eSewa", type: "wallet" }, 201)).data.id;
  await call("POST", `${H}/accounts/${wallet}/bank-balance`, { amount: "5000" }, 200);
  await tx(H, { date: today, amount: "1000", direction: "out", accountId: wallet, description: "Recharge" });
  const w = (await call("GET", `${H}/accounts`, null, 200)).data.find((a) => a.id === wallet);
  ok(w.balanceMinor === rs(4_000), "a balance started today stands for right now, so today's spending still counts");
}

console.log("\nAccuracy: all good.");
