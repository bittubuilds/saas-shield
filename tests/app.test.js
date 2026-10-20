'use strict';
// Application integration tests: auth, workspace isolation, websites, the full
// scan lifecycle against two controlled local test sites (one with duplicated
// text, one unrelated), review actions, exports, and persistence.
process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.DATABASE_FILE = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'shield-')) + '/test.db';
process.env.SHIELD_ALLOW_PRIVATE_IPS = 'true';   // local test sites only
process.env.CRAWL_DELAY_MS = '50';
process.env.AUTH_RATE_LIMIT = '100';
process.env.COOKIE_SECURE = 'false';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');

const { server } = require('../src/server');
let BASE = null;    // API base (ends with /api)
let ROOT = null;    // site root
async function ready() {
  if (BASE) return;
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  ROOT = `http://127.0.0.1:${server.address().port}`;
  BASE = ROOT + '/api';
}

const COPIED = `Our platform helps modern logistics teams coordinate warehouse operations in real time.
Every shipment gets a live tracking timeline, predictive arrival windows, and automated
exception alerts routed to the right operator. Customers report forty percent fewer
support tickets, thirty percent faster dock turnaround, and a complete audit trail of
every handoff. The engine models each facility as a graph of dock doors, staging lanes,
and carrier commitments, then optimizes the entire day of arrivals before the first
truck rolls in, keeping promises honest even when weather or traffic breaks the schedule.`;
const COPIED_WORDS = COPIED.split(/\s+/).length; // > 100 words

function filler(n, prefix) {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ');
}

function page(title, body) {
  return `<!DOCTYPE html><html><head><title>${title}</title></head><body>${body}</body></html>`;
}

function startSite(routes) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      const handler = routes[req.url];
      if (handler) { res.end(handler); return; }
      res.statusCode = 404;
      res.end('not found');
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

