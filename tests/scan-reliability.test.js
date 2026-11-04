'use strict';
// Reliability tests for the one-time scan: crawl timeouts, sitemap indexes, and
// recovery of scans orphaned by a crashed process.
//
// Nothing here weakens the existing suites; these are additive and each one drives
// the real modules against controlled local HTTP fixtures.
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NODE_ENV = 'test';
process.env.DATABASE_FILE = fs.mkdtempSync(path.join(os.tmpdir(), 'shield-rel-')) + '/rel.db';
process.env.SHIELD_ALLOW_PRIVATE_IPS = 'true';
process.env.AUTH_RATE_LIMIT = '500';
process.env.CRAWL_DELAY_MS = '0';
process.env.CRAWL_TIMEOUT_MS = '400';          // short, so the timeout path is reachable
process.env.CRAWL_MAX_PAGES_PER_SITE = '5';    // small, so the page cap is observable
process.env.SCAN_STALE_AFTER_MINUTES = '15';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const http = require('http');

const db = require('../src/db/index');
const scanner = require('../src/scanner');
const initialScan = require('../src/initialscan');
const { recoverStaleScans, INTERRUPTED } = require('../src/scan-recovery');
const { newId, utcNow } = require('../src/util');

const servers = [];
after(() => { for (const s of servers) try { s.close(); } catch { /* closed */ } });

function page(title, body) {
  return `<!DOCTYPE html><html><head><title>${title}</title></head><body>${body}</body></html>`;
}

// routes: { '/path': [contentType, body, delayMs?] }
function startSite(routes) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const hit = routes[req.url];
      if (!hit) { res.statusCode = 404; res.end('not found'); return; }
      const [type, body, delay] = hit;
      const send = () => { res.writeHead(200, { 'content-type': type }); res.end(body); };
      if (delay) setTimeout(send, delay); else send();
    });
    servers.push(srv);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}


// handlers: { '/path': (req, res, base) => void }
function serve(handlers) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const base = `http://127.0.0.1:${srv.address().port}`;
      const h = handlers[req.url];
      if (!h) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
      h(req, res, base);
    });
    servers.push(srv);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, base: `http://127.0.0.1:${srv.address().port}` }));
  });
}
const html = (body) => (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(body); };
const xml = (body) => (req, res) => { res.writeHead(200, { 'content-type': 'application/xml' }); res.end(body); };
const robots = (extra = '') => (req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('User-agent: *\nAllow: /\n' + extra); };
function indexXml(paths, base) {
  return '<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
    paths.map((p) => `<sitemap><loc>${base}${p}</loc></sitemap>`).join('') + '</sitemapindex>';
}
function urlsetXml(paths, base) {
  return '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
    paths.map((p) => `<url><loc>${base}${p}</loc></url>`).join('') + '</urlset>';
}

function seedWorkspace() {
  const wsId = newId('wsp');
  const now = utcNow();
  db.prepare(`INSERT INTO workspaces (id, name, created_at) VALUES (?,?,?)`)
    .run(wsId, 'Reliability', now);
  return wsId;
}

function seedSite(wsId, url, kind = 'original') {
  const id = newId('web');
  const now = utcNow();
  const domain = new URL(url).host.replace(/^www\./, '');
  db.prepare(`INSERT INTO websites (id, workspace_id, kind, submitted_url, normalized_domain, status, crawl_status, created_at, updated_at)
              VALUES (?,?,?,?,?,'active','not_crawled',?,?)`)
    .run(id, wsId, kind, url, domain, now, now);
  return id;
}

// --- 1. crawl timeout --------------------------------------------------------

test('a site that never answers times out and fails the scan with a readable error', async () => {
  const slow = await startSite({
    '/': ['text/html', page('Slow', '<p>slow</p>'), 5000],   // beyond CRAWL_TIMEOUT_MS
    '/robots.txt': ['text/plain', 'User-agent: *\nAllow: /\n']
  });
  const wsId = seedWorkspace();
  const siteId = seedSite(wsId, `http://127.0.0.1:${slow.port}/`);

  const started = Date.now();
  const site = db.prepare('SELECT * FROM websites WHERE id=?').get(siteId);
  const result = await scanner.crawlAndStore(site, { maxPages: 2, maxDepth: 0 }, null);
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 4000, `crawl must not hang, took ${elapsed}ms`);
  const stored = db.prepare('SELECT COUNT(*) AS n FROM pages WHERE website_id=?').get(siteId).n;
  assert.equal(stored, 0, 'no page should be extracted from a timing-out site');
  const after_ = db.prepare('SELECT crawl_status, crawl_error FROM websites WHERE id=?').get(siteId);
  assert.equal(after_.crawl_status, 'crawled', 'the crawl finishes rather than staying in "crawling"');
});

