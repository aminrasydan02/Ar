'use strict';
// Copies every table to Google BigQuery for reporting (Looker Studio, SQL analysis). BigQuery is a data
// warehouse, so the website keeps its own database; each export replaces the BigQuery tables with
// a fresh copy. Uses the BigQuery REST API with a service account key, so no Google SDK is needed.
//
//   BIGQUERY_PROJECT      Google Cloud project id
//   BIGQUERY_DATASET      dataset name (default smm), created when missing
//   BIGQUERY_LOCATION     e.g. asia-southeast1 (default US)
//   GOOGLE_APPLICATION_CREDENTIALS  path to the service account JSON key
//     (or BIGQUERY_CREDENTIALS with the JSON itself). The account needs BigQuery Data Editor + Job User.
const crypto = require('node:crypto');
const fs = require('node:fs');

function configFromEnv(env = process.env) {
  if (!env.BIGQUERY_PROJECT) return null;
  const raw = env.BIGQUERY_CREDENTIALS || (env.GOOGLE_APPLICATION_CREDENTIALS && fs.readFileSync(env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'));
  if (!raw) throw new Error('BigQuery needs GOOGLE_APPLICATION_CREDENTIALS (service account key file) or BIGQUERY_CREDENTIALS');
  const key = JSON.parse(raw);
  return { project: env.BIGQUERY_PROJECT, dataset: env.BIGQUERY_DATASET || 'smm', location: env.BIGQUERY_LOCATION || 'US', key };
}

const b64url = (x) => Buffer.from(x).toString('base64url');
async function accessToken(key) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: key.client_email, scope: 'https://www.googleapis.com/auth/bigquery', aud: key.token_uri || 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${claims}`).sign(key.private_key).toString('base64url');
  const res = await fetch(key.token_uri || 'https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${sig}` }) });
  const body = await res.json();
  if (!body.access_token) throw new Error(`Google sign-in failed: ${body.error_description || body.error || res.status}`);
  return body.access_token;
}

const BQ_TYPE = { id: 'INT64', int: 'INT64', real: 'FLOAT64', key: 'STRING', text: 'STRING', long: 'STRING' };

// tables: schema() from db.js; data: { table: rows[] } (from transfer.dump). Returns rows loaded per table.
async function exportToBigQuery(cfg, tables, data, { log = () => {} } = {}) {
  const token = await accessToken(cfg.key);
  const api = 'https://bigquery.googleapis.com/bigquery/v2';
  const call = async (url, opts = {}) => {
    const res = await fetch(url, { ...opts, headers: { authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 409) throw new Error(`BigQuery: ${(body.error && body.error.message) || res.status}`);
    return body;
  };
  await call(`${api}/projects/${cfg.project}/datasets`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ datasetReference: { projectId: cfg.project, datasetId: cfg.dataset }, location: cfg.location }) });
  const out = {};
  for (const t of tables) {
    const rows = data[t.name] || [];
    const fields = t.cols.map((c) => ({ name: c.name, type: BQ_TYPE[c.type] || 'STRING', mode: 'NULLABLE' }));
    fields.push({ name: 'exported_at', type: 'TIMESTAMP', mode: 'NULLABLE' });
    const stamp = new Date().toISOString();
    const known = new Set(t.cols.map((c) => c.name));
    const ndjson = rows.map((r) => JSON.stringify({ ...Object.fromEntries(Object.entries(r).filter(([k]) => known.has(k)).map(([k, v]) => [k, v === null || BQ_TYPE[t.cols.find((c) => c.name === k).type] !== 'STRING' ? v : String(v)])), exported_at: stamp })).join('\n');
    const config = { configuration: { load: {
      destinationTable: { projectId: cfg.project, datasetId: cfg.dataset, tableId: t.name },
      sourceFormat: 'NEWLINE_DELIMITED_JSON', writeDisposition: 'WRITE_TRUNCATE', createDisposition: 'CREATE_IF_NEEDED', schema: { fields } } },
    jobReference: { projectId: cfg.project, location: cfg.location } };
    const boundary = `smm${crypto.randomBytes(8).toString('hex')}`;
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(config)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n${ndjson}\r\n--${boundary}--`;
    let job = await call(`https://bigquery.googleapis.com/upload/bigquery/v2/projects/${cfg.project}/jobs?uploadType=multipart`, {
      method: 'POST', headers: { 'content-type': `multipart/related; boundary=${boundary}` }, body });
    while (job.status && job.status.state !== 'DONE') {
      await new Promise((r) => setTimeout(r, 1500));
      job = await call(`${api}/projects/${cfg.project}/jobs/${job.jobReference.jobId}?location=${cfg.location}`);
    }
    if (job.status && job.status.errorResult) throw new Error(`BigQuery load of ${t.name} failed: ${job.status.errorResult.message}`);
    out[t.name] = rows.length;
    log(`  ${t.name}: ${rows.length} rows`);
  }
  return out;
}

module.exports = { configFromEnv, exportToBigQuery, accessToken };
