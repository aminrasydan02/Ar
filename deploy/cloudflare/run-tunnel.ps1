# Starts Sheet Metal Manager and a Cloudflare Tunnel on Windows.
# Set these first (never put the token in a file in the repo):
#   setx CF_TUNNEL_TOKEN "<token from Cloudflare Zero Trust > Networks > Tunnels>"
#   setx PUBLIC_URL "https://smm.example.com"
$ErrorActionPreference = 'Stop'
if (-not $env:CF_TUNNEL_TOKEN) { throw 'Set CF_TUNNEL_TOKEN first (see deploy/cloudflare/README.md)' }
if (-not $env:PUBLIC_URL) { throw 'Set PUBLIC_URL first, e.g. https://smm.example.com' }
$env:HOST = '127.0.0.1'        # only the tunnel can reach the app
$env:SECURE_COOKIES = '1'      # the public site is HTTPS
Set-Location (Join-Path $PSScriptRoot '..\..')
Start-Process -NoNewWindow node -ArgumentList '--disable-warning=ExperimentalWarning', 'server/server.js'
cloudflared tunnel --no-autoupdate run --token $env:CF_TUNNEL_TOKEN
