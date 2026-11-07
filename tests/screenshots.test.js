'use strict';
// Phase 4 screenshot capture.
//
// No real browser anywhere in this file. The Playwright adapter is replaced by a
// fake provider with the same shape, so success, timeout, crash, deduplication and
// storage failure are all deterministic. A separate smoke test (see docs) can be run
// by hand where Chromium exists.

process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.DATABASE_FILE = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'shield-shot-')) + '/test.db';
process.env.AUTH_RATE_LIMIT = '1000';
process.env.COOKIE_SECURE = 'false';
process.env.SHOT_ENABLED = 'true';
process.env.SHOT_STORAGE = 'memory';
process.env.SHOT_CONCURRENCY = '1';
process.env.SHOT_TIMEOUT_MS = '500';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { server } = require('../src/server');
const db = require('../src/db/index');
const capture = require('../src/screenshots/capture');
const shotStore = require('../src/screenshots/store');
const shotBrowser = require('../src/screenshots/browser');
const { createStorage, getStorage, resetStorageCache, keyFor } = require('../src/storage');
const config = require('../src/config');
const { newId, utcNow } = require('../src/util');

let BASE = null;
async function ready() {
  if (BASE) return;
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  server.unref();
  BASE = `http://127.0.0.1:${server.address().port}/api`;
}

function client() {
  let cookie = null;
  return {
    async req(method, path) {
      await ready();
      const res = await fetch(BASE + path, {
        method,
        headers: { ...(cookie ? { cookie } : {}) }
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const type = res.headers.get('content-type') || '';
      const data = type.includes('image/png') ? Buffer.from(await res.arrayBuffer()) : await res.json().catch(() => null);
      return { status: res.status, data, headers: res.headers };
    }
  };
}

// --- fixtures --------------------------------------------------------------

const WS = 'ws_shot';
function seedWorkspace(id = WS) {
  if (!db.prepare('SELECT id FROM workspaces WHERE id=?').get(id)) {
    db.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)').run(id, id, utcNow());
  }
  return id;
}

let n = 0;
function seedCompetitor(workspaceId = WS) {
  seedWorkspace(workspaceId);
  n += 1;
  const id = newId('cmp');
  const now = utcNow();
  db.prepare(`INSERT INTO competitors (id, workspace_id, domain, site_url, name, status, discovered_at, created_at)
      VALUES (?,?,?,?,?, 'verified', ?, ?)`)
    .run(id, workspaceId, `shot-${n}.test`, `https://shot-${n}.test/`, `shot-${n}`, now, now);
  return id;
}

function pagesFixture() {
  return [
    { page_id: 'pg_home', url: 'https://shot.test/', page_type: 'homepage' },
    { page_id: 'pg_price', url: 'https://shot.test/pricing', page_type: 'pricing' },
    { page_id: 'pg_prod', url: 'https://shot.test/product', page_type: 'product' },
    { page_id: 'pg_feat', url: 'https://shot.test/features', page_type: 'features' },
    { page_id: 'pg_blog', url: 'https://shot.test/blog', page_type: 'blog' },
    { page_id: 'pg_about', url: 'https://shot.test/about', page_type: 'docs' }
  ];
}

// A fake browser: `behaviour(url)` decides what happens, `bytes` decides the image.
function fakeProvider({ behaviour = (url) => ({ bytes: Buffer.from(`image:${url}`) }), cap = null, openError = null, onCapture = null } = {}) {
  const state = { captures: 0, inFlight: 0, maxInFlight: 0, closed: 0 };
  return {
    name: 'fake',
    state,
    capability() {
      return cap || { available: true, engine: 'fake', version: '0.0.0', reason: null };
    },
    async open() {
      if (openError) throw openError;
      return {
        async close() { state.closed += 1; }
      };
    },
    async capture(session, opts) {
      state.captures += 1;
      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      try {
        if (onCapture) onCapture(opts);
        const result = behaviour(opts.url);
        if (result && result.hang) {
          await new Promise((r) => setTimeout(r, result.hang));
        }
        if (result && result.error) throw result.error;
        if (result && result.rejectAfter !== undefined) {
          await new Promise((r) => setTimeout(r, result.rejectAfter));
        }
        const buffer = (result && result.bytes) || Buffer.from(`image:${opts.url}`);
        return {
          buffer,
          width: (result && result.width) || config.screenshots.viewport.width,
          height: (result && result.height) || config.screenshots.viewport.height,
          durationMs: 12,
          finalUrl: opts.url
        };
      } finally {
        state.inFlight -= 1;
      }
    }
  };
}

const settings = () => ({ ...config.screenshots, timeoutMs: 200, maxPerCompetitor: 4, concurrency: 1 });

async function captureWith(competitorId, provider, overrides = {}) {
  return capture.captureFor({
    workspaceId: WS,
    competitorId,
    pages: pagesFixture(),
    settings: { ...settings(), ...(overrides.settings || {}) },
    storage: overrides.storage || createStorage({ provider: 'memory' }),
    provider,
    enabled: true
  });
}

// --- 1. success ------------------------------------------------------------

test('captures one screenshot per supported page type and stores metadata', async () => {
  const competitorId = seedCompetitor();
  const storage = createStorage({ provider: 'memory' });
  const provider = fakeProvider();
  const result = await captureWith(competitorId, provider, { storage });

  // homepage, pricing, product, features. blog/docs are not supported targets.
  assert.equal(result.targets, 4);
  assert.equal(result.captured, 4);
  assert.equal(result.failed, 0);
  assert.equal(provider.state.captures, 4);
  assert.equal(provider.state.closed, 1, 'the browser is closed once, at the end');

  const rows = shotStore.screenshotsFor({ workspaceId: WS, competitorId });
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.equal(row.status, 'captured');
    assert.match(row.url, /^https:\/\/shot\.test/);
    assert.ok(['homepage', 'pricing', 'product', 'features'].includes(row.page_type));
    assert.ok(row.captured_at, 'capture timestamp');
    assert.match(row.content_hash, /^[a-f0-9]{64}$/, 'content hash of the image bytes');
    assert.equal(row.storage_provider, 'memory');
    assert.ok(row.storage_key, 'storage reference');
    assert.equal(row.bytes, Buffer.from(`image:${row.url}`).length);
    assert.ok(row.width > 0 && row.height > 0);
    assert.ok(row.duration_ms >= 0);
    assert.ok(row.page_id, 'linked to the collected page');
  }

  // The bytes really are behind the reference.
  const one = rows.find((r) => r.page_type === 'pricing');
  const blob = await storage.get(one.storage_key);
  assert.equal(blob.buffer.toString(), `image:${one.url}`);

  // Screenshot metadata is part of the versioned evidence model.
  const evidence = db.prepare("SELECT * FROM competitor_evidence WHERE competitor_id=? AND evidence_type='screenshot' ORDER BY identity_key")
    .all(competitorId);
  assert.equal(evidence.length, 4);
  assert.ok(evidence.every((e) => e.superseded_at === null));
  assert.match(evidence[0].excerpt, /screenshot of .* page https:\/\/shot\.test/);
});

