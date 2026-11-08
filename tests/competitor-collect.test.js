'use strict';
// Phase 4 tests: page discovery, secure fetch outcomes, feature and pricing
// extraction, dedupe, persistence and workspace isolation.
//
// The collector is exercised through its real route with an injected fetcher, so
// the whole path (ranking -> fetch -> store -> extract -> persist) runs without
// touching the network.

process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.DATABASE_FILE = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'shield-cint-')) + '/test.db';
process.env.AUTH_RATE_LIMIT = '1000';
process.env.COOKIE_SECURE = 'false';
process.env.AUTH_REQUIRE_EMAIL_VERIFICATION = 'false';
process.env.CINT_MAX_PAGES = '8';
process.env.CINT_MAX_PAGES_PER_TYPE = '2';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');

const { app, server } = require('../src/server');
const db = require('../src/db/index');
const deepCrawl = require('../src/competitor/deep-crawl');
const features = require('../src/competitor/extract-features');
const pricing = require('../src/competitor/extract-pricing');
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
    async req(method, path, body) {
      await ready();
      const res = await fetch(BASE + path, {
        method,
        headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, data };
    }
  };
}

async function signup(email, name) {
  const c = client();
  const res = await c.req('POST', '/auth/signup', { email, password: 'longpassword1', workspace_name: name });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return { client: c, wsId: res.data.workspace.id };
}

// (workspace, domain) is unique, so seeding is idempotent: a test that needs a
// clean competitor uses its own domain.
function seedCompetitor(workspaceId, domain = 'acme.test') {
  const now = utcNow();
  const existing = db.prepare('SELECT id FROM competitors WHERE workspace_id=? AND domain=?')
    .get(workspaceId, domain);
  if (existing) return existing.id;
  const id = newId('cmp');
  db.prepare(`INSERT INTO competitors (id, workspace_id, domain, site_url, name, status, discovered_at, created_at)
              VALUES (?,?,?,?,?, 'verified', ?, ?)`)
    .run(id, workspaceId, domain, `https://${domain}/`, 'Acme', now, now);
  return id;
}

// --- A. target discovery ----------------------------------------------------

test('ranking puts the homepage first, then pricing, and dedupes the same URL', () => {
  const targets = deepCrawl.rankTargets({
    siteUrl: 'https://acme.test/',
    links: [
      'https://acme.test/pricing',
      'https://acme.test/pricing/',        // same page, trailing slash
      'https://acme.test/features',
      'https://other.test/pricing',        // off-site
      'https://acme.test/blog/post-1',
      'https://acme.test/about',
      'https://acme.test/logo.png',        // asset
      'https://acme.test/login',           // page furniture
      'https://acme.test/docs/getting-started'
    ],
    sitemapUrls: ['https://acme.test/pricing?ref=sitemap', 'https://acme.test/product'],
    maxPages: 8,
    maxPerType: 2
  });
  assert.equal(targets[0].pageType, 'homepage');
  assert.equal(targets[0].discovery_source, 'seed');
  const types = targets.map((t) => t.pageType);
  assert.ok(types.indexOf('pricing') < types.indexOf('features'));
  assert.ok(types.indexOf('features') < types.indexOf('about'));
  assert.ok(types.indexOf('about') < types.indexOf('blog'));
  assert.equal(types.filter((t) => t === 'pricing').length, 2, 'two distinct pricing URLs, deduped');
  assert.equal(targets.some((t) => t.url.includes('other.test')), false, 'off-site links are ignored');
  assert.equal(targets.some((t) => t.url.endsWith('.png')), false, 'assets are ignored');
  assert.equal(targets.some((t) => t.url.includes('/login')), false, 'login is ignored');
  const urls = targets.map((t) => t.url);
  assert.equal(new Set(urls).size, urls.length, 'no duplicate targets');
});

