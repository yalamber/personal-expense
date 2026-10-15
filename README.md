# Family Money

A money tracker for one household: bank statements and alerts come in by email, the family
sees where money goes, where it is heading, and what could shrink without changing how they live.

The product plan (vision, data model, ingestion pipeline, forecast, insights, roadmap) lives on the
design canvas that this repository was started from. This README covers running the code.

## Status

Phase 0 of the roadmap: foundations.

- Cloudflare Worker with Hono API, D1 schema (Drizzle) and migrations
- Magic-link sign-in, households, members with roles, accounts
- Email Worker that stores forwarded bank mail in R2 and dispatches it for parsing
- Parser step that extracts attachments and routes to a parser registry (none registered yet);
  it runs right after delivery, or on a Queue if one is bound
- Web shell: sign in, create household, statement inbox, accounts, members
- Nightly cron that retries stuck emails and enforces raw-mail retention

Milestone: a forwarded bank email shows up in the admin inbox view.

## Stack

Cloudflare Workers, Email Routing, D1, R2, Cron Triggers (Queues optional). Hono for the API, Drizzle for
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
Parsing runs right after delivery, so the row moves from `queued` to `no parser yet` within
a few seconds.

## Deploying

### Cloudflare resources (already created)

| Resource | Name | Notes |
| --- | --- | --- |
| D1 database | `personal-expense` | id `eddba7ce-aa58-43c2-891e-7a6e1a075757`, APAC; migration `0000_init.sql` applied |
| R2 bucket | `personal-expense-mail` | raw statement emails and attachments |

To recreate them in another account, run `./scripts/cf-setup.sh` with wrangler logged in.

### Automatic deploys from GitHub (Workers Builds)

Cloudflare builds and deploys the repository itself; no CI workflow is needed.

1. In the Cloudflare dashboard go to Workers & Pages › Create › Import a repository, connect
   GitHub, and pick `yalamber/personal-expense`.
2. Use these settings:

   | Setting | Value |
   | --- | --- |
   | Project name | `personal-expense` (must match `name` in `wrangler.jsonc`) |
   | Production branch | `main` |
   | Build command | `npm run build` |
   | Deploy command | `npx wrangler deploy` |
   | Root directory | `/` |

3. After the first deploy, add the `AUTH_SECRET` secret under the Worker's Settings › Variables
   and Secrets (any long random string, for example from `openssl rand -base64 32`). Until it is
   set, the API answers 503 and `/api/health` reports `authConfigured: false`.

Every push to the production branch then deploys. Pushes to other branches build preview versions.

The default Workers Builds token has no D1 permission, so the deploy command does not run
migrations. When a new file appears in `migrations/`, apply it before merging, either with
`npm run db:migrate:remote` from a logged-in machine or through the Cloudflare connector.

### Email Routing

In the dashboard, open Email › Email Routing for the domain you want statements sent to, and
add a rule (or catch-all) that sends `stmt+*@<domain>` to the Worker `personal-expense`. Then set
`INBOUND_DOMAIN` in `wrangler.jsonc` to that domain so the app shows the right address.

### Sign-in emails

`MAILER` is `log`, so sign-in links are written to the Worker's logs (Workers › personal-expense ›
Logs) rather than emailed. For real email, set `MAILER` to `resend`, set `MAIL_FROM` to a verified
sender, and add a `RESEND_API_KEY` secret.

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