// --- 2. timeout ------------------------------------------------------------

test('a slow page times out without stopping the other captures', async () => {
  const competitorId = seedCompetitor();
  const provider = fakeProvider({
    behaviour: (url) => (url.includes('/pricing') ? { hang: 2000 } : { bytes: Buffer.from(`img:${url}`) })
  });
  const started = Date.now();
  const result = await captureWith(competitorId, provider, { settings: { timeoutMs: 150 } });
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 1500, `capture returned promptly (${elapsed}ms)`);
  assert.equal(result.targets, 4);
  assert.equal(result.failed, 1);
  assert.equal(result.captured, 3);

  const failed = shotStore.screenshotsFor({ workspaceId: WS, competitorId }).filter((r) => r.status === 'failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].page_type, 'pricing');
  assert.match(failed[0].reason, /SHOT_TIMEOUT/);
  assert.equal(provider.state.closed, 1, 'the browser is still closed after a timeout');
});

test('the timeout is enforced by the provider adapter too, not only the pool', async () => {
  const provider = fakeProvider({ behaviour: () => ({ hang: 300 }) });
  // Call the adapter's own race guard directly: the pool guard is covered above.
  await assert.rejects(
    () => shotBrowser.withTimeout(new Promise((r) => setTimeout(r, 300)), 50),
    (e) => e.code === 'SHOT_TIMEOUT'
  );
  assert.ok(provider);
});

// --- 3. failure ------------------------------------------------------------

test('a navigation failure is recorded and does not stop the run', async () => {
  const competitorId = seedCompetitor();
  const provider = fakeProvider({
    behaviour: (url) => (url.includes('/product')
      ? { error: Object.assign(new Error('net::ERR_NAME_NOT_RESOLVED'), { code: 'SHOT_FAILED' }) }
      : { bytes: Buffer.from(`img:${url}`) })
  });
  const result = await captureWith(competitorId, provider);
  assert.equal(result.captured, 3);
  assert.equal(result.failed, 1);
  const row = shotStore.screenshotsFor({ workspaceId: WS, competitorId }).find((r) => r.page_type === 'product');
  assert.equal(row.status, 'failed');
  assert.match(row.reason, /SHOT_FAILED/);
  assert.equal(row.storage_key, null, 'a failed capture stores no image reference');
  assert.equal(row.content_hash, null);
});