test('the page budget and the per-type ceiling both bind', () => {
  const links = [];
  for (let i = 0; i < 20; i += 1) links.push(`https://acme.test/docs/guide-${i}`);
  for (let i = 0; i < 10; i += 1) links.push(`https://acme.test/blog/post-${i}`);
  links.push('https://acme.test/pricing', 'https://acme.test/features');
  const targets = deepCrawl.rankTargets({
    siteUrl: 'https://acme.test/', links, sitemapUrls: [], maxPages: 6, maxPerType: 2
  });
  assert.equal(targets.length, 6, 'never exceeds the total budget');
  const docs = targets.filter((t) => t.pageType === 'docs').length;
  assert.ok(docs <= 2, `docs capped at 2, got ${docs}`);
});

// --- A. fetch outcomes ------------------------------------------------------

function page(html, finalUrl, status = 200) { return { html, finalUrl, httpStatus: status }; }

test('fetch outcomes separate failed, blocked, redirected and empty pages', async () => {
  const targets = [
    { url: 'https://acme.test/', pageType: 'homepage', score: 100, depth: 0 },
    { url: 'https://acme.test/pricing', pageType: 'pricing', score: 90, depth: 1 },
    { url: 'https://acme.test/docs', pageType: 'docs', score: 70, depth: 1 },
    { url: 'https://acme.test/blog', pageType: 'blog', score: 40, depth: 1 },
    { url: 'https://acme.test/about', pageType: 'about', score: 30, depth: 1 }
  ];
  const fetcher = async (url) => {
    if (url === 'https://acme.test/') return page('<h1>Acme</h1><p>Acme builds a keyword tracking platform for startups and agencies of every size.</p>', url);
    if (url.endsWith('/pricing')) { const e = new Error('HTTP 404'); e.code = 'HTTP_ERROR'; e.status = 404; throw e; }
    if (url.endsWith('/docs')) { const e = new Error('Blocked by robots.txt'); e.code = 'ROBOTS'; throw e; }
    if (url.endsWith('/blog')) return page('<h1>Blog</h1>', 'https://someone-else.test/landing', 200);
    return page('<html><body></body></html>', url, 200);
  };
  const ok = [];
  const failed = [];
  const results = await deepCrawl.fetchTargets({
    targets, fetchPage: fetcher,
    onPage: async (p) => ok.push(p),
    onFailure: async (f) => failed.push(f)
  });
  const byUrl = Object.fromEntries(results.map((r) => [r.url, r]));
  assert.equal(byUrl['https://acme.test/'].fetch_status, 'ok');
  assert.equal(byUrl['https://acme.test/pricing'].fetch_status, 'failed');
  assert.match(byUrl['https://acme.test/pricing'].error, /HTTP 404/);
  assert.equal(byUrl['https://acme.test/docs'].fetch_status, 'blocked');
  assert.equal(byUrl['https://acme.test/blog'].fetch_status, 'blocked', 'a redirect off-site is refused');
  assert.match(byUrl['https://acme.test/blog'].error, /redirected off-site/);
  assert.equal(byUrl['https://acme.test/about'].fetch_status, 'skipped', 'a page with no text is not stored as content');
  assert.equal(ok.length, 1);

  const totals = deepCrawl.summarise(results);
  assert.equal(totals.status, 'partial', 'some pages worked, so the run is partial not failed');
  assert.equal(totals.pagesOk, 1);
  assert.equal(totals.pagesFailed, 4);

  const allBad = deepCrawl.summarise([{ fetch_status: 'failed' }, { fetch_status: 'blocked' }]);
  assert.equal(allBad.status, 'failed');
  assert.equal(deepCrawl.summarise([{ fetch_status: 'ok' }]).status, 'completed');
});

test('identical page content is marked as a duplicate instead of counted twice', async () => {
  const body = '<h1>Acme</h1><p>Acme tracks keyword rankings, sends alerts and exports weekly reports for teams.</p>';
  const targets = [
    { url: 'https://acme.test/pricing', pageType: 'pricing', score: 90, depth: 1 },
    { url: 'https://acme.test/plans', pageType: 'pricing', score: 80, depth: 1 }
  ];
  const results = await deepCrawl.fetchTargets({
    targets,
    fetchPage: async (url) => ({ html: body, finalUrl: url, httpStatus: 200 })
  });
  assert.equal(results[0].duplicate_of, null);
  assert.equal(results[1].duplicate_of, 'https://acme.test/pricing');
});

