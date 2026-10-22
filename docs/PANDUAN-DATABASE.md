# Panduan Database, Export dan Publish — Sheet Metal Manager

Satu fail ini mengandungi semua yang diperlukan untuk menjalankan website Sheet Metal Manager pada mana-mana database yang disokong, memindah data, membuat backup jangka panjang, menghantar data ke Google BigQuery, dan menerbitkan (publish) website. Format setiap jadual dan medan juga disenaraikan di hujung fail.

Kandungan

1. Ringkasan dan status ujian
2. Memilih database
3. Tetapan sambungan (`DATABASE_URL`) dan driver
4. Tatacara publish untuk setiap database
5. Memindah data antara database
6. Backup jangka panjang, Cloudflare R2 dan Amazon S3
7. Google BigQuery (laporan)
8. Publish website: Cloudflare Tunnel (pilihan syarikat)
9. Publish website: cloud server (Docker atau VPS)
10. Halaman Admin "Database & backup"
11. Format fail export
12. Semua tetapan (environment variables)
13. Format jadual dan medan
14. Masalah biasa

---

## 1. Ringkasan dan status ujian

- Website ini menulis SQL sekali sahaja. Lapisan `server/lib/dbx` menterjemah SQL itu untuk setiap jenis database. Lapisan ini juga mencipta jadual, indeks dan pautan, dan menaik taraf jadual lama secara automatik semasa server dimulakan.
- SQLite ialah lalai. Ia terbina dalam Node.js 22.13 ke atas, jadi tiada pemasangan tambahan diperlukan.
- Untuk database lain, hanya driver bagi database itu dipasang (contoh `npm install pg`). Driver tidak dimasukkan dalam `package.json`, jadi website asas kekal tanpa sebarang pakej npm.
- Kata laluan dan token hanya diletakkan dalam environment variable atau `config.json`. Jangan simpan dalam repo.

| Database / perkhidmatan | Status | Apa yang diuji |
|---|---|---|
| SQLite (lalai) | **Diuji penuh** | 38/38 ujian, backup, import, skrip SQL |
| PostgreSQL 16 | **Diuji penuh** | 32/32 ujian API, copy-to, skrip SQL dimuat dengan `psql`, docker-compose |
| MariaDB 10.11 (MySQL) | **Diuji penuh** | 32/32 ujian API, copy-to, skrip SQL dimuat dengan `mariadb` |
| SQL Server 2022 | **Diuji penuh** | 32/32 ujian API, copy-to, skrip SQL dimuat dengan `sqlcmd` |
| Oracle Database 23 Free | **Diuji penuh** | 32/32 ujian API, copy-to, skrip SQL dimuat dengan `sqlplus` |
| Supabase, Neon, AWS RDS/Aurora PostgreSQL, Azure PostgreSQL, Google Cloud SQL | Sama seperti PostgreSQL | Protokol sama; perlu `?sslmode=require` |
| MySQL 8, PlanetScale, TiDB, Aurora MySQL | Usaha terbaik | Hanya MariaDB diuji; protokol sama |
| Azure SQL Database | Sama seperti SQL Server | Enjin yang sama |
| Cloudflare D1 | Usaha terbaik (belum diuji) | Melalui REST API Cloudflare; tiada token untuk ujian |
| Turso / libSQL | Usaha terbaik (belum diuji) | Melalui HTTP (Hrana); tiada token untuk ujian |
| Cloudflare R2 / Amazon S3 | Diuji dengan pelayan tiruan | Tandatangan AWS SigV4 disemak sama dengan AWS signer rasmi; belum diuji pada bucket sebenar |
| Google BigQuery | Belum diuji | Tiada akaun servis untuk ujian |

Nota SQL Server: pemadaman berantai (ON DELETE CASCADE) dibuat oleh aplikasi, bukan oleh database, kerana SQL Server tidak membenarkan beberapa laluan cascade ke jadual yang sama.

---

## 2. Memilih database

| Keperluan | Cadangan |
|---|---|
| Satu kilang, satu PC/server, pengguna < 50 | **SQLite** (lalai). Paling mudah; backup ialah satu fail. |
| Cloud server, ramai pengguna serentak, data jangka panjang | **PostgreSQL** (sendiri, Supabase, Neon, RDS, Cloud SQL, Azure). |
| Syarikat sudah guna Microsoft | **SQL Server / Azure SQL**. |
| Syarikat sudah ada lesen Oracle | **Oracle Database**. |
| Hosting web biasa (cPanel) yang ada MySQL | **MySQL / MariaDB**. |
| Laporan dan analisis (Looker Studio) | Kekalkan database di atas, dan **export ke BigQuery** (seksyen 7). |

Pangkalan data gred perusahaan untuk simpanan jangka panjang: PostgreSQL, SQL Server dan Oracle. Ketiga-tiganya diuji penuh. Gabungkan dengan backup harian ke R2/S3 (seksyen 6).

---

## 3. Tetapan sambungan (`DATABASE_URL`) dan driver

Database dipilih dengan satu tetapan, `DATABASE_URL` (atau `"databaseUrl"` dalam `config.json`). Jika tidak ditetapkan, website guna SQLite di `data/smm.sqlite`.

| Database | Contoh `DATABASE_URL` | Pasang driver |
|---|---|---|
| SQLite | *(kosong)* atau `sqlite:/var/lib/smm/smm.sqlite` | tiada |
| PostgreSQL | `postgres://smm:KATA@host:5432/smm` | `npm install pg` |
| PostgreSQL awan (SSL) | `postgres://user:KATA@host:5432/db?sslmode=require` | `npm install pg` |
| MySQL / MariaDB | `mysql://smm:KATA@host:3306/smm` (SSL: `?ssl=true`) | `npm install mysql2` |
| SQL Server / Azure SQL | `mssql://user:KATA@host:1433/smm` (sijil sendiri: `?trustServerCertificate=true`) | `npm install mssql` |
| Oracle | `oracle://user:KATA@host:1521/NAMA_SERVIS` | `npm install oracledb` |
| Cloudflare D1 | `d1://<account id>/<database id>` + `CLOUDFLARE_API_TOKEN` | tiada |
| Turso / libSQL | `libsql://<db>-<org>.turso.io` + `LIBSQL_AUTH_TOKEN` | tiada |

Pemasangan driver dibuat dalam folder projek (folder yang ada `package.json`):

```
npm install --no-save pg
```

Aksara khas dalam kata laluan (`@ : / ? #`) mesti ditulis dalam bentuk URL, contoh `@` menjadi `%40`.

---

## 4. Tatacara publish untuk setiap database

Langkah umum untuk semua database:

