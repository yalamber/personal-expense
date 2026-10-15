# Family Money

A money tracker for one household: bank statements and alerts come in by email, the family
sees where money goes, where it is heading, and what could shrink without changing how they live.

The product plan (vision, data model, ingestion pipeline, forecast, insights, roadmap) lives on the
design canvas that this repository was started from. This README covers running the code.

## Status

Phase 0 of the roadmap: foundations.

- Cloudflare Worker with Hono API, D1 schema (Drizzle) and migrations
- Magic-link sign-in, households, members with roles, accounts
- Email Worker that stores forwarded bank mail in R2 and queues it
- Queue consumer that extracts attachments and routes to a parser (none registered yet)
- Web shell: sign in, create household, statement inbox, accounts, members
- Nightly cron enforcing raw-mail retention

Milestone: a forwarded bank email shows up in the admin inbox view.

## Stack

Cloudflare Workers, Email Routing, Queues, D1, R2, Cron Triggers. Hono for the API, Drizzle for
the database, React + Vite for the web app. See `wrangler.jsonc` for bindings.

## Local development

```sh
npm install
cp .dev.vars.example .dev.vars      # set AUTH_SECRET to any long random string
npm run db:migrate:local            # applies migrations to the local D1
npm run dev                         # builds the web app on change and runs wrangler dev on :8787
```

Open http://localhost:8787, enter an email, and copy the sign-in link from the terminal
(`MAILER=log` prints outgoing mail instead of sending it).

To try the email path locally, send a raw message to the local Email Worker:

```sh
curl -X POST 'http://localhost:8787/cdn-cgi/handler/email?from=alerts@bank.example&to=stmt+<token>@example.com' \
  --data-binary @test/fixtures/sample.eml
```

The `<token>` is shown on the inbox page as part of the household's inbound address.
The queue consumer runs inside `wrangler dev`, so the row moves from `queued` to
`no parser yet` within a few seconds.

## Deploying

One-time setup, from a machine that is logged in (`npx wrangler login`) or has
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the environment:

```sh
./scripts/cf-setup.sh            # creates D1, R2, queues; writes the D1 id; applies migrations
npx wrangler secret put AUTH_SECRET
# for real email: npx wrangler secret put RESEND_API_KEY and set MAILER to "resend"
```

Then edit the `vars` in `wrangler.jsonc` (`APP_ORIGIN`, `INBOUND_DOMAIN`, `MAIL_FROM`),
commit the D1 id the script wrote, and run `npm run deploy`.

In the Cloudflare dashboard, open Email › Email Routing for the `INBOUND_DOMAIN` zone and add a
rule (or a catch-all) that sends `stmt+*@<domain>` to the Worker named `personal-expense`.
Queues need the Workers Paid plan; everything else fits the free allowances for one household.

### Continuous deploys

`.github/workflows/deploy.yml` type-checks, tests, applies migrations and deploys on every push
to `main`. It needs two repository secrets: `CLOUDFLARE_API_TOKEN` (a token with Workers
Scripts, D1, R2, Queues and Workers KV edit permissions) and `CLOUDFLARE_ACCOUNT_ID`.
The one-time setup above still has to run once before the first workflow deploy.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Web build in watch mode plus `wrangler dev` |
| `npm run build` | Build the web app to `dist/client` |
| `npm run deploy` | Build and `wrangler deploy` |
| `npm run typecheck` | Type-check worker and web code |
| `npm test` | Unit tests (vitest) |
| `npm run db:generate` | Generate a migration from `src/worker/db/schema.ts` |
| `npm run db:migrate:local` / `:remote` | Apply migrations |
| `npm run cf:types` | Regenerate `worker-configuration.d.ts` from `wrangler.jsonc` |

## Layout

```
src/worker/          Worker: API, email handler, queue consumer, cron
  db/schema.ts       The whole data model
  auth/              Magic links and sessions
  http/              Hono app, middleware, routes
  ingest/            Email Worker, queue consumer, parser registry
  lib/               Pure helpers (unit-tested)
src/web/             React web app (Vite root)
migrations/          Drizzle-generated SQL applied by wrangler
test/                Vitest unit tests and email fixtures
```

## Next: Phase 1

Quick add, categories and merchant memory; the first two bank parsers with fixture emails;
dedupe, transfer pairing and statement balance reconciliation; the review queue; recurring
rules and monthly budgets; history backfill; CSV import and export.