// --- B. feature extraction --------------------------------------------------

function featurePage(overrides) {
  return {
    url: 'https://acme.test/features',
    page_type: 'features',
    content_hash: 'h1',
    text_content: '',
    fetched_at: '2026-11-07T06:00:00.000Z',
    ...overrides
  };
}

test('features distinguish documentation, marketing, inference and unverified headings', () => {
  const docs = features.extractFromPage(featurePage({
    page_type: 'docs', url: 'https://acme.test/docs/api',
    text_content: 'REST API\nSend a request to the v1 endpoint and receive JSON. It supports pagination and webhooks per workspace.\nRate limits\nEach plan allows 60 requests per minute.'
  }));
  assert.ok(docs.length >= 1);
  assert.equal(docs[0].claim_level, 'documented');
  assert.ok(docs[0].confidence > 0.6);

  const marketing = features.extractFromPage(featurePage({
    text_content: 'Keyword tracking\nTrack every keyword you care about and see movement daily across markets.\nAutomated alerts\nGet notified the moment a ranking drops below a threshold.'
  }));
  assert.ok(marketing.length >= 2);
  assert.ok(marketing.every((f) => f.claim_level === 'marketing'));

  const inferred = features.extractFromPage(featurePage({
    page_type: 'about', url: 'https://acme.test/about',
    text_content: 'Our story\nWe started in 2019 to make rank tracking affordable for small teams.'
  }));
  assert.equal(inferred[0].claim_level, 'inferred');
  assert.equal(inferred[0].verification_status, 'inferred');

  const unverified = features.extractFromPage(featurePage({
    page_type: 'product',
    text_content: 'Insight engine\nContact sales'
  }));
  // A bare phrase with no supporting sentence is still recorded, but labelled as
  // unverified and scored down rather than presented as a documented capability.
  assert.equal(unverified.length, 1);
  assert.equal(unverified[0].claim_level, 'unverified');
  assert.equal(unverified[0].verification_status, 'unverified');
  assert.ok(unverified[0].confidence < 0.5);
});

test('feature extraction drops navigation and keeps the source excerpt', () => {
  const pageUnderTest = featurePage({
    text_content: [
      'Sign in', 'Privacy policy', 'Cookie settings', 'Accept all',
      'Campaign builder',
      'Build multi-step email campaigns with branching logic and A/B tests in minutes.'
    ].join('\n')
  });
  const found = features.extractFromPage(pageUnderTest);
  assert.equal(found.length, 1);
  assert.equal(found[0].name, 'Campaign builder');
  assert.match(found[0].description, /branching logic/);
  assert.match(found[0].evidence_excerpt, /Campaign builder - Build multi-step/);
  assert.equal(found[0].source_url, pageUnderTest.url);
  assert.equal(found[0].page_type, 'features');
  assert.equal(found[0].category, 'email');
  assert.ok(found[0].confidence > 0 && found[0].confidence <= 0.95);
  assert.equal(found[0].observed_at, '2026-11-07T06:00:00.000Z');
});

test('the same feature on two pages is one feature with extra evidence', () => {
  const featuresPage = featurePage({
    content_hash: 'h-features',
    text_content: 'Shared inbox\nManage every conversation from one shared inbox with assignment rules.'
  });
  const docsPage = featurePage({
    page_type: 'docs', url: 'https://acme.test/docs/inbox', content_hash: 'h-docs',
    text_content: 'Shared inbox\nAll members of a workspace can read and reply from the shared inbox; assignment rules route new threads.'
  });
  const all = features.extractAll([featuresPage, docsPage]);
  const shared = all.filter((f) => f.identity_key === 'shared inbox');
  assert.equal(shared.length, 1, 'deduped to one feature');
  assert.equal(shared[0].claim_level, 'documented', 'the documentation observation wins');
  assert.equal(shared[0].support.length, 1, 'the other page is kept as supporting evidence');
  assert.equal(shared[0].support[0].source_url, featuresPage.url);
});

