'use strict';
// End-to-end integration: one workspace, one competitor, the whole pipeline.
//
//   website added -> discovery & scoring -> page collection -> features ->
//   pricing -> evidence (URL + timestamp) -> duplicate sighting -> versioned
//   change -> freshness -> screenshots -> incremental AI -> citation validation
//   -> synthesis -> report -> PDF -> historical report versions
//
// Everything external is a deterministic fixture: the search provider, the page
// fetcher and the browser are replaced, and the AI provider is the mock responder.
// No live website is contacted and no AI quota is spent.
//
// Two seams are used deliberately rather than writing new production code:
//   * `app.locals.competitorFetcher`, the existing test hook on the collect route;
//   * module-level stubs for `searchWeb`, `enqueueScan` and the browser provider,
//     which the route layer calls through the module object at request time.
// The discovery *route* cannot be used offline because `src/discover.js`
// destructures `searchWeb` at load, so the row is created over HTTP and
// `runDiscovery` is called with its documented `searchFn` injection.

process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.DATABASE_FILE = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'shield-e2e-')) + '/test.db';
process.env.AUTH_RATE_LIMIT = '1000';
process.env.CINT_COLLECT_RATE_LIMIT = '1000';
process.env.COOKIE_SECURE = 'false';
process.env.AUTH_REQUIRE_EMAIL_VERIFICATION = 'false';
process.env.AI_PROVIDER = 'mock';
process.env.AI_API_KEY = '';
process.env.GROQ_API_KEY = '';
process.env.AI_MIN_PAGE_CHARS = '20';
process.env.AI_ANALYSE_RATE_LIMIT = '1000';
process.env.SHOT_ENABLED = 'true';
process.env.SHOT_STORAGE = 'memory';
process.env.SHOT_CONCURRENCY = '1';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { server } = require('../src/server');
const db = require('../src/db/index');
const provider = require('../src/ai/provider');
const crawler = require('../src/crawler');
const scanner = require('../src/scanner');
const discover = require('../src/discover');
const browserAdapter = require('../src/screenshots/browser');
const { newId, utcNow } = require('../src/util');

// --- harness ---------------------------------------------------------------

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
    async req(method, path, body, extraHeaders = {}) {
      await ready();
      const res = await fetch(BASE + path, {
        method,
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(cookie ? { cookie } : {}),
          ...extraHeaders
        },
        body: body ? JSON.stringify(body) : undefined
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const type = res.headers.get('content-type') || '';
      if (type.includes('application/pdf')) {
        return { status: res.status, data: Buffer.from(await res.arrayBuffer()), headers: res.headers };
      }
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, data, headers: res.headers };
    }
  };
}

// --- the fake web ----------------------------------------------------------
// A mutable map of URL -> HTML. `setPage` lets a test change what a page says, which
// is how a pricing change is simulated without touching a real site.

const site = 'fixture-acme.test';
const web = new Map();
const ORIGINAL = 'fixture-origin.test';

function page({ title, h1, body }) {
  return `<!doctype html><html><head><title>${title}</title>
    <meta name="description" content="${body.slice(0, 120)}"></head>
    <body><h1>${h1}</h1>${body}
    <nav><a href="/pricing">Pricing</a><a href="/features">Features</a>
    <a href="/product">Product</a><a href="/docs">Docs</a><a href="/about">About</a>
    <a href="/blog">Blog</a></nav></body></html>`;
}

function seedWeb({ price = '$39' } = {}) {
  web.clear();
  web.set(`https://${site}/`, page({
    title: 'Acme competitor monitoring',
    h1: 'Competitor monitoring for product teams',
    body: '<p>Acme does competitor monitoring and content change detection for product teams. '
      + 'We track competitor pricing pages and feature launches with alerts and weekly digests.</p>'
  }));
  // A real pricing page is headings and price lines, which is what the extractor
  // reads. Flattening them into one sentence is not a pricing page.
  web.set(`https://${site}/pricing`, page({
    title: 'Acme pricing for competitor monitoring',
    h1: 'Competitor monitoring pricing',
    body: '<p>Competitor monitoring and content change detection for product teams, priced simply.</p>'
      + '<h2>Starter</h2><p>' + price + ' per month</p><p>3 projects and 10 tracked pages.</p>'
      + '<h2>Growth</h2><p>$99 per month</p><p>Unlimited projects and weekly alert digests.</p>'
      + '<h2>Enterprise</h2><p>Contact us for custom pricing.</p>'
      + '<p>All prices in USD.</p>'
  }));
  web.set(`https://${site}/features`, page({
    title: 'Acme features for competitor monitoring',
    h1: 'Competitor monitoring features',
    body: '<h2>Competitor monitoring</h2><p>We track competitor pricing pages and alert product teams.</p>'
      + '<h2>Content change detection</h2><p>Detects new features on competitor product pages.</p>'
      + '<h2>Alert digests</h2><p>Weekly email summaries of competitor changes and feature launches.</p>'
  }));
  web.set(`https://${site}/product`, page({
    title: 'Acme product',
    h1: 'Competitor monitoring workspace',
    body: '<p>A workspace for product teams to compare competitors, pricing pages and feature launches.</p>'
  }));
  web.set(`https://${site}/docs`, page({
    title: 'Acme Docs', h1: 'Documentation',
    body: '<p>Tracked pages are crawled weekly; alerts fire on diff.</p>'
  }));
  web.set(`https://${site}/about`, page({
    title: 'About Acme', h1: 'About',
    body: '<p>Acme is a small team building competitor intelligence tools for SaaS.</p>'
  }));
  // A reachable but irrelevant result: it must be scored and rejected on content,
  // not mistaken for a competitor just because it ranked.
  web.set('https://unrelated-bakery.test/cakes', page({
    title: 'Cakes by Dana',
    h1: 'Celebration cakes',
    body: '<p>Buttercream celebration cakes, wedding cakes and cupcake orders for local delivery.</p>'
  }));
  web.set(`https://${site}/blog`, page({
    title: 'Acme blog', h1: 'Blog',
    body: '<p>How we think about pricing changes in SaaS markets.</p>'
  }));
}