// HTTP client with a cookie jar
function client() {
  let cookie = null;
  return {
    async req(method, path, body) {
      const res = await fetch(BASE + path, {
        method,
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(cookie ? { cookie } : {})
        },
        body: body ? JSON.stringify(body) : undefined
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, data, headers: res.headers, text };
    },
    getCookie: () => cookie,
    setCookie: (c) => { cookie = c; }
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForScan(c, wsId, scanId, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { data } = await c.req('GET', `/workspaces/${wsId}/scans/${scanId}`);
    if (['completed', 'failed', 'cancelled'].includes(data.scan.status)) return data.scan;
    await sleep(300);
  }
  throw new Error('scan did not finish in time');
}

// ---------------------------------------------------------------------------
// Controlled test sites
// ---------------------------------------------------------------------------
const ORIG_HOME = page('Home', `<nav>Home Pricing About Contact</nav>
  <main><h1>ShipFlow</h1><p>${COPIED}</p><p>${filler(60, 'orig')}</p></main>
  <a href="/pricing">Pricing</a> <a href="/about">About</a>`);
const ORIG_PRICING = page('Pricing', `<nav>Home Pricing About Contact</nav>
  <main><p>${filler(80, 'price')}</p></main><a href="/">Home</a>`);
const ORIG_ABOUT = page('About', `<nav>Home Pricing About Contact</nav>
  <main><p>${filler(80, 'aboutus')}</p></main><a href="/">Home</a>`);

const DUP_HOME = page('Copycat Home', `<nav>Home Services Contact</nav>
  <main><p>${COPIED}</p><p>${filler(50, 'copyfill')}</p></main><a href="/services">Services</a>`);
const DUP_SERVICES = page('Services', `<main><p>${filler(80, 'svc')}</p></main><a href="/">Home</a>`);

const UNRELATED_HOME = page('Tea Shop', `<nav>Home Blends Contact</nav>
  <main><p>We roast single-origin coffee beans every Tuesday morning and ship fresh
  batches across the city. Our blends are named after local parks, and every purchase
  funds a community garden plot for a school. ${filler(80, 'tea')}</p></main>`);

test('complete user journey: signup, websites, real scan, review, export, persistence', async (t) => {
  await ready();
  const origSite = await startSite({ '/': ORIG_HOME, '/pricing': ORIG_PRICING, '/about': ORIG_ABOUT });
  const dupSite = await startSite({ '/': DUP_HOME, '/services': DUP_SERVICES });
  const unrelSite = await startSite({ '/': UNRELATED_HOME });
  t.after(() => { origSite.srv.close(); dupSite.srv.close(); unrelSite.srv.close(); });

  const a = client();

  // --- unauthenticated access is blocked ---
  {
    const r = await a.req('GET', '/auth/me');
    assert.equal(r.status, 401);
    const r2 = await a.req('GET', `/workspaces/anything/results`);
    assert.equal(r2.status, 401);
  }

  // --- 1. sign up (workspace auto-created) ---
  const signup = await a.req('POST', '/auth/signup', { email: 'founder@example.com', password: 'longpassword1', workspace_name: 'ShipFlow Inc' });
  assert.equal(signup.status, 201);
  const wsId = signup.data.workspace.id;
  assert.ok(wsId);
  const badSignup = await a.req('POST', '/auth/signup', { email: 'founder@example.com', password: 'longpassword1' });
  assert.equal(badSignup.status, 409);
  const weakPw = await a.req('POST', '/auth/signup', { email: 'x@example.com', password: 'short' });
  assert.equal(weakPw.status, 400);

  // --- 2. add original website; validation + duplicate rules ---
  const origAdd = await a.req('POST', `/workspaces/${wsId}/websites`, { url: `http://127.0.0.1:${origSite.port}/`, kind: 'original' });
  assert.equal(origAdd.status, 201);
  const origId = origAdd.data.website.id;
  const secondOrig = await a.req('POST', `/workspaces/${wsId}/websites`, { url: `http://127.0.0.1:${origSite.port}/`, kind: 'original' });
  assert.equal(secondOrig.status, 409, 'only one original per workspace');
  for (const badUrl of ['notaurl', 'ftp://example.com/x', 'http://user:pw@example.com/']) {
    const r = await a.req('POST', `/workspaces/${wsId}/websites`, { url: badUrl, kind: 'comparison' });
    assert.equal(r.status, 400, `should reject ${badUrl}`);
  }

  // --- 3. add comparison websites (copier + unrelated) ---
  const dupAdd = await a.req('POST', `/workspaces/${wsId}/websites`, { url: `http://127.0.0.1:${dupSite.port}/`, kind: 'comparison', label: 'Copycat' });
  assert.equal(dupAdd.status, 201);
  const dupId = dupAdd.data.website.id;
  const dupAgain = await a.req('POST', `/workspaces/${wsId}/websites`, { url: `http://127.0.0.1:${dupSite.port}/`, kind: 'comparison' });
  assert.equal(dupAgain.status, 409, 'duplicate comparison rejected');
  const unrelAdd = await a.req('POST', `/workspaces/${wsId}/websites`, { url: `http://127.0.0.1:${unrelSite.port}/`, kind: 'comparison' });
  assert.equal(unrelAdd.status, 201);
  const unrelId = unrelAdd.data.website.id;

  // --- 4. run a real scan against the copying site ---
  const scan1 = await a.req('POST', `/workspaces/${wsId}/scans`, { original_website_id: origId, comparison_website_id: dupId });
  assert.equal(scan1.status, 202);
  const dupScan = await a.req('POST', `/workspaces/${wsId}/scans`, { original_website_id: origId, comparison_website_id: dupId });
  assert.equal(dupScan.status, 409, 'duplicate concurrent scan blocked');
  const finished = await waitForScan(a, wsId, scan1.data.scan.id);
  assert.equal(finished.status, 'completed', `scan error: ${finished.error}`);
  assert.ok(finished.pages_compared >= 1);

  // crawled pages recorded on both sites
  const origPages = await a.req('GET', `/workspaces/${wsId}/websites/${origId}/pages`);
  assert.ok(origPages.data.pages.length >= 3, 'original site pages extracted');
  const sites = await a.req('GET', `/workspaces/${wsId}/websites`);
  const dupSiteRow = sites.data.websites.find((w) => w.id === dupId);
  assert.equal(dupSiteRow.crawl_status, 'crawled');
  assert.ok(dupSiteRow.accessible_page_count >= 2);

  // --- 5. results show the duplicated passage ---
  const results = await a.req('GET', `/workspaces/${wsId}/results`);
  assert.ok(results.data.results.length >= 1, 'expected at least one potential match');
  const best = results.data.results[0];
  assert.equal(best.status, 'new');
  assert.ok(best.jaccard_score > 0, 'real score derived from content');

  const detail = await a.req('GET', `/workspaces/${wsId}/results/${best.id}`);
  assert.equal(detail.status, 200);
  const r = detail.data.result;
  assert.ok(r.passages.length >= 1, 'matching passages extracted');
  const passage = r.passages[0];
  assert.ok(passage.word_count >= COPIED_WORDS - 10, `long passage expected, got ${passage.word_count} words`);
  assert.ok(passage.original_text.includes('warehouse operations in real time'));
  assert.ok(r.evidence && r.evidence.capture_status === 'captured');
  assert.ok(r.evidence.original_hash.length === 64 && r.evidence.comparison_hash.length === 64);
  assert.ok(r.evidence.captured_at);
  assert.equal(r.evidence.screenshot_ref, null, 'screenshots must be reported honestly as absent');
  assert.ok(r.scoring_method.includes('Jaccard'));

  // --- 6. scan against the unrelated site: no fabricated findings ---
  const scan2 = await a.req('POST', `/workspaces/${wsId}/scans`, { original_website_id: origId, comparison_website_id: unrelId });
  assert.equal(scan2.status, 202);
  const finished2 = await waitForScan(a, wsId, scan2.data.scan.id);
  assert.equal(finished2.status, 'completed');
  const resultsAfter2 = await a.req('GET', `/workspaces/${wsId}/results`);
  const unrelFindings = resultsAfter2.data.results.filter((x) => x.comparison_url.includes(`:${unrelSite.port}`));
  assert.equal(unrelFindings.length, 0, 'unrelated site must produce no findings');
  assert.equal(finished2.findings, 0, 'scan stats must agree');

  // --- 7. review status changes are persisted and audited ---
  const patch = await a.req('PATCH', `/workspaces/${wsId}/results/${best.id}`, { status: 'in_review', note: 'Checking with counsel' });
  assert.equal(patch.status, 200);
  const badPatch = await a.req('PATCH', `/workspaces/${wsId}/results/${best.id}`, { status: 'stolen' });
  assert.equal(badPatch.status, 400);
  const detail2 = await a.req('GET', `/workspaces/${wsId}/results/${best.id}`);
  assert.equal(detail2.data.result.status, 'in_review');
  assert.ok(detail2.data.result.review_history.length >= 1);
  assert.equal(detail2.data.result.review_history[0].to_status, 'in_review');
  assert.equal(detail2.data.result.review_history[0].user_email, 'founder@example.com');

  // filters
  const filterStatus = await a.req('GET', `/workspaces/${wsId}/results?status=in_review`);
  assert.ok(filterStatus.data.results.length >= 1);
  const filterConfirmed = await a.req('GET', `/workspaces/${wsId}/results?status=confirmed`);
  assert.equal(filterConfirmed.data.results.length, 0);
  const filterMin = await a.req('GET', `/workspaces/${wsId}/results?min_score=0.99`);
  assert.equal(filterMin.data.results.length, 0);

  // --- 8. exports (JSON + PDF) ---
  const jsonRep = await a.req('GET', `/workspaces/${wsId}/reports/export`);
  const rep = JSON.parse(jsonRep.text);
  assert.ok(rep.findings.length >= 1);
  assert.ok(rep.methodology.length >= 3 && rep.limitations.length >= 1);
  assert.ok(rep.findings[0].passages.length >= 1);
  const pdfRep = await a.req('GET', `/workspaces/${wsId}/reports/export.pdf`);
  assert.ok(pdfRep.text.startsWith('%PDF'), 'valid PDF');
  const singlePdf = await a.req('GET', `/workspaces/${wsId}/reports/export.pdf?result_id=${best.id}`);
  assert.ok(singlePdf.text.startsWith('%PDF'));
  const missingRep = await a.req('GET', `/workspaces/${wsId}/reports/export?result_id=res_doesnotexist`);
  assert.equal(missingRep.status, 404);

  // --- 9. dashboard shows real numbers ---
  const dash = await a.req('GET', `/workspaces/${wsId}/dashboard`);
  assert.equal(dash.status, 200, `dashboard failed: ${JSON.stringify(dash.data)}`);
  assert.equal(dash.data.monitored_websites, 3);
  assert.equal(dash.data.scans_completed, 2);
  assert.equal(dash.data.findings_total, resultsAfter2.data.results.length);
  assert.ok(dash.data.last_successful_scan);

  // --- 10. sign out / sign back in; data persists ---
  await a.req('POST', '/auth/signout');
  const meAfter = await a.req('GET', '/auth/me');
  assert.equal(meAfter.status, 401);
  const signin = await a.req('POST', '/auth/signin', { email: 'founder@example.com', password: 'longpassword1' });
  assert.equal(signin.status, 200);
  const resultsAgain = await a.req('GET', `/workspaces/${wsId}/results`);
  assert.equal(resultsAgain.data.results.length, resultsAfter2.data.results.length);
  const badPassword = await a.req('POST', '/auth/signin', { email: 'founder@example.com', password: 'wrongpassword' });
  assert.equal(badPassword.status, 401);

  // --- 11. workspace isolation: another user cannot see or touch anything ---
  const b = client();
  const bSignup = await b.req('POST', '/auth/signup', { email: 'other@example.com', password: 'anotherpass123' });
  assert.equal(bSignup.status, 201);
  const bWs = bSignup.data.workspace.id;
  const bMe = await b.req('GET', '/auth/me');
  assert.equal(bMe.data.workspaces.length, 1);
  const crossRead = await b.req('GET', `/workspaces/${wsId}/results`);
  assert.equal(crossRead.status, 404, 'cross-workspace read must fail');
  const crossList = await b.req('GET', `/workspaces/${wsId}/websites`);
  assert.equal(crossList.status, 404);
  const crossPatch = await b.req('PATCH', `/workspaces/${wsId}/websites/${origId}`, { status: 'paused' });
  assert.equal(crossPatch.status, 404);
  const crossResultDetail = await b.req('GET', `/workspaces/${wsId}/results/${best.id}`);
  assert.equal(crossResultDetail.status, 404);
  const crossScan = await b.req('POST', `/workspaces/${wsId}/scans`, { original_website_id: origId, comparison_website_id: dupId });
  assert.equal(crossScan.status, 404);
  // B can register the same URL in their own workspace
  const bAdd = await b.req('POST', `/workspaces/${bWs}/websites`, { url: `http://127.0.0.1:${origSite.port}/`, kind: 'original' });
  assert.equal(bAdd.status, 201);
  const bDash = await b.req('GET', `/workspaces/${bWs}/dashboard`);
  assert.equal(bDash.data.monitored_websites, 1);
  assert.equal(bDash.data.scans_completed, 0);

  // --- 12. website pause/delete lifecycle ---
  const pause = await a.req('PATCH', `/workspaces/${wsId}/websites/${unrelId}`, { status: 'paused' });
  assert.equal(pause.status, 200);
  const scanPaused = await a.req('POST', `/workspaces/${wsId}/scans`, { original_website_id: origId, comparison_website_id: unrelId });
  assert.equal(scanPaused.status, 400, 'paused sites cannot be scanned');
  const resume = await a.req('PATCH', `/workspaces/${wsId}/websites/${unrelId}`, { status: 'active' });
  assert.equal(resume.status, 200);
  const del = await a.req('DELETE', `/workspaces/${wsId}/websites/${unrelId}`);
  assert.equal(del.status, 200);
  const gone = await a.req('GET', `/workspaces/${wsId}/websites/${unrelId}/pages`);
  assert.equal(gone.status, 404);

  // members management
  const addMember = await a.req('POST', `/workspaces/${wsId}/members`, { email: 'other@example.com', role: 'member' });
  assert.equal(addMember.status, 201);
  const bMemberList = await b.req('GET', `/workspaces/${wsId}/websites`);
  assert.equal(bMemberList.status, 200, 'member can now access workspace');

  try { fs.rmSync(process.env.DATABASE_FILE, { force: true }); } catch {}
});

test('landing and app pages serve, unknown API paths 404', async (t) => {
  await ready();
  const landing = await fetch(ROOT + '/');
  assert.equal(landing.status, 200);
  assert.ok((await landing.text()).includes('SaaS Shield'));
  const appHtml = await fetch(ROOT + '/app');
  assert.equal(appHtml.status, 200);
  const css = await fetch(ROOT + '/styles.css');
  assert.equal(css.status, 200);
  const noRoute = await fetch(BASE + '/nothing');
  assert.ok([401, 404].includes(noRoute.status), 'unknown api path must not leak anything');
  const deepLink = await fetch(ROOT + '/app/results/xyz');
  assert.equal(deepLink.status, 200);

  // PWA assets serve correctly (installable web app)
  const manifest = await fetch(ROOT + '/manifest.webmanifest');
  assert.equal(manifest.status, 200);
  assert.equal(manifest.headers.get('content-type'), 'application/manifest+json');
  const man = await manifest.json();
  assert.equal(man.name, 'SaaS Shield');
  assert.ok(man.icons.length >= 2);
  const sw = await fetch(ROOT + '/sw.js');
  assert.equal(sw.status, 200);
  const icon = await fetch(ROOT + '/icon-192.png');
  assert.equal(icon.status, 200);
  const iconBuf = Buffer.from(await icon.arrayBuffer());
  assert.ok(iconBuf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'valid PNG');
  t.after(() => new Promise((r) => server.close(r)));
});
