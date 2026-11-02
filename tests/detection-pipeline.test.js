'use strict';
// Ground-truth tests for the copy-detection pipeline.
//
// Two controlled fixture sites with known overlap, one distinct site and one thin
// site, so every number here has a correct answer:
//   - fixture A/B share a verbatim paragraph  -> must be a finding with evidence
//   - fixture A/C share nothing              -> must NOT be a finding
//   - thin pages (< MIN_WORDS)               -> honest "nothing comparable" status
// No external network is used.
process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.DATABASE_FILE = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'detect-')) + '/test.db';
process.env.SHIELD_ALLOW_PRIVATE_IPS = 'true';
process.env.CRAWL_DELAY_MS = '5';
process.env.AUTH_RATE_LIMIT = '100';
process.env.COOKIE_SECURE = 'false';
process.env.AUTH_REQUIRE_EMAIL_VERIFICATION = 'false';
process.env.CRAWL_MAX_PAGES_PER_SITE = '3';
delete process.env.SERPER_API_KEY;
delete process.env.EMAIL_PROVIDER;

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { server } = require('../src/server');
const db = require('../src/db');

// Deterministic prose, long enough to clear the engine's MIN_WORDS gate.
const SHARED = 'Our aquaponics control system schedules nutrient dosing for every grow bed, records water temperature and pH every ninety seconds, and raises an alarm when dissolved oxygen drops below the configured threshold. Operators review a weekly compliance report that lists every dosing event, the measured concentration before and after treatment, and the technician who approved the adjustment.';
const UNIQUE_A = 'The dashboard was designed for greenhouse managers who need one screen that shows tank levels, pump duty cycles and the current feeding plan without hunting through menus. Alerts are grouped by severity so a failing pump is never buried under routine reminders, and every alert keeps the sensor reading that triggered it.';
const UNIQUE_C = 'Legal teams use the archive to answer questions about contract renewals, because every signed amendment is indexed by counterparty, effective date and the clause that changed. Search results show the surrounding paragraph, the approval chain, and a link to the original file stored in the document vault.';

function page(title, body) {
  return `<!DOCTYPE html><html><head><title>${title}</title></head><body><nav><a href="/">Home</a><a href="/pricing">Pricing</a></nav><main><h1>${title}</h1>${body}</main></body></html>`;
}

function makeSite(pages) {
  return http.createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname.replace(/\/$/, '') || '/';
    if (path === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(''); }
    const body = pages[path];
    if (!body) { res.writeHead(404, { 'content-type': 'text/html' }); return res.end('<h1>Not found</h1>'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  });
}

// A and B share SHARED verbatim; C is a different product entirely; D is thin.
const siteA = makeSite({
  '/': page('Aquaponics Control', `<p>${SHARED}</p><p>${UNIQUE_A}</p>`),
  '/pricing': page('Pricing', `<p>${SHARED}</p><p>Starter plan costs 29 dollars per month for up to five grow beds and includes email support with a four hour response target during business days.</p>`)
});
const siteB = makeSite({
  '/': page('Aquaponics Control', `<p>${SHARED}</p><p>We also publish an open API reference and a public status page so integrators can confirm sensor ingestion latency before they connect a new site.</p>`),
  '/pricing': page('Pricing', `<p>${SHARED}</p><p>Team plan costs 99 dollars per month for twenty grow beds with priority support and quarterly compliance reviews performed by our agronomy staff.</p>`)
});
const siteC = makeSite({
  '/': page('Contract Archive', `<p>${UNIQUE_C}</p><p>Retention policies can be configured per matter so closed engagements are archived after the statutory window instead of being kept indefinitely.</p>`),
  '/pricing': page('Pricing', '<p>Archive pricing is quoted per seat with volume discounts for firms above fifty lawyers.</p>')
});
const siteD = makeSite({
  '/': page('Thin', '<p>Hello world.</p>'),
  '/pricing': page('Pricing', '<p>Contact us.</p>')
});

const servers = [siteA, siteB, siteC, siteD];
let BASE = null;

async function ready() {
  if (BASE) return;
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  BASE = `http://127.0.0.1:${server.address().port}/api`;
  for (const s of servers) {
    if (!s.listening) {
      const up = new Promise((r) => s.once('listening', r));
      s.listen(0, '127.0.0.1');
      await up;
    }
  }
}

function origin(s) { return `http://127.0.0.1:${s.address().port}/`; }