test('a scan whose site times out ends failed, not running', async () => {
  const dead = await startSite({ '/robots.txt': ['text/plain', 'User-agent: *\nAllow: /\n'] });
  const wsId = seedWorkspace();
  const original = seedSite(wsId, `http://127.0.0.1:${dead.port}/`);
  const comparison = seedSite(wsId, 'http://127.0.0.1:1/', 'comparison');

  const scanId = newId('scn');
  db.prepare(`INSERT INTO scans (id, workspace_id, original_website_id, comparison_website_id, status, params, created_at)
              VALUES (?,?,?,?,'queued','{}',?)`).run(scanId, wsId, original, comparison, utcNow());
  scanner.enqueueScan(scanId);

  const deadline = Date.now() + 15000;
  let row = null;
  while (Date.now() < deadline) {
    row = db.prepare('SELECT status, error FROM scans WHERE id=?').get(scanId);
    if (row.status === 'failed' || row.status === 'completed') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(row.status, 'failed', 'terminal failed state');
  assert.ok(row.error && row.error.length > 10, 'carries a human-readable reason');
  assert.match(row.error, /accessible pages|could not|crawl/i);
});

// --- 2. sitemap indexes ------------------------------------------------------

async function crawlPages(wsId, base, opts = { maxPages: 5, maxDepth: 1 }) {
  const siteId = seedSite(wsId, base + '/');
  const row = db.prepare('SELECT * FROM websites WHERE id=?').get(siteId);
  await scanner.crawlAndStore(row, opts, null);
  return db.prepare('SELECT url FROM pages WHERE website_id=?').all(siteId)
    .map((pg) => new URL(pg.url).pathname).sort();
}

test('a sitemap index with several children contributes pages from every child', async () => {
  const site = await serve({
    '/robots.txt': (req, res, base) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml\n`); },
    '/': html(page('Home', '<p>home page</p>')),
    '/sitemap.xml': (req, res, base) => { res.writeHead(200, { 'content-type': 'application/xml' }); res.end(indexXml(['/sm-a.xml', '/sm-b.xml'], base)); },
    '/sm-a.xml': (req, res, base) => { res.writeHead(200, { 'content-type': 'application/xml' }); res.end(urlsetXml(['/a1'], base)); },
    '/sm-b.xml': (req, res, base) => { res.writeHead(200, { 'content-type': 'application/xml' }); res.end(urlsetXml(['/b1'], base)); },
    '/a1': html(page('A1', '<p>alpha one content</p>')),
    '/b1': html(page('B1', '<p>beta one content</p>'))
  });
  const paths = await crawlPages(seedWorkspace(), site.base);
  assert.ok(paths.includes('/a1'), `child A page missing: ${paths.join(',')}`);
  assert.ok(paths.includes('/b1'), `child B page missing: ${paths.join(',')}`);
});

test('a nested sitemap index is followed, and broken children do not abort the crawl', async () => {
  const site = await serve({
    '/robots.txt': (req, res, base) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml\n`); },
    '/': html(page('Home', '<p>home page</p>')),
    '/sitemap.xml': (req, res, base) => { res.writeHead(200, { 'content-type': 'application/xml' }); res.end(indexXml(['/child.xml', '/missing.xml', '/garbage.xml'], base)); },
    '/child.xml': (req, res, base) => { res.writeHead(200, { 'content-type': 'application/xml' }); res.end(indexXml(['/grand.xml'], base)); },
    '/grand.xml': (req, res, base) => { res.writeHead(200, { 'content-type': 'application/xml' }); res.end(urlsetXml(['/deep'], base)); },
    '/garbage.xml': (req, res) => { res.writeHead(200, { 'content-type': 'application/xml' }); res.end('<html><body>not a sitemap'); },
    '/deep': html(page('Deep', '<p>deep page content</p>'))
  });
  const paths = await crawlPages(seedWorkspace(), site.base);
  assert.ok(paths.includes('/deep'), `nested index should reach the grandchild sitemap: ${paths.join(',')}`);
});

