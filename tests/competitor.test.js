'use strict';
// Milestone 3: competitor intelligence foundation.
//
// Deterministic layers only. Nothing here calls an AI provider or a network
// fetch: candidates are fed through the same evaluation path discovery uses,
// with fetchPage injected so the tests are hermetic.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'shield-competitor-'));
process.env.DATABASE_FILE = path.join(TMP, 'competitor.db');

const db = require('../src/db/index');
const { newId, utcNow } = require('../src/util');
const { classifyPage, priorityOf } = require('../src/competitor/classify');
const { identifyProduct } = require('../src/competitor/identify');
const { scoreRelevance, verdictReason } = require('../src/competitor/score');
const store = require('../src/competitor/store');
const { evaluateCandidate, profileFromPages } = require('../src/competitor/pipeline');

after(() => { try { db.close && db.close(); } catch { /* sqlite keeps the handle */ } });

function workspace(label) {
  const userId = newId('usr');
  const wsId = newId('wsp');
  const now = utcNow();
  db.prepare('INSERT INTO users (id,email,password_hash,created_at) VALUES (?,?,?,?)')
    .run(userId, `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`, 'x', now);
  db.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)').run(wsId, label, now);
  db.prepare('INSERT INTO memberships (workspace_id,user_id,role,created_at) VALUES (?,?,?,?)')
    .run(wsId, userId, 'owner', now);
  return { wsId, userId };
}

const SEO_ORIGINAL = {
  title: 'Acme SEO — keyword research and backlinks',
  description: 'SEO platform for startups and indie hackers',
  h1: 'Rank higher with data'
};

function fakeFetch(pages) {
  return async (url) => {
    const entry = pages[url];
    if (!entry) throw new Error('ENOTFOUND');
    if (typeof entry === 'string') return { status: 200, html: entry };
    return entry;
  };
}

function htmlPage(title, description, h1, body = '') {
  return `<html><head><title>${title}</title><meta name="description" content="${description}"></head>`
    + `<body><h1>${h1}</h1><p>${body}</p></body></html>`;
}

// --- page classification -----------------------------------------------------

test('pages classify deterministically with a confidence and a reason', () => {
  const cases = [
    ['https://a.com/', 'homepage'],
    ['https://a.com/pricing', 'pricing'],
    ['https://a.com/features', 'features'],
    ['https://a.com/product/platform', 'product'],
    ['https://a.com/docs/api', 'docs'],
    ['https://a.com/blog/post-1', 'blog'],
    ['https://a.com/about', 'about'],
    ['https://a.com/random/page', 'other']
  ];
  for (const [url, expected] of cases) {
    const got = classifyPage(url);
    assert.equal(got.page_type, expected, `${url} should classify as ${expected}`);
    assert.ok(got.confidence > 0 && got.confidence <= 1);
    assert.ok(got.reason, 'classification explains itself');
  }
  // Title hints only apply when the path says nothing.
  assert.equal(classifyPage('https://a.com/x', { title: 'Simple pricing plans' }).page_type, 'pricing');
  assert.equal(classifyPage('https://a.com/pricing', { title: 'About our team' }).page_type, 'pricing');
  assert.ok(priorityOf('homepage') < priorityOf('blog'), 'homepage outranks blog when budget is tight');
});

// --- identification and scoring ---------------------------------------------

test('a same-category competitor scores as verified and explains every point', () => {
  const original = identifyProduct(SEO_ORIGINAL, { domain: 'acme.com' });
  const candidate = identifyProduct({
    title: 'Beta SEO — keyword research for startups',
    description: 'SEO analytics platform for indie hackers',
    h1: 'Rank higher with keyword data'
  }, { domain: 'beta.com' });

  const result = scoreRelevance(candidate, original, { searchRank: 0 });
  assert.equal(result.verdict, 'verified');
  assert.ok(result.score >= 60, `expected >= 60, got ${result.score}`);
  assert.equal(result.components.category.points, 30);
  assert.ok(result.components.features.points > 0, 'shared vocabulary contributes');
  const reason = verdictReason(result);
  assert.match(reason, /category \+30/);
  assert.ok(!/undefined/.test(reason));
});