// --- C. pricing extraction --------------------------------------------------

function pricingPage(text, overrides) {
  return {
    url: 'https://acme.test/pricing', page_type: 'pricing', content_hash: 'ph1',
    text_content: text, fetched_at: '2026-11-07T06:00:00.000Z', ...overrides
  };
}

test('pricing keeps the printed price, its currency and the original wording', () => {
  const { plans, summary } = pricing.extractAll([pricingPage([
    'Starter',
    '$29 per month',
    '3 seats included',
    'Up to 10 projects',
    'Pro',
    '$79 per month',
    '10 seats included',
    'Priority support'
  ].join('\n'))]);

  const starter = plans.find((p) => p.plan_name === 'Starter');
  assert.equal(starter.price_value, 29);
  assert.equal(starter.price_display, '$29');
  assert.equal(starter.currency, null, 'a bare $ is not assumed to be USD');
  assert.equal(starter.currency_display, '$');
  assert.equal(starter.billing_interval, 'month');
  assert.match(starter.original_text, /\$29 per month/);
  assert.deepEqual(starter.limits, ['3 seats included', 'Up to 10 projects']);
  assert.ok(starter.plan_features.includes('Priority support') === false, 'features stay in their own plan');

  assert.equal(summary.starting_price_display, '$29');
  assert.equal(summary.starting_price_value, 29);
  assert.equal(summary.free_plan, 0, 'a pricing page with no free plan is a stated "no"');
  assert.equal(summary.free_trial, 0);
  assert.equal(summary.plans_count, 2);
});

test('euro prices are not converted and a free plan plus trial are recorded only when stated', () => {
  const { plans, summary } = pricing.extractAll([pricingPage([
    'Free',
    '\u20ac0 forever',
    '1 project',
    'Team',
    '\u20ac49 per month',
    'Unlimited projects',
    'Start with a 14-day free trial. No credit card required.'
  ].join('\n'))]);

  const team = plans.find((p) => p.plan_name === 'Team');
  assert.equal(team.price_value, 49);
  assert.equal(team.currency, 'EUR');
  assert.equal(team.price_display, '\u20ac49');
  // The free tier is recorded as a free plan, and the starting price is the
  // cheapest *paid* plan, not a $0 row.
  const free = plans.find((p) => p.plan_name === 'Free');
  assert.equal(free.free_plan, 1);
  assert.equal(summary.starting_price_value, 49);
  assert.equal(summary.starting_price_display, '\u20ac49');
  assert.equal(summary.free_plan, 1);
  assert.equal(summary.free_trial, 1);
  assert.equal(summary.trial_days, 14);
  assert.match(summary.trial_display, /14-day free trial/);
});

test('an unstated price stays unknown and never becomes free', () => {
  const { plans, summary } = pricing.extractAll([pricingPage([
    'Business',
    'Contact sales for a quote',
    'Custom annual agreement'
  ].join('\n'))]);

  const business = plans.find((p) => p.plan_name === 'Business');
  assert.equal(business.price_value, null, 'no number invented');
  assert.equal(business.price_stated, false);
  assert.equal(business.enterprise_custom, 1);
  assert.equal(business.billing_interval, 'custom');
  assert.equal(summary.has_pricing_evidence, 1);
  assert.equal(summary.starting_price_value, null);
  assert.notEqual(summary.free_plan, 1, 'an unpriced plan is not a free plan');
});

test('without a pricing page nothing is claimed about price at all', () => {
  const { plans, summary } = pricing.extractAll([
    featurePage({ text_content: 'Keyword tracking\nTrack keywords every day and see the movement.' })
  ]);
  assert.deepEqual(plans, []);
  assert.equal(summary.has_pricing_evidence, 0);
  assert.equal(summary.free_plan, null, 'unknown, not "no"');
  assert.equal(summary.free_trial, null);
  assert.equal(summary.starting_price_value, null);
  assert.equal(summary.confidence, 0);
});

