// End to end, the core: sign-in, a household, accounts, logging and the twin check, categories,
// envelopes, goals, statements by email on the subdomain. Runs against the Worker from run.mjs.
import { BASE, LOG, addDays, addMonths, iso, newClient, ok, sleep } from "./lib.mjs";

const { call, signIn, state } = newClient(`core-${Date.now()}@example.com`);
await signIn();
ok(state.cookie.length > 0, "signed in");

const hh = (await call("POST", "/api/households", { name: "Smoke family", currency: "NPR", timezone: "Asia/Kathmandu", memberName: "Tester" }, 201)).data.id;
const H = `/api/households/${hh}`;
const info = (await call("GET", H, null, 200)).data;
ok(info.inboundAddress.endsWith("@statements.leadbase.stream"), `inbound address on the statements subdomain (${info.inboundAddress})`);
const token = info.inboundAddress.split("+")[1].split("@")[0];

const card = (await call("POST", `${H}/accounts`, { name: "Joint card", type: "credit", statementSenderPattern: "alerts@bank.example", isShared: true }, 201)).data;
const cash = (await call("POST", `${H}/accounts`, { name: "Cash", type: "cash", statementSenderPattern: "", isShared: true }, 201)).data;
const cats = (await call("GET", `${H}/categories`, null, 200)).data;
const eating = cats.find((c) => c.name === "Eating out");

// Manual entry, then the same again: the twin check answers 409 with the first one.
const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
await call("POST", `${H}/transactions`, { date: yesterday, amount: "1860", direction: "out", accountId: card.id, categoryId: eating.id, description: "Momo House", note: "Dinner", isPersonal: false }, 201);
const twin = await call("POST", `${H}/transactions`, { date: today, amount: "1,860", direction: "out", accountId: card.id, categoryId: null, description: "Momo house", note: "", isPersonal: false });
ok(twin.status === 409 && twin.data.twins?.length === 1 && twin.data.twins[0].name === "Momo House", "second entry of the same payment is caught before saving");
await call("POST", `${H}/transactions`, { date: today, amount: "1860", direction: "out", accountId: card.id, categoryId: null, description: "Momo house", note: "", isPersonal: false, force: true }, 201);
ok(true, "force saves it as a separate payment");

// A statement with one line matching an unconfirmed manual entry -> confirmed, not added.
await call("POST", `${H}/transactions`, { date: yesterday, amount: "2000", direction: "out", accountId: card.id, categoryId: null, description: "Sajha fuel", note: "", isPersonal: false }, 201);
const csv = `Date,Description,Amount\n${today},SAJHA FUEL STN 03,-2000.00\n${today},FRESH MART BALUWATAR,-1240.00\n${today},NEW SHOP KTM,-500.00\n`;
const mapping = { dateColumn: 0, descriptionColumn: 1, amountMode: "single", amountColumn: 2, dateFormat: "YYYY-MM-DD", decimalSeparator: ".", negativeIsOut: true, hasHeader: true };
let imp = await call("POST", `${H}/accounts/${card.id}/import-csv`, { csv, filename: "oct.csv", mapping, saveMapping: true });
if (imp.status !== 201) {
  console.log("mapping rejected, reading csv-mapping shape:", imp.status, JSON.stringify(imp.data).slice(0, 200));
  process.exit(1);
}
ok(imp.data.confirmed === 1, `statement line confirmed the manual fuel entry (confirmed=${imp.data.confirmed}, review=${imp.data.needsReview})`);
const month = today.slice(0, 7);
const txs = (await call("GET", `${H}/transactions?month=${month}`, null, 200)).data;
const fuel = txs.filter((t) => /fuel/i.test(t.merchantName ?? t.description ?? ""));
ok(fuel.length === 1 && fuel[0].confirmedAt, "only one fuel transaction, now confirmed by the bank");

// Decide: the two Momo House entries make the statement-free twin? Category cards for new merchants.
let cards = (await call("GET", `${H}/decide`, null, 200)).data;
ok(cards.some((c) => c.kind === "category"), `decide has category cards (${cards.map((c) => c.kind).join(",")})`);
const cat = cards.find((c) => c.kind === "category");
await call("POST", `${H}/review/accept-many`, { lineIds: cat.lineIds, categoryId: eating.id }, 200);

