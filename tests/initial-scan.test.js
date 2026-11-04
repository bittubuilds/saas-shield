'use strict';
// The free product is one scan per website. These tests cover the one-time
// initial scan that starts when a website is added, and the honest status the
// dashboard reads back. No monitoring, no scheduler, no fabricated progress.
process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.DATABASE_FILE = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'shield-init-')) + '/test.db';
process.env.SHIELD_ALLOW_PRIVATE_IPS = 'true';
process.env.CRAWL_DELAY_MS = '50';
process.env.AUTH_RATE_LIMIT = '100';
process.env.AUTH_REQUIRE_EMAIL_VERIFICATION = 'false';
process.env.COOKIE_SECURE = 'false';
// Discovery must be unavailable here: that is the deployment reality this suite
// pins down, so no search key may leak in from the host environment.
delete process.env.SERPER_API_KEY;

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { server } = require('../src/server');
let BASE = null;
async function ready() {
  if (BASE) return;
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  BASE = `http://127.0.0.1:${server.address().port}/api`;
}

const COPIED = `Our platform helps modern logistics teams coordinate warehouse operations in real time.
Every shipment gets a live tracking timeline, predictive arrival windows, and automated
exception alerts routed to the right operator. Customers report forty percent fewer
support tickets, thirty percent faster dock turnaround, and a complete audit trail of
every handoff. The engine models each facility as a graph of dock doors, staging lanes,
and carrier commitments, then optimizes the entire day of arrivals before the first
truck rolls in, keeping promises honest even when weather or traffic breaks the schedule.`;

function page(title, body) {
  return `<!DOCTYPE html><html><head><title>${title}</title></head><body>${body}</body></html>`;
}

function startSite(routes) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const handler = routes[req.url];
      if (!handler) { res.statusCode = 404; res.end('not found'); return; }
      const [type, body] = handler;
      res.setHeader('content-type', type);
      res.end(body);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

function client() {
  let cookie = null;
  return {
    async req(method, path, body) {
      const res = await fetch(BASE + path, {
        method,
        headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined
      });
      const sc = res.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, data };
    }
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The server starts background workers; close it so the runner can exit.
after(() => new Promise((r) => server.close(r)));

async function newWorkspace(c, name) {
  const stamp = Date.now() + Math.floor(Math.random() * 1000);
  const email = `init-${stamp}@example.test`;
  const signup = await c.req('POST', '/auth/signup', { email, password: 'Init!scan12345', workspace_name: name });
  assert.equal(signup.status, 201, 'signup should succeed');
  const me = await c.req('GET', '/me');
  assert.equal(me.status, 200);
  return me.data.workspaces[0].id;
}

async function pollStatus(c, wsId, siteId, until, timeoutMs = 60000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    const { status, data } = await c.req('GET', `/workspaces/${wsId}/websites/${siteId}/initial-scan`);
    assert.equal(status, 200, 'status endpoint should answer');
    last = data;
    if (until(last)) return last;
    await sleep(400);
  }
  return last;
}

test('adding a website with no competitor and no search provider starts nothing and says so', async () => {
  await ready();
  const mine = await startSite({
    '/robots.txt': ['text/plain', 'User-agent: *\nAllow: /\nSitemap: /sitemap.xml\n'],
    '/sitemap.xml': ['application/xml', '<?xml version="1.0"?><urlset><url><loc>/</loc></url></urlset>'],
    '/': ['text/html', page('Home', `<p>${COPIED}</p>`)]
  });
  const c = client();
  const wsId = await newWorkspace(c, 'Solo site');
  const site = mine ? `http://127.0.0.1:${mine.port}` : '';

  const added = await c.req('POST', `/workspaces/${wsId}/websites`, { url: site, kind: 'original', label: 'My site' });
  assert.equal(added.status, 201);
  const init = added.data.initial_scan;
  assert.ok(init, 'creation should report what the automatic step did');
  assert.equal(init.mode, 'needs_comparison');
  assert.equal(init.started, false);
  assert.match(init.message, /not available|Add the site/i);

  // Nothing may be silently queued: no scan, no discovery, no findings.
  const scans = await c.req('GET', `/workspaces/${wsId}/scans`);
  assert.equal(scans.data.scans.length, 0, 'no scan should exist without a comparison');

  const st = await c.req('GET', `/workspaces/${wsId}/websites/${added.data.website.id}/initial-scan`);
  assert.equal(st.status, 200);
  assert.equal(st.data.website.registered, true);
  assert.equal(st.data.comparison.available, false);
  assert.equal(st.data.scan, null);
  assert.equal(st.data.findings_total, 0);
  mine.srv.close();
});

