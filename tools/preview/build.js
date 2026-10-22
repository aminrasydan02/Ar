'use strict';
// Makes a read-only, single-file preview of the website from a database made by load.js:
// every screen's data is captured through the API, then served to the real browser app
// by a small stand-in for fetch(). Nothing can be saved in the preview.
//
//   node tools/preview/build.js <db-dir> <out.html>
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const db = require('../../server/lib/db');
const { createApp } = require('../../server/lib/app');

const [dbDir, outFile] = process.argv.slice(2);
if (!dbDir || !outFile) { console.error('Usage: node tools/preview/build.js <db-dir> <out.html>'); process.exit(1); }
const PUBLIC = path.join(__dirname, '../../public');
const PASSWORD = process.env.ADMIN_PASSWORD || 'preview-admin-1';

async function main() {
  const database = db.open(path.join(dbDir, 'smm.sqlite'));
  const server = http.createServer(createApp({ db: database, drawingsDir: path.join(dbDir, 'drawings'), company: process.env.COMPANY || 'NEWBILLION Precision Metal Sdn Bhd' }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: PASSWORD }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const snap = {};
  const get = async (url) => {
    const res = await fetch(base + url, { headers: { cookie } });
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    return (snap[url] = await res.json());
  };
  try {
    const meta = await get('/api/meta');
    for (const name of Object.keys(meta.resources)) await get(`/api/${name}`);
    for (const url of ['/api/me', '/api/dashboard', '/api/users', '/api/audit', '/api/rights', '/api/layout', '/api/worktime']) await get(url);
    // Hourly and actual output as the pages ask for them on the day the preview is built.
    const day = new Date().toISOString().slice(0, 10);
    await get(`/api/reports/hourly?date=${day}`);
    await get(`/api/reports/actual?from=${day.slice(0, 8)}01&to=${day}`);
    for (const v of await get('/api/layout/versions')) await get(`/api/layout/versions/${v.version}`);
    for (const jt of snap['/api/job_travellers']) { await get(`/api/job_travellers/${jt.id}/info`); await get(`/api/job_travellers/${jt.id}/progress`); }
    for (const i of snap['/api/issues']) await get(`/api/issues/${i.id}/replies`);
  } finally {
    server.close();
    database.close();
  }
  snap['/api/me'].version = `${snap['/api/me'].version} preview`;
  // THEME=galaxy opens the preview in that colour theme (and so the Cockpit dashboard).
  if (process.env.THEME) snap['/api/me'].user.theme = process.env.THEME;
  const today = new Date().toISOString().slice(0, 10);
  const check = fs.existsSync(path.join(dbDir, 'data-check.md')) ? fs.readFileSync(path.join(dbDir, 'data-check.md'), 'utf8') : '';
  const icon = `data:image/svg+xml;base64,${fs.readFileSync(path.join(PUBLIC, 'icon.svg')).toString('base64')}`;
  // Keep "</script>" in data or code from closing the script tag early.
  const safe = (js) => js.replace(/<\/(script)/gi, '<\\/$1');
  const html = `<title>Sheet Metal Manager Preview</title>
<style>
${fs.readFileSync(path.join(PUBLIC, 'styles.css'), 'utf8')}
${fs.readFileSync(path.join(__dirname, 'preview.css'), 'utf8')}
</style>
<div class="pv-bar" role="note"><span class="pv-tag">Preview</span><span class="pv-text">Read-only copy of the website with the department's data on ${today.split('-').reverse().join('/')}. Changes are not saved.</span><button class="pv-btn" id="pv-check" type="button">Data check</button></div>
<div id="app"></div>
<script>window.__SNAP = ${safe(JSON.stringify(snap))}; window.__TODAY = ${JSON.stringify(today)}; window.__CHECK = ${safe(JSON.stringify(check))};</script>
<script>${safe(fs.readFileSync(path.join(__dirname, 'shim.js'), 'utf8'))}</script>
<script>${safe(fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8').replace(/src: 'icon\.svg'/g, `src: '${icon}'`))}</script>
<script>localToday = () => window.__TODAY;</script>
`;
  fs.writeFileSync(outFile, html);
  console.log(`Preview written: ${outFile} (${Math.round(html.length / 1024)} KB, ${Object.keys(snap).length} API answers)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
