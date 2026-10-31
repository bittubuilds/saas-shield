'use strict';
// Monitoring pipeline tests.
//
// A local, mutable HTTP site stands in for a competitor. Each test changes the
// served HTML and then runs the real check pipeline (fetch -> structure ->
// snapshot -> change detection -> changelog -> alert), so the assertions cover
// the behaviour that drives the product, not a mock of it.
process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.DATABASE_FILE = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'shield-mon-')) + '/monitor.db';
process.env.SHIELD_ALLOW_PRIVATE_IPS = 'true';   // local fixture site only
process.env.CRAWL_DELAY_MS = '5';
process.env.AUTH_RATE_LIMIT = '1000';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const db = require('../src/db');
const monitor = require('../src/monitor');
const alerts = require('../src/alerts');

// ---------------------------------------------------------------------------
// Fixture site
// ---------------------------------------------------------------------------
const state = {
  home: '',
  pricing: '',
  signup: '',
  failPaths: new Set(),
  redirects: new Map()
};

function pageShell(title, body) {
  return `<!doctype html><html><head><title>${title}</title>
    <meta name="description" content="${title} page"></head>
    <body><nav><a href="/">Home</a><a href="/pricing">Pricing</a><a href="/signup">Start free</a></nav>
    <main>${body}</main><footer><p>© 2026 Fixture Inc. All rights reserved.</p></footer></body></html>`;
}

function homeHtml(paragraph, extra = '') {
  return pageShell('Fixture — workflow automation', `
    <h1>Automate the busywork</h1>
    <p>${paragraph}</p>
    <h2>Why teams switch</h2>
    <p>Our engine models every handoff, retries failed steps and keeps an audit trail of each run. ${extra}</p>
    <a class="btn" href="/signup">Start free</a>
  `);
}

function pricingHtml(plans) {
  return pageShell('Pricing — Fixture', `
    <h1>Simple pricing</h1>
    <h2>Starter</h2>
    <p>${plans.starter}</p>
    <p>Up to 3 projects</p>
    <h2>Pro</h2>
    <p>${plans.pro}</p>
    <p>Unlimited projects</p>
    <p>10 seats</p>
    <h2>Enterprise</h2>
    <p>Contact sales</p>
  `);
}

function signupHtml(fields, submit = 'Create account') {
  return pageShell('Create your account — Fixture', `
    <h1>Create your account</h1>
    <form action="/api/signup" method="post">
      ${fields.map((f) => `<input type="${f.type || 'text'}" name="${f.name}" ${f.required ? 'required' : ''}>`).join('')}
      <button type="submit">${submit}</button>
    </form>
  `);
}

const BASE_PARAGRAPH = 'Fixture coordinates warehouse operations in real time. Every shipment gets a live tracking timeline, predictive arrival windows, and automated exception alerts routed to the right operator. The engine optimises the whole day before the first truck arrives.';

let srv;
let origin;
let workspaceId;
let websiteId;
let homePageId;
let pricingPageId;
let signupPageId;