test('mixed currencies do not produce a starting price', () => {
  const { summary } = pricing.extractAll([pricingPage([
    'Starter', '\u20ac19 per month', 'Team', '$49 per month'
  ].join('\n'))]);
  assert.equal(summary.starting_price_value, null, 'currencies are never compared or converted');
  assert.equal(summary.mixed_currencies, true);
  assert.equal(summary.currency, null);
});

test('usage-based and annual wording are preserved', () => {
  const { plans } = pricing.extractAll([pricingPage([
    'Scale',
    '$0.02 per request, billed monthly',
    'Pay as you go with a metered API'
  ].join('\n'))]);
  const scale = plans[0];
  assert.equal(scale.price_value, 0.02);
  assert.equal(scale.usage_based, 1);
  assert.equal(scale.billing_interval, 'month');
});

// --- D. persistence, isolation and partial failure through the API ----------

let owner;
let stranger;
before(async () => {
  owner = await signup('cint-owner@example.test', 'CINT Owner');
  stranger = await signup('cint-stranger@example.test', 'CINT Stranger');
});

// A fake competitor site per domain: homepage with links, pricing, features and a
// page that always fails. Each test gets its own domain so collections cannot
// leak between them.
function fakeSite(domain) {
  const home = `https://${domain}/`;
  const pages = {
    [home]: `<h1>Acme</h1><p>Acme builds keyword tracking for startups and agencies of every size.</p>
      <a href="/pricing">Pricing</a><a href="/features">Features</a><a href="/broken">Blog</a>`,
    [`https://${domain}/pricing`]: `<h1>Pricing</h1><h2>Starter</h2><p>$29 per month</p><p>3 seats included</p>
      <h2>Pro</h2><p>$79 per month</p><p>10 seats included</p>`,
    [`https://${domain}/features`]: `<h1>Features</h1><h2>Keyword tracking</h2>
      <p>Track every keyword you care about and see the daily movement across markets.</p>
      <h2>Automated alerts</h2><p>Get notified the moment a ranking drops below a threshold you set.</p>`,
    [`https://${domain}/broken`]: null
  };
  return {
    pages,
    set(keyPath, html) { pages[`https://${domain}${keyPath}`] = html; },
    fetcher: async (url) => {
      if (!(url in pages)) { const e = new Error('HTTP 404'); e.code = 'HTTP_ERROR'; e.status = 404; throw e; }
      if (pages[url] === null) { const e = new Error('HTTP 500'); e.code = 'HTTP_ERROR'; e.status = 500; throw e; }
      return { html: pages[url], finalUrl: url, httpStatus: 200 };
    }
  };
}

function installSite(domain) {
  const site = fakeSite(domain);
  app.locals.competitorFetcher = site.fetcher;
  return site;
}