function fixtureFetch(rawUrl) {
  const url = String(rawUrl).replace(/\/$/, '') || rawUrl;
  const html = web.get(url) || web.get(`${url}/`) || web.get(url.replace(/\/$/, ''));
  if (!html) {
    const err = new Error(`no fixture for ${url}`);
    err.code = 'NETWORK';
    throw err;
  }
  return Promise.resolve({
    url, finalUrl: url, status: 200, html,
    headers: { 'content-type': 'text/html' },
    fetchedAt: utcNow()
  });
}

// --- AI mock ---------------------------------------------------------------

const OVERVIEW = {
  summary: 'Acme tracks competitor pricing and features for SaaS teams.',
  category: 'competitor-intelligence', use_case: 'pricing and feature tracking',
  audience: 'saas product teams', positioning: 'automated competitor monitoring',
  differentiators: ['pricing alerts'], unknowns: []
};
const SYNTH = {
  executive_summary: 'One competitor (Acme) was compared.',
  common_features: [{ feature: 'pricing monitoring', competitors: [site] }],
  unique_features: [{ feature: 'alert digests', competitor: site }],
  gaps: [], swot: [],
  recommendations: [{
    recommendation: 'Publish a free trial length',
    reason: 'the compared pricing page states no trial duration',
    supporting_competitors: [site], confidence: 0.6, limitations: 'one competitor'
  }]
};

let modelCalls = 0;
const callsByStage = Object.create(null);
let forgedCitationStage = null;

// The prompt lists the citable ids on one line ("Cite evidence using these ids
// exactly: ..."). The mock reads one of them, which is what a well-behaved model
// does; ids themselves are never invented by the test.
function firstEvidenceId(userPrompt) {
  const line = /cite evidence using these ids exactly:([^\n]*)/i.exec(userPrompt || '');
  if (!line) return null;
  const ids = line[1].match(/\b[a-z]{2,6}_[A-Za-z0-9_-]{6,}\b/g) || [];
  return ids.length ? ids[0] : null;
}

// The responder cites a real id parsed out of the prompt, so findings are valid.
// For one stage it deliberately cites a forged id instead, which must be dropped.
provider.setMockResponder(async ({ stage, user }) => {
  modelCalls += 1;
  callsByStage[stage] = (callsByStage[stage] || 0) + 1;
  const realId = firstEvidenceId(user);
  const forged = forgedCitationStage === stage;
  const ids = forged ? ['ev_forged_000000'] : (realId ? [realId] : []);

  if (stage === 'overview') {
    return { ...OVERVIEW, evidence_ids: ids };
  }
  if (stage === 'features') {
    return {
      features: [{ name: 'Pricing monitoring', category: 'monitoring', statement: 'Tracks competitor pricing pages', claim: 'explicit', confidence: 0.8, evidence_ids: ids }]
    };
  }
  if (stage === 'pricing') {
    const seen = /\$\s?(\d+)/.exec(user || '');
    const price = seen ? `$${seen[1]}` : '$39';
    return {
      plans: [{ name: 'Starter', price, interval: 'month', claim: 'explicit', confidence: 0.8, evidence_ids: ids }],
      has_free_tier: false, enterprise: true, model: 'subscription', unstated: []
    };
  }
  if (stage === 'positioning') {
    return {
      value_proposition: 'competitor intelligence without manual checks', audience: 'saas product teams',
      differentiators: ['pricing alerts'], messaging_patterns: ['simple'], claims_to_verify: [], evidence_ids: ids
    };
  }
  if (stage === 'synthesis') return SYNTH;
  return OVERVIEW;
});