1. Cipta database kosong dan satu pengguna yang boleh mencipta jadual.
2. Pasang driver (jadual seksyen 3).
3. Tetapkan `DATABASE_URL`.
4. Mulakan website (`npm start`). Jadual, indeks dan pautan dicipta secara automatik.
5. Jika ada data lama, pindahkan dengan `copy-to` atau `import-backup` (seksyen 5).

### 4.1 SQLite (lalai)

1. Pasang Node.js 22.13 ke atas.
2. `npm start`. Fail database ialah `data/smm.sqlite`.
3. Backup: salin folder `data/` (termasuk `drawings/`), atau guna backup automatik (seksyen 6).

### 4.2 PostgreSQL (server sendiri)

```sql
CREATE USER smm WITH PASSWORD 'KATA';
CREATE DATABASE smm OWNER smm;
```

```
npm install --no-save pg
export DATABASE_URL=postgres://smm:KATA@127.0.0.1:5432/smm
npm start
```

### 4.3 Supabase

1. Cipta projek di supabase.com.
2. **Project Settings > Database > Connection string > URI**. Guna "Session pooler" (port 5432).
3. `DATABASE_URL=postgres://postgres.<ref>:KATA@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require`
4. `npm install --no-save pg` dan `npm start`.

### 4.4 Neon

1. Cipta projek di neon.tech. Pilih rantau Singapura (`ap-southeast-1`).
2. Salin connection string, contoh `postgres://user:KATA@ep-xxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`.
3. `npm install --no-save pg` dan `npm start`.

### 4.5 AWS RDS / Aurora PostgreSQL, Google Cloud SQL, Azure Database for PostgreSQL

1. Cipta instance PostgreSQL 14 ke atas. Benarkan IP server website dalam security group / authorized networks / firewall.
2. Cipta database `smm` dan pengguna (seperti 4.2).
3. `DATABASE_URL=postgres://smm:KATA@<endpoint>:5432/smm?sslmode=require`
4. `npm install --no-save pg` dan `npm start`.

### 4.6 MySQL / MariaDB (server sendiri atau cPanel)

```sql
CREATE DATABASE smm CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'smm'@'%' IDENTIFIED BY 'KATA';
GRANT ALL PRIVILEGES ON smm.* TO 'smm'@'%';
```

```
npm install --no-save mysql2
export DATABASE_URL=mysql://smm:KATA@127.0.0.1:3306/smm
npm start
```

Untuk server dalam mesin yang sama, MariaDB mungkin perlukan pengguna `'smm'@'localhost'` juga.

### 4.7 PlanetScale, TiDB Cloud, AWS Aurora MySQL

1. Cipta database dan kata laluan dalam konsol penyedia.
2. `DATABASE_URL=mysql://user:KATA@<host>:3306/<db>?ssl=true`
3. `npm install --no-save mysql2` dan `npm start`.

PlanetScale tidak menyokong FOREIGN KEY secara lalai. Hidupkan "Foreign key constraints" dalam tetapan database sebelum memulakan website.

### 4.8 SQL Server dan Azure SQL

```sql
CREATE DATABASE smm;
CREATE LOGIN smm WITH PASSWORD = 'KATA';
USE smm; CREATE USER smm FOR LOGIN smm; ALTER ROLE db_owner ADD MEMBER smm;
```

```
npm install --no-save mssql
export DATABASE_URL="mssql://smm:KATA@127.0.0.1:1433/smm?trustServerCertificate=true"
npm start
```

Azure SQL: `mssql://user:KATA@<server>.database.windows.net:1433/<db>` (sambungan sentiasa disulitkan). Benarkan IP server dalam **Networking > Firewall rules**.

### 4.9 Oracle Database (19c, 21c, 23ai, Autonomous Database)

```sql
-- sebagai pentadbir, dalam PDB (contoh FREEPDB1)
CREATE USER smm IDENTIFIED BY "KATA" QUOTA UNLIMITED ON USERS;
GRANT CREATE SESSION, CREATE TABLE, CREATE SEQUENCE TO smm;
```

```
npm install --no-save oracledb
export DATABASE_URL=oracle://smm:KATA@127.0.0.1:1521/FREEPDB1
npm start
```

Nilai selepas `/` ialah nama servis (service name), bukan SID. Driver `oracledb` berjalan dalam mod "Thin", jadi Oracle Instant Client tidak diperlukan.

### 4.10 Cloudflare D1 (usaha terbaik)

1. Cloudflare dashboard > **Storage & Databases > D1 > Create database**. Salin Database ID.
2. Cipta API token: **My Profile > API Tokens > Create Token**, dengan kebenaran "Account > D1 > Edit".
3. Tetapkan:
   ```
   DATABASE_URL=d1://<account id>/<database id>
   CLOUDFLARE_API_TOKEN=<token>
   ```
4. `npm start`.

Setiap pertanyaan dihantar melalui internet ke Cloudflare. Website akan lebih perlahan berbanding database dalam rangkaian yang sama. D1 sesuai untuk data kecil sahaja (had 10 GB satu database).

### 4.11 Turso / libSQL (usaha terbaik)

1. `turso db create smm` dan `turso db tokens create smm`.
2. Tetapkan:
   ```
   DATABASE_URL=libsql://smm-<org>.turso.io
   LIBSQL_AUTH_TOKEN=<token>
   ```
3. `npm start`.

---

## 5. Memindah data antara database

Semua arahan dijalankan dalam folder projek. Arahan membaca database semasa daripada `DATABASE_URL`.

| Arahan | Fungsi |
|---|---|
| `node server/server.js copy-to <URL sasaran> [--replace]` | Salin semua data terus ke database lain, kemudian semak bilangan baris setiap jadual |
| `node server/server.js export-backup <fail.json.gz>` | Simpan semua data ke satu fail backup |
| `node server/server.js import-backup <fail> [--replace]` | Muat fail backup ke database semasa, kemudian semak |
| `node server/server.js verify-backup <fail>` | Bandingkan fail backup dengan database semasa |
| `node server/server.js export-sql <postgres\|mysql\|mssql\|oracle\|sqlite> <fail.sql>` | Skrip SQL yang mencipta jadual dan memasukkan semua baris |
| `node server/server.js backup-now` | Backup sekarang (folder data dan R2/S3) |
| `node server/server.js export-bigquery` | Hantar semua jadual ke BigQuery |

Contoh: memindah dari SQLite ke PostgreSQL.

```
npm install --no-save pg
node server/server.js copy-to postgres://smm:KATA@db-host:5432/smm
# Copied 429 rows from sqlite to postgres.
# Check passed: every table has the same number of rows.
```

Kemudian tetapkan `DATABASE_URL` kepada database baharu dan mulakan semula website. Folder `data/drawings/` (fail lukisan) perlu disalin secara berasingan.

