'use strict';
// Auto-discovery unit + integration tests.
process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.DATABASE_FILE = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'shield-')) + '/test.db';
process.env.SHIELD_ALLOW_PRIVATE_IPS = 'true';
process.env.AUTH_RATE_LIMIT = '100';
process.env.AUTH_DEV_EXPOSE_LINK = 'true';   // signup requires email verification now
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
      // Verification redirects to PUBLIC_BASE_URL, which has no usable port when
      // PORT=0. The session cookie is on the 303 itself, so do not follow it.
      redirect: 'manual',
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
  const su = await c('/auth/signup', { method: 'POST', body: { email, password: 'TestPass#123', name: 'DT' } });
  // Signup no longer issues a session: the address must be confirmed first.
  const link = su.data.verification && su.data.verification.dev_link;
  if (link) {
    // Use the test server's real address; the emailed link embeds PUBLIC_BASE_URL,
    // which has no usable port when PORT=0.
    const token = new URL(link).search;
    await c('/auth/verify' + token);
  }
  const me = await c('/auth/me');
  if (!me.data.workspaces) throw new Error('account setup failed: ' + JSON.stringify(me.data));
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

// Regression: a JavaScript-challenge page stored as an empty document made
// discovery trust the stale row forever and fail with "no readable content" on a
// site that had become readable. Discovery must crawl again when every stored page
// is empty, exactly as the scanner does.
test('discovery re-crawls when the only stored page is an empty shell', async () => {
  await ready();
  const READABLE = pg('Home', `<h1>Studio</h1><p>${'Our photography retainer includes two shoot days every month and a licensed image library for the whole team. '.repeat(6)}</p>`);
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(READABLE); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const port = srv.address().port;
    const c = client();
    const wsId = await makeAccount(c);
    const site = await c(`/workspaces/${wsId}/websites`, { method: 'POST', body: { url: `http://127.0.0.1:${port}/`, kind: 'original', auto_scan: false } });
    const origId = site.data.website.id;
    const orig = db.prepare('SELECT * FROM websites WHERE id=?').get(origId);

    // The stale state seen in production: one stored page, no text.
    db.prepare(`INSERT INTO pages (id, website_id, workspace_id, url, submitted_url, canonical_url, title, text_content, meta_description, content_hash, http_status, fetched_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(newId('pg'), origId, wsId, `http://127.0.0.1:${port}/`, orig.submitted_url, null, '', '', null, 'hshell', 200, utcNow());

    const discoveryId = newId('dsc');
    db.prepare(`INSERT INTO discoveries (id, workspace_id, original_website_id, status, created_by, created_at, updated_at)
                VALUES (?,?,?, 'queued', ?, ?, ?)`).run(discoveryId, wsId, origId, null, utcNow(), utcNow());

    const searched = [];
    await discover.runDiscovery(discoveryId, { searchFn: async (q) => { searched.push(q); return ['https://copier-two.test/page']; } });

    const d = db.prepare('SELECT * FROM discoveries WHERE id=?').get(discoveryId);
    assert.equal(d.status, 'completed', `discovery failed: ${d.error}`);
    assert.ok(searched.length >= 1, 'it found sentences to search for after re-crawling');
    const readable = db.prepare(`SELECT COUNT(*) c FROM pages WHERE website_id=? AND LENGTH(TRIM(text_content)) >= 200`).get(origId).c;
    assert.ok(readable >= 1, 'the shell page was replaced by readable text');
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

// The progress screen retries discovery, so runs repeat. Without a budget every run
// added up to six more comparison sites and scans; one workspace ended up sitting on
// dozens of comparisons with nothing visibly moving.
test('repeated discovery runs respect the workspace budget', async () => {
  await ready();
  const c = client();
  const wsId = await makeAccount(c);
  const site = await c(`/workspaces/${wsId}/websites`, { method: 'POST', body: { url: 'http://127.0.0.1:1/', kind: 'original', auto_scan: false } });
  const origId = site.data.website.id;
  const orig = db.prepare('SELECT * FROM websites WHERE id=?').get(origId);
  db.prepare(`INSERT INTO pages (id, website_id, workspace_id, url, submitted_url, canonical_url, title, text_content, meta_description, content_hash, http_status, fetched_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(newId('pg'), origId, wsId, 'http://127.0.0.1:1/', orig.submitted_url, null, 'Home',
         'Our platform helps modern logistics teams coordinate warehouse operations across every facility in real time with predictive arrival windows.',
         null, 'h1', 200, utcNow());

  const hosts = Array.from({ length: 10 }, (_, i) => `https://copier-budget-${i}.test/page`);
  for (let run = 0; run < 3; run++) {
    const discoveryId = newId('dsc');
    db.prepare(`INSERT INTO discoveries (id, workspace_id, original_website_id, status, created_by, created_at, updated_at)
                VALUES (?,?,?, 'queued', ?, ?, ?)`).run(discoveryId, wsId, origId, null, utcNow(), utcNow());
    await discover.runDiscovery(discoveryId, { searchFn: async () => hosts });
  }

  const comps = db.prepare(`SELECT COUNT(*) c FROM websites WHERE workspace_id=? AND kind='comparison'`).get(wsId).c;
  assert.ok(comps <= 8, `auto-discovery must stay bounded, got ${comps}`);
  const pending = db.prepare(`SELECT COUNT(*) c FROM scans WHERE workspace_id=? AND status='queued'`).get(wsId).c;
  assert.ok(pending <= 3, `queued scans must stay bounded, got ${pending}`);
});

// A short portfolio has no 8-word sentence, and that used to end discovery with
// "no distinctive text sentences" even though the page was read fine.
test('short marketing copy still yields a search query', () => {
  const pages = [{ text_content: 'Bittu Builds. Website design and automation. Good work should feel easy. Discuss your website.' }];
  const picked = discover.pickSearchSentences(pages, []);
  assert.ok(picked.length >= 1, 'a relaxed tier must find something to search for');
});

// "Completed" with no site to compare used to be silent, and the progress screen then
// showed a placeholder "queued" with nothing behind it. The row now says why.
test('a completed discovery that kept nothing records the reason', async () => {
  await ready();
  const c = client();
  const wsId = await makeAccount(c);
  const site = await c(`/workspaces/${wsId}/websites`, { method: 'POST', body: { url: 'http://127.0.0.1:1/', kind: 'original', auto_scan: false } });
  const origId = site.data.website.id;
  const orig = db.prepare('SELECT * FROM websites WHERE id=?').get(origId);
  db.prepare(`INSERT INTO pages (id, website_id, workspace_id, url, submitted_url, canonical_url, title, text_content, meta_description, content_hash, http_status, fetched_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(newId('pg'), origId, wsId, 'http://127.0.0.1:1/', orig.submitted_url, null, 'Home',
         'Our platform helps modern logistics teams coordinate warehouse operations across every facility in real time with predictive arrival windows.',
         null, 'h1', 200, utcNow());

  const run = async (urls) => {
    const id = newId('dsc');
    db.prepare(`INSERT INTO discoveries (id, workspace_id, original_website_id, status, created_by, created_at, updated_at)
                VALUES (?,?,?, 'queued', ?, ?, ?)`).run(id, wsId, origId, null, utcNow(), utcNow());
    await discover.runDiscovery(id, { searchFn: async () => urls });
    return db.prepare('SELECT status, error, created_scan_count FROM discoveries WHERE id=?').get(id);
  };

  const empty = await run([]);
  assert.equal(empty.status, 'completed');
  assert.match(empty.error, /no results/i);

  const ownOnly = await run(['https://facebook.com/spam']);
  assert.equal(ownOnly.status, 'completed');
  assert.match(ownOnly.error, /none were kept/i);
});

// The caps are only useful if old rows cannot lock them shut. Earlier builds added up
// to six sites per run, so a workspace could carry dozens and then sit at a budget of
// zero: every run "completed" and added nothing, which is what the screen showed.
test('a pile of auto-discovered sites is trimmed to the cap', async () => {
  await ready();
  const c = client();
  const wsId = await makeAccount(c);
  const site = await c(`/workspaces/${wsId}/websites`, { method: 'POST', body: { url: 'http://127.0.0.1:1/', kind: 'original', auto_scan: false } });
  const origId = site.data.website.id;
  const orig = db.prepare('SELECT * FROM websites WHERE id=?').get(origId);

  for (let i = 0; i < 12; i++) {
    db.prepare(`INSERT INTO websites (id, workspace_id, kind, submitted_url, normalized_domain, label, status, crawl_status, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(newId('web'), wsId, 'comparison', `https://pile-${i}.test/`, `pile-${i}.test`,
           'Found by auto-discovery', 'active', 'crawled', utcNow(), utcNow());
  }
  const before = db.prepare(`SELECT COUNT(*) c FROM websites WHERE workspace_id=? AND label='Found by auto-discovery' AND archived_at IS NULL`).get(wsId).c;
  assert.equal(before, 12);

  const { archived } = discover.trimAutoDiscovered(wsId);
  assert.equal(archived, 12 - discover.MAX_DISCOVERED_TOTAL);
  const after = db.prepare(`SELECT COUNT(*) c FROM websites WHERE workspace_id=? AND label='Found by auto-discovery' AND archived_at IS NULL`).get(wsId).c;
  assert.equal(after, discover.MAX_DISCOVERED_TOTAL, 'the cap is restored instead of staying stuck');
});

test('discovered sites that never got a scan are given one on the next run', async () => {
  await ready();
  const c = client();
  const wsId = await makeAccount(c);
  const site = await c(`/workspaces/${wsId}/websites`, { method: 'POST', body: { url: 'http://127.0.0.1:1/', kind: 'original', auto_scan: false } });
  const origId = site.data.website.id;
  const orig = db.prepare('SELECT * FROM websites WHERE id=?').get(origId);
  db.prepare(`INSERT INTO pages (id, website_id, workspace_id, url, submitted_url, canonical_url, title, text_content, meta_description, content_hash, http_status, fetched_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(newId('pg'), origId, wsId, 'http://127.0.0.1:1/', orig.submitted_url, null, 'Home',
         'Our platform helps modern logistics teams coordinate warehouse operations across every facility in real time with predictive arrival windows.',
         null, 'h1', 200, utcNow());

  // Registered by an earlier run, but no scan row was ever created for it.
  const stranded = newId('web');
  db.prepare(`INSERT INTO websites (id, workspace_id, kind, submitted_url, normalized_domain, label, status, crawl_status, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(stranded, wsId, 'comparison', 'https://stranded.test/', 'stranded.test',
         'Found by auto-discovery', 'active', 'not_crawled', utcNow(), utcNow());

  const id = newId('dsc');
  db.prepare(`INSERT INTO discoveries (id, workspace_id, original_website_id, status, created_by, created_at, updated_at)
              VALUES (?,?,?, 'queued', ?, ?, ?)`).run(id, wsId, origId, null, utcNow(), utcNow());
  await discover.runDiscovery(id, { searchFn: async () => [] });

  const row = db.prepare(`SELECT id FROM scans WHERE workspace_id=? AND comparison_website_id=?`).get(wsId, stranded);
  assert.ok(row, 'the stranded site finally gets the scan it was promised');
  const d = db.prepare('SELECT status, error, created_scan_count FROM discoveries WHERE id=?').get(id);
  assert.equal(d.status, 'completed');
  assert.ok(d.created_scan_count >= 1);
});

// A comparison registered but never scanned is the exact state a restart leaves
// behind. The progress screen must start that scan on its own, not sit on "queued".
test('the progress poll starts a scan when a comparison exists but nothing is running', async () => {
  await ready();
  const c = client();
  const wsId = await makeAccount(c);
  const site = await c(`/workspaces/${wsId}/websites`, { method: 'POST', body: { url: 'http://127.0.0.1:1/', kind: 'original', auto_scan: false } });
  const origId = site.data.website.id;

  // An earlier scan that compared nothing must not block (it is not an answer).
  const comp = newId('web');
  db.prepare(`INSERT INTO websites (id, workspace_id, kind, submitted_url, normalized_domain, label, status, crawl_status, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(comp, wsId, 'comparison', 'https://known-copy.test/', 'known-copy.test', null, 'active', 'crawled', utcNow(), utcNow());
  db.prepare(`INSERT INTO scans (id, workspace_id, original_website_id, comparison_website_id, status, params, pages_compared, findings, created_by, created_at, finished_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(newId('scn'), wsId, origId, comp, 'completed', '{}', 0, 0, null, utcNow(), utcNow());

  const res = await c(`/workspaces/${wsId}/websites/${origId}/initial-scan`);
  assert.equal(res.status, 200);
  const scan = res.data.scan;
  assert.ok(scan, 'a scan row is reported');
  assert.ok(['queued', 'running'].includes(scan.status), `a new scan started, got ${scan.status}`);
  assert.notEqual(scan.pages_compared, 0, 'the empty earlier scan is not the one being reported');
});

// A comparison that cannot be crawled must not be retried on every poll forever.
test('the poll stops starting scans after three automatic attempts in an hour', async () => {
  await ready();
  const c = client();
  const wsId = await makeAccount(c);
  const site = await c(`/workspaces/${wsId}/websites`, { method: 'POST', body: { url: 'http://127.0.0.1:1/', kind: 'original', auto_scan: false } });
  const origId = site.data.website.id;
  const comp = newId('web');
  db.prepare(`INSERT INTO websites (id, workspace_id, kind, submitted_url, normalized_domain, label, status, crawl_status, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(comp, wsId, 'comparison', 'https://dead-copy.test/', 'dead-copy.test', null, 'active', 'crawled', utcNow(), utcNow());
  for (let i = 0; i < 3; i++) {
    db.prepare(`INSERT INTO scans (id, workspace_id, original_website_id, comparison_website_id, status, params, pages_compared, findings, created_by, created_at, finished_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(newId('scn'), wsId, origId, comp, 'completed', '{}', 0, 0, null, utcNow(), utcNow());
  }
  const before = db.prepare('SELECT COUNT(*) c FROM scans WHERE workspace_id=?').get(wsId).c;
  await c(`/workspaces/${wsId}/websites/${origId}/initial-scan`);
  const after = db.prepare('SELECT COUNT(*) c FROM scans WHERE workspace_id=?').get(wsId).c;
  assert.equal(after, before, 'no fourth automatic scan is created');
});
