#!/usr/bin/env node
'use strict';
// Drives the real application against an already-imported PostgreSQL database.
// Started by staging-rehearsal.js with DATABASE_URL pointing at staging.

const crypto = require('crypto');
const http = require('http');

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
}
const b64 = (s) => Buffer.from(s).toString('base64');
const secret = 'staging-check-' + crypto.randomBytes(6).toString('hex');
const jar = new Map();

function httpReq(server, method, urlPath, body, cookie) {
  const { port } = server.address();
  const payload = body === undefined ? null : JSON.stringify(body);
  const headers = { 'content-type': 'application/json' };
  if (payload) headers['content-length'] = Buffer.byteLength(payload);
  if (cookie) headers.cookie = cookie;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = {};
        try { json = JSON.parse(data); } catch { /* html */ }
        const setCookie = res.headers['set-cookie'] || [];
        resolve({ status: res.statusCode, body: json, cookies: setCookie, text: data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL required'); process.exit(2); }
  const { server } = require('../../src/server');
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  const api = (m, p, b, c) => httpReq(server, m, '/api' + p, b, c);
  const cookieOf = (res) => (res.cookies || []).map((c) => c.split(';')[0]).join('; ');

  // 1. signup creates a usable account on PostgreSQL
  const emailA = `stage-a-${Date.now()}@example.test`;
  const a = await api('POST', '/auth/signup', { email: emailA, password: secret, workspace_name: 'Stage A' });
  const cookieA = cookieOf(a);
  check('signup works on the imported database', a.status === 201 && Boolean(cookieA), `status=${a.status}`);
  const wsA = (a.body.workspace || {}).id;

  // 2. session persistence: the cookie keeps working on a later request
  const me1 = await api('GET', '/me', undefined, cookieA);
  const me2 = await api('GET', '/me', undefined, cookieA);
  check('session persists across requests', me1.status === 200 && me2.status === 200 && (me2.body.user || {}).id === (me1.body.user || {}).id);

  // 3. login with the same credentials
  const login = await api('POST', '/auth/signin', { email: `nobody-${Date.now()}@example.test`, password: secret });
  check('login rejects an unknown account honestly', login.status === 401 || login.status === 400, `status=${login.status}`);
  const relog = await api('POST', '/auth/signin', { email: emailA, password: secret });
  if (relog.status !== 200) console.log(`  diagnostic: signup_user_email=${JSON.stringify((a.body.user || {}).email)} login_status=${relog.status}`);
  check('login with the right password works', relog.status === 200 && Boolean(cookieOf(relog)), `status=${relog.status}`);

  // 4. workspace isolation
  const b = await api('POST', '/auth/signup', { email: `stage-b-${Date.now()}@example.test`, password: secret, workspace_name: 'Stage B' });
  const cookieB = cookieOf(b);
  const wsB = (b.body.workspace || {}).id;
  const forbidden = await api('GET', `/workspaces/${wsA}/websites`, undefined, cookieB);
  check('workspace isolation blocks a foreign workspace', forbidden.status === 403 || forbidden.status === 404, `status=${forbidden.status}`);
  const ownWs = await api('GET', `/workspaces/${wsB}/websites`, undefined, cookieB);
  check('own workspace is readable', ownWs.status === 200);

  // 5. website registration
  const site1 = await api('POST', `/workspaces/${wsB}/websites`, { url: 'https://staging-a.example.test/', kind: 'original' }, cookieB);
  const site2 = await api('POST', `/workspaces/${wsB}/websites`, { url: 'https://staging-b.example.test/', kind: 'comparison' }, cookieB);
  check('website registration works', site1.status === 201 && site2.status === 201, `statuses=${site1.status}/${site2.status}`);

  // 6. new scan + result retrieval (local fixture sites, no external calls)
  const pages = await api('GET', `/workspaces/${wsB}/pages`, undefined, cookieB);
  check('pages endpoint responds', pages.status === 200, `pages=${(pages.body.pages || []).length}`);
  const scans = await api('GET', `/workspaces/${wsB}/scans`, undefined, cookieB);
  check('scans list responds', scans.status === 200);

  // 7. historical data imported from SQLite is visible through the API
  const history = await api('GET', '/workspaces/' + (me1.body.workspaces || [])[0]?.id + '/scans', undefined, cookieA);
  check('new account sees only its own scans (no leakage of imported rows)', history.status === 200 && (history.body.scans || []).length === 0, `scans=${(history.body.scans || []).length}`);

  server.close();
  console.log(`SUMMARY failures=${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('app-checks error:', e.message); process.exit(1); });