// --- fixtures --------------------------------------------------------------

let owner;
let wsId;
let originalSiteId;
let competitorId;
let competitorWebsiteId;

function signupClient() { return client(); }

async function signup(email, workspaceName) {
  const c = signupClient();
  const res = await c.req('POST', '/auth/signup', { email, password: 'longpassword1', workspace_name: workspaceName });
  assert.equal(res.status, 201, `signup failed: ${JSON.stringify(res.data)}`);
  return { client: c, wsId: res.data.workspace.id };
}

before(async () => {
  seedWeb();
  // The route layer reads these through the module object at request time.
  server.locals = server.locals || {};
  server.locals.competitorFetcher = fixtureFetch;
  crawler.fetchPage = fixtureFetch;
  scanner.enqueueScan = () => ({ started: false, reason: 'test: scans are not run here' });
  discover.enqueueDiscovery = () => {};

  // Capture is part of the collect flow, so the browser stand-in has to be in
  // place from the first collection onwards.
  browserAdapter.playwrightProvider = () => ({
    name: 'fake-browser',
    capability: () => ({ available: true, engine: 'fake', version: '1.0.0', reason: null }),
    async open() { return { async close() {} }; },
    async capture(session, opts) {
      // The bytes encode the page, so a changed page is a changed image.
      const html = web.get(opts.url) || '';
      return {
        buffer: Buffer.from(`png:${opts.url}:${html.length}`),
        width: 1280, height: 900, durationMs: 5, finalUrl: opts.url
      };
    }
  });

  owner = await signup('e2e-owner@example.test', 'E2E Workspace');
  wsId = owner.wsId;
});

after(() => {
  provider.setMockResponder(null);
  delete server.locals.competitorFetcher;
});

// --- A. the flow -----------------------------------------------------------

