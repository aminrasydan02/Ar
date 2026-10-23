#!/bin/sh
# Starts Sheet Metal Manager and a Cloudflare Tunnel on Linux.
# export CF_TUNNEL_TOKEN=...   (from Cloudflare Zero Trust > Networks > Tunnels; never commit it)
# export PUBLIC_URL=https://smm.example.com
set -e
: "${CF_TUNNEL_TOKEN:?Set CF_TUNNEL_TOKEN first (see deploy/cloudflare/README.md)}"
: "${PUBLIC_URL:?Set PUBLIC_URL first, e.g. https://smm.example.com}"
cd "$(dirname "$0")/../.."
HOST=127.0.0.1 SECURE_COOKIES=1 node --disable-warning=ExperimentalWarning server/server.js &
APP=$!
trap 'kill $APP' EXIT
cloudflared tunnel --no-autoupdate run --token "$CF_TUNNEL_TOKEN"