test('a full collection persists pages, features and pricing', async () => {
  const domain = 'full.test';
  installSite(domain);
  const competitorId = seedCompetitor(owner.wsId, domain);
  const res = await owner.client.req('POST', `/workspaces/${owner.wsId}/competitors/${competitorId}/collect`, { use_sitemaps: false });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.status, 'partial', 'one target failed, so the run reports partial');
  assert.ok(res.data.pages_ok >= 3, `expected at least 3 pages, got ${res.data.pages_ok}`);
  assert.ok(res.data.features >= 2);
  assert.equal(res.data.plans, 2);
  assert.equal(res.data.pricing.starting_price_value, 29);
  assert.equal(res.data.pricing.free_plan, 0);

  const detail = await owner.client.req('GET', `/workspaces/${owner.wsId}/competitors/${competitorId}/intelligence`);
  assert.equal(detail.status, 200);
  const features_ = detail.data.features;
  assert.ok(features_.some((f) => f.name === 'Keyword tracking' && f.claim_level === 'marketing'));
  for (const f of features_) {
    assert.ok(f.source_url.startsWith(`https://${domain}/`), 'every feature carries its source');
    assert.ok(f.evidence_id, 'every feature cites an evidence row');
    assert.ok(['documented', 'marketing', 'inferred', 'unverified'].includes(f.claim_level));
    assert.ok(f.confidence > 0 && f.confidence <= 0.95);
    assert.ok(f.observed_at);
  }

  const plans = detail.data.plans;
  const starter = plans.find((p) => p.plan_name === 'Starter');
  assert.equal(starter.price_value, 29);
  assert.equal(starter.price_stated, true);
  assert.ok(starter.evidence_id, 'a plan cites its evidence');
  assert.ok(starter.original_text.includes('$29 per month'), 'original wording is preserved');
  assert.deepEqual(starter.limits, ['3 seats included']);

  // the failed page is recorded with its reason, not dropped
  const broken = detail.data.pages.find((p) => p.url.endsWith('/broken'));
  assert.ok(broken, 'the failed target is stored');
  assert.equal(broken.fetch_status, 'failed');
  assert.match(broken.fetch_error, /HTTP 500/);

  const crawls = detail.data.crawls;
  assert.equal(crawls.length, 1);
  assert.equal(crawls[0].status, 'partial');
  assert.ok(crawls[0].finished_at);
  assert.ok(detail.data.evidence_count >= plans.length + features_.length);
});

test('re-collecting the same site adds no duplicate features or plans', async () => {
  const domain = 'recollect.test';
  installSite(domain);
  const competitorId = seedCompetitor(owner.wsId, domain);
  await owner.client.req('POST', `/workspaces/${owner.wsId}/competitors/${competitorId}/collect`, { use_sitemaps: false });
  const first = await owner.client.req('GET', `/workspaces/${owner.wsId}/competitors/${competitorId}/intelligence`);
  const second = await owner.client.req('POST', `/workspaces/${owner.wsId}/competitors/${competitorId}/collect`, { use_sitemaps: false });
  assert.equal(second.data.features_saved, 0, 'unchanged evidence produces no new feature rows');
  assert.equal(second.data.plans_saved, 0, 'unchanged evidence produces no new plan rows');
  const after = await owner.client.req('GET', `/workspaces/${owner.wsId}/competitors/${competitorId}/intelligence`);
  assert.equal(after.data.features.length, first.data.features.length);
  assert.equal(after.data.plans.length, first.data.plans.length);
  assert.equal(after.data.crawls.length, 2, 'both attempts stay visible');
});

test('a changed page creates a new observation and history keeps the old one', async () => {
  const domain = 'changing.test';
  const site = installSite(domain);
  const competitorId = seedCompetitor(owner.wsId, domain);
  await owner.client.req('POST', `/workspaces/${owner.wsId}/competitors/${competitorId}/collect`, { use_sitemaps: false });

  // The competitor changes its pricing and adds a feature.
  site.set('/pricing', '<h1>Pricing</h1><h2>Starter</h2><p>$39 per month</p><p>5 seats included</p>');
  site.set('/features', `<h1>Features</h1><h2>Keyword tracking</h2>
    <p>Track every keyword you care about and see the daily movement across markets.</p>
    <h2>Competitor tracking</h2><p>Watch competitor pages change and get a summary of what moved.</p>`);
  const res = await owner.client.req('POST', `/workspaces/${owner.wsId}/competitors/${competitorId}/collect`, { use_sitemaps: false });
  assert.equal(res.status, 200);

  const latest = await owner.client.req('GET', `/workspaces/${owner.wsId}/competitors/${competitorId}/intelligence`);
  assert.ok(latest.data.features.some((f) => f.name === 'Competitor tracking'), 'the new feature appears');
  const starterNow = latest.data.plans.find((p) => p.plan_name === 'Starter');
  assert.equal(starterNow.price_value, 39, 'the current price is the new one');

  const history = await owner.client.req('GET', `/workspaces/${owner.wsId}/competitors/${competitorId}/intelligence?history=1`);
  const starterHistory = history.data.plans.filter((p) => p.plan_name === 'Starter');
  assert.equal(starterHistory.length, 2, 'both observations are kept');
  const observed = starterHistory.map((p) => p.price_value).sort((a, b) => a - b);
  assert.deepEqual(observed, [29, 39]);
});

