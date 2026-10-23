# Family Money

A money tracker for one household: bank statements and alerts come in by email, the family
sees where money goes, where it is heading, and what could shrink without changing how they live.

The product plan (vision, data model, ingestion pipeline, forecast, insights, roadmap) lives on the
design canvas that this repository was started from. This README covers running the code.

## Status

**Phase 0, foundations: done.** Worker, D1 schema, magic-link sign-in, households and roles,
the Email Worker storing forwarded mail in R2, the statement inbox, nightly housekeeping.

**Phase 1, ledger and ingestion: done, with the redesign.**

The app has three spaces plus Family, and Log on every screen:

- **Today**: what the family can spend per day until payday and stay on plan, the book for the
  month with ✓ (logged by the family) and ✓✓ (confirmed by the bank), envelopes (budgets), which
  accounts the bank has confirmed, and the next goal.
- **Log**: money out, money in, or a move between accounts or into a goal. Repeats and merchant
  memory fill in the category and account. Before saving, anything that looks already in the
  book is shown, so the family says "same payment" or "a separate one".
- **Decide**: one card at a time. Possible double entries, balance gaps against the bank,
  merchants that need a category (one choice files them all), a goal that could be funded from
  spare money, and Gmail forwarding codes.
- **Plan**: goals funded in priority order, drawn as one road with a lever for the monthly amount
  and a price-rise guess. Goals have parts (cost items, or stages for a build), wanted-by dates,
  and money moved in from accounts.
- **Family**: starting point, forwarding setup, accounts, people, envelopes, inbox, payday,
  CSV export.

**Day one, not month three.** The starting point (Family › Starting point) takes what the family
has and owes today, so balances, Today and the Plan are right from the first day:

- **Accounts with a starting balance**: bank, savings, cash and wallets. A balance typed for today
  means "right now"; anything logged later today still counts.
- **Fixed deposits**: amount, yearly rate, start, term or maturity date, and whether interest stays
  in (compounded quarterly) or is paid out. Interest earned so far and the value at maturity are
  worked out; two weeks before maturity Decide asks to renew it or close it into an account.
- **Loans we owe**: amount still owed, rate (empty for a friendly loan), and the installment, or
  months left to work the EMI out. Paying one splits it: the month's interest is spending, the rest
  comes off the loan. Decide asks five days before each installment, and the Plan shows when each
  loan is paid off and can put its installment into the goals from then on.
- **Money we lent**, **credit cards**, and **a usual month** (income and spending, used by the Plan
  until the book has two months of its own).
- An account or deposit can be kept for a goal; the goal then counts its balance as saved.

**Contacts (Family › Contacts)** keep a khata per shop, relative or friend: what was owed before
today, then entries as money goes back and forth (we paid them, we got from them, bought on
credit, they owe us for something). Each contact shows debit, credit and the running balance:
"we owe Rs 8,200" or "owes us Rs 15,000". Buying on credit is that month's spending; settling
the tab later is a move. In Log, a contact appears under "On credit from" and in Move or save.

**Goal payments.** A baina or advance to the land's seller, or a stage paid to the builder, is
recorded on the goal as "Paid toward it": it counts toward the goal but is not money the family
holds. It can come from an account, out of money already saved for the goal, or from before the
book started.

Today shows what we have (held, owed, FD interest so far) and the month's loan installments.
Entries on deposits, loans and money lent are moves, never the month's income or spending.

Next: bank-specific email parsers (needs three sample emails per bank), recurring bills, history
backfill.

## Stack

Cloudflare Workers, Email Routing, D1, R2, Cron Triggers (Queues optional). Hono for the API, Drizzle for
the database, React + Vite for the web app. See `wrangler.jsonc` for bindings.

## Local development

