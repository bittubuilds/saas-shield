'use strict';
// Auto-discovery unit + integration tests.
process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.DATABASE_FILE = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'shield-')) + '/test.db';
process.env.SHIELD_ALLOW_PRIVATE_IPS = 'true';
process.env.AUTH_RATE_LIMIT = '100';
process.env.COOKIE_SECURE = 'false';
delete process.env.SERPER_API_KEY;   // keyless behaviour under test

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { server } = require('../src/server');
const discover = require('../src/discover');
const db = require('../src/db');
const { newId, utcNow } = require('../src/util');
const http = require('http');

const COPIED = `Our platform helps modern logistics teams coordinate warehouse operations in real time. Every shipment gets a live tracking timeline, predictive arrival windows, and automated exception alerts routed to the right operator.`;
function pg(title, body) { return `<!DOCTYPE html><html><head><title>${title}</title></head><body>${body}</body></html>`; }

after(() => new Promise((r) => server.close(r)));  // let the runner exit

let BASE = null;
async function ready() {
  if (BASE) return;
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  BASE = `http://127.0.0.1:${server.address().port}/api`;
}

function client() {
  let cookie = null;
  return async (path, opts = {}) => {
    const res = await fetch(BASE + path, {
      ...opts,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(opts.headers || {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    let data = {};
    try { data = await res.json(); } catch { /* empty */ }
    return { status: res.status, data };
  };
}

async function makeAccount(c) {
  const email = `dt${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`;
  await c('/auth/signup', { method: 'POST', body: { email, password: 'TestPass#123', name: 'DT' } });
  const me = await c('/auth/me');
  return me.data.workspaces[0].id;
}

// ---------------------------------------------------------------------------
// Unit: sentence selection
// ---------------------------------------------------------------------------
test('pickSearchSentences picks long content sentences and skips boilerplate', () => {
  const long = 'Our platform helps modern logistics teams coordinate warehouse operations across every facility in real time with live tracking.';
  const pages = [
    { text_content: `Home Menu Services Contact. ${long} Call us today!` },
    { text_content: 'Short. Too short. Nope.' }
  ];
  const picked = discover.pickSearchSentences(pages, []);
  assert.equal(picked.length, 1);
  assert.ok(picked[0].includes('logistics teams'));
});

test('pickSearchSentences respects the query cap', () => {
  const long = 'This is a distinctive and very long sentence about content protection services that should be searchable across the public web.';
  const pages = Array.from({ length: 10 }, () => ({ text_content: long }));
  const picked = discover.pickSearchSentences(pages, []);
  assert.ok(picked.length <= discover.MAX_QUERIES);
});

// ---------------------------------------------------------------------------
// Unit: result filtering
// ---------------------------------------------------------------------------
test('filterResultHosts drops own domain, platforms, junk and dedupes', () => {
  const urls = [
    'https://mysite.com/page',
    'https://www.mysite.com/other',
    'https://copier.example.com/stolen',
    'https://copier.example.com/another',
    'https://facebook.com/x',
    'https://en.wikipedia.org/wiki/X',
    'https://evil.example.net/copy',
    'ftp://bad.example.org/x',
    'https://good.example.io/fine',
    'https://a.example.co/copy1',
    'https://b.example.co/copy2',
    'https://c.example.co/copy3',
    'https://d.example.co/copy4',
    'https://e.example.co/copy5',
    'https://f.example.co/copy6',
    'https://g.example.co/copy7'
  ];
  const out = discover.filterResultHosts(urls, 'mysite.com');
  const hosts = out.map((u) => new URL(u).host);
  assert.ok(!hosts.includes('mysite.com'));
  assert.ok(!hosts.includes('www.mysite.com'));
  assert.ok(!hosts.includes('facebook.com'));
  assert.ok(!hosts.includes('en.wikipedia.org'));
  assert.equal(new Set(hosts).size, hosts.length);
  assert.ok(hosts.length <= discover.MAX_SITES);
  assert.ok(hosts.includes('copier.example.com'));
});

// ---------------------------------------------------------------------------
// Integration: API + engine
// ---------------------------------------------------------------------------
test('discovery without a search key fails with an honest, actionable error', async () => {
  await ready();
  const c = client();
  const wsId = await makeAccount(c);
  // A real (local) site so the crawl step succeeds and the missing search key
  // is what actually fails the run.
  const srv = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(pg('Home', `<h1>Logistics</h1><p>${COPIED}</p>`));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const siteUrl = `http://127.0.0.1:${srv.address().port}/`;
  const site = await c(`/workspaces/${wsId}/websites`, { method: 'POST', body: { url: siteUrl, kind: 'original' } });
  assert.equal(site.status, 201);
  const origId = site.data.website.id;

  const resp = await c(`/workspaces/${wsId}/discover`, { method: 'POST', body: { original_website_id: origId } });
  assert.equal(resp.status, 202);

  let d = null;
  for (let i = 0; i < 40; i++) {
    const st = await c(`/workspaces/${wsId}/discoveries/${resp.data.discovery.id}`);
    d = st.data.discovery;
    if (['completed', 'failed'].includes(d.status)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(d.status, 'failed');
  assert.ok(d.error.includes('SERPER_API_KEY'), 'error mentions the missing key: ' + d.error);
  srv.close();
});

test('runDiscovery with a stubbed search registers comparison sites and queues scans', async () => {
  await ready();
  const c = client();
  const wsId = await makeAccount(c);
  const site = await c(`/workspaces/${wsId}/websites`, { method: 'POST', body: { url: 'http://127.0.0.1:1/', kind: 'original' } });
  const origId = site.data.website.id;

  // Seed original content directly (no live crawl in this test).
  const orig = db.prepare('SELECT * FROM websites WHERE id=?').get(origId);
  db.prepare(`INSERT INTO pages (id, website_id, workspace_id, url, submitted_url, canonical_url, title, text_content, meta_description, content_hash, http_status, fetched_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(newId('pg'), origId, wsId, 'http://127.0.0.1:1/', orig.submitted_url, null, 'Home',
         'Our platform helps modern logistics teams coordinate warehouse operations across every facility in real time with predictive arrival windows.',
         null, 'h1', 200, utcNow());

  const discoveryId = newId('dsc');
  db.prepare(`INSERT INTO discoveries (id, workspace_id, original_website_id, status, created_by, created_at, updated_at)
              VALUES (?,?,?, 'queued', ?, ?, ?)`)
    .run(discoveryId, wsId, origId, null, utcNow(), utcNow());

  const searchFn = async (q) => [
    'http://127.0.0.1:1/',                                  // own site (non-std port) -> excluded
    'http://127.0.0.1:1/about',                            // same -> deduped
    'https://copier-one.test/stolen-content',               // registered
    'https://copier-one.test/again',                       // same host -> deduped
    'https://facebook.com/spam',                           // blocked platform
    'ftp://bad.example.org/x'                               // non-http scheme -> skipped
  ];
  await discover.runDiscovery(discoveryId, { searchFn });

  const d = db.prepare('SELECT * FROM discoveries WHERE id=?').get(discoveryId);
  assert.equal(d.status, 'completed');
  assert.equal(d.created_scan_count, 1);
  const found = JSON.parse(d.found_hosts);
  assert.equal(found.length, 1);
  assert.ok(found[0].url.includes('copier-one.test'));

  const comps = db.prepare(`SELECT * FROM websites WHERE workspace_id=? AND kind='comparison'`).all(wsId);
  assert.equal(comps.length, 1);
  assert.equal(comps[0].label, 'Found by auto-discovery');

  const scans = db.prepare(`SELECT * FROM scans WHERE workspace_id=?`).all(wsId);
  assert.equal(scans.length, 1);
  assert.equal(scans[0].comparison_website_id, comps[0].id);
  assert.equal(JSON.parse(scans[0].params).discovered, true);
});