test('an unrelated site is rejected and search rank cannot rescue it', () => {
  const original = identifyProduct(SEO_ORIGINAL, { domain: 'acme.com' });
  const bakery = identifyProduct({
    title: 'Pune Bakery', description: 'Fresh bread and cakes daily', h1: 'Our bakery'
  }, { domain: 'bakery.in' });

  const result = scoreRelevance(bakery, original, { searchRank: 0 });
  assert.equal(result.verdict, 'rejected');
  assert.equal(result.components.search.points, 0, 'rank is ignored without a content signal');
  assert.match(result.components.search.evidence, /no content signal/);
});

test('a borderline site lands in possible, not verified', () => {
  const original = identifyProduct(SEO_ORIGINAL, { domain: 'acme.com' });
  const adjacent = identifyProduct({
    title: 'Gamma content suite', description: 'Editorial calendar for marketing teams', h1: 'Plan content'
  }, { domain: 'gamma.io' });
  const result = scoreRelevance(adjacent, original, { searchRank: 3 });
  assert.ok(['possible', 'rejected'].includes(result.verdict), 'never verified without real overlap');
  assert.ok(result.score < 60);
});

// --- persistence ------------------------------------------------------------

test('a candidate is stored with its evidence and source urls', async () => {
  const { wsId, userId } = workspace('persist');
  const original = identifyProduct(SEO_ORIGINAL, { domain: 'acme.com' });
  const url = 'https://beta-seo.example/';
  const fetchPage = fakeFetch({
    [url]: htmlPage('Beta SEO — keyword research', 'SEO platform for startups and indie hackers',
      'Rank higher with keyword data', 'keyword research backlinks serp tracking')
  });

  const result = await evaluateCandidate({
    workspaceId: wsId, url, original, searchRank: 0, createdBy: userId, fetchPage
  });
  assert.equal(result.decision, 'verified');

  const detail = store.competitorDetail(wsId, result.competitorId);
  assert.equal(detail.competitor.domain, 'beta-seo.example');
  assert.equal(detail.competitor.status, 'verified');
  assert.ok(detail.competitor.name.startsWith('Beta SEO'));
  assert.ok(JSON.parse(detail.competitor.relevance_breakdown).category.points === 30);
  assert.equal(detail.pages.length, 1);
  assert.equal(detail.pages[0].page_type, 'homepage');
  assert.equal(detail.pages[0].fetch_status, 'ok');
  assert.ok(detail.evidence.length >= 3, 'name, description, category, audience recorded');
  for (const e of detail.evidence) {
    assert.ok(e.source_url, 'every fact carries its source');
    assert.ok(e.collected_at, 'and a collection timestamp');
    assert.ok(['observed', 'inferred', 'unverified'].includes(e.verification_status));
    assert.equal(e.field === 'category' || e.field === 'target_audience' ? 'inferred' : 'observed', e.verification_status);
  }
  assert.equal(detail.discovery.length, 1);
  assert.equal(detail.discovery[0].decision, 'verified');
});

test('the same domain is never stored twice', async () => {
  const { wsId } = workspace('dedupe');
  const original = identifyProduct(SEO_ORIGINAL, { domain: 'acme.com' });
  const fetchPage = fakeFetch({});
  for (const url of ['https://dup.example/', 'https://www.dup.example/', 'https://dup.example/pricing']) {
    await evaluateCandidate({ workspaceId: wsId, url, original, fetchPage });
  }
  const rows = store.listCompetitors(wsId);
  assert.equal(rows.length, 1, 'three urls, one domain, one competitor');
  assert.equal(rows[0].domain, 'dup.example');
  assert.equal(store.competitorDetail(wsId, rows[0].id).discovery.length, 3, 'each attempt is recorded');
});

test('a candidate that cannot be fetched is kept as unverifiable, not invented', async () => {
  const { wsId } = workspace('unreachable');
  const original = identifyProduct(SEO_ORIGINAL, { domain: 'acme.com' });
  const url = 'https://gone.example/';
  const result = await evaluateCandidate({
    workspaceId: wsId, url, original, searchRank: 1,
    fetchPage: async () => { throw new Error('ECONNREFUSED'); }
  });
  assert.equal(result.decision, 'unverifiable');
  const detail = store.competitorDetail(wsId, result.competitorId);
  assert.equal(detail.competitor.status, 'unverifiable');
  assert.equal(detail.competitor.description, null, 'no description was invented');
  assert.equal(detail.competitor.category, null, 'no category was invented');
  assert.equal(detail.pages[0].fetch_status, 'failed');
  assert.match(detail.pages[0].fetch_error, /ECONNREFUSED/);
});

