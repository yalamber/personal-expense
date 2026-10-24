// End to end: starting balances, fixed deposits, loans (EMI and friendly), money lent, a usual
// month, and email on the statements subdomain. Runs against the Worker from run.mjs.
import { BASE, LOG, addDays, addMonths, iso, newClient, ok, sleep } from "./lib.mjs";

const { call, signIn, state } = newClient(`start-${Date.now()}@example.com`);
await signIn();
ok(state.cookie.length > 0, "signed in");

const hh = (await call("POST", "/api/households", { name: "Start family", currency: "NPR", timezone: "UTC", memberName: "Tester" }, 201)).data.id;
const H = `/api/households/${hh}`;
const today = iso(new Date());
let t = (await call("GET", `${H}/today`, null, 200)).data;
ok(t.needsStart === true, "a new household is asked for its starting point");

// 1. Where the money is today.
const salary = (await call("POST", `${H}/accounts`, { name: "Salary account", type: "checking", balance: "250,000", balanceDate: addDays(today, -10) }, 201)).data.id;
const savings = (await call("POST", `${H}/accounts`, { name: "Joint savings", type: "savings", balance: "1200000", balanceDate: today }, 201)).data.id;
// 2. Fixed deposits: one maturing in a week, one paying interest quarterly.
const fdA = (await call("POST", `${H}/accounts`, { name: "Land FD", type: "deposit", institution: "NIC Asia", principal: "500000", rate: "8.5", startDate: addDays(addMonths(today, -12), 7), termMonths: 12 }, 201)).data.id;
const fdB = (await call("POST", `${H}/accounts`, { name: "Quarterly FD", type: "deposit", principal: "1000000", rate: "9", startDate: addMonths(today, -6), termMonths: 12, payout: "quarterly", settleAccountId: savings }, 201)).data.id;
const bad = await call("POST", `${H}/accounts`, { name: "Broken FD", type: "deposit", principal: "1000", rate: "8", startDate: today, endDate: addDays(today, -1) });
ok(bad.status === 400, `a deposit maturing before it starts is refused (${bad.data.error})`);
// 3. What we owe and what we lent.
const day = Math.min(28, Number(today.slice(8, 10)) + 2);
const home = (await call("POST", `${H}/accounts`, { name: "Home loan", type: "loan", institution: "Global IME", balance: "2400000", balanceDate: today, rate: "10", installment: "32000", installmentDay: day, settleAccountId: salary }, 201)).data.id;
const friend = (await call("POST", `${H}/accounts`, { name: "Loan from Hari", type: "loan", balance: "300000", balanceDate: today, rate: "", endDate: addMonths(today, 12) }, 201)).data.id;
const car = (await call("POST", `${H}/accounts`, { name: "Car loan", type: "loan", balance: "1200000", balanceDate: today, rate: "12", termMonths: 36, installmentDay: 5 }, 201)).data.id;
const lent = (await call("POST", `${H}/accounts`, { name: "Loan to Ram", type: "lent", balance: "50000", balanceDate: today }, 201)).data.id;
const noOwed = await call("POST", `${H}/accounts`, { name: "Mystery loan", type: "loan", rate: "5" });
ok(noOwed.status === 400, "a loan without the amount owed is refused");
// 4. A usual month.
await call("PATCH", H, { typicalIncome: "150000", typicalSpend: "90000" }, 200);