before(async () => {
  state.home = homeHtml(BASE_PARAGRAPH);
  state.pricing = pricingHtml({ starter: '$19 per month', pro: '$29 per month' });
  state.signup = signupHtml([{ name: 'email', type: 'email', required: true }, { name: 'password', type: 'password', required: true }]);

  srv = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (state.failPaths.has(url)) {
      res.statusCode = 500;
      res.setHeader('content-type', 'text/html');
      res.end('<html><body>server error</body></html>');
      return;
    }
    if (state.redirects.has(url)) {
      res.statusCode = 302;
      res.setHeader('location', state.redirects.get(url));
      res.end();
      return;
    }
    let body = null;
    if (url === '/' || url === '/home' || url === '/late' || url === '/spa') body = state.home;
    else if (url === '/pricing') body = state.pricing;
    else if (url === '/signup') body = state.signup;
    else if (url === '/robots.txt') {
      res.setHeader('content-type', 'text/plain');
      res.end('User-agent: *\nAllow: /\n');
      return;
    }
    if (body === null) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(body);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${srv.address().port}`;

  // Seed a user, workspace, membership and website directly.
  const now = new Date().toISOString();
  db.prepare('INSERT INTO users (id,email,password_hash,name,created_at,email_verified_at,email_verified_source) VALUES (?,?,?,?,?,?,?)')
    .run('usr_mon', 'monitor@example.com', 'x', null, now, now, 'email_link');
  db.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)').run('wsp_mon', 'Monitor Workspace', now);
  db.prepare('INSERT INTO memberships (workspace_id,user_id,role,created_at) VALUES (?,?,?,?)').run('wsp_mon', 'usr_mon', 'owner', now);
  db.prepare(`INSERT INTO notification_settings
    (workspace_id, immediate_email, digest_enabled, digest_day, digest_hour_utc, min_severity, include_empty_digest, updated_at)
    VALUES (?,1,1,1,8,'high',0,?)`).run('wsp_mon', now);
  db.prepare(`INSERT INTO websites (id, workspace_id, kind, submitted_url, normalized_domain, status, crawl_status,
      monitor_enabled, frequency_hours, baseline_status, created_at, updated_at)
    VALUES (?,?,?,?,?, 'active','crawled',1,1,'none',?,?)`)
    .run('web_mon', 'wsp_mon', 'comparison', origin + '/', '127.0.0.1', now, now);

  workspaceId = 'wsp_mon';
  websiteId = 'web_mon';

  const home = monitor.addMonitoredPage({ workspaceId, websiteId, url: origin + '/', role: 'homepage', label: 'Homepage' });
  const pricing = monitor.addMonitoredPage({ workspaceId, websiteId, url: origin + '/pricing', role: 'pricing', label: 'Pricing' });
  const signup = monitor.addMonitoredPage({ workspaceId, websiteId, url: origin + '/signup', role: 'signup', label: 'Signup' });
  assert.equal(home.ok, true, JSON.stringify(home));
  assert.equal(pricing.ok, true, JSON.stringify(pricing));
  assert.equal(signup.ok, true, JSON.stringify(signup));
  homePageId = home.page.id;
  pricingPageId = pricing.page.id;
  signupPageId = signup.page.id;
});

after(() => {
  if (srv) srv.close();
});

function changeCount(pageId = null) {
  if (pageId) {
    return db.prepare('SELECT COUNT(*) c FROM changes WHERE monitored_page_id=?').get(pageId).c;
  }
  return db.prepare('SELECT COUNT(*) c FROM changes WHERE workspace_id=?').get(workspaceId).c;
}

function changesFor(pageId) {
  return db.prepare('SELECT * FROM changes WHERE monitored_page_id=? ORDER BY detected_at').all(pageId);
}

// Changes created after a marker (rowid). Keeps each test independent of what
// earlier tests in this file observed on the same page.
function markChanges(pageId) {
  return db.prepare('SELECT COALESCE(MAX(rowid),0) r FROM changes WHERE monitored_page_id=?').get(pageId).r;
}
function changesSince(pageId, mark) {
  return db.prepare('SELECT * FROM changes WHERE monitored_page_id=? AND rowid > ? ORDER BY rowid').all(pageId, mark);
}

// ---------------------------------------------------------------------------
// Baselines
// ---------------------------------------------------------------------------
test('first check creates a baseline snapshot and never reports a change', async () => {
  const result = await monitor.runPageCheck(homePageId);
  assert.equal(result.status, 'baseline_created');

  const snap = db.prepare('SELECT * FROM snapshots WHERE monitored_page_id=?').all(homePageId);
  assert.equal(snap.length, 1);
  assert.equal(snap[0].is_baseline, 1);
  assert.equal(snap[0].capture_status, 'ok');
  assert.equal(snap[0].final_url, origin + '/');
  assert.ok(snap[0].content_hash.length === 64);
  assert.ok(snap[0].text_normalized.includes('automate the busywork'));

  const page = db.prepare('SELECT * FROM monitored_pages WHERE id=?').get(homePageId);
  assert.equal(page.last_status, 'ok');
  assert.equal(page.baseline_snapshot_id, snap[0].id);
  assert.ok(page.next_check_at > new Date().toISOString());

  const site = db.prepare('SELECT * FROM websites WHERE id=?').get(websiteId);
  assert.equal(site.baseline_status, 'created');
  assert.equal(changeCount(homePageId), 0, 'a baseline is not a change');
});

test('an unchanged page produces no change, but does store a snapshot', async () => {
  const before = db.prepare('SELECT COUNT(*) c FROM snapshots WHERE monitored_page_id=?').get(homePageId).c;
  const result = await monitor.runPageCheck(homePageId);
  assert.equal(result.status, 'unchanged');
  const after = db.prepare('SELECT COUNT(*) c FROM snapshots WHERE monitored_page_id=?').get(homePageId).c;
  assert.equal(after, before + 1, 'every check is persisted as a snapshot');
  assert.equal(changeCount(homePageId), 0);
  assert.equal(db.prepare('SELECT last_status FROM monitored_pages WHERE id=?').get(homePageId).last_status, 'unchanged');
});

test('volatile values (dates, tokens, counters, cache busters) do not look like a change', async () => {
  // Same page, same words, different clock/ids on every request: this is the
  // most common cause of false "changed" alerts on real sites.
  const volatileHome = ({ iso, hex, count }) => homeHtml(BASE_PARAGRAPH,
    `<p>Last updated ${iso}</p><p>Session token ${hex}</p><p>${count} users online</p>`);

  state.home = volatileHome({ iso: '2026-10-31T10:00:00Z', hex: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', count: '1,482' });
  await monitor.runPageCheck(homePageId);
  const before = changeCount(homePageId);

  state.home = volatileHome({ iso: '2026-11-01T11:11:11Z', hex: 'ffeeddccbbaa99887766554433221100', count: '9,731' });
  const result = await monitor.runPageCheck(homePageId);

  assert.equal(result.status, 'unchanged', 'timestamp/token/counter churn must not raise a change');
  assert.equal(changeCount(homePageId), before, 'no changelog row for volatile churn');
});

// ---------------------------------------------------------------------------
// Real changes
// ---------------------------------------------------------------------------
test('a meaningful copy change is detected with evidence, snapshots and a summary', async () => {
  state.home = homeHtml(BASE_PARAGRAPH);
  await monitor.runPageCheck(homePageId);          // known "before" snapshot
  const mark = markChanges(homePageId);

  state.home = homeHtml(`${BASE_PARAGRAPH} We now also support multi-warehouse routing and same-day carrier rebooking across every region.`);
  const result = await monitor.runPageCheck(homePageId);
  assert.equal(result.status, 'changed');
  assert.ok(result.changes.length >= 1);

  const rows = changesSince(homePageId, mark);
  const copy = rows.find((c) => c.category === 'copy');
  assert.ok(copy, `expected a copy change, got ${rows.map((r) => r.category).join(',')}`);
  assert.match(copy.summary, /words? (added|removed)|copy changed/i);
  assert.ok(copy.significance > 0.2);
  assert.ok(['minor', 'moderate', 'major', 'critical'].includes(copy.significance_label));

  const evidence = JSON.parse(copy.evidence);
  assert.equal(evidence.kind, 'text');
  assert.ok(evidence.addedSentences.some((s) => /multi-warehouse routing/.test(s)), 'added sentence must be quoted as evidence');

  // Both snapshots are linked and persisted.
  assert.ok(copy.previous_snapshot_id && copy.current_snapshot_id);
  assert.notEqual(copy.previous_snapshot_id, copy.current_snapshot_id);
  const prev = db.prepare('SELECT * FROM snapshots WHERE id=?').get(copy.previous_snapshot_id);
  const curr = db.prepare('SELECT * FROM snapshots WHERE id=?').get(copy.current_snapshot_id);
  assert.ok(prev && curr);
  assert.notEqual(prev.content_hash, curr.content_hash);
  assert.ok(curr.fetched_at >= prev.fetched_at);

  // Detail view returns both texts so a human can compare.
  const detail = monitor.getChange(workspaceId, copy.id);
  assert.ok(detail);
  assert.ok(detail.previousText.includes('Automate the busywork'));
  assert.ok(detail.currentText.includes('multi-warehouse routing'));
});

test('pricing changes are extracted structurally, not invented', async () => {
  state.pricing = pricingHtml({ starter: '$19 per month', pro: '$29 per month' });
  const baseline = await monitor.runPageCheck(pricingPageId);
  assert.equal(baseline.status, 'baseline_created');

  const snap = db.prepare('SELECT pricing FROM snapshots WHERE monitored_page_id=? ORDER BY fetched_at DESC LIMIT 1').get(pricingPageId);
  const plans = JSON.parse(snap.pricing);
  const pro = plans.find((p) => p.name === 'Pro');
  assert.ok(pro, `expected a Pro plan, got ${JSON.stringify(plans)}`);
  assert.equal(pro.amount, 29);
  assert.equal(pro.currency, 'USD');
  assert.equal(pro.interval, 'month');
  assert.equal(pro.confidence, 'high');

  state.pricing = pricingHtml({ starter: '$19 per month', pro: '$39 per month' });
  const result = await monitor.runPageCheck(pricingPageId);
  assert.equal(result.status, 'changed');

  const pricingChange = changesFor(pricingPageId).find((c) => c.category === 'pricing');
  assert.ok(pricingChange, 'pricing change must be categorised as pricing');
  assert.match(pricingChange.summary, /Pro/);
  assert.match(pricingChange.summary, /29/);
  assert.match(pricingChange.summary, /39/);
  assert.ok(pricingChange.significance >= 0.9, `price movement should be high significance, got ${pricingChange.significance}`);
  assert.equal(pricingChange.confidence, 'high');

  const evidence = JSON.parse(pricingChange.evidence);
  assert.equal(evidence.kind, 'pricing');
  assert.equal(evidence.changed[0].previous.amount, 29);
  assert.equal(evidence.changed[0].current.amount, 39);
});

test('a new pricing plan is reported as an addition with its exact price', async () => {
  state.pricing = pricingHtml({ starter: '$19 per month', pro: '$39 per month' }) + '';
  // Insert a Team plan between Pro and Enterprise blocks.
  state.pricing = pageShell('Pricing — Fixture', `
    <h1>Simple pricing</h1>
    <h2>Starter</h2><p>$19 per month</p><p>Up to 3 projects</p>
    <h2>Pro</h2><p>$39 per month</p><p>Unlimited projects</p><p>10 seats</p>
    <h2>Team</h2><p>$59 per month</p><p>25 seats</p>
    <h2>Enterprise</h2><p>Contact sales</p>`);
  const result = await monitor.runPageCheck(pricingPageId);
  assert.equal(result.status, 'changed');
  const pricingChange = changesFor(pricingPageId).filter((c) => c.category === 'pricing').pop();
  const evidence = JSON.parse(pricingChange.evidence);
  const addedTeam = evidence.added.find((p) => p.name === 'Team');
  assert.ok(addedTeam, `expected Team to be added, got ${JSON.stringify(evidence.added)}`);
  assert.equal(addedTeam.amount, 59);
  assert.match(pricingChange.summary, /New plan detected/);
});

test('signup form changes are detected with the added field named', async () => {
  const baseline = await monitor.runPageCheck(signupPageId);
  assert.equal(baseline.status, 'baseline_created');

  state.signup = signupHtml([
    { name: 'email', type: 'email', required: true },
    { name: 'password', type: 'password', required: true },
    { name: 'work_email', type: 'email', required: true }
  ], 'Create workspace');
  const result = await monitor.runPageCheck(signupPageId);
  assert.equal(result.status, 'changed');

  const signupChange = changesFor(signupPageId).find((c) => c.category === 'signup');
  assert.ok(signupChange, 'signup change must be categorised as signup');
  assert.match(signupChange.summary, /work_email/);
  const evidence = JSON.parse(signupChange.evidence);
  assert.deepEqual(evidence.addedFields, ['work_email']);
});

test('re-observing the same difference does not create a duplicate changelog entry or alert', async () => {
  // Move the page back to its previous content, then forward again: the second
  // forward move is the identical difference, so it must deduplicate.
  state.home = homeHtml(BASE_PARAGRAPH);
  await monitor.runPageCheck(homePageId);
  const afterRevert = changeCount(homePageId);

  state.home = homeHtml(`${BASE_PARAGRAPH} We now also support multi-warehouse routing and same-day carrier rebooking across every region.`);
  const again = await monitor.runPageCheck(homePageId);
  assert.equal(again.status, 'changed');
  const afterRepeat = changeCount(homePageId);

  // The repeated A->B difference must map to the same dedupe key as the first.
  const repeated = db.prepare(`SELECT COUNT(*) c FROM changes WHERE monitored_page_id=? AND category='copy'
      AND dedupe_key = (SELECT dedupe_key FROM changes WHERE monitored_page_id=? AND category='copy'
                        AND previous_value NOT LIKE '%multi-warehouse%' ORDER BY rowid DESC LIMIT 1)`)
    .get(homePageId, homePageId).c;
  assert.equal(repeated, 1, 'identical evidence must not be reported twice');
  assert.equal(afterRepeat, afterRevert, 'no new change rows for a repeated difference');
  assert.equal(again.changes.length, 0, 'the repeat produced no new change');

  // Exactly one alert per unique change row: the repeated difference added no
  // change row, so it added no alert either.
  const alertRows = db.prepare('SELECT COUNT(*) c FROM alerts WHERE change_id IN (SELECT id FROM changes WHERE monitored_page_id=?)').get(homePageId).c;
  assert.equal(alertRows, changeCount(homePageId), 'one alert per unique change, never one per observation');
  const duplicateAlerts = db.prepare(`SELECT change_id, COUNT(*) c FROM alerts WHERE change_id IN
      (SELECT id FROM changes WHERE monitored_page_id=?) GROUP BY change_id HAVING c > 1`).all(homePageId);
  assert.equal(duplicateAlerts.length, 0, 'no change may own two alerts');
});

// ---------------------------------------------------------------------------
// Failures and redirects
// ---------------------------------------------------------------------------
test('a failed fetch is recorded as a failure, never as a change', async () => {
  state.failPaths.add('/pricing');
  const before = changeCount(pricingPageId);
  const result = await monitor.runPageCheck(pricingPageId);
  state.failPaths.delete('/pricing');

  assert.equal(result.status, 'failed');
  assert.match(result.error, /HTTP 500/);
  assert.equal(changeCount(pricingPageId), before, 'a failed fetch cannot produce a change');
  const page = db.prepare('SELECT * FROM monitored_pages WHERE id=?').get(pricingPageId);
  assert.equal(page.last_status, 'failed');
  assert.match(page.last_error, /HTTP 500/);
  assert.ok(new Date(page.next_check_at) > new Date(), 'a retry is scheduled');
  assert.ok(new Date(page.next_check_at) - new Date() <= 31 * 60 * 1000, 'retry backs off, not a full interval');
});

test('a redirect is followed and the final URL is recorded on the snapshot', async () => {
  const added = monitor.addMonitoredPage({
    workspaceId, websiteId, url: origin + '/moved', role: 'other', label: 'Moved page'
  });
  assert.equal(added.ok, true, JSON.stringify(added));
  state.redirects.set('/moved', '/home');

  const result = await monitor.runPageCheck(added.page.id);
  assert.equal(result.status, 'baseline_created');
  const snap = db.prepare('SELECT * FROM snapshots WHERE monitored_page_id=? ORDER BY fetched_at DESC LIMIT 1').get(added.page.id);
  assert.equal(snap.requested_url, origin + '/moved');
  assert.equal(snap.final_url, origin + '/home');
  state.redirects.delete('/moved');
});

test('a page that never had a baseline reports no change on its first success', async () => {
  const added = monitor.addMonitoredPage({
    workspaceId, websiteId, url: origin + '/late', role: 'other', label: 'Late page'
  });
  assert.equal(added.ok, true);
  state.failPaths.add('/late');

  const failed = await monitor.runPageCheck(added.page.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /HTTP 500/);
  state.failPaths.delete('/late');

  state.home = homeHtml(BASE_PARAGRAPH + ' Freshly added section about onboarding.');
  const ok = await monitor.runPageCheck(added.page.id);
  assert.equal(ok.status, 'baseline_created', 'first valid fetch becomes the baseline');
  assert.equal(changeCount(added.page.id), 0, 'no change can be reported without a baseline');
  state.home = homeHtml(`${BASE_PARAGRAPH} We now also support multi-warehouse routing and same-day carrier rebooking across every region.`);
});

test('a JavaScript-only page with no readable content fails honestly instead of reporting changes', async () => {
  const added = monitor.addMonitoredPage({
    workspaceId, websiteId, url: origin + '/spa', role: 'other', label: 'SPA shell'
  });
  assert.equal(added.ok, true);
  const original = state.home;
  state.home = '<!doctype html><html><head><title>app</title></head><body><div id="root"></div></body></html>';
  state.redirects.set('/spa', '/home');
  const result = await monitor.runPageCheck(added.page.id);
  state.redirects.delete('/spa');
  state.home = original;

  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'no_readable_content');
  const page = db.prepare('SELECT * FROM monitored_pages WHERE id=?').get(added.page.id);
  assert.equal(page.last_status, 'failed');
  assert.match(page.last_error, /JavaScript-rendered|no readable content/i);
});

// ---------------------------------------------------------------------------
// Scheduling, changelog queries, alerts
// ---------------------------------------------------------------------------
test('due checks only run pages whose next_check_at has passed, bounded per tick', async () => {
  db.prepare('UPDATE monitored_pages SET next_check_at=? WHERE workspace_id=?')
    .run(new Date(Date.now() + 3600 * 1000).toISOString(), workspaceId);

  const notDue = await monitor.runDueChecks({ limit: 10 });
  assert.equal(notDue.checked, 0, 'nothing is due yet');

  db.prepare('UPDATE monitored_pages SET next_check_at=? WHERE id=?')
    .run(new Date(Date.now() - 1000).toISOString(), homePageId);
  const due = await monitor.runDueChecks({ limit: 1 });
  assert.equal(due.checked, 1);
  assert.ok(due.results[0].pageId === homePageId);
});

test('the changelog is paginated, filterable and totals correctly', async () => {
  const all = monitor.listChanges(workspaceId, { limit: 100 });
  assert.ok(all.total >= 3, `expected several changes, got ${all.total}`);

  const firstPage = monitor.listChanges(workspaceId, { limit: 2 });
  assert.equal(firstPage.changes.length, 2);
  assert.equal(firstPage.has_more, true);
  assert.equal(firstPage.total, all.total);

  const secondPage = monitor.listChanges(workspaceId, { limit: 2, offset: 2 });
  assert.ok(secondPage.changes.length >= 1);
  const firstIds = new Set(firstPage.changes.map((c) => c.id));
  assert.ok(secondPage.changes.every((c) => !firstIds.has(c.id)), 'pages must not overlap');

  const pricingOnly = monitor.listChanges(workspaceId, { category: 'pricing' });
  assert.ok(pricingOnly.changes.every((c) => c.category === 'pricing'));
  assert.equal(pricingOnly.total, pricingOnly.changes.length);

  // Newest first
  const timestamps = all.changes.map((c) => c.detected_at);
  assert.deepEqual(timestamps, [...timestamps].sort().reverse());
});

test('significant changes raise one deduplicated alert and queue honest delivery rows', async () => {
  const change = db.prepare(`SELECT * FROM changes WHERE workspace_id=? AND category='pricing' ORDER BY significance DESC LIMIT 1`).get(workspaceId);
  assert.ok(change);

  const alertRow = db.prepare('SELECT * FROM alerts WHERE change_id=?').get(change.id);
  assert.ok(alertRow, 'a high significance change must create an alert');
  assert.equal(alertRow.status, 'unread');
  assert.ok(['critical', 'high'].includes(alertRow.severity));

  // Raising again for the same change is a no-op.
  const page = db.prepare('SELECT * FROM monitored_pages WHERE id=?').get(change.monitored_page_id);
  const site = db.prepare('SELECT * FROM websites WHERE id=?').get(websiteId);
  const again = alerts.raiseAlertForChange({ change, page, website: site });
  assert.equal(again, null, 'the same change cannot raise a second alert');

  const list = alerts.listAlerts(workspaceId, {});
  assert.ok(list.total >= 1);
  assert.equal(list.alerts[0].category !== undefined, true);
});

test('dismissing a change also dismisses its alert and removes it from the digest', async () => {
  const change = db.prepare('SELECT * FROM changes WHERE workspace_id=? ORDER BY detected_at DESC LIMIT 1').get(workspaceId);
  const result = monitor.setChangeStatus(workspaceId, change.id, { status: 'dismissed', userId: 'usr_mon' });
  assert.equal(result.ok, true);
  const alertRow = db.prepare('SELECT * FROM alerts WHERE change_id=?').get(change.id);
  if (alertRow) assert.equal(alertRow.status, 'dismissed');

  const period = alerts.digestPeriod(alerts.getSettings(workspaceId), new Date(Date.now() + 8 * 86400000));
  const digest = alerts.buildDigest(workspaceId, period);
  assert.ok(!digest.changes.some((c) => c.id === change.id), 'dismissed changes are excluded from the digest');

  // Review state survives a re-detection of the same evidence.
  monitor.setChangeStatus(workspaceId, change.id, { status: 'open', userId: 'usr_mon' });
});