test('adding a competitor starts the single initial scan, and status reports real stages', async () => {
  await ready();
  const original = await startSite({
    '/robots.txt': ['text/plain', 'User-agent: *\nAllow: /\n'],
    '/': ['text/html', page('Home', `<h1>Logistics platform</h1><p>${COPIED}</p>`)],
    '/pricing': ['text/html', page('Pricing', '<h1>Pricing</h1><p>Simple plans for teams of every size, billed monthly.</p>')]
  });
  const competitor = await startSite({
    '/robots.txt': ['text/plain', 'User-agent: *\nAllow: /\n'],
    '/': ['text/html', page('Cheap copy', `<h1>Logistics</h1><p>${COPIED}</p><p>Contact us for a quote today.</p>`)]
  });

  const c = client();
  const wsId = await newWorkspace(c, 'Two sites');
  const mineUrl = `http://127.0.0.1:${original.port}`;
  const compUrl = `http://127.0.0.1:${competitor.port}`;

  const first = await c.req('POST', `/workspaces/${wsId}/websites`, { url: mineUrl, kind: 'original', label: 'Mine' });
  assert.equal(first.status, 201);
  assert.equal(first.data.initial_scan.mode, 'needs_comparison');
  const siteId = first.data.website.id;

  // Adding a comparison site must kick off the one scan by itself.
  const second = await c.req('POST', `/workspaces/${wsId}/websites`, { url: compUrl, kind: 'comparison', label: 'Them' });
  assert.equal(second.status, 201);
  const init = second.data.initial_scan;
  assert.equal(init.mode, 'scan');
  assert.equal(init.started, true);
  assert.ok(init.scan_id, 'a scan id should be returned');

  // Status is read back from the jobs themselves, so wait for the real thing.
  const done = await pollStatus(c, wsId, siteId, (s) => s.done === true, 90000);
  assert.ok(done.scan, 'a scan should be attached to the website');
  assert.equal(done.scan.status, 'completed', `scan should complete, got ${done.scan && done.scan.status} ${done.scan && done.scan.error}`);
  assert.ok(done.website.pages_discovered > 0, 'pages should be stored for the added site');
  assert.ok(done.findings_total > 0, 'the copied passage should be found');

  // The findings are evidence-backed, not counts alone.
  const results = await c.req('GET', `/workspaces/${wsId}/results`);
  const rows = results.data.results || results.data.findings || [];
  assert.ok(rows.length > 0, 'results endpoint should list findings');
  const finding = rows[0];
  assert.ok(finding.original_url && finding.comparison_url, 'both sides must be present');
  assert.ok(typeof finding.jaccard_score === 'number', 'similarity score must be numeric');
  assert.ok(finding.match_type, 'detection method must be reported');

  original.srv.close();
  competitor.srv.close();
});

test('a second workspace cannot read another workspace status', async () => {
  await ready();
  const site = await startSite({
    '/robots.txt': ['text/plain', 'User-agent: *\nAllow: /\n'],
    '/': ['text/html', page('Home', `<p>${COPIED}</p>`)]
  });
  const owner = client();
  const wsA = await newWorkspace(owner, 'Owner');
  const added = await owner.req('POST', `/workspaces/${wsA}/websites`, { url: `http://127.0.0.1:${site.port}`, kind: 'original' });
  assert.equal(added.status, 201);

  const stranger = client();
  const wsB = await newWorkspace(stranger, 'Stranger');
  const denied = await stranger.req('GET', `/workspaces/${wsA}/websites/${added.data.website.id}/initial-scan`);
  assert.ok([403, 404].includes(denied.status), `cross-workspace read must fail, got ${denied.status}`);

  // And the stranger's own workspace never sees the other site.
  const own = await stranger.req('GET', `/workspaces/${wsB}/websites`);
  assert.equal(own.data.websites.length, 0);
  site.srv.close();
});

test('auto_scan:false is respected for scripted callers', async () => {
  await ready();
  const site = await startSite({ '/': ['text/html', page('Home', '<p>hello</p>')] });
  const c = client();
  const wsId = await newWorkspace(c, 'No auto');
  const added = await c.req('POST', `/workspaces/${wsId}/websites`, { url: `http://127.0.0.1:${site.port}`, kind: 'original', auto_scan: false });
  assert.equal(added.status, 201);
  assert.equal(added.data.initial_scan, null, 'no automatic work should be reported');
  const scans = await c.req('GET', `/workspaces/${wsId}/scans`);
  assert.equal(scans.data.scans.length, 0);
  site.srv.close();
});

