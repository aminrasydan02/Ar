'use strict';
// Upload, list, download and delete files in Amazon S3 or Cloudflare R2 (both speak the S3 API).
// Requests are signed here with AWS Signature Version 4, so no AWS SDK is needed.
//
//   BACKUP_STORAGE=s3   S3_BUCKET, S3_REGION (e.g. ap-southeast-1), S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY
//   BACKUP_STORAGE=r2   R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
//   Optional: S3_ENDPOINT for any other S3-compatible store (MinIO, Wasabi, Backblaze B2), BACKUP_PREFIX (default smm-backups/)
const crypto = require('node:crypto');

function storageFromEnv(env = process.env) {
  const kind = String(env.BACKUP_STORAGE || '').toLowerCase();
  if (!kind) return null;
  const prefix = (env.BACKUP_PREFIX || 'smm-backups/').replace(/^\/+/, '');
  if (kind === 'r2') {
    const need = ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'].filter((k) => !env[k]);
    if (need.length) throw new Error(`Cloudflare R2 needs ${need.join(', ')}`);
    return createStore({ name: 'Cloudflare R2', endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, region: 'auto', bucket: env.R2_BUCKET,
      accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY, prefix, pathStyle: true });
  }
  if (kind === 's3') {
    const need = ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'].filter((k) => !env[k]);
    if (need.length) throw new Error(`Amazon S3 needs ${need.join(', ')}`);
    const region = env.S3_REGION || 'us-east-1';
    return createStore({ name: env.S3_ENDPOINT ? 'S3-compatible storage' : 'Amazon S3', endpoint: env.S3_ENDPOINT || `https://s3.${region}.amazonaws.com`, region, bucket: env.S3_BUCKET,
      accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY, sessionToken: env.S3_SESSION_TOKEN, prefix, pathStyle: Boolean(env.S3_ENDPOINT) });
  }
  throw new Error(`BACKUP_STORAGE must be s3 or r2, not "${kind}"`);
}

const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
// S3 path encoding: every byte except unreserved characters and "/".
const encodeKey = (k) => k.split('/').map((p) => encodeURIComponent(p).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');

function createStore(cfg) {
  const base = new URL(cfg.endpoint);
  const host = cfg.pathStyle ? base.host : `${cfg.bucket}.${base.host}`;
  const pathFor = (key) => (cfg.pathStyle ? `/${cfg.bucket}/${encodeKey(key)}` : `/${encodeKey(key)}`);

  async function request(method, key, { query = {}, body = Buffer.alloc(0), headers = {} } = {}) {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
    const day = amzDate.slice(0, 8);
    const payloadHash = sha(body);
    const canonicalQuery = Object.keys(query).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`).join('&');
    const h = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, ...headers };
    if (cfg.sessionToken) h['x-amz-security-token'] = cfg.sessionToken;
    const names = Object.keys(h).map((k) => k.toLowerCase()).sort();
    const lower = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
    const path = key === null ? (cfg.pathStyle ? `/${cfg.bucket}` : '/') : pathFor(key);
    const canonical = [method, path, canonicalQuery, names.map((n) => `${n}:${lower[n]}\n`).join(''), names.join(';'), payloadHash].join('\n');
    const scope = `${day}/${cfg.region}/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha(canonical)].join('\n');
    const kSigning = hmac(hmac(hmac(hmac(`AWS4${cfg.secretAccessKey}`, day), cfg.region), 's3'), 'aws4_request');
    const signature = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex');
    h.authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
    delete h.host;
    const url = `${base.protocol}//${host}${path}${canonicalQuery ? `?${canonicalQuery}` : ''}`;
    const res = await fetch(url, { method, headers: h, body: method === 'GET' || method === 'HEAD' || method === 'DELETE' ? undefined : body });
    if (!res.ok && !(method === 'DELETE' && res.status === 404)) {
      const text = await res.text().catch(() => '');
      const code = (/<Code>([^<]+)<\/Code>/.exec(text) || [])[1];
      throw new Error(`${cfg.name} ${method} ${key || ''} failed: ${res.status}${code ? ` ${code}` : ''}`);
    }
    return res;
  }

  return {
    name: cfg.name, bucket: cfg.bucket, prefix: cfg.prefix,
    async put(key, body, contentType = 'application/octet-stream') {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
      await request('PUT', cfg.prefix + key, { body: buf, headers: { 'content-type': contentType, 'content-length': String(buf.length) } });
      return { key: cfg.prefix + key, size: buf.length };
    },
    async get(key) { return Buffer.from(await (await request('GET', cfg.prefix + key)).arrayBuffer()); },
    async remove(key) { await request('DELETE', cfg.prefix + key); },
    // Every file under the prefix: [{ key (without prefix), size, modified }]
    async list() {
      const out = [];
      let token;
      do {
        const query = { 'list-type': '2', prefix: cfg.prefix, ...(token ? { 'continuation-token': token } : {}) };
        const xml = await (await request('GET', null, { query })).text();
        for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const pick = (tag) => ((new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(m[1]) || [])[1] || '');
          const key = pick('Key').replace(/&amp;/g, '&');
          out.push({ key: key.slice(cfg.prefix.length), size: Number(pick('Size')), modified: pick('LastModified') });
        }
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? (/<NextContinuationToken>([^<]+)</.exec(xml) || [])[1] : null;
      } while (token);
      return out;
    },
  };
}

module.exports = { storageFromEnv, createStore };
