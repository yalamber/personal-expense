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
cp .dev.vars.example .dev.vars      # keeps sign-in links on localhost
npm run db:migrate:local            # applies migrations to the local D1
npm run dev                         # builds the web app on change and runs wrangler dev on :8787
```

Open http://localhost:8787, enter an email, and copy the sign-in link from the terminal
(`MAILER=log` prints outgoing mail instead of sending it).

To try the email path locally, send a raw message to the local Email Worker:

```sh
curl -X POST 'http://localhost:8787/cdn-cgi/handler/email?from=alerts@bank.example&to=stmt%2B<token>@statements.leadbase.stream' \
  --data-binary @test/fixtures/sample.eml
```

The `<token>` is shown on the inbox page as part of the household's inbound address.
Parsing runs right after delivery, so the row moves from `queued` to `no parser yet` within
a few seconds.

## Deploying

### What is already set up in Cloudflare

| Resource | Name | Notes |
| --- | --- | --- |
| D1 database | `personal-expense` | id `eddba7ce-aa58-43c2-891e-7a6e1a075757`, APAC; migrations `0000` and `0001` applied |
| R2 bucket | `personal-expense-mail` | raw statement emails and attachments |

| Address | Purpose |
| --- | --- |
| `https://money.leadbase.stream` | The app (custom domain, created on first deploy) |
| `https://personal-expense.<your-subdomain>.workers.dev` | Fallback address |
| `stmt+<household token>@statements.leadbase.stream` | Where each household forwards statements |

No secrets are required. The session-signing secret is generated on first use and stored in
the `app_settings` table; set an `AUTH_SECRET` Worker secret only if you want to manage it.

### Create the Worker with automatic deploys (one time)

1. Dashboard › Workers & Pages › Create › Import a repository › GitHub ›
   `yalamber/personal-expense`.
2. Settings:

   | Setting | Value |
   | --- | --- |
   | Project name | `personal-expense` (must match `name` in `wrangler.jsonc`) |
   | Production branch | `main`, or `claude/cool-archimedes-vk3kgg` until it is merged |
   | Build command | `npm run build` |
   | Deploy command | `npx wrangler deploy` |

3. Save and deploy. The first deploy creates `money.leadbase.stream`.

Every later push to the production branch deploys automatically.

### Email Routing for statements (one time)

1. Dashboard › Email Service › Email Routing › `leadbase.stream` › Settings:
   - under **Subdomains**, add `statements.leadbase.stream`
   - turn on **Subaddressing**
2. Routing Rules › Create: custom address `stmt@statements.leadbase.stream`, action
   **Send to a Worker**, Worker `personal-expense`.

With subaddressing on, `stmt+<token>@statements.leadbase.stream` matches that one rule and the
Worker reads the token. Email Routing must already be enabled on `leadbase.stream` to add a
subdomain. If `leadbase.stream` itself receives mail through another provider, check that
enabling Email Routing will not replace its MX records before you do it.

### Migrations

The default Workers Builds token has no D1 permission, so deploys do not run migrations. Apply a
new file in `migrations/` before merging, with `npm run db:migrate:remote` from a logged-in
machine or through the Cloudflare connector.

### Sign-in emails

`MAILER` is `log`, so sign-in links are written to the Worker's logs (Workers › personal-expense ›
Observability › Logs) rather than emailed. For real email, set `MAILER` to `resend`, set
`MAIL_FROM` to a verified sender, and add a `RESEND_API_KEY` secret.

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