`--replace` memadam data sedia ada dalam sasaran sebelum memuat. Tanpa `--replace`, arahan berhenti jika sasaran sudah ada data.

Nombor id rekod dikekalkan. Selepas pemindahan, kaunter id dibetulkan supaya rekod baharu bermula selepas id terbesar.

Menjalankan skrip SQL:

| Database | Arahan |
|---|---|
| PostgreSQL | `psql "postgres://..." -v ON_ERROR_STOP=1 -f smm-postgres.sql` |
| MySQL / MariaDB | `mysql -u smm -p smm < smm-mysql.sql` |
| SQL Server | `sqlcmd -S host -U smm -P KATA -d smm -i smm-mssql.sql` |
| Oracle | `sqlplus smm/KATA@host:1521/FREEPDB1 @smm-oracle.sql` |
| SQLite | `sqlite3 smm.sqlite < smm-sqlite.sql` |

Skrip SQL mesti dijalankan pada database kosong.

---

## 6. Backup jangka panjang, Cloudflare R2 dan Amazon S3

Backup automatik berjalan setiap `BACKUP_EVERY_HOURS` jam (lalai 24; `0` = mati).

Setiap backup:

1. Ditulis ke `data/backups/smm-YYYYMMDD-HHMMSS.json.gz`, dengan bilangan baris dan checksum SHA-256.
2. Dimuat naik ke `db/<fail>` dalam bucket, jika R2/S3 ditetapkan.
3. Fail lukisan baharu dimuat naik ke `drawings/` dalam bucket. Fail yang sudah ada tidak dihantar semula.

Peraturan simpanan (untuk folder tempatan dan bucket):

- Setiap backup disimpan selama `BACKUP_KEEP_DAYS` hari (lalai 30).
- Selepas itu, hanya backup pertama setiap bulan disimpan, selama `BACKUP_KEEP_MONTHS` bulan (lalai 120 = 10 tahun; `0` = selama-lamanya).

### 6.1 Cloudflare R2

1. Cloudflare dashboard > **R2 Object Storage > Create bucket**, contoh `smm-backup`.
2. **R2 > Manage API tokens > Create API token**, dengan kebenaran "Object Read & Write" untuk bucket itu. Salin Access Key ID dan Secret Access Key.
3. Tetapkan:
   ```
   BACKUP_STORAGE=r2
   R2_ACCOUNT_ID=<account id>
   R2_BUCKET=smm-backup
   R2_ACCESS_KEY_ID=<access key id>
   R2_SECRET_ACCESS_KEY=<secret>
   ```
4. Uji: `node server/server.js backup-now`. Hasilnya patut berbunyi "uploaded to Cloudflare R2".

### 6.2 Amazon S3

1. Cipta bucket di rantau `ap-southeast-1` (Singapura) atau `ap-southeast-5` (Malaysia). Sekat semua akses awam.
2. Cipta pengguna IAM dengan polisi `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` dan `s3:ListBucket` untuk bucket itu sahaja.
3. Tetapkan:
   ```
   BACKUP_STORAGE=s3
   S3_BUCKET=smm-backup
   S3_REGION=ap-southeast-1
   S3_ACCESS_KEY_ID=<key>
   S3_SECRET_ACCESS_KEY=<secret>
   ```
4. Pilihan: hidupkan **Versioning** dan **Object Lock** untuk perlindungan tambahan.

Storan lain yang serasi dengan S3 (MinIO, Wasabi, Backblaze B2): `BACKUP_STORAGE=s3` dengan `S3_ENDPOINT=https://...`.

### 6.3 Memulihkan daripada backup

1. Muat turun fail backup dari bucket (`db/smm-....json.gz`), atau ambil dari `data/backups/`.
2. `node server/server.js import-backup smm-....json.gz --replace`
3. Salin semula fail lukisan dari `drawings/` dalam bucket ke `data/drawings/`.

---

## 7. Google BigQuery (laporan)

BigQuery ialah gudang data untuk laporan, bukan database harian website. Website kekal pada database pilihan, dan setiap export menggantikan jadual BigQuery dengan salinan terkini. Setiap baris mendapat medan tambahan `exported_at`.

1. Google Cloud Console: cipta projek dan hidupkan **BigQuery API**.
2. **IAM > Service Accounts > Create**. Beri peranan "BigQuery Data Editor" dan "BigQuery Job User".
3. Cipta kunci JSON. Simpan di server (contoh `data/bigquery-key.json`), bukan dalam repo.
4. Tetapkan:
   ```
   BIGQUERY_PROJECT=<project id>
   BIGQUERY_DATASET=smm
   BIGQUERY_LOCATION=asia-southeast1
   GOOGLE_APPLICATION_CREDENTIALS=/path/bigquery-key.json
   BIGQUERY_EVERY_HOURS=24      # 0 = hanya bila diminta
   ```
5. Uji: `node server/server.js export-bigquery`, atau butang **Export to BigQuery** dalam halaman Admin.
6. Looker Studio: **Add data > BigQuery >** projek > dataset `smm`.

---

## 8. Publish website: Cloudflare Tunnel (pilihan syarikat)

Website dan data kekal di PC atau server syarikat. Cloudflare Tunnel membuka sambungan keluar ke Cloudflare, jadi port router tidak perlu dibuka, dan alamat awam terus menggunakan HTTPS.

Perlu ada:

- Akaun Cloudflare dengan domain syarikat.
- PC/server yang sentiasa hidup, dengan Node.js 22.13 ke atas.
- `cloudflared` dipasang.

Langkah:

1. Cloudflare dashboard > **Zero Trust > Networks > Tunnels > Create a tunnel** (jenis Cloudflared). Beri nama, contoh `smm`.
2. Salin **token** tunnel. Jangan simpan token dalam repo atau hantar dalam chat.
3. Tab **Public Hostname**: masukkan subdomain (contoh `smm`) dan domain syarikat, dengan service `HTTP` ke `127.0.0.1:8080`.
4. Di PC server (Windows, PowerShell):
   ```powershell
   setx CF_TUNNEL_TOKEN "<token>"
   setx PUBLIC_URL "https://smm.domain-syarikat.com"
   ```
   Buka PowerShell baharu, kemudian jalankan `deploy\cloudflare\run-tunnel.ps1`.
   Di Linux, `export` dua nilai itu dan jalankan `deploy/cloudflare/run-tunnel.sh`.
5. Buka `https://smm.domain-syarikat.com` dan log masuk.
6. Supaya semuanya bermula sendiri bila PC dihidupkan:
   - Jalankan `cloudflared service install <token>` (Windows service).
   - Jalankan website sebagai service (contoh Task Scheduler, "At startup").
7. Hidupkan backup ke R2 (seksyen 6.1). Data berada di satu PC, jadi salinan luar adalah penting.