test('an unreachable competitor fails cleanly and says why', async () => {
  app.locals.competitorFetcher = async () => { const e = new Error('HTTP 503'); e.code = 'HTTP_ERROR'; throw e; };
  const competitorId = seedCompetitor(owner.wsId, 'down.test');
  const res = await owner.client.req('POST', `/workspaces/${owner.wsId}/competitors/${competitorId}/collect`, { use_sitemaps: false });
  assert.equal(res.status, 502);
  assert.equal(res.data.code, 'homepage_unreachable');
  assert.match(res.data.error, /HTTP 503/);

  const detail = await owner.client.req('GET', `/workspaces/${owner.wsId}/competitors/${competitorId}/intelligence`);
  assert.equal(detail.data.crawls[0].status, 'failed');
  assert.equal(detail.data.features.length, 0);
  assert.equal(detail.data.pricing, null, 'no pricing answer is invented for a site we could not read');
});

test('another workspace cannot read or collect this competitor', async () => {
  const domain = 'isolated.test';
  installSite(domain);
  const competitorId = seedCompetitor(owner.wsId, domain);
  await owner.client.req('POST', `/workspaces/${owner.wsId}/competitors/${competitorId}/collect`, { use_sitemaps: false });

  const read = await stranger.client.req('GET', `/workspaces/${owner.wsId}/competitors/${competitorId}/intelligence`);
  assert.equal(read.status, 404);
  const run = await stranger.client.req('POST', `/workspaces/${owner.wsId}/competitors/${competitorId}/collect`, { use_sitemaps: false });
  assert.equal(run.status, 404);
  const list = await stranger.client.req('GET', `/workspaces/${stranger.wsId}/competitors`);
  assert.equal(list.data.competitors.length, 0, 'a foreign workspace sees none of it');
  const plans = await stranger.client.req('GET', `/workspaces/${stranger.wsId}/pricing`);
  assert.equal(plans.data.pricing.length, 0);
});

test('an interrupted collection is recovered instead of leaving pages stuck', async () => {
  const competitorId = seedCompetitor(owner.wsId, 'stuck.test');
  const now = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const crawlId = newId('cwl');
  db.prepare(`INSERT INTO competitor_crawls (id, workspace_id, competitor_id, status, page_budget,
      pages_attempted, pages_ok, pages_failed, started_at, created_at)
      VALUES (?,?,?, 'running', 8, 0, 0, 0, ?, ?)`).run(crawlId, owner.wsId, competitorId, now, now);
  db.prepare(`INSERT INTO competitor_pages (id, workspace_id, competitor_id, url, page_type, fetch_status, created_at)
      VALUES (?,?,?,?, 'pricing', 'pending', ?)`).run(newId('cpge'), owner.wsId, competitorId, 'https://stuck.test/pricing', now);

  // A new run first closes the abandoned attempt.
  app.locals.competitorFetcher = async (url) => ({ html: '<h1>Stuck</h1><p>This site works now and has enough text to be read.</p>', finalUrl: url, httpStatus: 200 });
  await owner.client.req('POST', `/workspaces/${owner.wsId}/competitors/${competitorId}/collect`, { use_sitemaps: false });

  const crawl = db.prepare('SELECT * FROM competitor_crawls WHERE id=?').get(crawlId);
  assert.equal(crawl.status, 'partial');
  assert.match(crawl.reason, /recovered/);
  const page = db.prepare('SELECT * FROM competitor_pages WHERE competitor_id=? AND fetch_status=?').get(competitorId, 'skipped');
  assert.match(page.fetch_error, /interrupted/);
});

test('the collect route requires a session', async () => {
  const anon = client();
  const competitorId = seedCompetitor(owner.wsId, 'anon.test');
  const res = await anon.req('POST', `/workspaces/${owner.wsId}/competitors/${competitorId}/collect`, {});
  assert.equal(res.status, 401);
});
