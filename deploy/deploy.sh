#!/usr/bin/env bash
# Release DavoChain on the VPS: fetch the code, install, build, update the
# database, then (re)start both apps under PM2. Reports/PM2_VPS_GUIDE.md.
#
#   bash /var/www/davochain/api/deploy/deploy.sh               # a normal release
#   bash /var/www/davochain/api/deploy/deploy.sh --first-time  # also loads the starting data (seed)
#
# Branches: API_BRANCH and ADMIN_BRANCH (default: main).
# Stops at the first error, BEFORE restarting anything, so a failed build
# leaves the running version alone as far as possible.
set -euo pipefail

APP_ROOT="${APP_ROOT:-/var/www/davochain}"
API_BRANCH="${API_BRANCH:-main}"
ADMIN_BRANCH="${ADMIN_BRANCH:-main}"
FIRST_TIME=false
[ "${1:-}" = "--first-time" ] && FIRST_TIME=true

API="$APP_ROOT/api"
ADMIN="$APP_ROOT/admin"

if [ ! -f "$API/.env" ]; then
  echo "Missing $API/.env. Put the live settings there first (guide step 5)." >&2
  exit 1
fi
if ! grep -q '^NODE_ENV=production' "$API/.env"; then
  echo "$API/.env must say NODE_ENV=production." >&2
  exit 1
fi

update() { # folder branch
  echo "==> $1: $2"
  git -C "$1" fetch --quiet origin
  git -C "$1" checkout --quiet "$2"
  git -C "$1" pull --ff-only --quiet origin "$2"
  git -C "$1" log --oneline -1
}

update "$API" "$API_BRANCH"
update "$ADMIN" "$ADMIN_BRANCH"

echo "==> API: install and build"
cd "$API"
npm install --no-audit --no-fund
npx prisma generate
npm run build

echo "==> Dashboard: install and build"
cd "$ADMIN"
npm install --no-audit --no-fund
npm run build

echo "==> Database: apply new changes (migrations)"
cd "$API"
npx prisma migrate deploy
if [ "$FIRST_TIME" = true ]; then
  echo "==> First time: load the starting data (coins, networks, settings)"
  npm run seed
fi

echo "==> (Re)start under PM2"
pm2 startOrReload "$API/ecosystem.config.js" --update-env
pm2 startOrReload "$ADMIN/ecosystem.config.js" --update-env
pm2 save

echo "==> Health check"
PORT="$(grep -E '^PORT=' "$API/.env" | cut -d= -f2 | tr -d '\r"' || true)"
PORT="${PORT:-3000}"
ok=false
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then ok=true; break; fi
  sleep 2
done
if [ "$ok" = true ]; then
  echo "API answers on port ${PORT}."
else
  echo "The API did not answer within 60 seconds. Look at: pm2 logs davochain-api --lines 100" >&2
  exit 1
fi
if curl -fsS -o /dev/null "http://127.0.0.1:3100/login"; then
  echo "Dashboard answers on port 3100."
else
  echo "The dashboard did not answer. Look at: pm2 logs davochain-admin --lines 100" >&2
  exit 1
fi
pm2 status
