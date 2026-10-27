#!/usr/bin/env bash
# One-time set-up of a fresh Ubuntu VPS (Contabo) for DavoChain under PM2.
# Reports/PM2_VPS_GUIDE.md explains each step.
#
# Run it as the user that will own the apps (NOT root), who can use sudo:
#   bash setup-server.sh
#
# It installs Node.js 22, git and build tools, PM2 and its log rotation, makes
# PM2 start the apps again after a reboot, and creates /var/www/davochain.
# It does NOT install Postgres, Redis or Nginx, and does not touch .env files.
set -euo pipefail

APP_ROOT="${APP_ROOT:-/var/www/davochain}"
NODE_MAJOR="${NODE_MAJOR:-22}"

if [ "$(id -u)" -eq 0 ]; then
  echo "Run this as the app user (e.g. 'davochain'), not root. See the guide, step 2." >&2
  exit 1
fi

echo "==> System packages"
sudo apt-get update -y
sudo apt-get install -y curl git build-essential ca-certificates

echo "==> Node.js ${NODE_MAJOR}"
if ! node -v 2>/dev/null | grep -q "^v${NODE_MAJOR}\."; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v
npm -v

echo "==> PM2"
if ! command -v pm2 >/dev/null 2>&1; then
  sudo npm install -g pm2
fi
pm2 -v

echo "==> PM2 log rotation (keep 14 days, 20 MB per file, compressed)"
pm2 install pm2-logrotate >/dev/null
pm2 set pm2-logrotate:max_size 20M >/dev/null
pm2 set pm2-logrotate:retain 14 >/dev/null
pm2 set pm2-logrotate:compress true >/dev/null

echo "==> Start PM2 at boot (systemd)"
sudo env PATH="$PATH:/usr/bin" "$(command -v pm2)" startup systemd -u "$USER" --hp "$HOME"

echo "==> App folder ${APP_ROOT}"
sudo mkdir -p "$APP_ROOT"
sudo chown "$USER":"$USER" "$APP_ROOT"

cat <<EOF

Done. Next (guide step 4):
  cd ${APP_ROOT}
  git clone https://github.com/davosoftware/davochain-api.git api
  git clone https://github.com/davosoftware/Davochain-admin.git admin
  # put the live settings in ${APP_ROOT}/api/.env  (never commit it)
  bash ${APP_ROOT}/api/deploy/deploy.sh --first-time
EOF