test('1. a user adds their website', async () => {
  const res = await owner.client.req('POST', `/workspaces/${wsId}/websites`, {
    url: `https://${ORIGINAL}/`, kind: 'original', label: 'My product', auto_scan: false
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  originalSiteId = res.data.website.id;
  assert.equal(res.data.website.kind, 'original');

  // The original site's own crawl is pre-seeded: the crawler has its own suites and
  // this test is about what happens downstream of it.
  const now = utcNow();
  const pages = [
    ['/', 'SaaS Shield competitor monitoring', 'Competitor monitoring and content change detection for product teams. Track competitor pricing pages and feature launches with alerts and digests.'],
    ['/pricing', 'SaaS Shield pricing', 'SaaS Shield plans track competitor pricing pages and feature launches for product teams, with alerts and digests.']
  ];
  for (const [path, title, text] of pages) {
    db.prepare(`INSERT INTO pages (id, website_id, workspace_id, url, title, meta_description, text_content, content_hash, fetched_at)
        VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(newId('pag'), originalSiteId, wsId, `https://${ORIGINAL}${path}`, title, text.slice(0, 100), text,
        `h${path.length}`, now);
  }
  db.prepare("UPDATE websites SET crawl_status='crawled', status='active', accessible_page_count=2 WHERE id=?")
    .run(originalSiteId);
});

test('2. competitors are discovered and scored', async () => {
  // Discovery row over HTTP, run with the documented searchFn injection.
  const created = await owner.client.req('POST', `/workspaces/${wsId}/discover`, { original_website_id: originalSiteId });
  assert.equal(created.status, 202, JSON.stringify(created.data));
  const discoveryId = created.data.discovery.id;

  // One search response carrying every case the run must handle: a real
  // competitor, an irrelevant site and an unreachable one.
  const results = [
    `https://${site}/`,
    `https://${site}/pricing`,
    `https://${site}/features`,
    'https://unrelated-bakery.test/cakes',
    'https://unreachable-acme.test/pricing'
  ];
  await discover.runDiscovery(discoveryId, { searchFn: async () => results });

  const detail = await owner.client.req('GET', `/workspaces/${wsId}/discoveries/${discoveryId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.discovery.status, 'completed', JSON.stringify(detail.data.discovery));

  const list = await owner.client.req('GET', `/workspaces/${wsId}/competitors`);
  assert.equal(list.status, 200);
  const byDomain = new Map(list.data.competitors.map((c) => [c.domain, c]));

  const acme = byDomain.get(site);
  assert.ok(acme, `acme should be registered, got ${JSON.stringify([...byDomain.keys()])}`);
  assert.equal(acme.status, 'verified', `acme scored ${acme.relevance_score}: ${acme.status_reason}`);
  assert.ok(acme.relevance_score >= 60, 'a verified competitor clears the threshold');

  const bakery = byDomain.get('unrelated-bakery.test');
  assert.ok(bakery, 'the irrelevant candidate is recorded, not silently dropped');
  assert.equal(bakery.status, 'rejected');

  const dead = byDomain.get('unreachable-acme.test');
  assert.ok(dead);
  assert.equal(dead.status, 'unverifiable', 'a page that cannot be fetched claims nothing');

  competitorId = acme.id;
  // The list route reports what a human needs; the link to the crawlable website
  // row is read from storage.
  competitorWebsiteId = db.prepare('SELECT website_id FROM competitors WHERE id=?').get(acme.id).website_id;
});

test('3-6. pages, features, pricing and evidence are collected and stored with sources', async () => {
  const res = await owner.client.req('POST', `/workspaces/${wsId}/competitors/${competitorId}/collect`, {
    use_sitemaps: false
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.ok(res.data.pages_ok >= 4, `expected several pages, got ${res.data.pages_ok}`);
  assert.equal(res.data.status, 'completed');

  const intel = await owner.client.req('GET', `/workspaces/${wsId}/competitors/${competitorId}/intelligence`);
  assert.equal(intel.status, 200);
  const types = new Set(intel.data.pages.map((p) => p.page_type));
  for (const t of ['homepage', 'pricing', 'features', 'product']) {
    assert.ok(types.has(t), `expected a ${t} page, saw ${[...types].join(', ')}`);
  }
  for (const p of intel.data.pages) {
    assert.match(p.url, /^https:\/\//);
    assert.ok(p.fetched_at, 'every collected page carries a timestamp');
  }

  // 4. structured features
  assert.ok(intel.data.features.length >= 2, `expected features, got ${intel.data.features.length}`);
  for (const f of intel.data.features) {
    assert.ok(f.name, 'feature has a name');
    assert.ok(f.competitor_id === competitorId);
    assert.ok(f.source_url, 'feature has a source URL');
    assert.ok(f.page_type, 'feature has a page type');
    assert.ok(f.evidence_excerpt, 'feature has supporting evidence text');
    assert.ok(f.observed_at, 'feature has a timestamp');
    assert.ok(f.confidence !== null && f.confidence !== undefined, 'feature has confidence');
    assert.ok(['documented', 'marketing', 'inferred', 'unverified'].includes(f.claim_level),
      `unexpected claim level ${f.claim_level}`);
    assert.ok(f.verification_status, 'feature has a verification status');
  }
  const documented = intel.data.features.filter((f) => f.claim_level === 'documented');
  const marketing = intel.data.features.filter((f) => f.claim_level === 'marketing');
  assert.ok(documented.length + marketing.length >= 1, 'claims are classified, not lumped together');

  // 5. structured pricing
  const plans = intel.data.plans;
  assert.ok(plans.length >= 2, `expected plans, got ${plans.length}`);
  const starter = plans.find((p) => /starter/i.test(p.plan_name));
  assert.ok(starter, 'the Starter plan is extracted');
  assert.equal(starter.price_value, 39);
  assert.equal(starter.currency, null, 'a bare $ is ambiguous, so no currency is asserted');
  assert.equal(starter.currency_display, '$');
  assert.equal(starter.billing_interval, 'month');
  assert.equal(starter.price_display, '$39');
  assert.match(starter.original_text, /Starter[\s\S]*39/, 'the plan name and price are kept together as evidence');

  const enterprise = plans.find((p) => /enterprise/i.test(p.plan_name));
  assert.ok(enterprise, 'the enterprise tier is extracted');
  assert.equal(enterprise.price_value, null, 'a "contact us" price stays unknown');
  assert.ok(!enterprise.price_stated, 'an unstated price is flagged as unstated');
  assert.equal(enterprise.enterprise_custom, 1);

  // no plan invents a currency, and no currency is converted
  for (const p of plans) {
    // A stated price always carries either a currency code or the symbol it was
    // printed with. "$" alone stays ambiguous by design and is never guessed.
    if (p.price_value !== null) {
      assert.ok(p.currency || p.currency_display, `priced plan ${p.plan_name} must keep its printed currency`);
    }
    assert.ok(!/converted/i.test(String(p.original_text)), 'no plan text claims a conversion');
  }

  // 6. evidence with source URLs and timestamps
  const evidence = await owner.client.req('GET', `/workspaces/${wsId}/competitors/${competitorId}/evidence`);
  assert.equal(evidence.status, 200);
  assert.ok(evidence.data.current.length >= 3);
  for (const e of evidence.data.current) {
    assert.ok(e.source_url, 'evidence carries its source URL');
    assert.ok(e.observed_at, 'evidence carries a timestamp');
    assert.ok(e.excerpt, 'evidence carries its excerpt');
  }
});

test('7. duplicate evidence is one record, not two', async () => {
  const before = db.prepare(`SELECT id, last_seen_at, observations, version FROM competitor_evidence
      WHERE workspace_id=? AND competitor_id=? AND evidence_type='pricing_plan'`).all(wsId, competitorId);
  assert.ok(before.length > 0);

  const again = await owner.client.req('POST', `/workspaces/${wsId}/competitors/${competitorId}/collect`, {
    use_sitemaps: false
  });
  assert.equal(again.status, 200);

  const after = db.prepare(`SELECT id, last_seen_at, observations, version FROM competitor_evidence
      WHERE workspace_id=? AND competitor_id=? AND evidence_type='pricing_plan'`).all(wsId, competitorId);
  assert.equal(after.length, before.length, 'an identical sighting creates no new evidence row');
  for (const row of after) {
    const prior = before.find((b) => b.id === row.id);
    assert.ok(prior, 'the same rows are still current');
    assert.ok(row.observations >= prior.observations, 'the sighting is counted');
    assert.equal(row.version, prior.version === undefined ? row.version : prior.version);
  }

  // Screenshots of identical pages are deduplicated too (asserted in full below).
  const shots = await owner.client.req('GET', `/workspaces/${wsId}/competitors/${competitorId}/screenshots`);
  assert.equal(shots.status, 200);
  assert.equal(shots.data.summary.failed, 0);
});

test('8. changed pricing creates a new evidence version and keeps the old one', async () => {
  const original = db.prepare(`SELECT * FROM competitor_evidence
      WHERE workspace_id=? AND competitor_id=? AND evidence_type='pricing_plan'
        AND identity_key LIKE '%starter%' AND superseded_at IS NULL`).get(wsId, competitorId);
  assert.ok(original);

  // The competitor raises its price: this is a real content change.
  seedWeb({ price: '$49' });
  const changed = await owner.client.req('POST', `/workspaces/${wsId}/competitors/${competitorId}/collect`, {
    use_sitemaps: false
  });
  assert.equal(changed.status, 200);

  const history = await owner.client.req('GET', `/workspaces/${wsId}/competitors/${competitorId}/evidence/history?identity=${encodeURIComponent(original.identity_key)}`);
  assert.equal(history.status, 200);
  const rows = history.data.history.filter((h) => h.identity_key === original.identity_key);
  assert.ok(rows.length >= 2, `expected two versions, got ${rows.length}`);

  const versions = rows.map((r) => r.version).sort();
  assert.ok(versions.includes(1) && versions.includes(2), `versions were ${versions.join(',')}`);

  const v1 = rows.find((r) => r.version === 1);
  const v2 = rows.find((r) => r.version === 2);
  assert.match(v1.excerpt, /39/, 'the old version still shows the old price');
  assert.match(v2.excerpt, /49/, 'the new version shows the new price');
  assert.ok(v1.superseded_at, 'the old version is closed by a timestamp');
  assert.equal(v2.superseded_at, null, 'the new version is current');
  assert.equal(v1.superseded_by, v2.id, 'the chain is explicit');

  const current = db.prepare(`SELECT COUNT(*) c FROM competitor_evidence
      WHERE workspace_id=? AND competitor_id=? AND identity_key=? AND superseded_at IS NULL`)
    .get(wsId, competitorId, original.identity_key);
  assert.equal(current.c, 1, 'exactly one current version per identity');
});

test('9. freshness is tracked from stored timestamps', async () => {
  const fresh = await owner.client.req('GET', `/workspaces/${wsId}/competitors/${competitorId}/evidence`);
  assert.equal(fresh.status, 200);
  const before = fresh.data.freshness;
  // Evidence has been collected but never analysed, so "changed" outranks "fresh".
  assert.equal(before.state, 'changed', before.reason);
  assert.match(before.reason, /never analysed|unseen|observed after/i, `reason was ${before.reason}`);
  assert.ok(before.last_success_at, 'the last successful fetch is reported');
  assert.ok(Date.parse(before.recrawl_due_at) > Date.now(), 'the re-crawl is not yet due');

  // Age the evidence: the due date must move with the stored timestamps.
  const old = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  db.prepare('UPDATE competitor_evidence SET observed_at=?, last_seen_at=? WHERE workspace_id=? AND competitor_id=?')
    .run(old, old, wsId, competitorId);
  db.prepare("UPDATE competitor_pages SET fetched_at=? WHERE workspace_id=? AND competitor_id=? AND fetch_status='ok'")
    .run(old, wsId, competitorId);

  const aged = await owner.client.req('GET', `/workspaces/${wsId}/competitors/${competitorId}/evidence`);
  assert.equal(aged.status, 200);
  assert.ok(Date.parse(aged.data.freshness.recrawl_due_at) < Date.now(), 'an old crawl is due for re-crawl');
  assert.equal(aged.data.freshness.last_success_at, old, 'the stored timestamp is reported verbatim');
  assert.ok(['stale', 'changed'].includes(aged.data.freshness.state));

  // Restore so later steps see current evidence.
  const now = utcNow();
  db.prepare('UPDATE competitor_evidence SET observed_at=?, last_seen_at=? WHERE workspace_id=? AND competitor_id=?')
    .run(now, now, wsId, competitorId);
  db.prepare("UPDATE competitor_pages SET fetched_at=? WHERE workspace_id=? AND competitor_id=? AND fetch_status='ok'")
    .run(now, wsId, competitorId);
});

test('10. screenshots are captured, stored and deduplicated', async () => {
  const first = await owner.client.req('POST', `/workspaces/${wsId}/competitors/${competitorId}/collect`, {
    use_sitemaps: false
  });
  assert.equal(first.status, 200);
  assert.equal(first.data.screenshots.enabled, true);
  // Earlier collections captured these pages already, so this run is a mix of
  // first-time captures and deduplicated sightings, never more than one per type.
  assert.equal(first.data.screenshots.targets, 4);
  assert.equal(first.data.screenshots.captured + first.data.screenshots.duplicates, 4,
    JSON.stringify(first.data.screenshots));
  assert.equal(first.data.screenshots.analysis, 'none: screenshots are stored, never interpreted');

  const list = await owner.client.req('GET', `/workspaces/${wsId}/competitors/${competitorId}/screenshots`);
  assert.equal(list.status, 200);
  const types = list.data.screenshots.filter((s) => s.status === 'captured').map((s) => s.page_type).sort();
  assert.deepEqual([...new Set(types)], ['features', 'homepage', 'pricing', 'product']);
  for (const shot of list.data.screenshots) {
    assert.ok(shot.content_hash, 'each screenshot has a content hash');
    assert.ok(shot.storage_reference, 'each screenshot has a storage reference');
    assert.ok(shot.captured_at, 'each screenshot has a capture timestamp');
  }
  assert.equal(list.data.durability.durable, false, 'ephemeral storage is reported honestly');
  assert.equal(list.data.analysis.supports_image_input, false);

  // Same pages, same bytes: nothing new is stored.
  const before = list.data.screenshots.length;
  const second = await owner.client.req('POST', `/workspaces/${wsId}/competitors/${competitorId}/collect`, {
    use_sitemaps: false
  });
  assert.equal(second.status, 200);
  assert.equal(second.data.screenshots.captured, 0);
  assert.equal(second.data.screenshots.duplicates, 4);
  const afterList = await owner.client.req('GET', `/workspaces/${wsId}/competitors/${competitorId}/screenshots`);
  assert.ok(afterList.data.screenshots.length > before, 'the sighting is recorded');
  assert.ok(afterList.data.screenshots.some((s) => s.duplicate_of), 'the duplicate points at the original');

  // The image itself is served.
  const capturedShot = afterList.data.screenshots.find((s) => s.status === 'captured');
  const image = await owner.client.req('GET', `/workspaces/${wsId}/competitors/${competitorId}/screenshots/${capturedShot.id}/image`);
  assert.equal(image.status, 200);
});

test('11-12. AI analyses evidence incrementally and findings cite valid evidence', async () => {
  assert.ok(competitorWebsiteId, 'discovery linked the competitor to a website row');

  // A finished scan is the precondition for analysis; the scan crawler is covered
  // by its own suites, so the row and its pages are fixtures here.
  const now = utcNow();
  const scanId = newId('scn');
  db.prepare(`INSERT INTO scans (id, workspace_id, original_website_id, comparison_website_id, status, params, created_by, created_at)
      VALUES (?,?,?,?, 'completed', '{}', ?, ?)`)
    .run(scanId, wsId, originalSiteId, competitorWebsiteId, null, now);
  db.prepare(`INSERT INTO pages (id, website_id, workspace_id, url, title, meta_description, text_content, content_hash, fetched_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(newId('pag'), competitorWebsiteId, wsId, `https://${site}/pricing`, 'Acme pricing',
      'Acme pricing plans', 'Acme Starter plan $49 per month with 3 projects and 10 tracked pages.', 'hx', now);

  const callsBefore = modelCalls;
  const analysed = await owner.client.req('POST', `/workspaces/${wsId}/scans/${scanId}/ai`);
  assert.equal(analysed.status, 200, JSON.stringify(analysed.data).slice(0, 400));
  assert.equal(analysed.data.ok, true);
  assert.ok(modelCalls > callsBefore, 'the model was called for the first analysis');

  // The packet preferred Phase 4 evidence over the legacy pages table.
  const statusJobs = db.prepare('SELECT * FROM ai_analyses WHERE workspace_id=? AND scan_id=?').all(wsId, scanId);
  assert.ok(statusJobs.length >= 1);

  const findingsRes = await owner.client.req('GET', `/workspaces/${wsId}/scans/${scanId}/ai/findings`);
  assert.equal(findingsRes.status, 200);
  const findings = findingsRes.data.findings;
  assert.ok(findings.length > 0, 'findings were produced');

  // Every cited id resolves to stored evidence in this workspace.
  const packet = require('../src/ai/evidence-source');
  const row = db.prepare('SELECT * FROM competitors WHERE id=?').get(competitorId);
  const packetData = packet.collectEvidence({ workspaceId: wsId, competitor: row });
  assert.ok(packetData.visuals.length >= 1, 'screenshot metadata is in the packet');
  for (const f of findings) {
    for (const ref of f.evidence_ids || []) {
      assert.ok(packetData.allowedRefs.has(ref), `finding cites ${ref}, which is not allowed evidence`);
    }
  }
  assert.equal(findings.every((f) => (f.evidence_ids || []).length > 0), true,
    'a finding without evidence is not stored');

  // 12b. Unchanged evidence: no stage re-runs and synthesis reuses its report.
  const reportsBefore = db.prepare('SELECT COUNT(*) c FROM ai_reports WHERE scan_id=?').get(scanId).c;
  const callsBeforeRepeat = modelCalls;
  const repeat = await owner.client.req('POST', `/workspaces/${wsId}/scans/${scanId}/ai`);
  assert.equal(repeat.status, 200, JSON.stringify(repeat.data).slice(0, 300));
  assert.equal(modelCalls, callsBeforeRepeat, 'unchanged evidence must not spend a model call');
  assert.equal(repeat.data.synthesis.ok, true);
  assert.equal(repeat.data.synthesis.unchanged, true, 'the existing report is reused');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM ai_reports WHERE scan_id=?').get(scanId).c, reportsBefore,
    'no new report version is written for unchanged findings');

  // 12c. A forged citation is dropped before storage. Unchanged evidence means the
  // stage is short-circuited before the model is reached, so the rejection is
  // proved against the validator directly rather than by re-running the stage.
  const engine = require('../src/ai/engine');
  const realRef = [...packetData.allowedRefs][0];
  const forgedKeep = engine.validateFindings({
    stage: 'overview',
    parsed: { summary: 'forged', category: 'unknown', audience: 'unknown', positioning: 'unknown', evidence_ids: ['ev_forged_000000'] },
    pages: packetData.pages, packet: packetData, workspaceId: wsId, competitorId
  });
  assert.equal(forgedKeep.length, 0, 'a finding citing only a forged id is dropped');

  const mixedKeep = engine.validateFindings({
    stage: 'overview',
    parsed: { summary: 'half forged', category: 'unknown', audience: 'unknown', positioning: 'unknown', evidence_ids: ['ev_forged_000000', realRef] },
    pages: packetData.pages, packet: packetData, workspaceId: wsId, competitorId
  });
  assert.equal(mixedKeep.length, 1, 'the real citation survives');
  assert.deepEqual(mixedKeep[0].evidence_ids, [realRef], 'the forged id is not attached to the finding');

  const afterForged = await owner.client.req('GET', `/workspaces/${wsId}/scans/${scanId}/ai/findings`);
  for (const f of afterForged.data.findings) {
    assert.ok(!(f.evidence_ids || []).includes('ev_forged_000000'), 'a forged citation is never stored');
    assert.ok((f.evidence_ids || []).length > 0, 'every stored finding still has real evidence');
  }

  // 9b. With a completed analysis and no unseen evidence, age alone decides.
  const afterAnalysis = await owner.client.req('GET', `/workspaces/${wsId}/competitors/${competitorId}/evidence`);
  assert.ok(['fresh', 'changed'].includes(afterAnalysis.data.freshness.state),
    `post-analysis state was ${afterAnalysis.data.freshness.state}: ${afterAnalysis.data.freshness.reason}`);
  const oldCrawl = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  db.prepare("UPDATE competitor_pages SET fetched_at=? WHERE workspace_id=? AND competitor_id=? AND fetch_status='ok'")
    .run(oldCrawl, wsId, competitorId);
  const stale = await owner.client.req('GET', `/workspaces/${wsId}/competitors/${competitorId}/evidence`);
  assert.equal(stale.data.freshness.state, 'stale', stale.data.freshness.reason);
  assert.equal(stale.data.recrawl.recollect, true, 'a stale competitor is due for a fresh fetch');
  db.prepare("UPDATE competitor_pages SET fetched_at=? WHERE workspace_id=? AND competitor_id=? AND fetch_status='ok'")
    .run(utcNow(), wsId, competitorId);

  // 12d. Nothing changed: a further run costs no model calls.
  const callsBeforeNoop = modelCalls;
  const third = await owner.client.req('POST', `/workspaces/${wsId}/scans/${scanId}/ai`);
  assert.equal(third.status, 200);
  assert.equal(modelCalls, callsBeforeNoop, 'unchanged evidence must not spend a model call');
  assert.equal(callsByStage.synthesis >= 1, true, 'synthesis ran at least once for real work');
});

test('13-15. synthesis, report, PDF and historical versions', async () => {
  const scanId = db.prepare('SELECT id FROM scans WHERE workspace_id=? AND status=? ORDER BY created_at DESC LIMIT 1')
    .get(wsId, 'completed').id;

  const report = await owner.client.req('GET', `/workspaces/${wsId}/scans/${scanId}/ai/report`);
  assert.equal(report.status, 200, JSON.stringify(report.data).slice(0, 300));
  assert.ok(report.data.report, 'a report exists');
  const stored = report.data.report;
  const doc = stored.body;
  assert.ok(stored.version >= 1);
  for (const key of ['executive_summary', 'competitors', 'comparison', 'recommendations', 'coverage']) {
    assert.ok(key in doc, `the report body carries ${key}`);
  }

  // Synthesis is a cross-competitor layer: it must name the analysed competitor.
  assert.ok(JSON.stringify(doc).includes(site), 'the report names the competitor it analysed');

  const pdf = await owner.client.req('GET', `/workspaces/${wsId}/scans/${scanId}/ai/report.pdf`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.data.slice(0, 4).toString(), '%PDF', 'the export is a real PDF');

  // 15. Historical versions: v1 must survive a newer report unchanged.
  const v1Snapshot = JSON.stringify(doc);
  const versionOne = stored.version;

  // Change the evidence: a new price on the pricing page, then collect again.
  seedWeb({ price: '$59' });
  const recollected = await owner.client.req('POST', `/workspaces/${wsId}/competitors/${competitorId}/collect`, {
    website_id: competitorWebsiteId
  });
  assert.equal(recollected.status, 200);

  // Changed evidence must trigger reanalysis and a new synthesis version.
  const callsBeforeChange = modelCalls;
  const changed = await owner.client.req('POST', `/workspaces/${wsId}/scans/${scanId}/ai`);
  assert.equal(changed.status, 200, JSON.stringify(changed.data).slice(0, 300));
  assert.ok(modelCalls > callsBeforeChange, 'changed evidence spends a model call');
  assert.equal(changed.data.synthesis.ok, true);
  assert.equal(changed.data.synthesis.unchanged, false, 'changed findings produce a new report');

  const latest = await owner.client.req('GET', `/workspaces/${wsId}/scans/${scanId}/ai/report`);
  assert.equal(latest.status, 200);
  assert.ok(latest.data.report.version > versionOne, 'a new report version exists');

  // A re-analysis must not repeat the same claim inside one report.
  for (const c of latest.data.report.body.competitors) {
    const keys = c.findings.map((f) => `${f.kind}|${f.statement}`);
    assert.equal(new Set(keys).size, keys.length, `duplicate finding in report: ${keys.join(', ')}`);
  }
  assert.equal(latest.data.report.id !== stored.id, true, 'the new version is a separate immutable row');

  const v1Again = await owner.client.req('GET', `/workspaces/${wsId}/scans/${scanId}/ai/report?version=${versionOne}`);
  assert.equal(v1Again.status, 200);
  assert.equal(JSON.stringify(v1Again.data.report.body), v1Snapshot, 'historical reports are immutable');
  assert.equal(v1Again.data.report.id, stored.id);

  // Restore the fixture price so the suite is repeatable in one process.
  seedWeb();
});

test('the whole flow stayed inside one workspace and spent no external quota', async () => {
  const other = await signup('e2e-stranger@example.test', 'Stranger Workspace');
  const otherClient = other.client;

  // Cross-tenant reads of every Phase 4/5 resource are refused, not leaked.
  const paths = [
    `/workspaces/${other.wsId}/competitors/${competitorId}/intelligence`,
    `/workspaces/${other.wsId}/competitors/${competitorId}/evidence`,
    `/workspaces/${other.wsId}/competitors/${competitorId}/evidence/history`,
    `/workspaces/${other.wsId}/competitors/${competitorId}/screenshots`,
    `/workspaces/${other.wsId}/competitors/${competitorId}/ai/analyses`
  ];
  for (const p of paths) {
    const res = await otherClient.req('GET', p);
    assert.equal(res.status, 404, `${p} leaked across workspaces (${res.status})`);
  }

  // Their own workspace lists nothing of ours.
  const theirCompetitors = await otherClient.req('GET', `/workspaces/${other.wsId}/competitors`);
  assert.equal(theirCompetitors.status, 200);
  assert.equal(theirCompetitors.data.competitors.length, 0);

  // Screenshot bytes are never served across tenants either.
  const shot = db.prepare('SELECT id FROM competitor_screenshots WHERE competitor_id=? LIMIT 1').get(competitorId);
  const stolen = await otherClient.req('GET', `/workspaces/${other.wsId}/competitors/${competitorId}/screenshots/${shot.id}/image`);
  assert.equal(stolen.status, 404);
});