Lapisan login tambahan (pilihan): **Zero Trust > Access > Applications**. Hanya e-mel syarikat boleh membuka alamat tersebut. Butiran lanjut ada dalam `deploy/cloudflare/README.md`.

Cloudflare Workers dan Pages biasa tidak boleh menjalankan website ini. Website ini ialah server Node.js dengan database dan fail lukisan, jadi Tunnel atau cloud server yang digunakan.

---

## 9. Publish website: cloud server (Docker atau VPS)

### 9.1 Docker Compose (website + PostgreSQL)

Untuk mana-mana cloud server yang ada Docker (AWS EC2/Lightsail, Google Compute Engine, Azure VM, DigitalOcean, Hetzner).

```
cp .env.example .env        # isi ADMIN_PASSWORD, POSTGRES_PASSWORD, PUBLIC_URL
docker compose up -d --build
docker compose logs -f app
```

- Website dibuka di `127.0.0.1:8080` pada server. Letakkan HTTPS di hadapan (Caddy, seperti 9.2, atau load balancer awan).
- Data PostgreSQL disimpan dalam volume `pgdata`. Lukisan dan backup disimpan dalam volume `appdata`.
- Backup manual: `docker compose exec app node server/server.js backup-now`
- Imej sahaja (SQLite): `docker build -t smm .` dan `docker run -d -p 8080:8080 -v smmdata:/data -e ADMIN_PASSWORD=... smm`
- Driver lain dalam imej: `docker build --build-arg DB_DRIVERS="mssql" -t smm .`

### 9.2 VPS tanpa Docker (Ubuntu / Debian, HTTPS automatik)

1. Halakan DNS domain (rekod A) ke IP server.
2. Salin projek ke server, kemudian:
   ```
   sudo DOMAIN=smm.domain-syarikat.com bash deploy/cloud/install.sh
   ```
3. Skrip ini:
   - memasang Node.js 22 dan Caddy
   - menyalin aplikasi ke `/opt/smm`
   - mencipta `/etc/smm.env` dengan kata laluan admin pertama (dipaparkan sekali)
   - memasang service systemd `smm`
   - menyediakan HTTPS
4. Database lain: tambah `DATABASE_URL=...` dalam `/etc/smm.env`, jalankan semula skrip dengan `DB_DRIVERS="pg"`, kemudian `systemctl restart smm`.
5. Log: `journalctl -u smm -f`.

---

## 10. Halaman Admin "Database & backup"

Menu **Admin > Database & backup** (Admin sahaja) memaparkan:

- database yang digunakan dan versi skema
- bilangan baris setiap jadual
- jadual backup automatik dan peraturan simpanan
- storan backup (R2/S3) dan tetapan BigQuery
- butang **Backup file (.json.gz)** untuk memuat turun backup penuh
- butang skrip SQL untuk PostgreSQL, MySQL/MariaDB, SQL Server, Oracle dan SQLite
- butang **Backup now** dan **Export to BigQuery**
- senarai backup yang tersimpan (tempatan dan dalam bucket)

Setiap muat turun, backup dan export direkodkan dalam Activity log.

---

## 11. Format fail export

### 11.1 Fail backup (`.json.gz`)

JSON yang dimampatkan dengan gzip:

```json
{
  "format": "sheet-metal-manager-backup",
  "version": 1,
  "app": "2.1.0",
  "schema_version": 5,
  "source": "sqlite",
  "created_at": "2026-10-22 18:31:14 UTC",
  "counts": { "projects": 1, "parts": 6, "...": 0 },
  "sha256": "<checksum bagi bahagian tables>",
  "tables": {
    "projects": [ { "id": 1, "code": "NEWAYS", "name": "...", "...": "..." } ],
    "parts": [ ]
  }
}
```

- `tables` mengandungi setiap jadual sebagai senarai baris, dengan nama medan seperti dalam seksyen 13.
- `sha256` dikira daripada `JSON.stringify(tables)`. Fail yang rosak atau diubah akan ditolak semasa import.
- Fail ini boleh dimuat ke mana-mana database yang disokong.

### 11.2 Skrip SQL

Satu fail `.sql` untuk setiap jenis database, mengandungi:

1. `CREATE TABLE`, indeks dan pautan (FOREIGN KEY), mengikut jenis medan dalam seksyen 13.
2. `INSERT` untuk setiap baris, mengikut susunan supaya jadual induk dimasukkan dahulu.
3. Pembetulan kaunter id (PostgreSQL `setval`, MySQL `AUTO_INCREMENT`, Oracle `START WITH`, SQL Server `IDENTITY_INSERT`).

Ciri khas setiap jenis:

| Database | Ciri khas |
|---|---|
| SQL Server | Setiap arahan diakhiri `GO` |
| Oracle | Teks panjang dipecah dengan `TO_CLOB`; bermula dengan `SET DEFINE OFF` |
| MySQL | Semakan pautan dimatikan semasa memuat |
| SQLite | Semua dalam satu transaksi |

### 11.3 BigQuery

| Perkara | Format |
|---|---|
| Dataset | `BIGQUERY_DATASET` (lalai `smm`) |
| Jadual | Satu jadual BigQuery bagi setiap jadual website, dengan nama yang sama |
| Jenis medan | `INT64` (id, int), `FLOAT64` (real), `STRING` (key, text, long) |
| Medan tambahan | `exported_at TIMESTAMP` |
| Cara muat | `WRITE_TRUNCATE`: setiap export menggantikan isi jadual |

### 11.4 Fail lain

- Excel / CSV daripada setiap senarai, Hourly output dan Actual output (butang Export dalam halaman berkenaan).
- Fail lukisan disimpan apa adanya dalam `data/drawings/`, dan dalam `drawings/` di bucket R2/S3.

---

## 12. Semua tetapan (environment variables)

