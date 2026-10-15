#!/usr/bin/env bash
# One-time Cloudflare setup: creates the D1 database, R2 bucket and queues the Worker
# needs, writes the D1 id into wrangler.jsonc, and applies migrations remotely.
# Safe to re-run: every step skips what already exists.
#
# Needs either `wrangler login` or CLOUDFLARE_API_TOKEN (+ CLOUDFLARE_ACCOUNT_ID) in the env.
set -euo pipefail
cd "$(dirname "$0")/.."

DB_NAME="personal-expense"
BUCKET="personal-expense-mail"
QUEUE="personal-expense-parse"
DLQ="personal-expense-parse-dlq"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "Checking Cloudflare access"
npx wrangler whoami >/dev/null

say "D1 database: $DB_NAME"
if ! npx wrangler d1 info "$DB_NAME" >/dev/null 2>&1; then
  npx wrangler d1 create "$DB_NAME" >/dev/null
  echo "created"
else
  echo "exists"
fi
DB_ID=$(npx wrangler d1 info "$DB_NAME" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).uuid))')
echo "id: $DB_ID"

if grep -q 'REPLACE_WITH_D1_ID' wrangler.jsonc; then
  sed -i.bak "s/REPLACE_WITH_D1_ID/$DB_ID/" wrangler.jsonc && rm -f wrangler.jsonc.bak
  echo "wrote database_id into wrangler.jsonc (commit this change)"
fi

say "R2 bucket: $BUCKET"
if npx wrangler r2 bucket info "$BUCKET" >/dev/null 2>&1; then
  echo "exists"
else
  npx wrangler r2 bucket create "$BUCKET" >/dev/null && echo "created"
fi

say "Queues: $QUEUE, $DLQ (Workers Paid plan required)"
for q in "$QUEUE" "$DLQ"; do
  if npx wrangler queues info "$q" >/dev/null 2>&1; then
    echo "$q exists"
  else
    npx wrangler queues create "$q" >/dev/null && echo "$q created"
  fi
done

say "Applying migrations to the remote database"
npx wrangler d1 migrations apply "$DB_NAME" --remote

say "Done. Next:"
cat <<'EOF'
  1. Set the secret:        npx wrangler secret put AUTH_SECRET
     (and RESEND_API_KEY if MAILER=resend)
  2. Edit wrangler.jsonc vars: APP_ORIGIN, INBOUND_DOMAIN, MAIL_FROM, MAILER
  3. Deploy:                npm run deploy
  4. In the Cloudflare dashboard, Email > Email Routing for INBOUND_DOMAIN:
     add a rule (or catch-all) that sends stmt+*@<domain> to the Worker "personal-expense".
EOF