test('a browser that cannot launch marks every target unavailable and never throws', async () => {
  const competitorId = seedCompetitor();
  const provider = fakeProvider({ openError: Object.assign(new Error('chromium missing'), { code: 'SHOT_BROWSER_UNAVAILABLE' }) });
  const result = await captureWith(competitorId, provider);
  assert.equal(result.reason, 'browser_unavailable');
  assert.equal(result.unavailable, 4);
  assert.equal(result.captured, 0);
  const rows = shotStore.screenshotsFor({ workspaceId: WS, competitorId });
  assert.equal(rows.length, 4);
  assert.ok(rows.every((r) => r.status === 'unavailable'));
  assert.ok(rows.every((r) => /SHOT_BROWSER_UNAVAILABLE/.test(r.reason)));
});

test('a host without playwright reports unavailable instead of failing', async () => {
  const competitorId = seedCompetitor();
  const noBrowser = {
    name: 'playwright',
    capability() { return { available: false, engine: 'playwright', reason: 'playwright is not installed on this host', hint: 'npm run screenshots:install' }; },
    async open() { throw new Error('should not be called'); }
  };
  const result = await captureWith(competitorId, noBrowser);
  assert.equal(result.reason, 'browser_unavailable');
  assert.equal(result.unavailable, 4);
  assert.equal(result.failed, 0);
  const rows = shotStore.screenshotsFor({ workspaceId: WS, competitorId });
  assert.ok(rows.every((r) => r.status === 'unavailable'));
  assert.ok(rows.every((r) => /npm run screenshots:install/.test(r.reason)));
});

// --- 4. deduplication ------------------------------------------------------

test('identical images are stored once and the second sighting is a duplicate', async () => {
  const competitorId = seedCompetitor();
  const storage = createStorage({ provider: 'memory' });
  const provider = fakeProvider();   // every page returns the same bytes

  const first = await captureWith(competitorId, provider, { storage });
  assert.equal(first.captured, 4);
  assert.equal(first.duplicates, 0);
  assert.equal(storage.stats().files, 4, 'one blob per distinct image');

  const second = await captureWith(competitorId, fakeProvider(), { storage });
  assert.equal(second.captured, 0);
  assert.equal(second.duplicates, 4);

  const rows = shotStore.screenshotsFor({ workspaceId: WS, competitorId });
  assert.equal(rows.length, 8, 'both sightings are recorded');
  const duplicates = rows.filter((r) => r.status === 'duplicate');
  assert.equal(duplicates.length, 4);
  for (const dup of duplicates) {
    const original = db.prepare('SELECT * FROM competitor_screenshots WHERE id=?').get(dup.duplicate_of);
    assert.ok(original, 'the duplicate points at a real row');
    assert.equal(original.status, 'captured');
    assert.equal(dup.content_hash, original.content_hash);
    assert.equal(dup.storage_key, original.storage_key, 'the stored image is reused, not rewritten');
  }
  // One blob per distinct image, not one per sighting: the second run added none.
  assert.equal(storage.stats().files, 4);
});

test('a changed image is a new capture, not a duplicate', async () => {
  const competitorId = seedCompetitor();
  const storage = createStorage({ provider: 'memory' });
  await captureWith(competitorId, fakeProvider(), { storage });
  const result = await captureWith(competitorId, fakeProvider({ behaviour: (url) => ({ bytes: Buffer.from(`new:${url}`) }) }), { storage });
  assert.equal(result.duplicates, 0);
  assert.equal(result.captured, 4);
  // Four old blobs plus four new ones: a changed image is genuinely stored again.
  assert.equal(storage.stats().files, 8);
});

test('deduplication is per competitor, never across competitors', async () => {
  const storage = createStorage({ provider: 'memory' });
  const a = seedCompetitor();
  const b = seedCompetitor();
  await captureWith(a, fakeProvider(), { storage });
  const result = await capture.captureFor({
    workspaceId: WS, competitorId: b, pages: pagesFixture(),
    settings: settings(), storage, provider: fakeProvider(), enabled: true
  });
  assert.equal(result.duplicates, 0, 'the same bytes for another competitor are its own screenshot');
  assert.equal(result.captured, 4);
});

// --- 5. storage errors -----------------------------------------------------

