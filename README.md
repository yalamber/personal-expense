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

1. `npx wrangler d1 create personal-expense` and put the id in `wrangler.jsonc`.
2. `npx wrangler r2 bucket create personal-expense-mail`
3. `npx wrangler queues create personal-expense-parse` and `... personal-expense-parse-dlq`
   (Queues need the Workers Paid plan).
4. `npx wrangler secret put AUTH_SECRET`; for real email also `RESEND_API_KEY` and set
   `MAILER` to `resend` plus `MAIL_FROM` and `APP_ORIGIN` in `wrangler.jsonc`.
5. Set `INBOUND_DOMAIN` to a zone on Cloudflare DNS with Email Routing enabled, and add a
   routing rule that sends `stmt+*@<domain>` (or a catch-all) to this Worker.
6. `npm run db:migrate:remote` then `npm run deploy`.

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