Requires Node.js 24 (pinned in `.node-version`, which Cloudflare's builds also use).

```sh
npm install
cp .dev.vars.example .dev.vars      # keeps sign-in links on localhost
npm run db:migrate:local            # applies migrations to the local D1
npm run dev                         # builds the web app on change and runs wrangler dev on :8787
```

Open http://localhost:8787, enter an email, and copy the sign-in link from the terminal
(`MAILER=log` prints outgoing mail instead of sending it).

To try the email path locally, send a raw message to the local Email Worker:

```sh
curl -X POST 'http://localhost:8787/cdn-cgi/handler/email?from=alerts@bank.example&to=stmt%2B<token>@leadbase.stream' \
  --data-binary @test/fixtures/sample.eml
```

The `<token>` is shown on the inbox page as part of the household's inbound address.
Parsing runs right after delivery, so the row moves from `queued` to `no parser yet` within
a few seconds.

## Deploying

### What is already set up in Cloudflare

| Resource | Name | Notes |
| --- | --- | --- |
| D1 database | `personal-expense` | id `eddba7ce-aa58-43c2-891e-7a6e1a075757`, APAC; migrations `0000` to `0003` applied |
| R2 bucket | `personal-expense-mail` | raw statement emails and attachments |

| Address | Purpose |
| --- | --- |
| `https://money.leadbase.stream` | The app (custom domain, created on first deploy) |
| `https://personal-expense.<your-subdomain>.workers.dev` | Fallback address |
| `stmt+<household token>@leadbase.stream` | Where each household forwards statements |

No secrets are required. The session-signing secret is generated on first use and stored in
the `app_settings` table; set an `AUTH_SECRET` Worker secret only if you want to manage it.

### Create the Worker with automatic deploys (one time)

1. Dashboard › Workers & Pages › Create › Import a repository › GitHub ›
   `yalamber/personal-expense`.
2. Settings:

   | Setting | Value |
   | --- | --- |
   | Project name | `personal-expense` (must match `name` in `wrangler.jsonc`) |
   | Production branch | `main` |
   | Build command | `npm run build` |
   | Deploy command | `npx wrangler deploy` |

3. Save and deploy. The first deploy creates `money.leadbase.stream`.

Every later push to `main` deploys automatically. All feature work happens on `main`; pushes to
any other branch only build preview versions.

### Email Routing for statements (one time)

Statements go to `stmt+<household token>@leadbase.stream`. Either of these sends them to the Worker:

- **Catch-all** (what is set up now): Email Service › Email Routing › `leadbase.stream` › Routing
  Rules › Catch-all › Send to a Worker › `personal-expense`. The Worker keeps mail for a known
  household token and quietly drops everything else, so no other address on the domain gets mail.
- **One rule, catch-all left free**: turn on **Subaddressing** under Settings, then create a custom
  address `stmt@leadbase.stream` › Send to a Worker › `personal-expense`. With subaddressing,
  `stmt+<token>@leadbase.stream` matches it.

A zone has one catch-all and it only covers the apex domain; subdomains need literal rules. The
Worker reads the token whatever the domain, so a subdomain address works once mail reaches it. For
`statements.leadbase.stream`: turn on Subaddressing, then add the custom address
`stmt@statements.leadbase.stream` › Send to a Worker › `personal-expense` (Cloudflare adds the MX
records for the subdomain). `stmt+<token>@statements.leadbase.stream` then reaches the household.

### Forwarding from Gmail

1. Gmail › Settings › See all settings › Forwarding and POP/IMAP › Add a forwarding address, and
   paste the household's address from Family › Statements by email.
2. Gmail mails a confirmation code to that address. The Worker recognises it
   (`forwarding-noreply@google.com`), keeps the code, and shows it as the first card in Decide
   and on the forwarding page.
3. Type the code into Gmail and choose Verify. Then add a filter that forwards only the bank's
   emails, and put the bank's sender address on the account so its mail is read, not held back.

### Migrations

The default Workers Builds token has no D1 permission, so deploys do not run migrations. Apply a
new file in `migrations/` before merging, with `npm run db:migrate:remote` from a logged-in
machine or through the Cloudflare connector.

### Sign-in emails

Sign-in links are sent with Cloudflare Email Service through the Worker's `send_email` binding
(`MAILER` is `cloudflare`), from `MAIL_FROM` (`money@leadbase.stream`). Two things must be set up
in the Cloudflare dashboard, both free:

1. Email Routing enabled on `leadbase.stream` (Email Service › Email Routing), because the sending
   address must be on a routing domain.
2. Each family member's address added and verified under Email Routing › Destination addresses.
   On the Workers Free plan Cloudflare only delivers to verified addresses. Onboarding the domain
   for Email Sending (Workers Paid) lets the app email anyone.

If a send fails, the sign-in form says so, and the Worker log keeps a `[mail:failed]` line with
the one-time link so an admin can still get in. For local development `.dev.vars` sets
`MAILER=log`, which prints links to the terminal. `MAILER=resend` with a `RESEND_API_KEY`
secret is also supported.

### Optional: parse on a Queue

Parsing runs inline after delivery and the nightly cron retries anything stuck, which is plenty
for one household. To use a Queue instead, uncomment the `queues` block in `wrangler.jsonc`. That
needs the Workers Paid plan and a build token with Queues edit permission.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Web build in watch mode plus `wrangler dev` |
| `npm run build` | Build the web app to `dist/client` |
| `npm run deploy` | Build and `wrangler deploy` |
| `npm run typecheck` | Type-check worker and web code |
| `npm test` | Unit tests (vitest) |
| `npm run db:generate` | Generate a migration from `src/worker/db/schema.ts` |
| `npm run db:migrate:local` / `:remote` | Apply migrations locally or to the Cloudflare database |
| `npm run cf:types` | Regenerate `worker-configuration.d.ts` from `wrangler.jsonc` |

## Layout

```
src/shared/          Pure helpers used by both sides: money, dates, CSV, column mapping, merchant names
src/worker/          Worker: API, email handler, parse step, cron
  db/schema.ts       The whole data model
  auth/              Magic links, sessions, generated signing secret
  http/routes/       households, accounts (balances, deposits, loans, repayments, maturity, contact khata),
                     ledger (transactions, budgets, export), imports (CSV, review),
                     goals (goals, parts, money in, plan), home (today, decide, log hints)
  ledger/            Categories, merchant memory, transactions and transfers
  ingest/            Email Worker, parse step, ingest pipeline, parser registry
  lib/               Small Worker helpers
src/shared/plan.ts   The long-term plan simulator (priority order, rollover, price rise, freed EMIs), used by both sides
src/shared/deposit.ts, loan.ts   Fixed-deposit interest and maturity; EMI, interest split, months left
src/web/             React web app (Vite root): Today, Log, Decide, Plan, Family
migrations/          Drizzle-generated SQL applied by wrangler or the Cloudflare connector
test/                Vitest unit tests and email fixtures
```

## How imports work

1. A CSV arrives, either uploaded on the Accounts page or attached to a forwarded statement email.
2. Its rows are read with the account's saved column mapping (set once, on the first upload).
3. Each row's description is normalised to a merchant, and merchant memory supplies a category.
4. Each row is compared with transactions on the same account with the same amount and
   direction within two days:
   - exactly one fits, and it is a family entry the bank has not confirmed yet: the row is the
     bank's copy of it, so the entry becomes ✓✓ and nothing new is added
   - anything else fits (a bank line already there, two family entries): it waits in Decide
5. Rows with a known category and nothing that fits are posted, already ✓✓. Everything else
   waits in Decide, where one choice files every row from that merchant.
6. An account's starting balance (Family › Starting point or Accounts) starts its book; later
   figures are compared with the book, and a gap shows in Decide with the unconfirmed entries most
   likely to explain it.