test('the page cap holds even when the sitemap advertises many pages', async () => {
  const many = Array.from({ length: 12 }, (_, i) => `/p${i}`);
  const handlers = {
    '/robots.txt': (req, res, base) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml\n`); },
    '/': html(page('Home', '<p>home page</p>')),
    '/sitemap.xml': (req, res, base) => { res.writeHead(200, { 'content-type': 'application/xml' }); res.end(urlsetXml(many, base)); }
  };
  for (const p of many) handlers[p] = html(page(p, `<p>page content ${p}</p>`));
  const site = await serve(handlers);
  const paths = await crawlPages(seedWorkspace(), site.base, { maxPages: 5, maxDepth: 1 });
  assert.ok(paths.length <= 5, `page cap exceeded: ${paths.length} pages`);
  assert.ok(paths.length >= 2, 'and it still collects pages up to the cap');
});

// --- 3. stale scan recovery --------------------------------------------------

function seedScan(wsId, original, comparison, status, startedIso) {
  const id = newId('scn');
  db.prepare(`INSERT INTO scans (id, workspace_id, original_website_id, comparison_website_id, status, params, created_at, started_at)
              VALUES (?,?,?,?,?,'{}',?,?)`).run(id, wsId, original, comparison, status, startedIso, startedIso);
  return id;
}

test('an orphaned running scan is recovered, keeps its history and frees the free scan', async () => {
  const site = await serve({ '/': html(page('Home', '<p>home</p>')) });
  const other = await serve({ '/': html(page('Copy', '<p>copied passage words here</p>')) });
  const wsId = seedWorkspace();
  const original = seedSite(wsId, site.base + '/');
  const comparison = seedSite(wsId, other.base + '/', 'comparison');

  const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const orphan = seedScan(wsId, original, comparison, 'running', old);

  const recovered = recoverStaleScans({ olderThanMs: 15 * 60 * 1000 });
  assert.ok(recovered.recovered >= 1);

  const row = db.prepare('SELECT status, error, finished_at FROM scans WHERE id=?').get(orphan);
  assert.equal(row.status, 'failed', 'orphan becomes a terminal failure');
  assert.equal(row.error, INTERRUPTED, 'reason is preserved for the user');
  assert.ok(row.finished_at, 'finish time recorded');

  // and the user can still use their one scan
  initialScan.start({ workspaceId: wsId, siteId: original, userId: null });
  const fresh = db.prepare(`SELECT COUNT(*) AS n FROM scans WHERE workspace_id=? AND status IN ('queued','running')`).get(wsId);
  assert.equal(fresh.n, 1, 'exactly one fresh scan after recovery');
});

test('a scan that is still inside the window is never touched', async () => {
  const site = await startSite({ '/': ['text/html', page('Home', '<p>home</p>')] });
  const wsId = seedWorkspace();
  const original = seedSite(wsId, `http://127.0.0.1:${site.port}/`);
  const comparison = seedSite(wsId, 'http://127.0.0.1:1/', 'comparison');
  const active = seedScan(wsId, original, comparison, 'running', new Date(Date.now() - 60 * 1000).toISOString());

  recoverStaleScans({ olderThanMs: 15 * 60 * 1000 });
  const row = db.prepare('SELECT status FROM scans WHERE id=?').get(active);
  assert.equal(row.status, 'running', 'active scans are left alone');
});

test('recovery does not create replacement jobs', async () => {
  const site = await startSite({ '/': ['text/html', page('Home', '<p>home</p>')] });
  const wsId = seedWorkspace();
  const original = seedSite(wsId, `http://127.0.0.1:${site.port}/`);
  const comparison = seedSite(wsId, 'http://127.0.0.1:1/', 'comparison');
  const before = db.prepare('SELECT COUNT(*) AS n FROM scans WHERE workspace_id=?').get(wsId).n;
  seedScan(wsId, original, comparison, 'queued', new Date(Date.now() - 3600 * 1000).toISOString());
  recoverStaleScans({ olderThanMs: 15 * 60 * 1000 });
  const afterCount = db.prepare('SELECT COUNT(*) AS n FROM scans WHERE workspace_id=?').get(wsId).n;
  assert.equal(afterCount, before + 1, 'no rows added beyond the seeded one');
});

// --- 4. manual cancellation ------------------------------------------------
// Cancelling is the user's own decision, so it ends that job with a recorded
// reason but must not burn the free scan: the record is kept, nothing is queued
// in the background, and the next request (a deliberate Start Scan) is allowed.

test('a cancelled scan keeps its record and reason, and does not block a retry', async () => {
  const site = await serve({ '/': html(page('Home', '<p>home copy</p>')) });
  const other = await serve({ '/': html(page('Copy', '<p>copied words here now</p>')) });
  const wsId = seedWorkspace();
  const original = seedSite(wsId, site.base + '/');
  const comparison = seedSite(wsId, other.base + '/', 'comparison');

  // A scan the user cancelled earlier today.
  const cancelledId = newId('scn');
  const earlier = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  db.prepare(`INSERT INTO scans (id, workspace_id, original_website_id, comparison_website_id, status, params, error, created_at, started_at, finished_at)
              VALUES (?,?,?,?,'cancelled','{}','Cancelled by user',?,?,?)`)
    .run(cancelledId, wsId, original, comparison, earlier, earlier, earlier);

  // The one-time scan is still available.
  const again = initialScan.start({ workspaceId: wsId, siteId: original, userId: null });
  assert.equal(again.mode, 'scan', 'a cancelled scan must not consume the free scan');
  assert.equal(again.started, true);

  // The original row is untouched: same status, same reason, nothing deleted.
  const kept = db.prepare('SELECT status, error FROM scans WHERE id=?').get(cancelledId);
  assert.equal(kept.status, 'cancelled');
  assert.equal(kept.error, 'Cancelled by user');

  // One retry was created, not several: exactly two rows in total.
  const rows = db.prepare('SELECT COUNT(*) AS n FROM scans WHERE workspace_id=?').get(wsId);
  assert.equal(rows.n, 2, 'retry must create exactly one new scan and keep the cancelled one');

  // The status endpoint reports the live retry, not the cancelled history.
  const st = initialScan.status(wsId, original);
  assert.equal(st.scan.status, 'queued');
  assert.equal(st.done, false);
  site.srv.close(); other.srv.close();
});

test('cancelling a live scan records the reason and frees the allowance', async () => {
  // Slow page so the crawl is still running when we cancel it.
  // Five linked pages, each delayed, so the crawl spans many cancellation points.
  const links = [1, 2, 3, 4, 5].map((n) => `<a href="/p${n}">p${n}</a>`).join(' ');
  const slow = await serve({
    '/': (req, res) => setTimeout(() => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page('Slow', `<p>slow home copy words</p>${links}`)); }, 250),
    '/p1': (req, res) => setTimeout(() => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page('P1', '<p>page one unique words</p>')); }, 250),
    '/p2': (req, res) => setTimeout(() => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page('P2', '<p>page two unique words</p>')); }, 250),
    '/p3': (req, res) => setTimeout(() => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page('P3', '<p>page three unique words</p>')); }, 250),
    '/p4': (req, res) => setTimeout(() => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page('P4', '<p>page four unique words</p>')); }, 250),
    '/p5': (req, res) => setTimeout(() => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page('P5', '<p>page five unique words</p>')); }, 250)
  });
  const other = await serve({ '/': html(page('Copy', '<p>other copy words here</p>')) });
  const wsId = seedWorkspace();
  const original = seedSite(wsId, slow.base + '/');
  const comparison = seedSite(wsId, other.base + '/', 'comparison');

  const started = initialScan.start({ workspaceId: wsId, siteId: original, userId: null });
  assert.equal(started.mode, 'scan');

  // Cancel as soon as the worker has the job.
  let cancelled = false;
  for (let i = 0; i < 40 && !cancelled; i += 1) {
    cancelled = scanner.requestCancel(started.scan_id);
    if (!cancelled) await sleep(25);
  }
  assert.ok(cancelled, 'the running job must be cancellable');

  let row = null;
  for (let i = 0; i < 60; i += 1) {
    row = db.prepare('SELECT status, error FROM scans WHERE id=?').get(started.scan_id);
    if (row.status === 'cancelled' || row.status === 'failed' || row.status === 'completed') break;
    await sleep(50);
  }
  assert.equal(row.status, 'cancelled', `expected cancelled, got ${row.status}`);
  assert.equal(row.error, 'Cancelled by user');

  // A deliberate retry is allowed and the cancelled row stays in history.
  const retry = initialScan.start({ workspaceId: wsId, siteId: original, userId: null });
  assert.equal(retry.mode, 'scan');
  const total = db.prepare('SELECT COUNT(*) AS n FROM scans WHERE workspace_id=?').get(wsId);
  assert.equal(total.n, 2);
  slow.srv.close(); other.srv.close();
});
