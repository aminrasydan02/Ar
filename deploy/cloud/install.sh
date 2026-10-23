#!/usr/bin/env bash
# Installs Sheet Metal Manager on a fresh Ubuntu 22.04/24.04 or Debian 12 cloud server
# (AWS EC2/Lightsail, Google Compute Engine, Azure VM, DigitalOcean, Vultr, Hetzner...).
# Run as root from the project folder:
#   sudo DOMAIN=smm.example.com bash deploy/cloud/install.sh
# Optional: DB_DRIVERS="pg" (or mysql2, mssql, oracledb) when DATABASE_URL in /etc/smm.env points to a server database.
set -euo pipefail
DOMAIN="${DOMAIN:?Set DOMAIN, e.g. DOMAIN=smm.example.com}"
SRC="$(cd "$(dirname "$0")/../.." && pwd)"
APP=/opt/smm

echo "== Node.js 22"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

echo "== Caddy (HTTPS)"
if ! command -v caddy >/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update && apt-get install -y caddy
fi

echo "== App files in $APP"
id smm >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin smm
mkdir -p "$APP/data"
cp -r "$SRC/server" "$SRC/public" "$SRC/tools" "$SRC/package.json" "$APP/"
if [ -n "${DB_DRIVERS:-}" ]; then (cd "$APP" && npm install --omit=dev --no-save --no-package-lock $DB_DRIVERS); fi
chown -R smm:smm "$APP"

echo "== Settings in /etc/smm.env"
if [ ! -f /etc/smm.env ]; then
  PW="$(head -c 18 /dev/urandom | base64 | tr -d '/+=')"
  cat > /etc/smm.env <<ENV
PORT=8080
HOST=127.0.0.1
DATA_DIR=$APP/data
SECURE_COOKIES=1
PUBLIC_URL=https://$DOMAIN
ADMIN_PASSWORD=$PW
BACKUP_EVERY_HOURS=24
ENV
  chmod 600 /etc/smm.env
  echo "   First admin password: $PW  (user: admin). Change it after signing in."
fi

echo "== Service and HTTPS"
cp "$SRC/deploy/cloud/smm.service" /etc/systemd/system/smm.service
sed "s/smm.example.com/$DOMAIN/" "$SRC/deploy/cloud/Caddyfile" > /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable --now smm
systemctl reload caddy || systemctl restart caddy
if command -v ufw >/dev/null; then ufw allow 22/tcp; ufw allow 80/tcp; ufw allow 443/tcp; fi

echo "Done. Open https://$DOMAIN (DNS for $DOMAIN must point to this server)."
echo "Logs: journalctl -u smm -f   Settings: /etc/smm.env (then: systemctl restart smm)"