function client() {
  let cookie = null;
  return async (path, opts = {}) => {
    const res = await fetch(BASE + path, {
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      redirect: 'manual',
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of sc) if (c.startsWith('shield_session=')) cookie = c.split(';')[0];
    let data = {};
    try { data = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, data };
  };
}

async function account(c) {
  const email = `d${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`;
  const su = await c('/auth/signup', { method: 'POST', body: { email, password: 'TestPass#123', workspace_name: 'Detect' } });
  assert.equal(su.status, 201);
  const me = await c('/auth/me');
  return me.data.workspaces[0].id;
}

async function addSite(c, ws, url) {
  const r = await c(`/workspaces/${ws}/websites`, { method: 'POST', body: { url, kind: 'comparison' } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.website.id;
}

async function runScan(c, ws, a, b, maxPages = 3) {
  const created = await c(`/workspaces/${ws}/scans`, { method: 'POST', body: { original_website_id: a, comparison_website_id: b, max_pages: maxPages } });
  assert.ok([201, 202].includes(created.status), JSON.stringify(created.data));
  const scanId = (created.data.scan || created.data).id;
  for (let i = 0; i < 60; i += 1) {
    const got = await c(`/workspaces/${ws}/scans/${scanId}`);
    const scan = got.data.scan || got.data;
    if (scan.status === 'completed' || scan.status === 'failed') return scan;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('scan did not finish');
}

after(() => Promise.all([server, ...servers].map((s) => new Promise((r) => (s.listening ? s.close(r) : r())))));

test('a verbatim shared paragraph is detected with evidence, and a distinct site is not', async () => {
  await ready();
  const c = client();
  const ws = await account(c);
  const a = await addSite(c, ws, origin(siteA));
  const b = await addSite(c, ws, origin(siteB));
  const d = await addSite(c, ws, origin(siteD));

  // ---- positive: A vs B share SHARED verbatim ----
  const pos = await runScan(c, ws, a, b);
  assert.equal(pos.status, 'completed');
  assert.ok(pos.pages_compared >= 1, `pages must be compared, got ${pos.pages_compared}`);
  assert.ok(pos.findings >= 1, `verbatim overlap must produce a finding, got ${pos.findings}`);

  const results = (await c(`/workspaces/${ws}/results?scan_id=${pos.id}`)).data.results || [];
  assert.ok(results.length >= 1, 'findings are persisted');
  const top = results.sort((x, y) => y.cosine_score - x.cosine_score)[0];
  assert.ok(top.jaccard_score > 0.2, `shingle overlap should be high, got ${top.jaccard_score}`);
  assert.ok(['long_passage', 'partial_passage'].includes(top.match_type), `match type was ${top.match_type}`);
  assert.ok(top.verdict, 'a human-readable verdict is attached');

  const detail = (await c(`/workspaces/${ws}/results/${top.id}`)).data.result;
  const passages = detail.passages || [];
  assert.ok(passages.length >= 1, 'the shared passage is stored as evidence');
  assert.ok(String(passages[0].original_text).includes('aquaponics control system'), 'passage text is the real overlap');

  // ---- negative: A vs D (thin pages) must compare nothing, honestly ----
  const thin = await runScan(c, ws, a, d);
  assert.equal(thin.status, 'completed');
  assert.equal(thin.pages_compared, 0, 'thin pages must not be counted as comparisons');
  assert.equal(thin.findings, 0, 'thin pages must not invent findings');
  const thinResults = (await c(`/workspaces/${ws}/results?scan_id=${thin.id}`)).data.results || [];
  assert.equal(thinResults.length, 0, 'no results are fabricated for thin pages');
});

test('unrelated sites score low, and verdicts explain the difference', async () => {
  await ready();
  const c = client();
  const ws = await account(c);
  const a = await addSite(c, ws, origin(siteA));
  const cSite = await addSite(c, ws, origin(siteC));
  const scan = await runScan(c, ws, a, cSite);
  assert.equal(scan.status, 'completed');
  assert.ok(scan.pages_compared >= 1, 'substantive pages must be compared');
  assert.equal(scan.findings, 0, 'different products must not be reported as copying');
});

test('pages are discovered from navigation and from the sitemap', async () => {
  await ready();
  const c = client();
  const ws = await account(c);
  const sitemapSite = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${sitemapSite.address().port}`;
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(`Sitemap: ${base}/sitemap.xml\n`); }
    if (p === '/sitemap.xml') {
      res.writeHead(200, { 'content-type': 'application/xml' });
      return res.end(`<urlset><url><loc>${base}/</loc></url><url><loc>${base}/pricing</loc></url><url><loc>${base}/features</loc></url></urlset>`);
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page(p === '/' ? 'Home' : p.slice(1), `<p>${SHARED}</p>`));  // no nav links at all
  });
  const up = new Promise((r) => sitemapSite.once('listening', r));
  sitemapSite.listen(0, '127.0.0.1');
  await up;
  const id = await addSite(c, ws, `http://127.0.0.1:${sitemapSite.address().port}/`);
  const mon = await c(`/workspaces/${ws}/websites/${id}/monitor`, { method: 'POST', body: { enabled: true, roles: ['homepage', 'pricing', 'features'] } });
  assert.equal(mon.status, 200, JSON.stringify(mon.data));
  const roles = (mon.data.pages || []).map((p) => p.role).sort();
  assert.deepEqual(roles, ['features', 'homepage', 'pricing'], 'sitemap supplied every page, the landing page has no links');
  assert.equal(mon.data.sitemap.used, true);
  assert.ok(mon.data.sitemap.urls >= 3, `sitemap urls read: ${mon.data.sitemap.urls}`);
  await new Promise((r) => sitemapSite.close(r));
});