test('a storage write failure is recorded as failed, with no dangling reference', async () => {
  const competitorId = seedCompetitor();
  const broken = {
    provider: 'broken',
    describe() { return { provider: 'broken', durable: false }; },
    async put() { throw Object.assign(new Error('disk is read-only'), { code: 'STORAGE_WRITE_FAILED' }); },
    async get() { throw new Error('nope'); },
    async delete() { return true; }
  };
  const result = await captureWith(competitorId, fakeProvider(), { storage: broken });
  assert.equal(result.captured, 0);
  assert.equal(result.failed, 4);
  const rows = shotStore.screenshotsFor({ workspaceId: WS, competitorId });
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.equal(row.status, 'failed');
    assert.match(row.reason, /STORAGE_ERROR/);
    assert.equal(row.storage_key, null);
    assert.ok(row.content_hash, 'the hash is kept so the failure is diagnosable');
  }
});

test('an unknown storage provider is reported, not thrown', async () => {
  const competitorId = seedCompetitor();
  const result = await capture.captureFor({
    workspaceId: WS, competitorId, pages: pagesFixture(),
    settings: { ...settings(), storageProvider: 's3-paid' },
    storage: null, provider: fakeProvider(), enabled: true
  });
  assert.equal(result.reason, 'storage_unavailable');
  assert.equal(result.unavailable, 4);
});

test('local storage writes to disk and refuses keys that escape its root', async () => {
  const dir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'shot-store-'));
  const storage = createStorage({ provider: 'local', dir });
  const key = keyFor({ workspaceId: 'ws_1', competitorId: 'cmp_1', contentHash: 'abc123' });
  const put = await storage.put({ key, buffer: Buffer.from('png-bytes') });
  assert.equal(put.key, key);
  assert.equal((await storage.get(key)).buffer.toString(), 'png-bytes');
  assert.equal(await storage.exists(key), true);
  assert.equal(await storage.delete(key), true);
  assert.equal(await storage.exists(key), false);
  await assert.rejects(() => storage.put({ key: '../../etc/passwd', buffer: Buffer.from('x') }), /invalid storage key/);
  await assert.rejects(() => storage.put({ key: '/abs/path.png', buffer: Buffer.from('x') }), /invalid storage key/);
  assert.match(storage.describe().warning, /not durable production storage/i);
});

// --- 6. bounded concurrency -------------------------------------------------

test('captures never exceed the configured concurrency', async () => {
  const competitorId = seedCompetitor();
  const provider = fakeProvider({ behaviour: (url) => ({ bytes: Buffer.from(`x:${url}`), rejectAfter: 30 }) });
  const result = await captureWith(competitorId, provider, { settings: { concurrency: 2 } });
  assert.equal(result.captured, 4);
  assert.ok(provider.state.maxInFlight <= 2, `max in flight was ${provider.state.maxInFlight}`);
  assert.equal(provider.state.maxInFlight, 2, 'the pool actually uses the parallelism it is given');
});

test('the page cap is respected', async () => {
  const competitorId = seedCompetitor();
  const provider = fakeProvider();
  const result = await captureWith(competitorId, provider, { settings: { maxPerCompetitor: 2 } });
  assert.equal(result.targets, 2);
  assert.equal(provider.state.captures, 2);
});

// --- 7. capture must never break text crawling ------------------------------

test('a capture layer that explodes leaves text collection untouched', async () => {
  const collect = require('../src/competitor/collect');
  const dbmod = require('../src/db/index');
  const now = utcNow();
  const ws = 'ws_shot_text';
  seedWorkspace(ws);
  const site = newId('web');
  dbmod.prepare(`INSERT INTO websites (id, workspace_id, kind, submitted_url, normalized_domain, status, crawl_status, accessible_page_count, created_at, updated_at)
      VALUES (?,?, 'original', 'https://origin.test/', 'origin.test', 'active', 'crawled', 1, ?, ?)`).run(site, ws, now, now);
  const competitorId = seedCompetitor(ws);
  db.prepare('UPDATE competitors SET website_id=? WHERE id=?').run(site, competitorId);

  const html = '<html><head><title>Home</title></head><body>'
    + '<p>Pricing starts at $29 per month for our starter plan with 3 seats.</p>'
    + '<a href="/pricing">Pricing</a><a href="/features">Features</a></body></html>';
  const fetchPage = async (url) => ({
    url, finalUrl: url, status: 200, html,
    text: 'Pricing starts at $29 per month for our starter plan with 3 seats.',
    title: 'Home', contentHash: 'h1'
  });

  const result = await collect.collectCompetitor({
    workspaceId: ws, competitorId, fetchPage, useSitemaps: false, maxPages: 2,
    screenshotOptions: {
      enabled: true,
      captureImpl: async () => { throw new Error('capture subsystem is on fire'); }
    }
  });
  assert.equal(result.ok, true, 'the crawl still succeeded');
  assert.ok(result.pages_ok >= 1, 'text pages were still collected');
  assert.equal(result.screenshots.enabled, true);
  assert.equal(result.screenshots.reason, 'capture_error');
  assert.match(result.screenshots.error, /on fire/);
  assert.equal(result.screenshots.analysis, 'none: screenshots are stored, never interpreted');
});

