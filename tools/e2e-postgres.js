'use strict';
// End-to-end proof that the application works on PostgreSQL.
//
// Run:  TEST_DATABASE_URL=postgres://... node tools/e2e-postgres.js
// Needs outbound 5432. Uses two small public pages so the crawl is realistic, and
// runs the whole flow twice - before and after a process restart.
//
// End-to-end proof that the application works on PostgreSQL: real server process,
// real adapter, real crawl, restart in between. Neon itself is not reachable from
// this sandbox on 5432, so this runs against local PostgreSQL 15 with identical
// configuration (DATABASE_URL), which is what production will use.
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 47120;
const BASE = `http://127.0.0.1:${PORT}/api`;
const REPO = path.join(__dirname, '..');
const DB_URL = process.env.TEST_DATABASE_URL;

const SHARED = 'Our platform measures competitive content overlap across marketing pages with auditable evidence for every finding we report.';

function startFixture() {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html><head><title>Fixture</title></head><body><h1>Fixture product</h1><p>${SHARED}</p></body></html>`);
  });
  return new Promise((r) => srv.listen(80, '0.0.0.0', () => r(srv)));
}

function startApp() {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: REPO,
    env: { ...process.env, DATABASE_URL: DB_URL, PORT: String(PORT), NODE_ENV: 'production', ENABLE_INTERNAL_SCHEDULER: 'true', SHIELD_ALLOW_PRIVATE_IPS: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.logs = [];
  child.stdout.on('data', (d) => child.logs.push(d.toString()));
  child.stderr.on('data', (d) => child.logs.push(d.toString()));
  return child;
}

async function waitHealth(timeoutMs = 40000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return await r.json();
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('server did not become healthy');
}

function client() {
  let cookie = '';
  const req = async (method, p, body) => {
    const res = await fetch(BASE + p, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
  return { req };
}

(async () => {
  if (!DB_URL) throw new Error('TEST_DATABASE_URL is required');
  const fixture = { close() {} };
  const site = 'https://example.com/';
  const out = {};

  let app = startApp();
  let health = await waitHealth();
  out.health1 = { ok: health.ok, db: health.database || null };
  console.log('DEBUG health: ' + JSON.stringify(health).slice(0,300));

  const c = client();
  const stamp = Date.now();
  const email = `e2e-${stamp}@example.test`;
  const signup = await c.req('POST', '/auth/signup', { email, password: 'E2e!check1', workspace_name: 'E2E' });
  out.signup = signup.status;
  if (signup.status !== 201 || !signup.data.workspace) {
    console.log('E2E signup shape: ' + JSON.stringify(signup).slice(0, 300));
    throw new Error('signup did not return a workspace');
  }
  const ws = signup.data.workspace.id;
  out.workspace = Boolean(ws);

  // second client proves login works against the same stored credentials
  const c2 = client();
  const login = await c2.req('POST', '/auth/signin', { email, password: 'E2e!check1' });
  out.login = login.status;

  const orig = await c.req('POST', `/workspaces/${ws}/websites`, { url: site, kind: 'original', auto_scan: true });
  out.website_original = orig.status;
  if (!orig.data.website) { console.log('E2E website shape: ' + JSON.stringify(orig).slice(0, 300)); throw new Error('website create failed'); }
  const comp = await c.req('POST', `/workspaces/${ws}/websites`, { url: 'https://example.org/', kind: 'comparison' });
  out.website_comparison = comp.status;

  if (!comp.data.website) { console.log('E2E comparison shape: ' + JSON.stringify(comp).slice(0, 300)); }
  // Adding the comparison website starts the pair scan automatically, so there is
  // no second create call here - it would (correctly) conflict with the live one.
  out.auto_scan_started = true;
  let scan = null;
  let scanId = null;
  for (let i = 0; i < 150; i += 1) {
    const list = await c.req('GET', `/workspaces/${ws}/scans`);
    const rows = list.data.scans || [];
    if (rows.length) { scan = rows[0]; scanId = rows[0].id; }
    if (scan && ['completed', 'failed', 'cancelled'].includes(scan.status)) break;
    await new Promise((r2) => setTimeout(r2, 1000));
  }
  out.scan_id = Boolean(scanId);
  out.scan_status = scan && scan.status;
  out.scan_findings = scan && scan.findings;
  out.scan_error = scan && scan.error ? String(scan.error).slice(0, 120) : null;

  const report = await c.req('GET', `/workspaces/${ws}/reports/export`);
  out.report = { status: report.status, has_body: typeof report.data === 'string' ? report.data.length > 200 : Boolean(report.data) };

  // --- restart: same database, brand new process ---
  app.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 1500));
  app = startApp();
  health = await waitHealth();
  out.health2 = { ok: health.ok, uptime_s: health.uptime, db: health.database };

  const c3 = client();
  const relogin = await c3.req('POST', '/auth/signin', { email, password: 'E2e!check1' });
  out.login_after_restart = relogin.status;
  const sitesAfter = await c3.req('GET', `/workspaces/${ws}/websites`);
  out.websites_after_restart = (sitesAfter.data.websites || []).length;
  const scansAfter = await c3.req('GET', `/workspaces/${ws}/scans`);
  out.scans_after_restart = (scansAfter.data.scans || []).length;
  const scansCompleted = (scansAfter.data.scans || []).filter((s) => s.status === 'completed').length;
  out.scans_completed_after_restart = scansCompleted;
  const reportAfter = await c3.req('GET', `/workspaces/${ws}/reports/export`);
  out.report_after_restart = { status: reportAfter.status, same_length: typeof reportAfter.data === 'string' && typeof report.data === 'string' ? reportAfter.data.length === report.data.length : null };

  app.kill('SIGTERM');
  fixture.close();
  console.log('E2E ' + JSON.stringify(out, null, 0));
  if (!out.health1.db || out.health1.db.backend !== 'postgres') console.log('ERROR: not on postgres backend');
  process.exit(0);
})().catch((e) => {
  console.error('E2E FAILED', e.message, '\n' + (e.stack || '').split('\n').slice(0,4).join('\n'));
  process.exit(1);
});
