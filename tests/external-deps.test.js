'use strict';
// MVP without paid dependencies: no Serper key, no verified sending domain, no
// transactional email provider. These tests prove the core product still works.
process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.DATABASE_FILE = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'mvp-')) + '/test.db';
process.env.SHIELD_ALLOW_PRIVATE_IPS = 'true';
process.env.CRAWL_DELAY_MS = '10';
process.env.AUTH_RATE_LIMIT = '100';
process.env.COOKIE_SECURE = 'false';
process.env.AUTH_REQUIRE_EMAIL_VERIFICATION = 'false';   // the no-email MVP mode
delete process.env.SERPER_API_KEY;
delete process.env.EMAIL_PROVIDER;
delete process.env.RESEND_API_KEY;

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const COPY_TEXT = 'Our platform helps logistics teams coordinate warehouse operations in real time with a live tracking timeline for every shipment.';

// ---------------------------------------------------------------------------
// Fixture: a landing page with NO navigation links. Its other pages are only
// advertised through robots.txt + sitemap.xml, which is exactly what the free
// discovery path has to handle without a search provider.
// ---------------------------------------------------------------------------
function html(title, body) {
  return `<!DOCTYPE html><html><head><title>${title}</title></head><body>${body}</body></html>`;
}

const site = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const base = `http://127.0.0.1:${site.address().port}`;
  if (url.pathname === '/robots.txt') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end(`User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml\n`);
  }
  if (url.pathname === '/sitemap.xml') {
    res.writeHead(200, { 'content-type': 'application/xml' });
    return res.end(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${base}/</loc></url>
  <url><loc>${base}/pricing</loc></url>
  <url><loc>${base}/signup</loc></url>
  <url><loc>${base}/blog/post-1</loc></url>
</urlset>`);
  }
  const pages = {
    '/': html('Logistics platform', `<h1>Logistics platform</h1><p>${COPY_TEXT}</p>`),
    '/pricing': html('Pricing', '<h1>Pricing</h1><div class="plan"><h2>Pro</h2><span>$49 / month</span></div>'),
    '/signup': html('Signup', '<h1>Create account</h1><form action="/signup"><input name="email"><input name="password"></form>'),
    '/blog/post-1': html('Post', '<h1>Post</h1><p>Blog post.</p>')
  };
  if (!pages[url.pathname]) { res.writeHead(404); return res.end('nope'); }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(pages[url.pathname]);
});

const copycat = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(html('Copycat', `<h1>Logistics platform</h1><p>${COPY_TEXT}</p>`));
});

const { server } = require('../src/server');

after(() => new Promise((r) => server.close(() => copycat.close(() => site.close(r)))));

let BASE = null;
async function ready() {
  if (BASE) return BASE;
  for (const s of [site, copycat]) {
    if (!s.listening) {
      const up = new Promise((r) => s.once('listening', r));
      s.listen(0, '127.0.0.1');
      await up;
    }
  }
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  BASE = `http://127.0.0.1:${server.address().port}/api`;
  return BASE;
}

function client() {
  let cookie = null;
  return async (p, opts = {}) => {
    await ready();
    const res = await fetch(BASE + p, {
      redirect: 'manual',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    const set = res.headers.get('set-cookie');
    if (set) {
      const m = /(shield_session=[^;]+)/.exec(set);
      if (m) cookie = m[1];
    }
    let data = {};
    try { data = await res.json(); } catch { /* empty */ }
    return { status: res.status, data };
  };
}

// ---------------------------------------------------------------------------
// 1. Auth mode is derived from what the deployment can really deliver
// ---------------------------------------------------------------------------
test('auth mode follows deliverability, and an explicit flag always wins', () => {
  const childEnv = (overrides) => {
    const env = { ...process.env };
    delete env.AUTH_REQUIRE_EMAIL_VERIFICATION;
    for (const [k, v] of Object.entries(overrides)) {
      if (v === '') delete env[k]; else env[k] = v;
    }
    return env;
  };
  const probe = (env) => JSON.parse(execFileSync(process.execPath, ['-e', `
    const c = require(${JSON.stringify(path.join(ROOT, 'src/config'))});
    process.stdout.write(JSON.stringify({ mode: c.auth.mode, required: c.auth.requireEmailVerification, reachable: c.auth.emailReachable, source: c.auth.modeSource }));
  `], { env: childEnv(env), encoding: 'utf8' }));

  const none = probe({ EMAIL_PROVIDER: '', RESEND_API_KEY: '', EMAIL_FROM: '' });
  assert.equal(none.mode, 'instant', 'no provider means no verification gate');
  assert.equal(none.reachable, false);

  const testSender = probe({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_x', EMAIL_FROM: 'SaaS Shield <onboarding@resend.dev>' });
  assert.equal(testSender.mode, 'instant', 'a test sender cannot reach users, so it must not gate signup');

  const realDomain = probe({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_x', EMAIL_FROM: 'SaaS Shield <alerts@example.org>' });
  assert.equal(realDomain.mode, 'verified');
  assert.equal(realDomain.reachable, true);

  const forced = probe({ EMAIL_PROVIDER: '', AUTH_REQUIRE_EMAIL_VERIFICATION: 'true' });
  assert.equal(forced.mode, 'verified', 'an explicit flag always wins');
  assert.equal(forced.source, 'AUTH_REQUIRE_EMAIL_VERIFICATION');
});

// ---------------------------------------------------------------------------
// 2. Registration and login with no email provider
// ---------------------------------------------------------------------------
test('registration and login work with no email provider at all', async () => {
  const c = client();
  const cfg = await c('/auth/config');
  assert.equal(cfg.status, 200);
  assert.equal(cfg.data.auth_mode, 'instant');
  assert.equal(cfg.data.email_reachable, false);
  assert.equal(cfg.data.email_verification_required, false);
  assert.equal(cfg.data.email.configured, false);

  const signup = await c('/auth/signup', {
    method: 'POST', body: { email: 'mvp@example.com', password: 'longenough123', workspace_name: 'MVP Co' }
  });
  assert.equal(signup.status, 201);
  assert.equal(signup.data.verification.required, false);
  assert.equal(signup.data.verification.delivery, 'not_needed', 'no provider call in instant mode');
  assert.equal(signup.data.verification.delivery_error, undefined, 'no provider error is surfaced');

  const me = await c('/me');
  assert.equal(me.status, 200, 'signup starts a session in instant mode');
  assert.equal(me.data.user.email, 'mvp@example.com');
  assert.equal(me.data.user.email_verified, true, 'instant accounts are marked verified (source: ' + me.data.user.email_verified_source + ')');
  assert.equal(me.data.workspaces.length, 1);

  const login = await client()('/auth/signin', { method: 'POST', body: { email: 'mvp@example.com', password: 'longenough123' } });
  assert.equal(login.status, 200);
  assert.ok(!login.data.user.password_hash, 'never return the password hash');

  const wrong = await client()('/auth/signin', { method: 'POST', body: { email: 'mvp@example.com', password: 'wrongpass123' } });
  assert.equal(wrong.status, 401, 'hashing and credential checks are untouched');
});

// ---------------------------------------------------------------------------
// 3. Core product: register both sites and compare, with zero external services
// ---------------------------------------------------------------------------
test('two websites are crawled and compared with no search, email or domain', async () => {
  const c = client();
  await c('/auth/signin', { method: 'POST', body: { email: 'mvp@example.com', password: 'longenough123' } });
  const me = await c('/me');
  const ws = me.data.workspaces[0].id;

  const orig = await c(`/workspaces/${ws}/websites`, {
    method: 'POST', body: { url: `http://127.0.0.1:${site.address().port}/`, kind: 'original', label: 'Fixture', auto_scan: false }
  });
  assert.equal(orig.status, 201, JSON.stringify(orig.data));
  const comp = await c(`/workspaces/${ws}/websites`, {
    method: 'POST', body: { url: `http://127.0.0.1:${copycat.address().port}/`, kind: 'comparison', label: 'Copycat', auto_scan: false }
  });
  assert.equal(comp.status, 201, JSON.stringify(comp.data));

  const scan = await c(`/workspaces/${ws}/scans`, {
    method: 'POST',
    body: { original_website_id: orig.data.website.id, comparison_website_id: comp.data.website.id }
  });
  assert.ok([201, 202].includes(scan.status), 'scan accepted without any external service: ' + JSON.stringify(scan.data));

  let done = null;
  for (let i = 0; i < 60; i += 1) {
    const poll = await c(`/workspaces/${ws}/scans/${scan.data.scan.id}`);
    if (['completed', 'failed'].includes(poll.data.scan.status)) { done = poll.data.scan; break; }
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(done, 'scan finished');
  assert.equal(done.status, 'completed', 'comparison completed offline: ' + JSON.stringify(done.error || ''));

  const results = await c(`/workspaces/${ws}/results?scan_id=${done.id}`);
  assert.equal(results.status, 200);
  const rows = results.data.results || results.data.items || [];
  assert.ok(Array.isArray(rows), 'results are returned');
});

// ---------------------------------------------------------------------------
// 4. Sitemap discovery finds pages a link-less landing page hides
// ---------------------------------------------------------------------------
test('sitemap discovery registers pages without any search provider', async () => {
  const c = client();
  await c('/auth/signin', { method: 'POST', body: { email: 'mvp@example.com', password: 'longenough123' } });
  const me = await c('/me');
  const ws = me.data.workspaces[0].id;
  const sites = await c(`/workspaces/${ws}/websites`);
  const original = sites.data.websites.find((w) => w.kind === 'original');
  assert.ok(original, 'original site exists');

  const mon = await c(`/workspaces/${ws}/websites/${original.id}/monitor`, {
    method: 'POST', body: { enabled: true, frequency_hours: 24 }
  });
  assert.equal(mon.status, 200, JSON.stringify(mon.data));

  const pages = await c(`/workspaces/${ws}/pages`);
  assert.equal(pages.status, 200);
  const roles = pages.data.pages.map((p) => p.role);
  assert.ok(roles.includes('homepage'), 'homepage registered: ' + roles.join(','));
  // The landing page has no links at all, so these can only come from the sitemap.
  assert.ok(roles.includes('pricing'), 'sitemap gave no pricing page. roles=' + roles.join(',') + ' monitor=' + JSON.stringify(mon.data).slice(0, 400));
  assert.ok(roles.includes('signup'), 'signup page discovered via sitemap: ' + roles.join(','));
  assert.ok(!pages.data.pages.some((p) => p.url.includes('/blog/')), 'blog pages stay out of monitoring');
});

// ---------------------------------------------------------------------------
// 5. Auto-discovery is optional and refuses honestly
// ---------------------------------------------------------------------------
test('auto-discovery is optional and reports why it cannot run', async () => {
  const c = client();
  await c('/auth/signin', { method: 'POST', body: { email: 'mvp@example.com', password: 'longenough123' } });
  const me = await c('/me');
  const ws = me.data.workspaces[0].id;

  const sites = await c(`/workspaces/${ws}/websites`);
  const original = sites.data.websites.find((w) => w.kind === 'original');

  const before = await c(`/workspaces/${ws}/discoveries`);
  assert.equal(before.status, 200);
  assert.equal(before.data.search_available, false, 'the API states the capability is off');

  const run = await c(`/workspaces/${ws}/discover`, { method: 'POST', body: { original_website_id: original.id } });
  assert.ok([202, 400, 409, 503].includes(run.status), 'discovery answers, never hangs: ' + run.status);
  assert.ok(!/at Object\.|stack/.test(JSON.stringify(run.data)), 'no stack traces leak');

  // If it queued, the run must end as a clear failure rather than a fake success.
  if (run.status === 202) {
    let record = null;
    for (let i = 0; i < 40; i += 1) {
      const list = await c(`/workspaces/${ws}/discoveries`);
      record = (list.data.discoveries || []).find((d) => d.id === run.data.discovery.id);
      if (record && ['failed', 'completed', 'cancelled'].includes(record.status)) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(record, 'discovery run is tracked');
    assert.equal(record.status, 'failed', 'without a search provider the run fails honestly');
    assert.match(String(record.error), /search|key/i, 'the failure names the missing capability');
  }
});

// ---------------------------------------------------------------------------
// 6. Optional integrations degrade with messages, not crashes
// ---------------------------------------------------------------------------
test('missing optional integrations are reported, not fatal', async () => {
  const c = client();
  const cfg = await c('/auth/config');
  assert.equal(cfg.data.google.enabled, false);
  assert.ok(cfg.data.google.missing.length > 0, 'the missing variables are named');
  assert.ok(cfg.data.email.missing.length > 0);
  const health = await c('/health');
  assert.equal(health.status, 200, 'the app is healthy with nothing configured');
});