| Tetapan | Lalai | Maksud |
|---|---|---|
| `PORT` | 8080 | Port website |
| `HOST` | 0.0.0.0 | Alamat dengar (`127.0.0.1` di belakang Caddy/Tunnel) |
| `DATA_DIR` | `./data` | Folder data, lukisan dan backup |
| `DATABASE_URL` | *(SQLite)* | Database (seksyen 3) |
| `ADMIN_PASSWORD` | *(dijana)* | Kata laluan admin pertama |
| `COMPANY` | Sheet Metal Department | Nama syarikat pada Job Traveller dan laporan |
| `PUBLIC_URL` | | Alamat awam, contoh `https://smm.domain.com` (boleh beberapa, dipisah koma) |
| `SECURE_COOKIES` | 0 | `1` bila website dibuka melalui HTTPS |
| `CLOUDFLARE_API_TOKEN` | | Untuk D1 |
| `LIBSQL_AUTH_TOKEN` | | Untuk Turso |
| `BACKUP_EVERY_HOURS` | 24 | Selang backup automatik; `0` = mati |
| `BACKUP_KEEP_DAYS` | 30 | Simpan setiap backup selama ini |
| `BACKUP_KEEP_MONTHS` | 120 | Kemudian satu sebulan selama ini; `0` = selama-lamanya |
| `BACKUP_STORAGE` | | `r2` atau `s3` |
| `BACKUP_PREFIX` | `smm-backups/` | Folder dalam bucket |
| `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | | Cloudflare R2 |
| `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | | Amazon S3 |
| `S3_ENDPOINT`, `S3_SESSION_TOKEN` | | Storan serasi S3 lain / kunci sementara |
| `BIGQUERY_PROJECT`, `BIGQUERY_DATASET`, `BIGQUERY_LOCATION` | –, `smm`, `US` | Google BigQuery |
| `GOOGLE_APPLICATION_CREDENTIALS` atau `BIGQUERY_CREDENTIALS` | | Laluan kunci JSON, atau isi JSON itu sendiri |
| `BIGQUERY_EVERY_HOURS` | 0 | Export automatik ke BigQuery |
| `DBX_DEBUG` | | `1` untuk log SQL yang gagal (penyelesaian masalah) |

---

## 13. Format jadual dan medan

Website mempunyai 34 jadual. Setiap medan mempunyai satu jenis logik, dan jenis itu ditukar kepada jenis sebenar bagi setiap database seperti dalam jadual di bawah.

- Tarikh dan masa disimpan sebagai teks ISO, contoh `2026-10-22` dan `2026-10-22 18:31:14` (UTC).
- Medan "masa sekarang" diisi semasa rekod dicipta.
- Pautan "(CASCADE)" bermaksud rekod anak dipadam bersama rekod induk. "(SET NULL)" bermaksud pautan dikosongkan.

| Jenis logik | Maksud | SQLite / D1 / Turso | PostgreSQL | MySQL / MariaDB | SQL Server | Oracle | BigQuery |
|---|---|---|---|---|---|---|---|
| `id` | Nombor rekod automatik (kunci utama) | `INTEGER PRIMARY KEY` | `INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY` | `INT AUTO_INCREMENT PRIMARY KEY` | `INT IDENTITY(1,1) PRIMARY KEY` | `NUMBER(10) GENERATED BY DEFAULT ON NULL AS IDENTITY PRIMARY KEY` | `INT64` |
| `int` | Nombor bulat | `INTEGER` | `INTEGER` | `INT` | `INT` | `NUMBER(10)` | `INT64` |
| `real` | Nombor perpuluhan | `REAL` | `DOUBLE PRECISION` | `DOUBLE` | `FLOAT` | `BINARY_DOUBLE` | `FLOAT64` |
| `key` | Teks pendek (kod, tarikh, status; boleh diindeks) | `TEXT` | `TEXT` | `VARCHAR(255)` | `NVARCHAR(200)` | `VARCHAR2(450 CHAR)` | `STRING` |
| `text` | Teks biasa | `TEXT` | `TEXT` | `LONGTEXT` | `NVARCHAR(MAX)` | `VARCHAR2(4000 CHAR)` | `STRING` |
| `long` | Teks panjang (JSON, susun atur) | `TEXT` | `TEXT` | `LONGTEXT` | `NVARCHAR(MAX)` | `CLOB` | `STRING` |

#### meta

Kunci utama: key.

| Medan | Jenis | Wajib | Lalai | Pautan |
|---|---|---|---|---|
| key | key |  |  |  |
| value | text |  |  |  |

#### users

Kunci utama: id.

| Medan | Jenis | Wajib | Lalai | Pautan |
|---|---|---|---|---|
| id | id | ya |  |  |
| username | key | ya |  |  |
| full_name | text |  |  |  |
| role | key | ya |  |  |
| password_hash | text | ya |  |  |
| active | int | ya | 1 |  |
| created_at | key | ya | masa sekarang |  |
| process | text |  |  |  |
| theme | text |  |  |  |
| full_edit | int | ya | 0 |  |
| extra_processes | text |  |  |  |

#### sessions

Kunci utama: token.

| Medan | Jenis | Wajib | Lalai | Pautan |
|---|---|---|---|---|
| token | key |  |  |  |
| user_id | int | ya |  | users.id (CASCADE) |
| expires | key | ya |  |  |

#### audit

Kunci utama: id.

| Medan | Jenis | Wajib | Lalai | Pautan |
|---|---|---|---|---|
| id | id | ya |  |  |
| at | key | ya | masa sekarang |  |
| username | text |  |  |  |
| action | text |  |  |  |
| resource | text |  |  |  |
| record_id | int |  |  |  |
| before | long |  |  |  |
| after | long |  |  |  |

#### shop_processes

Kunci utama: id.

| Medan | Jenis | Wajib | Lalai | Pautan |
|---|---|---|---|---|
| id | id | ya |  |  |
| code | key |  |  |  |
| name | key |  |  |  |
| seq | real |  |  |  |
| unit | text |  |  |  |
| extra_fields | text |  |  |  |
| active | text |  |  |  |
| created_at | key | ya | masa sekarang |  |
| updated_at | key | ya | masa sekarang |  |

Indeks: unik ux_shop_processes_code (code); unik ux_shop_processes_name (name).

#### projects

Kunci utama: id.

| Medan | Jenis | Wajib | Lalai | Pautan |
|---|---|---|---|---|
| id | id | ya |  |  |
| code | key |  |  |  |
| name | text |  |  |  |
| customer | text |  |  |  |
| work_order | text |  |  |  |
| start_date | text |  |  |  |
| due_date | text |  |  |  |
| status | text |  |  |  |
| notes | long |  |  |  |
| created_at | key | ya | masa sekarang |  |
| updated_at | key | ya | masa sekarang |  |

Indeks: unik ux_projects_code (code).

#### parts

Kunci utama: id.

| Medan | Jenis | Wajib | Lalai | Pautan |
|---|---|---|---|---|
| id | id | ya |  |  |
| project_id | int |  |  | projects.id (CASCADE) |
| part_no | key |  |  |  |
| parent_no | text |  |  |  |
| description | text |  |  |  |
| material | text |  |  |  |
| thickness | real |  |  |  |
| qty_per_set | real |  |  |  |
| sets | real |  |  |  |
| job_sheet | text |  |  |  |
| category | text |  |  |  |
| make_buy | text |  |  |  |
| drawing_no | text |  |  |  |
| flat_size | text |  |  |  |
| process_flow | text |  |  |  |
| finish | text |  |  |  |
| hardware | text |  |  |  |
| created_at | key | ya | masa sekarang |  |
| updated_at | key | ya | masa sekarang |  |