let accts = (await call("GET", `${H}/accounts`, null, 200)).data;
const by = (id) => accts.find((a) => a.id === id);
ok(by(salary).balanceMinor === 25_000_000, "salary account starts at 250,000");
ok(by(fdA).balanceMinor === 50_000_000 && by(fdA).deposit.accruedMinor > 4_000_000 && by(fdA).deposit.daysToMaturity === 7, `Land FD: 500,000 in, ${by(fdA).deposit.accruedMinor / 100} interest so far, matures in 7 days`);
ok(by(fdA).deposit.maturityValueMinor > 54_000_000 && by(fdA).deposit.maturityValueMinor < 55_000_000, `Land FD worth about ${by(fdA).deposit.maturityValueMinor / 100} at maturity (quarterly compounding)`);
ok(by(home).balanceMinor === -240_000_000 && by(home).loan.owedMinor === 240_000_000 && by(home).loan.monthsLeft > 100, `home loan: 2,400,000 owed, ${by(home).loan.monthsLeft} installments left, paid off ${by(home).loan.payoffMonth}`);
ok(by(friend).loan.interestLeftMinor === 0 && by(friend).loan.payoffMonth === addMonths(today, 12).slice(0, 7), "friendly loan: no interest, repay-by month as payoff");
ok(by(car).installmentMinor > 3_900_000 && by(car).installmentMinor < 4_000_000, `car loan EMI worked out from 36 months: ${by(car).installmentMinor / 100}`);

t = (await call("GET", `${H}/today`, null, 200)).data;
const have = 25_000_000 + 120_000_000 + 50_000_000 + 100_000_000 + 5_000_000;
const owe = 240_000_000 + 30_000_000 + 120_000_000;
ok(t.needsStart === false, "starting point done");
ok(t.worth.haveMinor === have && t.worth.oweMinor === owe && t.worth.netMinor === have - owe, `worth: have ${have / 100}, owe ${owe / 100}`);
ok(t.worth.accruedMinor > 0, `FD interest so far ${t.worth.accruedMinor / 100}`);
ok(t.loansMinor === 3_200_000 + by(car).installmentMinor || t.loansMinor === 3_200_000, `loan installments this month ${t.loansMinor / 100}`);
ok(t.incomeExpected && t.incomeMinor === 15_000_000, "Today expects the usual month's income");

const plan = (await call("GET", `${H}/plan`, null, 200)).data;
ok(plan.basis.source === "typical" && plan.basis.incomeMinor === 15_000_000, "Plan uses the usual month until the book has two");
ok(plan.loans.monthlyMinor === 3_200_000 + by(car).installmentMinor, `EMIs a month: ${plan.loans.monthlyMinor / 100}`);
ok(plan.spareMinor === 15_000_000 - 9_000_000 - plan.loans.monthlyMinor, `spare after spending and EMIs: ${plan.spareMinor / 100}`);
ok(plan.loans.releases.length === 2, `paid-off loans free their EMIs: ${plan.loans.releases.map((r) => `${r.name} from ${r.fromMonth}`).join(", ")}`);

let cards = (await call("GET", `${H}/decide`, null, 200)).data;
ok(cards.some((c) => c.kind === "maturity" && c.accountId === fdA), "Decide: Land FD maturity card");
const emiCard = cards.find((c) => c.kind === "installment" && c.accountId === home);
ok(emiCard && emiCard.interestMinor === 2_000_000 && emiCard.due === `${today.slice(0, 7)}-${String(day).padStart(2, "0")}`, `Decide: home loan EMI due ${emiCard?.due}, 20,000 of it interest`);

// Pay the EMI: 20,000 interest is spending, 12,000 comes off the loan.
const r = (await call("POST", `${H}/accounts/${home}/repayment`, { amount: "32000", date: today, otherAccountId: salary }, 201)).data;
ok(r.interestMinor === 2_000_000 && r.principalMinor === 1_200_000, "EMI split into interest and principal");
accts = (await call("GET", `${H}/accounts`, null, 200)).data;
ok(by(home).balanceMinor === -238_800_000 && by(salary).balanceMinor === 25_000_000 - 3_200_000, "loan down by 12,000; salary account down by 32,000");
cards = (await call("GET", `${H}/decide`, null, 200)).data;
ok(!cards.some((c) => c.kind === "installment" && c.accountId === home), "paid EMI leaves Decide");
const check = (await call("POST", `${H}/accounts/${home}/bank-balance`, { amount: "2388000", date: today }, 200)).data;
ok(check.matches === true, "the bank's owed figure matches the book");

