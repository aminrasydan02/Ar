'use strict';
// Sheet Metal Manager web server.
//   node server/server.js                      start the server
//   node server/server.js seed-demo            add the NEWAYS demo project
//   node server/server.js reset-password <user> <new password>
//
// Settings come from environment variables or config.json next to package.json:
//   PORT (default 8080), HOST (default 0.0.0.0), DATA_DIR (default ./data),
//   SECURE_COOKIES=1 when served over HTTPS, ADMIN_PASSWORD for the first admin.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const db = require('./lib/db');
const { createApp, VERSION } = require('./lib/app');
const { hashPassword } = require('./lib/auth');
const { seedDemo } = require('./seed');

const ROOT = path.join(__dirname, '..');

function loadConfig() {
  const file = path.join(ROOT, 'config.json');
  const fromFile = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const env = process.env;
  return {
    port: Number(env.PORT || fromFile.port || 8080),
    host: env.HOST || fromFile.host || '0.0.0.0',
    dataDir: path.resolve(ROOT, env.DATA_DIR || fromFile.dataDir || 'data'),
    secureCookies: (env.SECURE_COOKIES || String(fromFile.secureCookies || '')) === '1' || fromFile.secureCookies === true,
    adminPassword: env.ADMIN_PASSWORD || fromFile.adminPassword,
  };
}

function main() {
  const cfg = loadConfig();
  const database = db.open(path.join(cfg.dataDir, 'smm.sqlite'));
  const [cmd, ...args] = process.argv.slice(2);

  if (cmd === 'seed-demo') {
    db.ensureAdmin(database, cfg.adminPassword);
    console.log(seedDemo(database) ? 'NEWAYS demo project added.' : 'NEWAYS project already exists.');
    return;
  }
  if (cmd === 'reset-password') {
    const [username, password] = args;
    if (!username || !password || password.length < 8) {
      console.error('Usage: reset-password <username> <new password (8+ characters)>');
      process.exitCode = 1;
      return;
    }
    const r = database.prepare('UPDATE users SET password_hash = ?, active = 1 WHERE username = ?').run(hashPassword(password), username);
    console.log(r.changes ? `Password changed for ${username}.` : `No user called ${username}.`);
    return;
  }

  const firstPassword = db.ensureAdmin(database, cfg.adminPassword);
  if (firstPassword && !cfg.adminPassword) {
    console.log(`First start: sign in as "admin" with password: ${firstPassword}`);
    console.log('Change it under My account after signing in.');
  }

  const server = http.createServer(createApp({
    db: database,
    drawingsDir: path.join(cfg.dataDir, 'drawings'),
    secureCookies: cfg.secureCookies,
  }));
  server.listen(cfg.port, cfg.host, () => {
    console.log(`Sheet Metal Manager ${VERSION} running at http://${cfg.host === '0.0.0.0' ? 'localhost' : cfg.host}:${cfg.port}`);
    console.log(`Data folder: ${cfg.dataDir} (back this up, including drawings/)`);
  });
}

main();