// A pending statement line, then the person logs the same thing: twin of kind "line".
const csv2 = `Date,Description,Amount\n${today},TEA SHOP 7,-350.00\n`;
imp = await call("POST", `${H}/accounts/${card.id}/import-csv`, { csv: csv2, filename: "oct2.csv" }, 201);
const lineTwin = await call("POST", `${H}/transactions`, { date: today, amount: "350", direction: "out", accountId: card.id, categoryId: eating.id, description: "Tea shop", note: "with Asha", isPersonal: false });
ok(lineTwin.status === 409 && lineTwin.data.twins.some((t) => t.kind === "line"), "logging something already waiting in Decide finds the statement line");
const lt = lineTwin.data.twins.find((t) => t.kind === "line");
await call("POST", `${H}/review/${lt.id}`, { action: "accept", categoryId: eating.id, description: "Tea shop", note: "with Asha" }, 200);
const tea = (await call("GET", `${H}/transactions?month=${month}`, null, 200)).data.filter((t) => /tea/i.test(t.merchantName ?? t.description ?? ""));
ok(tea.length === 1 && tea[0].note === "with Asha" && tea[0].confirmedAt, "the line carries the person's name and note, confirmed");

// Balance check: start the book, then a bank figure that differs.
await call("POST", `${H}/accounts/${cash.id}/bank-balance`, { amount: "10000", date: yesterday }, 200);
await call("POST", `${H}/transactions`, { date: today, amount: "340", direction: "in", accountId: cash.id, categoryId: null, description: "Pharmacy refund", note: "", isPersonal: false }, 201);
const bal = (await call("POST", `${H}/accounts/${cash.id}/bank-balance`, { amount: "10000", date: today }, 200)).data;
ok(!bal.matches && bal.bookMinor === 1034000, `book 10,340 vs bank 10,000 flagged (book=${bal.bookMinor})`);
cards = (await call("GET", `${H}/decide`, null, 200)).data;
const bc = cards.find((c) => c.kind === "balance");
console.log(JSON.stringify(bc));
ok(bc && bc.suspects.some((s) => /pharmacy refund/i.test(s.name)), "balance card points at the unconfirmed refund");
await call("POST", `${H}/accounts/${cash.id}/balance-correction`, null, 200);
cards = (await call("GET", `${H}/decide`, null, 200)).data;
ok(!cards.some((c) => c.kind === "balance"), "correction makes the book match");

// Goals and the plan.
const e = (await call("POST", `${H}/goals`, { name: "Emergency fund", kind: "safety", target: "600000", saved: "465000", monthly: "20000", wantedBy: "2027-06" }, 201)).data.id;
const l = (await call("POST", `${H}/goals`, { name: "Land purchase", kind: "purchase", wantedBy: "2029-09", saved: "1120000", monthly: "25000", parts: [{ name: "Plot price", amount: "2200000" }, { name: "Registration and tax", amount: "180000" }, { name: "Survey and legal", amount: "40000" }, { name: "Boundary wall", amount: "80000" }] }, 201)).data.id;
const h = (await call("POST", `${H}/goals`, { name: "House build", kind: "build", wantedBy: "2031-12", saved: "380000", parts: [{ name: "Design and permits", amount: "350000" }, { name: "Foundation and plinth", amount: "1100000" }, { name: "Structure", amount: "2000000" }, { name: "Walls and roof", amount: "1350000" }, { name: "Finishing", amount: "1200000" }] }, 201)).data.id;
const plan = (await call("GET", `${H}/plan`, null, 200)).data;
ok(plan.goals.length === 3 && plan.plannedMinor === 4500000, "plan has three goals and Rs 45,000 a month planned");
ok(plan.goals.find((g) => g.id === l).targetMinor === 250000000, "land target is the sum of its parts");
await call("POST", `${H}/goals/${l}/contributions`, { amount: "25000", date: today, fromAccountId: card.id, note: "October" }, 201);
const land = (await call("GET", `${H}/goals`, null, 200)).data.find((g) => g.id === l);
ok(land.savedMinor === 114500000, "a move toward the land adds to what is saved");
const moveTx = (await call("GET", `${H}/transactions?month=${month}`, null, 200)).data.find((t) => t.goalId === l);
ok(moveTx && moveTx.direction === "out", "and is real money leaving the card, filed as saved");
await call("PUT", `${H}/goals/order`, { ids: [l, e, h] }, 200);
ok((await call("GET", `${H}/goals`, null, 200)).data[0].id === l, "reordering changes who is funded first");