Indeks: unik ux_parts_part_no (part_no); ix_parts_project_id (project_id).

#### routings

Kunci utama: id.

| Medan | Jenis | Wajib | Lalai | Pautan |
|---|---|---|---|---|
| id | id | ya |  |  |
| part_id | int |  |  | parts.id (CASCADE) |
| seq | real |  |  |  |
| operation | text |  |  |  |
| machine_id | int |  |  | machines.id (SET NULL) |
| setup_min | real |  |  |  |
| cycle_min | real |  |  |  |
| created_at | key | ya | masa sekarang |  |
| updated_at | key | ya | masa sekarang |  |

Indeks: ix_routings_part_id (part_id); ix_routings_machine_id (machine_id).

#### nestings

Kunci utama: id.

| Medan | Jenis | Wajib | Lalai | Pautan |
|---|---|---|---|---|
| id | id | ya |  |  |
| project_id | int |  |  | projects.id (CASCADE) |
| program | text |  |  |  |
| material | text |  |  |  |
| thickness | real |  |  |  |
| sheet_size | text |  |  |  |
| sheets | real |  |  |  |
| cut_min | real |  |  |  |
| part_count | real |  |  |  |
| part_qty | real |  |  |  |
| parts | text |  |  |  |
| created_at | key | ya | masa sekarang |  |
| updated_at | key | ya | masa sekarang |  |

Indeks: ix_nestings_project_id (project_id).

#### nesting_parts

Kunci utama: id.

| Medan | Jenis | Wajib | Lalai | Pautan |
|---|---|---|---|---|
| id | id | ya |  |  |
| nesting_id | int |  |  | nestings.id (CASCADE) |
| part_no | text |  |  |  |
| description | text |  |  |  |
| qty_per_sheet | real |  |  |  |
| total_qty | real |  |  |  |
| created_at | key | ya | masa sekarang |  |
| updated_at | key | ya | masa sekarang |  |

Indeks: ix_nesting_parts_nesting_id (nesting_id).

#### wf_steps

Kunci utama: id.

| Medan | Jenis | Wajib | Lalai | Pautan |
|---|---|---|---|---|
| id | id | ya |  |  |
| part_id | int |  |  | parts.id (CASCADE) |
| seq | real |  |  |  |
| step | text |  |  |  |
| status | text |  |  |  |
| qty_done | real |  |  |  |
| pic | text |  |  |  |
| due_date | text |  |  |  |
| created_at | key | ya | masa sekarang |  |
| updated_at | key | ya | masa sekarang |  |

Indeks: ix_wf_steps_part_id (part_id).

#### machines

Kunci utama: id.

| Medan | Jenis | Wajib | Lalai | Pautan |
|---|---|---|---|---|
| id | id | ya |  |  |
| code | key |  |  |  |
| name | text |  |  |  |
| machine_type | text |  |  |  |
| brand | text |  |  |  |
| model | text |  |  |  |
| location | text |  |  |  |
| status | text |  |  |  |
| notes | text |  |  |  |
| created_at | key | ya | masa sekarang |  |
| updated_at | key | ya | masa sekarang |  |

Indeks: unik ux_machines_code (code).

#### tooling

Kunci utama: id.

| Medan | Jenis | Wajib | Lalai | Pautan |
|---|---|---|---|---|
| id | id | ya |  |  |
| code | key |  |  |  |
| description | text |  |  |  |
| tool_type | text |  |  |  |
| machine_type | text |  |  |  |
| machine_id | int |  |  | machines.id (SET NULL) |
| location | text |  |  |  |
| condition | text |  |  |  |
| created_at | key | ya | masa sekarang |  |
| updated_at | key | ya | masa sekarang |  |

Indeks: unik ux_tooling_code (code); ix_tooling_machine_id (machine_id).

#### plates

Kunci utama: id.

| Medan | Jenis | Wajib | Lalai | Pautan |
|---|---|---|---|---|
| id | id | ya |  |  |
| project_id | int |  |  | projects.id (SET NULL) |
| material | text |  |  |  |
| thickness | real |  |  |  |
| sheet_size | text |  |  |  |
| qty | real |  |  |  |
| min_qty | real |  |  |  |
| location | text |  |  |  |
| created_at | key | ya | masa sekarang |  |
| updated_at | key | ya | masa sekarang |  |

Indeks: ix_plates_project_id (project_id).

#### drawings

Kunci utama: id.

| Medan | Jenis | Wajib | Lalai | Pautan |
|---|---|---|---|---|
| id | id | ya |  |  |
| project_id | int |  |  | projects.id (SET NULL) |
| part_no | text |  |  |  |
| rev | text |  |  |  |
| kind | text |  |  |  |
| format | text |  |  |  |
| job_traveller_id | int |  |  | job_travellers.id (SET NULL) |
| status | text |  |  |  |
| filename | text |  |  |  |
| size | real |  |  |  |
| stored_name | text |  |  |  |
| uploaded_by | text |  |  |  |
| notes | text |  |  |  |
| created_at | key | ya | masa sekarang |  |
| updated_at | key | ya | masa sekarang |  |

Indeks: ix_drawings_project_id (project_id); ix_drawings_job_traveller_id (job_traveller_id).

#### maint_orders

Kunci utama: id.

| Medan | Jenis | Wajib | Lalai | Pautan |
|---|---|---|---|---|
| id | id | ya |  |  |
| machine_id | int |  |  | machines.id (CASCADE) |
| kind | text |  |  |  |
| title | text |  |  |  |
| opened | text |  |  |  |
| closed | text |  |  |  |
| downtime_min | real |  |  |  |
| pic | text |  |  |  |
| status | text |  |  |  |
| details | long |  |  |  |
| created_at | key | ya | masa sekarang |  |
| updated_at | key | ya | masa sekarang |  |

Indeks: ix_maint_orders_machine_id (machine_id).

#### pm_tasks

Kunci utama: id.

| Medan | Jenis | Wajib | Lalai | Pautan |
|---|---|---|---|---|
| id | id | ya |  |  |
| machine_id | int |  |  | machines.id (CASCADE) |
| frequency | text |  |  |  |
| item_no | text |  |  |  |
| task | text |  |  |  |
| procedure | long |  |  |  |
| standard | text |  |  |  |
| status | text |  |  |  |
| checked_on | text |  |  |  |
| checked_by | text |  |  |  |
| remarks | text |  |  |  |
| created_at | key | ya | masa sekarang |  |
| updated_at | key | ya | masa sekarang |  |

Indeks: ix_pm_tasks_machine_id (machine_id).

#### schedules

Kunci utama: id.