test('an HTTP error page is recorded as a failure, not as content', async () => {
  const { wsId } = workspace('http-error');
  const original = identifyProduct(SEO_ORIGINAL, { domain: 'acme.com' });
  const url = 'https://blocked.example/';
  const result = await evaluateCandidate({
    workspaceId: wsId, url, original,
    fetchPage: async () => ({ status: 403, html: '<html><title>Forbidden</title></html>' })
  });
  const detail = store.competitorDetail(wsId, result.competitorId);
  assert.equal(detail.competitor.status, 'unverifiable');
  assert.equal(detail.competitor.name, null);
  assert.match(detail.pages[0].fetch_error, /403/);
});

test('partial discovery keeps the good candidate and records the bad one', async () => {
  const { wsId } = workspace('partial');
  const original = identifyProduct(SEO_ORIGINAL, { domain: 'acme.com' });
  const fetchPage = fakeFetch({
    'https://good.example/': htmlPage('Good SEO', 'SEO platform for startups', 'Rank higher', 'keyword research backlinks')
  });
  const results = [];
  for (const url of ['https://good.example/', 'https://bad.example/']) {
    results.push(await evaluateCandidate({ workspaceId: wsId, url, original, searchRank: 0, fetchPage }));
  }
  assert.equal(results[0].decision, 'verified');
  assert.equal(results[1].decision, 'unverifiable');
  const counts = store.countsByStatus(wsId);
  assert.equal(counts.verified, 1);
  assert.equal(counts.unverifiable, 1);
});

// --- isolation --------------------------------------------------------------

test('competitors from another workspace are invisible', async () => {
  const a = workspace('iso-a');
  const b = workspace('iso-b');
  const original = identifyProduct(SEO_ORIGINAL, { domain: 'acme.com' });
  const url = 'https://iso.example/';
  const fetchPage = fakeFetch({ [url]: htmlPage('Iso SEO', 'SEO platform for startups', 'Rank higher', 'keyword research') });
  const created = await evaluateCandidate({ workspaceId: a.wsId, url, original, fetchPage });

  assert.equal(store.listCompetitors(b.wsId).length, 0, 'other workspace sees nothing');
  assert.equal(store.competitorDetail(b.wsId, created.competitorId), null, 'no cross-workspace detail');
  assert.equal(store.countsByStatus(b.wsId).verified, 0);
  assert.equal(store.listCompetitors(a.wsId).length, 1);
});

test('the competitor profile of the user site comes from its own pages', () => {
  const profile = profileFromPages([
    { title: 'Acme SEO — keyword research', meta_description: 'SEO platform for startups', h1: 'Rank higher', text_content: 'keyword research backlinks serp', normalized_domain: 'acme.com' }
  ]);
  assert.equal(profile.category, 'seo tools');
  assert.equal(profile.targetAudience, 'founders and startups');
  assert.equal(profileFromPages([]), null);
});

// --- PostgreSQL compatibility ----------------------------------------------

test('migration 8 and the competitor tables work on PostgreSQL too', { skip: !process.env.TEST_DATABASE_URL }, () => {
  const out = execFileSync(process.execPath, ['-e', `
    const db = require('./src/db/index');
    const store = require('./src/competitor/store');
    const { newId, utcNow } = require('./src/util');
    const ws = newId('wsp'), u = newId('usr'), c = newId('cmp');
    const now = utcNow();
    db.prepare('INSERT INTO users (id,email,password_hash,created_at) VALUES (?,?,?,?)').run(u, u + '@example.test', 'x', now);
    db.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)').run(ws, 'pg', now);
    store.upsertCompetitor({ workspaceId: ws, domain: 'pg.example', siteUrl: 'https://pg.example/', name: 'PG', status: 'possible' });
    const rows = store.listCompetitors(ws);
    const mig = db.prepare('SELECT MAX(version) v FROM schema_migrations').get();
    console.log(JSON.stringify({ migrations: Number(mig.v), competitors: rows.length, domain: rows[0].domain }));
  `], { cwd: REPO, env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL, DATABASE_FILE: '' }, encoding: 'utf8' });
  const parsed = JSON.parse(out.trim().split('\n').pop());
  assert.equal(parsed.migrations, 8);
  assert.equal(parsed.competitors, 1);
  assert.equal(parsed.domain, 'pg.example');
});