const t = (await call("GET", `${H}/today`, null, 200)).data;
ok(typeof t.perDayMinor === "number" && t.daysLeft >= 1 && t.goalsMinor >= 4500000, `today: ${t.perDayMinor / 100}/day, ${t.daysLeft} days, goals ${t.goalsMinor / 100}`);
const hints = (await call("GET", `${H}/log-hints`, null, 200)).data;
ok(hints.merchants.some((m) => m.name === "Momo House"), "log hints remember merchants");

// Gmail forwarding confirmation through the Email Worker.
const eml = [
  "From: Gmail Team <forwarding-noreply@google.com>",
  `To: stmt+${token}@leadbase.stream`,
  "Subject: (#572612094) Gmail Forwarding Confirmation - Receive Mail from asha.k@gmail.com",
  `Message-ID: <fwd-${Date.now()}@google.com>`,
  "Content-Type: text/plain; charset=UTF-8",
  "",
  "asha.k@gmail.com has requested to automatically forward mail to your email address.",
  "Confirmation code: 572612094",
  "To allow asha.k@gmail.com to automatically forward mail to your address, please click the link below to confirm the request:",
  "https://mail-settings.google.com/mail/vf-%5BANGjdJ8%5D-abc123",
  "",
].join("\r\n");
const er = await fetch(`${BASE}/cdn-cgi/handler/email?from=forwarding-noreply@google.com&to=${encodeURIComponent(`stmt+${token}@leadbase.stream`)}`, { method: "POST", body: eml });
ok(er.status < 300, `email handler accepted the message (${er.status})`);
await sleep(800);
cards = (await call("GET", `${H}/decide`, null, 200)).data;
const fwd = cards.find((c) => c.kind === "forwarding");
ok(fwd && fwd.code === "572612094" && fwd.link?.startsWith("https://mail-settings.google.com/") && fwd.requester === "asha.k@gmail.com", "Gmail's code, link and requester show as the first Decide card");
ok(cards[0].kind === "forwarding", "forwarding check is first");
await call("POST", `${H}/statements/${fwd.statementId}/dismiss`, null, 200);