// Friendly loan, money lent back.
const f = (await call("POST", `${H}/accounts/${friend}/repayment`, { amount: "100000", date: today, otherAccountId: savings }, 201)).data;
ok(f.interestMinor === 0 && f.principalMinor === 10_000_000, "friendly loan: all of it comes off");
await call("POST", `${H}/accounts/${lent}/repayment`, { amount: "20000", date: today, otherAccountId: salary }, 201);
accts = (await call("GET", `${H}/accounts`, null, 200)).data;
ok(by(friend).balanceMinor === -20_000_000 && by(lent).balanceMinor === 3_000_000, "Hari's loan 200,000 left; Ram owes 30,000");

// Goal held in an FD.
const goal = (await call("POST", `${H}/goals`, { name: "Land", kind: "purchase", target: "2500000", monthly: "20000" }, 201)).data.id;
await call("PATCH", `${H}/accounts/${fdA}`, { goalId: goal }, 200);
let g = (await call("GET", `${H}/goals`, null, 200)).data.find((x) => x.id === goal);
ok(g.savedFrom === "accounts" && g.savedMinor === 50_000_000, "Land counts the FD's balance as saved");

// Renew the Land FD with its interest; break the quarterly FD into savings.
const est = by(fdA).deposit.maturityValueMinor - 50_000_000;
const rn = (await call("POST", `${H}/accounts/${fdA}/renew`, { interest: String(est / 100), termMonths: 12, rate: "8" }, 200)).data;
ok(rn.startDate === addDays(today, 7) && rn.endDate === addMonths(addDays(today, 7), 12), `renewed ${rn.startDate} to ${rn.endDate}`);
const badClose = await call("POST", `${H}/accounts/${fdB}/close`, { interest: "100", toAccountId: fdB });
ok(badClose.status === 400, "closing into itself is refused");
await call("POST", `${H}/accounts/${fdB}/close`, { interest: "0", toAccountId: savings }, 200);
accts = (await call("GET", `${H}/accounts`, null, 200)).data;
ok(by(fdB).closedAt && by(savings).balanceMinor === 120_000_000 - 10_000_000 + 100_000_000, "quarterly FD closed today into savings (no stray interest from the refused call)");
cards = (await call("GET", `${H}/decide`, null, 200)).data;
ok(!cards.some((c) => c.kind === "maturity"), "renewed FD leaves Decide");
t = (await call("GET", `${H}/today`, null, 200)).data;
ok(t.incomeExpected && t.incomeMinor === 15_000_000 && t.spentMinor === 2_000_000, "interest left in the FD is not this month's income; the EMI interest is spending");

// Email on the statements subdomain reaches the same household.
const info = (await call("GET", H, null, 200)).data;
const token = info.inboundAddress.split("+")[1].split("@")[0];
const to = `stmt+${token}@statements.leadbase.stream`;
const eml = [
  "From: Gmail Team <forwarding-noreply@google.com>",
  `To: ${to}`,
  "Subject: (#123456789) Gmail Forwarding Confirmation - Receive Mail from asha.k@gmail.com",
  `Message-ID: <sub-${Date.now()}@google.com>`,
  "Content-Type: text/plain; charset=UTF-8",
  "",
  "Confirmation code: 123456789",
  "",
].join("\r\n");
const er = await fetch(`${BASE}/cdn-cgi/handler/email?from=forwarding-noreply@google.com&to=${encodeURIComponent(to)}`, { method: "POST", body: eml });
ok(er.status < 300, `email to ${to} accepted (${er.status})`);
await sleep(800);
cards = (await call("GET", `${H}/decide`, null, 200)).data;
ok(cards.some((c) => c.kind === "forwarding" && c.code === "123456789"), "subdomain address lands in this household");

console.log(`\nAll good. Household ${hh}`);
console.log(JSON.stringify({ hh, cookie: state.cookie }));