test('screenshots are off by default, so a host without a browser pays nothing', async () => {
  const competitorId = seedCompetitor();
  const result = await capture.captureFor({
    workspaceId: WS, competitorId, pages: pagesFixture(),
    settings: settings(), enabled: false
  });
  assert.equal(result.enabled, false);
  assert.equal(result.reason, 'screenshots_disabled');
  assert.equal(shotStore.screenshotsFor({ workspaceId: WS, competitorId }).length, 0);
});

// --- 8. API -----------------------------------------------------------------

let owner;
let stranger;
async function signup(email, name) {
  const c = client();
  const res = await fetch(`${BASE || ''}/auth/signup`, { method: 'POST' });
  void res;
  return c;
}

test('screenshot API lists metadata, streams the image and flags non-durable storage', async () => {
  await ready();
  const c = client();
  const signupRes = await fetch(`${BASE}/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'shot-owner@example.test', password: 'longpassword1', workspace_name: 'Shots' })
  });
  const setCookie = signupRes.headers.get('set-cookie');
  assert.equal(signupRes.status, 201);
  const cookie = setCookie.split(';')[0];
  const authed = {
    async get(path) {
      const res = await fetch(BASE + path, { headers: { cookie } });
      const type = res.headers.get('content-type') || '';
      const data = type.includes('image/png') ? Buffer.from(await res.arrayBuffer()) : await res.json().catch(() => null);
      return { status: res.status, data, headers: res.headers };
    }
  };
  const wsId = (await signupRes.json()).workspace.id;

  const competitorId = seedCompetitor(wsId);
  const result = await capture.captureFor({
    workspaceId: wsId, competitorId, pages: pagesFixture(),
    settings: settings(), storage: resetStorageCache() || getStorage({ provider: 'memory' }),
    provider: fakeProvider(), enabled: true
  });
  assert.equal(result.captured, 4);

  const list = await authed.get(`/workspaces/${wsId}/competitors/${competitorId}/screenshots`);
  assert.equal(list.status, 200);
  assert.equal(list.data.screenshots.length, 4);
  assert.equal(list.data.durability.durable, false);
  assert.match(list.data.durability.warning, /not durable|never durable/i);
  assert.equal(list.data.analysis.supports_image_input, false, 'the API never claims vision');
  assert.equal(list.data.analysis.tested, false);
  assert.equal(list.data.summary.captured, 4);

  const shotId = list.data.screenshots[0].id;
  const image = await authed.get(`/workspaces/${wsId}/competitors/${competitorId}/screenshots/${shotId}/image`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.ok(image.data.length > 0);

  const capability = await authed.get(`/workspaces/${wsId}/screenshots/capability`);
  assert.equal(capability.status, 200);
  assert.equal(capability.data.analysis.supports_image_input, false);
  assert.equal(capability.data.storage.durable, false);
  assert.equal(capability.data.limits.concurrency > 0, true);
});

test('screenshots are workspace isolated', async () => {
  await ready();
  const other = client();
  const res = await fetch(`${BASE}/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'shot-stranger@example.test', password: 'longpassword1', workspace_name: 'Stranger' })
  });
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  const theirWs = (await res.json()).workspace.id;
  assert.ok(cookie && other);

  const mine = seedCompetitor(WS);
  const list = await fetch(`${BASE}/workspaces/${theirWs}/competitors/${mine}/screenshots`, { headers: { cookie } });
  assert.equal(list.status, 404, 'a competitor from another workspace is not visible');
  const cap = await fetch(`${BASE}/workspaces/${theirWs}/screenshots/capability`, { headers: { cookie } });
  assert.equal(cap.status, 200, 'the capability endpoint still answers');
  assert.equal((await cap.json()).analysis.supports_image_input, false);
  const image = await fetch(`${BASE}/workspaces/${theirWs}/competitors/${mine}/screenshots/shot_x/image`, { headers: { cookie } });
  assert.equal(image.status, 404);
});