// --- Statement emails: matched on the From header (not a forwarder's envelope), read by the alert parser ---
const inboundTo = encodeURIComponent(`stmt+${token}@statements.leadbase.stream`);
const mail = (from, subject, body, extraHeaders = []) =>
  [`From: ${from}`, `To: stmt+${token}@statements.leadbase.stream`, `Subject: ${subject}`, `Date: ${new Date().toUTCString()}`, `Message-ID: <${Math.random().toString(36).slice(2)}@e2e.example>`, ...extraHeaders, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", body].join("\r\n");
const deliver = async (envelopeFrom, eml) => {
  const r = await fetch(`${BASE}/cdn-cgi/handler/email?from=${encodeURIComponent(envelopeFrom)}&to=${inboundTo}`, { method: "POST", body: eml });
  if (r.status >= 300) throw new Error(`email handler answered ${r.status}`);
  await sleep(1500);
  return (await call("GET", `${H}/statements`, null, 200)).data[0];
};
const nabil = (await call("POST", `${H}/accounts`, { name: "Nabil savings", type: "savings", balance: "50,000", statementSenderPattern: "txn-alert@nabilbank.com" }, 201)).data.id;

// Gmail forwards with its own envelope sender; the bank is in the From header.
let st = await deliver("postmaster@mail-wr1-x436.google.com", mail("Nabil Bank <txn-alert@nabilbank.com>", "Transaction Alert", "Dear Customer,\r\n\r\nYour account 01010XXXXXX89 has been debited by NPR 1,500.00 on 26/10/2026 14:03:11.\r\nRemarks: ESEWA LOAD 9841XXXXXX\r\nAvailable Balance: NPR 1,23,456.78\r\n\r\nThank you."));
ok(st.fromAddress === "txn-alert@nabilbank.com" && st.accountId === nabil && st.status !== "quarantined", `a forwarded alert is matched on its From header (${st.status})`);
ok(st.parserKey === "alert-text" && st.status === "review", "the alert parser read it and the line waits for a person");
let review = (await call("GET", `${H}/review`, null, 200)).data;
ok(review.some((l) => Math.abs(l.amountMinor) === 150000 && /ESEWA LOAD/.test(l.description ?? "")), "the review queue has NPR 1,500 to ESEWA LOAD");
cards = (await call("GET", `${H}/decide`, null, 200)).data;
ok(cards.some((c) => c.kind === "category" && /ESEWA/i.test(c.description)), "Decide asks for its category");

// Forwarded by hand: the bank is only in the quoted block.
st = await deliver("me@gmail.com", mail("Me <me@gmail.com>", "Fwd: Credit Alert", "FYI\r\n\r\n---------- Forwarded message ---------\r\nFrom: Nabil Bank <txn-alert@nabilbank.com>\r\nDate: Wed, 7 Oct 2026 at 10:02\r\nSubject: Credit Alert\r\n\r\nDear Customer, Rs. 90,000.00 has been credited to your A/C XXXX1234 on 07-10-2026. Particulars: SALARY OCT. Available balance Rs. 2,10,000.00"));
ok(st.fromAddress === "txn-alert@nabilbank.com" && st.status === "review", "an alert forwarded by hand is matched through its quoted From line");
review = (await call("GET", `${H}/review`, null, 200)).data;
ok(review.some((l) => Math.abs(l.amountMinor) === 9000000 && /SALARY OCT/.test(l.description ?? "")), "and its credit of Rs 90,000 waits for a person");

// A sender no account lists: Decide asks which account, and remembers the answer.
st = await deliver("alerts@newbank.example", mail("New Bank <alerts@newbank.example>", "Debit Alert", "Your account has been debited by NPR 800.00 on 2026-10-20. Remarks: COFFEE"));
ok(st.status === "quarantined" && /alerts@newbank.example is not on any account/.test(st.error), "mail from a new sender waits");
let t2 = (await call("GET", `${H}/today`, null, 200)).data;
ok(t2.mail.newSender === 1, "Today counts it");
cards = (await call("GET", `${H}/decide`, null, 200)).data;
const inboxCard = cards.find((c) => c.kind === "inbox");
ok(inboxCard && inboxCard.from === "alerts@newbank.example" && inboxCard.statementId === st.id, "Decide shows the new-sender card first");
const raw = await fetch(`${BASE}${H}/statements/${st.id}/raw`, { headers: { cookie: state.cookie } });
ok(raw.status === 200 && /message\/rfc822/.test(raw.headers.get("content-type")) && /Debit Alert/.test(await raw.text()), "the raw email can be downloaded");
const rel = (await call("POST", `${H}/statements/${st.id}/release`, { accountId: nabil, remember: true }, 200)).data;
ok(rel.remembered === true, "attaching it remembers the sender");
await sleep(1500);
const acct = (await call("GET", `${H}/accounts`, null, 200)).data.find((a) => a.id === nabil);
ok(/alerts@newbank\.example/.test(acct.statementSenderPattern ?? ""), "the account's sender list grew");
st = (await call("GET", `${H}/statements`, null, 200)).data.find((x) => x.id === st.id);
ok(st.status === "review" && st.accountId === nabil, "and the email was read for that account");
st = await deliver("alerts@newbank.example", mail("New Bank <alerts@newbank.example>", "Debit Alert", "Your account has been debited by NPR 300.00 on 2026-10-21. Remarks: TEA"));
ok(st.status === "review", "the next one from that sender goes straight through");
st = await deliver("promo@shop.example", mail("Shop <promo@shop.example>", "Big sale this weekend", "Everything half price."));
ok(st.status === "quarantined", "a shop's newsletter waits too");
await call("POST", `${H}/statements/${st.id}/dismiss`, {}, 200);
st = (await call("GET", `${H}/statements`, null, 200)).data.find((x) => x.id === st.id);
ok(st.status === "done" && /not a statement/.test(st.error), "and can be set aside as not a statement");
t2 = (await call("GET", `${H}/today`, null, 200)).data;
ok(t2.mail.newSender === 0, "nothing from a new sender is left");
st = await deliver("postmaster@mail-x.google.com", mail("Nabil Bank <txn-alert@nabilbank.com>", "Transaction Alert", "Your one time password is 482913. Do not share it."));
ok(st.status === "unparsed" && /nothing in this email read like a transaction/.test(st.error), "an email with no transaction in it says so instead of failing");

console.log(`\nAll good. Household ${hh}`);
console.log(JSON.stringify({ hh, cookie: state.cookie }));