| Medan | Jenis | Wajib | Lalai | Pautan |
|---|---|---|---|---|
| id | id | ya |  |  |
| project_id | int |  |  | projects.id (CASCADE) |
| process_id | int |  |  | shop_processes.id (CASCADE) |
| job_traveller_id | int |  |  | job_travellers.id (SET NULL) |
| machine_id | int |  |  | machines.id (SET NULL) |
| start_date | text |  |  |  |
| end_date | text |  |  |  |
| planned_qty | real |  |  |  |
| status | text |  |  |  |
| source | text |  |  |  |
| notes | text |  |  |  |
| created_at | key | ya | masa sekarang |  |
| updated_at | key | ya | masa sekarang |  |

Indeks: ix_schedules_project_id (project_id); ix_schedules_process_id (process_id); ix_schedules_job_traveller_id (job_traveller_id); ix_schedules_machine_id (machine_id).

#### shift_plans

Kunci utama: id.

| Medan | Jenis | Wajib | Lalai | Pautan |
|---|---|---|---|---|
| id | id | ya |  |  |
| date | text |  |  |  |
| shift | text |  |  |  |
| operator | text |  |  |  |
| process_id | int |  |  | shop_processes.id (CASCADE) |
| machine_id | int |  |  | machines.id (SET NULL) |
| job_traveller_id | int |  |  | job_travellers.id (SET NULL) |
| project_id | int |  |  | projects.id (SET NULL) |
| planned_qty | real |  |  |  |
| hours | real |  |  |  |
| notes | text |  |  |  |
| created_at | key | ya | masa sekarang |  |
| updated_at | key | ya | masa sekarang |  |

Indeks: ix_shift_plans_process_id (process_id); ix_shift_plans_machine_id (machine_id); ix_shift_plans_job_traveller_id (job_traveller_id); ix_shift_plans_project_id (project_id).

#### shifts

Kunci utama: id.

| Medan | Jenis | Wajib | Lalai | Pautan |
|---|---|---|---|---|
| id | id | ya |  |  |
| name | key |  |  |  |
| start_time | text |  |  |  |
| end_time | text |  |  |  |
| break_start | text |  |  |  |
| break_end | text |  |  |  |
| days | text |  |  |  |
| active | text |  |  |  |
| net_min | real |  |  |  |
| created_at | key | ya | masa sekarang |  |
| updated_at | key | ya | masa sekarang |  |

Indeks: unik ux_shifts_name (name).

#### holidays

Kunci utama: id.

| Medan | Jenis | Wajib | Lalai | Pautan |
|---|---|---|---|---|
| id | id | ya |  |  |
| date | key |  |  |  |
| name | text |  |  |  |
| kind | text |  |  |  |
| created_at | key | ya | masa sekarang |  |
| updated_at | key | ya | masa sekarang |  |

Indeks: unik ux_holidays_date (date).

#### pm_logs

Kunci utama: id.

| Medan | Jenis | Wajib | Lalai | Pautan |
|---|---|---|---|---|
| id | id | ya |  |  |
| date | text |  |  |  |
| machine_id | int |  |  | machines.id (SET NULL) |
| pm_task_id | int |  |  | pm_tasks.id (CASCADE) |
| frequency | text |  |  |  |
| result | text |  |  |  |
| reading | text |  |  |  |
| remarks | text |  |  |  |
| checked_by | text |  |  |  |
| created_at | key | ya | masa sekarang |  |
| updated_at | key | ya | masa sekarang |  |

Indeks: ix_pm_logs_machine_id (machine_id); ix_pm_logs_pm_task_id (pm_task_id).

#### ncrs

Kunci utama: id.

| Medan | Jenis | Wajib | Lalai | Pautan |
|---|---|---|---|---|
| id | id | ya |  |  |
| ncr_no | key |  |  |  |
| date | text |  |  |  |
| project_id | int |  |  | projects.id (SET NULL) |
| part_no | text |  |  |  |
| qty_affected | real |  |  |  |
| defect | long |  |  |  |
| containment | long |  |  |  |
| root_cause | long |  |  |  |
| corrective | long |  |  |  |
| disposition | text |  |  |  |
| verification | long |  |  |  |
| raised_by | text |  |  |  |
| status | text |  |  |  |
| created_at | key | ya | masa sekarang |  |
| updated_at | key | ya | masa sekarang |  |

Indeks: unik ux_ncrs_ncr_no (ncr_no); ix_ncrs_project_id (project_id).

#### reason_codes

Kunci utama: id.

| Medan | Jenis | Wajib | Lalai | Pautan |
|---|---|---|---|---|
| id | id | ya |  |  |
| code | key |  |  |  |
| kind | text |  |  |  |
| description | text |  |  |  |
| process_id | int |  |  | shop_processes.id (SET NULL) |
| created_at | key | ya | masa sekarang |  |
| updated_at | key | ya | masa sekarang |  |

Indeks: unik ux_reason_codes_code (code); ix_reason_codes_process_id (process_id).

#### job_travellers

Kunci utama: id.

| Medan | Jenis | Wajib | Lalai | Pautan |
|---|---|---|---|---|
| id | id | ya |  |  |
| jt_no | key |  |  |  |
| project_id | int |  |  | projects.id (SET NULL) |
| customer | text |  |  |  |
| part_no | text |  |  |  |
| drawing_no | text |  |  |  |
| description | text |  |  |  |
| material | text |  |  |  |
| thickness | real |  |  |  |
| qty | real |  |  |  |
| due_date | text |  |  |  |
| status | text |  |  |  |
| approved_by | text |  |  |  |
| approved_on | text |  |  |  |
| notes | long |  |  |  |
| created_at | key | ya | masa sekarang |  |
| updated_at | key | ya | masa sekarang |  |

Indeks: unik ux_job_travellers_jt_no (jt_no); ix_job_travellers_project_id (project_id).

#### jt_steps

Kunci utama: id.

| Medan | Jenis | Wajib | Lalai | Pautan |
|---|---|---|---|---|
| id | id | ya |  |  |
| job_traveller_id | int |  |  | job_travellers.id (CASCADE) |
| process_id | int |  |  | shop_processes.id (CASCADE) |
| seq | real |  |  |  |
| cycle_min | real |  |  |  |
| target_qty | real |  |  |  |
| details | text |  |  |  |
| created_at | key | ya | masa sekarang |  |
| updated_at | key | ya | masa sekarang |  |

Indeks: ix_jt_steps_job_traveller_id (job_traveller_id); ix_jt_steps_process_id (process_id).

#### operator_outputs

Kunci utama: id.

