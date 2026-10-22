# Terbitkan laman web melalui Cloudflare Tunnel

Laman web kekal di PC atau server syarikat (data `data/` dan lukisan kekal di situ).
Cloudflare Tunnel membuka sambungan keluar ke Cloudflare, jadi tiada port router
perlu dibuka dan alamat awam terus guna HTTPS.

## Perlu ada
- Akaun Cloudflare dan domain syarikat dalam Cloudflare (contoh `example.com`).
- PC/server yang sentiasa hidup dengan Node.js 22.13 ke atas.
- `cloudflared` dipasang: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

## Langkah
1. Cloudflare dashboard > **Zero Trust > Networks > Tunnels > Create a tunnel** (jenis Cloudflared).
   Beri nama, contoh `smm`.
2. Salin **token** tunnel. Jangan simpan token dalam repo atau hantar dalam chat.
3. Tab **Public Hostname**: subdomain `smm`, domain `example.com`,
   service `HTTP` ke `127.0.0.1:8080`.
4. Di PC server (Windows, PowerShell):
   ```powershell
   setx CF_TUNNEL_TOKEN "<token>"
   setx PUBLIC_URL "https://smm.example.com"
   ```
   Buka PowerShell baharu, kemudian jalankan `deploy\cloudflare\run-tunnel.ps1`.
   Linux: `export` dua nilai itu dan jalankan `deploy/cloudflare/run-tunnel.sh`.
5. Buka `https://smm.example.com` dan log masuk.

Untuk mula sendiri bila PC dihidupkan: `cloudflared service install <token>` (Windows service),
dan jalankan laman web sebagai service (contoh Task Scheduler "At startup").

## Lapisan login tambahan (pilihan)
**Zero Trust > Access > Applications > Add (Self-hosted)** untuk `smm.example.com`.
Hanya emel syarikat (contoh `@syarikat.com.my`) boleh sampai ke halaman login.

## Nota keselamatan
- `HOST=127.0.0.1`: laman hanya boleh dicapai melalui tunnel.
- `SECURE_COOKIES=1`: cookie login hanya dihantar melalui HTTPS.
- `PUBLIC_URL`: alamat awam yang dibenarkan menghantar borang.
- Tukar kata laluan `admin` sebelum diterbitkan. Backup folder `data/` setiap hari.