// --- review hardening: duplicates, races, self-pairing, isolation -------------

test('the same site is refused in every URL spelling', async () => {
  await ready();
  const site = await startSite({ '/': ['text/html', page('Home')] });
  const c = client();
  const wsId = await newWorkspace(c, 'Duplicates');
  const base = `http://127.0.0.1:${site.port}`;
  const first = await c.req('POST', `/workspaces/${wsId}/websites`, { url: base + '/', kind: 'original', auto_scan: false });
  assert.equal(first.status, 201);
  for (const variant of [base, base + '/?utm=1', base + '/#frag', base.replace('http://', 'HTTP://')]) {
    const again = await c.req('POST', `/workspaces/${wsId}/websites`, { url: variant, kind: 'original', auto_scan: false });
    assert.equal(again.status, 409, `${variant} must be recognised as the same website`);
  }
  site.srv.close();
});

test('normalisation ignores scheme and www for duplicate detection', () => {
  const { domainOf } = require('../src/ssrf');
  assert.equal(domainOf('https://www.Example.com/a?b=1'), domainOf('http://example.com/'));
  assert.equal(domainOf('HTTP://EXAMPLE.COM/'), 'example.com');
});

test('a competitor cannot be the site under review', async () => {
  await ready();
  const site = await startSite({ '/': ['text/html', page('Home')] });
  const c = client();
  const wsId = await newWorkspace(c, 'Self pair');
  await c.req('POST', `/workspaces/${wsId}/websites`, { url: `http://127.0.0.1:${site.port}/`, kind: 'original', auto_scan: false });
  const same = await c.req('POST', `/workspaces/${wsId}/websites`, { url: `http://127.0.0.1:${site.port}`, kind: 'comparison' });
  assert.equal(same.status, 409, 'same domain must not register as a competitor');
  site.srv.close();
});

test('two concurrent adds create exactly one scan', async () => {
  await ready();
  const orig = await startSite({ '/': ['text/html', page('Home', '<p>' + COPIED + '</p>')] });
  const c1 = await startSite({ '/': ['text/html', page('Copy', '<p>' + COPIED + '</p>')] });
  const c2 = await startSite({ '/': ['text/html', page('Other', '<p>unrelated words here</p>')] });
  const c = client();
  const wsId = await newWorkspace(c, 'Race');
  await c.req('POST', `/workspaces/${wsId}/websites`, { url: `http://127.0.0.1:${orig.port}`, kind: 'original', auto_scan: false });
  const [a, b] = await Promise.all([
    c.req('POST', `/workspaces/${wsId}/websites`, { url: `http://127.0.0.1:${c1.port}`, kind: 'comparison' }),
    c.req('POST', `/workspaces/${wsId}/websites`, { url: `http://127.0.0.1:${c2.port}`, kind: 'comparison' })
  ]);
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  const modes = [a.data.initial_scan.mode, b.data.initial_scan.mode].sort();
  assert.deepEqual(modes, ['already_scanned', 'scan'], 'only one request may start the free scan');
  const scans = await c.req('GET', `/workspaces/${wsId}/scans`);
  assert.equal(scans.data.scans.length, 1, 'exactly one scan job');
  orig.srv.close(); c1.srv.close(); c2.srv.close();
});

test('an unreachable site fails the scan with a readable reason, not a hang', async () => {
  await ready();
  const c = client();
  const wsId = await newWorkspace(c, 'Unreachable');
  const probeSrv = http.createServer((req, res) => res.end('ok'));
  await new Promise((r) => probeSrv.listen(0, '127.0.0.1', r));
  const deadPort = probeSrv.address().port;
  await new Promise((r) => probeSrv.close(r));
  await c.req('POST', `/workspaces/${wsId}/websites`, { url: `http://127.0.0.1:${deadPort}/`, kind: 'original', auto_scan: false });
  const added = await c.req('POST', `/workspaces/${wsId}/websites`, { url: 'http://127.0.0.1:1/', kind: 'comparison' });
  assert.equal(added.data.initial_scan.mode, 'scan');
  let scan = null;
  for (let i = 0; i < 40; i += 1) {
    const list = await c.req('GET', `/workspaces/${wsId}/scans`);
    scan = (list.data.scans || [])[0];
    if (scan && ['completed', 'failed'].includes(scan.status)) break;
    await sleep(200);
  }
  assert.equal(scan.status, 'failed');
  assert.ok(scan.error && scan.error.length > 10, 'failure must explain itself');
});