| Medan | Jenis | Wajib | Lalai | Pautan |
|---|---|---|---|---|
| id | id | ya |  |  |
| date | text |  |  |  |
| process_id | int |  |  | shop_processes.id (CASCADE) |
| job_traveller_id | int |  |  | job_travellers.id (CASCADE) |
| project_id | int |  |  | projects.id (SET NULL) |
| slot | text |  |  |  |
| machine | text |  |  |  |
| good_qty | real |  |  |  |
| reject_qty | real |  |  |  |
| run_min | real |  |  |  |
| downtime_min | real |  |  |  |
| reject_code | text |  |  |  |
| downtime_code | text |  |  |  |
| extra | long |  |  |  |
| remark | text |  |  |  |
| operator | text |  |  |  |
| created_at | key | ya | masa sekarang |  |
| updated_at | key | ya | masa sekarang |  |

Indeks: ix_operator_outputs_process_id (process_id); ix_operator_outputs_job_traveller_id (job_traveller_id); ix_operator_outputs_project_id (project_id).

#### daily_logs

Kunci utama: id.

| Medan | Jenis | Wajib | Lalai | Pautan |
|---|---|---|---|---|
| id | id | ya |  |  |
| date | text |  |  |  |
| process | text |  |  |  |
| project_id | int |  |  | projects.id (SET NULL) |
| part_no | text |  |  |  |
| activity | long |  |  |  |
| hours | real |  |  |  |
| status | text |  |  |  |
| handover_to | text |  |  |  |
| handover_note | long |  |  |  |
| logged_by | text |  |  |  |
| created_at | key | ya | masa sekarang |  |
| updated_at | key | ya | masa sekarang |  |

Indeks: ix_daily_logs_project_id (project_id).

#### inventory_items

Kunci utama: id.

| Medan | Jenis | Wajib | Lalai | Pautan |
|---|---|---|---|---|
| id | id | ya |  |  |
| code | key |  |  |  |
| name | text |  |  |  |
| status | text |  |  |  |
| item_group | text |  |  |  |
| category | text |  |  |  |
| location | text |  |  |  |
| process | text |  |  |  |
| machine_id | int |  |  | machines.id (SET NULL) |
| unit | text |  |  |  |
| qty_on_hand | real |  |  |  |
| min_qty | real |  |  |  |
| notes | long |  |  |  |
| created_at | key | ya | masa sekarang |  |
| updated_at | key | ya | masa sekarang |  |

Indeks: unik ux_inventory_items_code (code); ix_inventory_items_machine_id (machine_id).

#### inventory_moves

Kunci utama: id.

| Medan | Jenis | Wajib | Lalai | Pautan |
|---|---|---|---|---|
| id | id | ya |  |  |
| date | text |  |  |  |
| item_id | int |  |  | inventory_items.id (CASCADE) |
| move | text |  |  |  |
| qty | real |  |  |  |
| process | text |  |  |  |
| machine_id | int |  |  | machines.id (SET NULL) |
| maint_order_id | int |  |  | maint_orders.id (SET NULL) |
| remark | text |  |  |  |
| moved_by | text |  |  |  |
| created_at | key | ya | masa sekarang |  |
| updated_at | key | ya | masa sekarang |  |

Indeks: ix_inventory_moves_item_id (item_id); ix_inventory_moves_machine_id (machine_id); ix_inventory_moves_maint_order_id (maint_order_id).

#### issues

Kunci utama: id.

| Medan | Jenis | Wajib | Lalai | Pautan |
|---|---|---|---|---|
| id | id | ya |  |  |
| issue_no | key |  |  |  |
| title | text |  |  |  |
| from_process | text |  |  |  |
| to_process | text |  |  |  |
| project_id | int |  |  | projects.id (SET NULL) |
| part_no | text |  |  |  |
| job_traveller_id | int |  |  | job_travellers.id (SET NULL) |
| priority | text |  |  |  |
| status | text |  |  |  |
| opened | text |  |  |  |
| due_date | text |  |  |  |
| resolved | text |  |  |  |
| details | long |  |  |  |
| action_plan | long |  |  |  |
| resolution | long |  |  |  |
| raised_by | text |  |  |  |
| created_at | key | ya | masa sekarang |  |
| updated_at | key | ya | masa sekarang |  |

Indeks: unik ux_issues_issue_no (issue_no); ix_issues_project_id (project_id); ix_issues_job_traveller_id (job_traveller_id).

#### process_rights

Kunci utama: process + resource.

| Medan | Jenis | Wajib | Lalai | Pautan |
|---|---|---|---|---|
| process | key | ya |  |  |
| resource | key | ya |  |  |

#### issue_replies

Kunci utama: id.

| Medan | Jenis | Wajib | Lalai | Pautan |
|---|---|---|---|---|
| id | id | ya |  |  |
| issue_id | int | ya |  | issues.id (CASCADE) |
| at | key | ya | masa sekarang |  |
| username | text |  |  |  |
| process | text |  |  |  |
| message | long | ya |  |  |

Indeks: ix_issue_replies_issue (issue_id).

#### floor_layouts

Kunci utama: id.

| Medan | Jenis | Wajib | Lalai | Pautan |
|---|---|---|---|---|
| id | id | ya |  |  |
| version | int | ya |  |  |
| data | long | ya |  |  |
| note | text |  |  |  |
| saved_by | text |  |  |  |
| created_at | key | ya | masa sekarang |  |

---

## 14. Masalah biasa

| Mesej | Punca dan penyelesaian |
|---|---|
| `Run: npm install pg` (atau `mysql2`, `mssql`, `oracledb`) | Driver belum dipasang. Jalankan arahan itu dalam folder projek. |
| `password authentication failed` / `Access denied` / `Login failed` | Nama pengguna atau kata laluan salah, atau aksara khas tidak ditulis dalam bentuk URL (`@` = `%40`). |
| `self-signed certificate` (SQL Server) | Tambah `?trustServerCertificate=true` untuk server dalaman. |
| `no pg_hba.conf entry` / sambungan tamat masa | IP server website belum dibenarkan dalam firewall database. Tambah `?sslmode=require` untuk database awan. |
| `ORA-12514` | Nama servis Oracle salah. Gunakan nama PDB (contoh `FREEPDB1`), bukan SID. |
| `The target database already has data` | Sasaran tidak kosong. Tambah `--replace` untuk menggantikan data. |
| `The backup is damaged: its checksum does not match` | Fail backup rosak atau diubah. Gunakan backup lain. |
| R2/S3 `403 SignatureDoesNotMatch` / `InvalidAccessKeyId` | Kunci salah, atau masa server tidak tepat. Semak tetapan R2/S3 dan hidupkan NTP. |
| BigQuery `Google sign-in failed` | Kunci JSON salah, atau akaun servis tiada peranan BigQuery. |
| Website perlahan dengan D1/Turso | Setiap pertanyaan melalui internet. Gunakan PostgreSQL dalam rantau yang sama. |

Untuk melihat SQL yang gagal, mulakan website dengan `DBX_DEBUG=1`.
