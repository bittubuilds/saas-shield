'use strict';
// Frontend render tests for the three-screen interface (dashboard, scan
// progress, report) plus URL validation.
//
// The pages are plain ES2020 in public/app.<hash>.js with no build step, so this
// suite loads the real HTML and the real script into a DOM and drives them with a
// stubbed fetch. That proves the wiring: which endpoint each screen calls, what it
// renders from the response, and that an offline or empty response degrades
// instead of throwing.
//
// jsdom is an optional local dependency. Without it the suite skips rather than
// failing, because the product has no runtime dependency on it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch { JSDOM = null; }
const skip = JSDOM ? false : 'jsdom is not installed (npm install --no-save jsdom)';

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'app.html'), 'utf8');
const scriptSrc = (html.match(/src="(\/app\.[a-z0-9]+\.js)"/) || [])[1];
const scriptBody = fs.readFileSync(path.join(PUBLIC, scriptSrc.replace(/^\//, '')), 'utf8');

const ME = { user: { email: 'founder@example.com', email_verified: true, role: 'owner' }, workspaces: [{ id: 'ws1', name: 'Acme' }] };

// Routes the interface is expected to call, and what each returns in the fixture.
function fixture(overrides = {}) {
  const calls = [];
  const routes = {
    '/auth/me': () => ME,
    '/workspaces/ws1/dashboard': () => ({ monitored_websites: 2, scans_completed: 5, findings_total: 7, scans_failed: 1, recent_results: [] }),
    '/workspaces/ws1/scans': () => ({
      scans: [{ id: 'scn1', status: 'completed', original_url: 'https://acme.test', comparison_url: 'https://rival.test', original_website_id: 'web1', created_at: '2026-11-06T09:00:00.000Z' }]
    }),
    '/workspaces/ws1/websites': () => ({ websites: [{ id: 'web1', url: 'https://acme.test', domain: 'acme.test', kind: 'original' }] }),
    '/workspaces/ws1/websites/web1/initial-scan': () => ({
      website: { id: 'web1', url: 'https://acme.test', crawl_status: 'crawled', pages_discovered: 9, registered: true },
      comparison: { available: true, competitors_in_workspace: 2 },
      discovery: { id: 'dis1', status: 'completed' },
      scan: { id: 'scn1', status: 'completed', pages_compared: 6, findings: 3, error: null, created_at: '2026-11-06T09:00:00.000Z', finished_at: '2026-11-06T09:02:30.000Z' },
      findings_total: 3,
      done: true
    }),
    '/workspaces/ws1/results?scan_id=scn1&limit=6': () => ({
      results: [
        { id: 'res1', match_type: 'long_passage', original_url: 'https://acme.test/a', comparison_url: 'https://rival.test/a', jaccard_score: 0.82, status: 'new' },
        { id: 'res2', match_type: 'phrase', original_url: 'https://acme.test/b', comparison_url: 'https://rival.test/b', jaccard_score: 0.41, status: 'in_review' }
      ]
    }),
    '/workspaces/ws1/scans/scn1/ai': () => ({ ok: true, ai_configured: false, model: 'openai/gpt-oss-120b', report: null }),
    '/workspaces/ws1/screenshots/capability': () => ({ enabled: false, browser: { available: false }, storage: { provider: 'local' } }),
    '/workspaces/ws1/competitors': () => ({ competitors: [{ id: 'c1', domain: 'rival.test' }] }),
    '/workspaces/ws1/members': () => ({ members: [{ email: 'founder@example.com', role: 'owner' }] })
  };
  Object.assign(routes, overrides);

  const fetchStub = async (url, opts = {}) => {
    const rel = String(url).replace(/^\/api/, '');
    const key = rel.split('?')[0] + (rel.includes('?') ? '?' + rel.split('?')[1] : '');
    calls.push({ path: key, method: (opts.method || 'GET').toUpperCase() });
    let handler = routes[key];
    if (!handler) handler = routes[rel.split('?')[0]];
    if (!handler) {
      return { ok: false, status: 404, json: async () => ({ error: 'no fixture for ' + key }) };
    }
    return { ok: true, status: 200, json: async () => handler({ method: opts.method, body: opts.body }) };
  };
  return { fetchStub, calls };
}

async function boot(overrides) {
  const f = fixture(overrides);
  const dom = new JSDOM(html, { url: 'http://127.0.0.1/app', runScripts: 'outside-only', pretendToBeVisual: true });
  dom.window.fetch = f.fetchStub;
  dom.window.eval(scriptBody.replace("'use strict';", ''));
  await new Promise((r) => setTimeout(r, 80));
  return { dom, doc: dom.window.document, win: dom.window, calls: f.calls };
}

test('the dashboard mounts inside the new shell', { skip }, async () => {
  const { doc, win, calls } = await boot();
  const text = doc.body.textContent;

  assert.ok(doc.querySelector('.topbar'), 'top navigation renders');
  assert.ok(doc.querySelector('#menuBtn'), 'hamburger button renders');
  assert.equal(doc.querySelectorAll('#menuPanel a.menu-link').length, 6, 'menu carries the six real destinations');
  assert.ok(doc.querySelector('.site-footer').textContent.includes('Bittu Builds'), 'footer branding is present');
  assert.ok(doc.querySelector('.site-footer').textContent.includes('Build. Grow. Dominate.'), 'footer tagline is present');
  assert.ok(text.includes('Protect Your SaaS Business'), 'hero heading renders');
  assert.ok(doc.querySelector('#urlForm') && doc.querySelector('#urlInput'), 'URL entry is present');
  assert.equal(doc.querySelectorAll('.feature-card').length, 4, 'four feature cards');
  assert.ok(calls.some((c) => c.path === '/workspaces/ws1/dashboard'), 'dashboard counts come from the API');
  // Numbers on screen must be the ones the API returned, not literals in the file.
  const nums = [...doc.querySelectorAll('.kpi .num')].map((n) => n.textContent.trim());
  assert.deepEqual(nums, ['2', '5', '7', '1'], 'KPI values are the response values');
  win.close();
});

test('URL entry rejects what the server would reject, and accepts the rest', { skip }, async () => {
  const { win } = await boot();
  const parse = win.parseUserUrl;
  assert.equal(parse('').ok, false);
  assert.equal(parse('   ').ok, false);
  assert.equal(parse('not a domain').ok, false);
  assert.equal(parse('ftp://example.com').ok, false);
  assert.equal(parse('http://user:pass@example.com').ok, false);
  assert.equal(parse('localhost:3000').ok, false);
  assert.equal(parse('127.0.0.1').ok, false);
  assert.equal(parse('192.168.1.5').ok, false);
  assert.equal(parse('169.254.169.254').ok, false);
  assert.equal(parse('box.local').ok, false);

  const bare = parse('acme.test');
  assert.equal(bare.ok, true);
  assert.equal(bare.url, 'https://acme.test/');
  const sec = parse('https://acme.test/pricing?a=1');
  assert.equal(sec.ok, true);
  assert.match(sec.url, /^https:\/\/acme\.test\/pricing/);
  win.close();
});

test('a submitted URL adds the website with auto-scan and moves to the scan screen', { skip }, async () => {
  let posted = null;
  const { win, doc } = await boot({
    '/workspaces/ws1/websites': (req) => {
      if (req.method === 'POST') {
        posted = JSON.parse(req.body);
        return null;
      }
      return { websites: [] };
    }
  });
  // POST returns a 201 shape; the generic stub returns the same body for GET, so
  // patch fetch for the POST only.
  const realFetch = win.fetch;
  win.fetch = async (url, opts = {}) => {
    if (String(url) === '/api/workspaces/ws1/websites' && (opts.method || 'GET') === 'POST') {
      posted = JSON.parse(opts.body);
      return { ok: true, status: 201, json: async () => ({ website: { id: 'webNew', url: 'https://acme.test/', domain: 'acme.test' }, initial_scan: { mode: 'compare', started: true, scan_id: 'scnNew' } }) };
    }
    return realFetch(url, opts);
  };

  const input = doc.querySelector('#urlInput');
  input.value = 'acme.test';
  await win.submitUrlForm(new win.Event('submit'));

  assert.ok(posted, 'the website POST was made');
  assert.equal(posted.kind, 'original');
  assert.equal(posted.auto_scan, true);
  assert.equal(posted.url, 'https://acme.test/');
  assert.equal(win.location.hash, '#/scan/webNew', 'navigates to the scan screen for the created site');
  win.close();
});

test('a rejected request keeps the user on the dashboard with the reason', { skip }, async () => {
  const { win, doc } = await boot();
  const realFetch = win.fetch;
  win.fetch = async (url, opts = {}) => {
    if (String(url) === '/api/workspaces/ws1/websites' && (opts.method || 'GET') === 'POST') {
      return { ok: false, status: 409, json: async () => ({ error: 'This workspace already has an original website.' }) };
    }
    return realFetch(url, opts);
  };
  doc.querySelector('#urlInput').value = 'other.test';
  await win.submitUrlForm(new win.Event('submit'));
  const err = doc.querySelector('#urlError').textContent;
  assert.match(err, /already has an original website/);
  assert.equal(doc.querySelector('#urlGo').disabled, false, 'the button is usable again');
  win.close();
});

test('the scan screen has no invented progress: a finished scan is 100%, a crawling one is not', { skip }, async () => {
  const done = await boot();
  const doneHtml = await done.win.scanProgressView('web1');
  assert.ok(doneHtml.includes('View report'), 'a finished scan offers the report');
  assert.match(doneHtml, /aria-valuenow="100"/, 'a finished scan reports 100%');
  assert.ok(doneHtml.includes('Screenshots'), 'the screenshot stage is still listed');
  assert.ok(doneHtml.includes('no browser available in this deployment'), 'and states why it did nothing');
  done.win.close();

  const running = await boot({
    '/workspaces/ws1/websites/web1/initial-scan': () => ({
      website: { id: 'web1', url: 'https://acme.test', crawl_status: 'crawling', pages_discovered: 0, registered: true },
      comparison: { available: false, competitors_in_workspace: 0 },
      discovery: null,
      scan: null,
      findings_total: 0,
      done: false
    })
  });
  const runningHtml = await running.win.scanProgressView('web1');
  const pct = Number((runningHtml.match(/aria-valuenow="(\d+)"/) || [])[1]);
  assert.ok(pct > 0 && pct < 100, `a running scan shows partial progress, got ${pct}`);
  assert.ok(!runningHtml.includes('View report'), 'no report link before the backend confirms completion');
  running.win.close();
});

test('the report renders server metrics, real findings and a working download link', { skip }, async () => {
  const { win } = await boot();
  const htmlOut = await win.reportView('web1');
  assert.ok(htmlOut.includes('https://acme.test'), 'the scanned site is named');
  assert.ok(htmlOut.includes('Potential findings'), 'metrics are labelled');
  assert.ok(htmlOut.includes('long passage') && htmlOut.includes('phrase'), 'findings come from the results API');
  assert.ok(htmlOut.includes('82.0%'), 'scores are the stored scores');
  assert.match(htmlOut, /href="\/api\/workspaces\/ws1\/reports\/export\.pdf\?result_id=res1"/, 'deterministic PDF is linked to the top finding');
  assert.match(htmlOut, /href="#\/results\/res1"/, 'View Details opens the existing result screen');
  assert.ok(htmlOut.includes('AI analysis is not configured'), 'an unconfigured provider is stated plainly');
  win.close();
});

test('the report links the AI PDF only when a report actually exists', { skip }, async () => {
  const { win } = await boot({
    '/workspaces/ws1/scans/scn1/ai': () => ({ ok: true, ai_configured: true, model: 'openai/gpt-oss-120b', report: { id: 'rep1', version: 3, created_at: '2026-11-06T10:00:00.000Z' } })
  });
  const out = await win.reportView('web1');
  assert.match(out, /href="\/api\/workspaces\/ws1\/scans\/scn1\/ai\/report\.pdf\?version=3"/, 'AI PDF uses the stored version');
  assert.ok(out.includes('Run AI analysis') === false, 'no run button when a report already exists');
  win.close();
});

test('a site with no scan yet explains itself instead of showing an empty report', { skip }, async () => {
  const { win } = await boot({
    '/workspaces/ws1/websites/web1/initial-scan': () => ({
      website: { id: 'web1', url: 'https://acme.test', crawl_status: 'not_crawled', pages_discovered: 0, registered: true },
      comparison: { available: false, competitors_in_workspace: 0 },
      discovery: { id: 'dis1', status: 'running' },
      scan: null,
      findings_total: 0,
      done: false
    })
  });
  const out = await win.reportView('web1');
  assert.ok(out.includes('No report yet'), 'states there is no report');
  assert.ok(out.includes('running'), 'reports the discovery state it was given');
  assert.ok(!out.includes('Download Report'), 'no download affordance for a report that does not exist');
  win.close();
});

test('a failed scan shows its stored reason and an honest retry', { skip }, async () => {
  const { win } = await boot({
    '/workspaces/ws1/websites/web1/initial-scan': () => ({
      website: { id: 'web1', url: 'https://acme.test', crawl_status: 'failed', pages_discovered: 0, crawl_error: 'the site returned HTTP 503', registered: true },
      comparison: { available: false, competitors_in_workspace: 0 },
      discovery: null,
      scan: { id: 'scn1', status: 'failed', pages_compared: 0, findings: 0, error: 'the site returned HTTP 503', created_at: '2026-11-06T09:00:00.000Z', finished_at: null },
      findings_total: 0,
      done: true
    })
  });
  const out = await win.scanProgressView('web1');
  assert.ok(out.includes('did not finish'), 'says the scan failed');
  assert.ok(out.includes('HTTP 503'), 'quotes the stored error');
  assert.match(out, /data-retry-scan="scn1"/, 'offers the real retry action');
  assert.ok(!out.includes('View report'), 'a failed scan has no report link');
  win.close();
});

test('an API outage on the dashboard still renders a usable page', { skip }, async () => {
  const { doc, win } = await boot({
    '/workspaces/ws1/dashboard': () => { throw new Error('boom'); },
    '/workspaces/ws1/scans': () => { throw new Error('boom'); }
  });
  assert.ok(doc.querySelector('#urlForm'), 'the primary action survives a failing summary call');
  assert.ok(doc.querySelector('.hero-title'), 'the page still renders');
  win.close();
});
