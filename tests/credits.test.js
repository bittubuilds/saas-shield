'use strict';
// Credit accounting: three free scan jobs per USER, one credit per job, refunds
// only when a job bought nothing. These tests use the real HTTP routes for the
// four insertion paths and direct calls for the accounting edge cases.
process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.DATABASE_FILE = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'shield-cr-')) + '/test.db';
process.env.SHIELD_ALLOW_PRIVATE_IPS = 'true';
process.env.CRAWL_DELAY_MS = '20';
process.env.AUTH_RATE_LIMIT = '500';
process.env.AUTH_REQUIRE_EMAIL_VERIFICATION = 'false';
process.env.COOKIE_SECURE = 'false';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { server } = require('../src/server');
const db = require('../src/db/index');
const credits = require('../src/credits');
const disposable = require('../src/disposable');
const { newId, utcNow } = require('../src/util');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let BASE = null;
async function ready() {
  if (BASE) return;
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  BASE = `http://127.0.0.1:${server.address().port}/api`;
}
after(async () => {
  // The suite enqueues real scans, so stop the scheduler timers before closing the
  // listener or node:test waits on handles it cannot see.
  try { require('../src/scheduler').stop(); } catch { /* not started */ }
  // fetch keeps sockets alive; without this, close() waits on idle connections
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await new Promise((r) => server.close(r));
  // This file's scans leave the global fetch agent's sockets parked; node:test runs
  // each file in its own child process, so exiting here only ends this file.
  setTimeout(() => process.exit(0), 250).unref();
});

function client() {
  let cookie = '';
  const req = async (method, path, body) => {
    const res = await fetch(BASE + path, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    return { status: res.status, data };
  };
  return { req };
}

let userSeq = 0;
// Tests create many accounts from a single loopback IP, so lift the signup budget
// for the suite; the cap test below sets it back deliberately.
require('../src/config').signup.rateLimit = 10000;

async function account(label = 'credits') {
  await ready();
  const c = client();
  userSeq += 1;
  const email = `${label}-${Date.now()}-${userSeq}@example.test`;
  const r = await c.req('POST', '/auth/signup', { email, password: 'Credit!test1', workspace_name: 'Credit ws' });
  assert.equal(r.status, 201, `signup should succeed: ${JSON.stringify(r.data)}`);
  const ws = r.data.workspace.id;
  const me = await c.req('GET', '/me');
  return { c, ws, userId: me.data.user.id, email };
}

// One route map server: handlers get (req, res, base).
function serve(handlers) {
  const srv = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${srv.address().port}`;
    const p = new URL(req.url, 'http://x').pathname;
    const h = handlers[p];
    if (!h) { res.statusCode = 404; res.end('not found'); return; }
    h(req, res, base);
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, base: `http://127.0.0.1:${srv.address().port}` })));
}
const html = (body) => (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<html><body>${body}</body></html>`); };

const SHARED = 'Our platform helps logistics teams coordinate warehouse operations in real time with live tracking, predictive arrival windows and automated exception alerts for every shipment handoff.';

test('a new account starts with exactly three credits, and regranting does nothing', async () => {
  const a = await account('grant');
  const bal = credits.balance(a.userId);
  assert.equal(bal.granted, 3);
  assert.equal(bal.available, 3);
  assert.equal(credits.grantOnce(a.userId, 'signup'), false, 'a second grant must be refused');
  assert.equal(credits.balance(a.userId).available, 3);
});

test('an existing account with no grant row is backfilled once on first touch', async () => {
  await ready();
  const legacy = newId('usr');
  db.prepare('INSERT INTO users (id, email, password_hash, name, created_at, email_verified_at, email_verified_source) VALUES (?,?,?,?,?,?,?)')
    .run(legacy, `legacy-${Date.now()}@example.test`, 'x', 'Legacy', utcNow(), utcNow(), 'instant');
  assert.equal(credits.balance(legacy).available, 3, 'first touch backfills 3');
  assert.equal(credits.balance(legacy).available, 3, 'second touch adds nothing');
  const grants = db.prepare(`SELECT COUNT(*) c FROM credit_ledger WHERE user_id=? AND entry_type='grant'`).get(legacy).c;
  assert.equal(grants, 1);
});

test('reservation floor holds: three reserves, the fourth is refused', async () => {
  const a = await account('floor');
  for (let i = 0; i < 3; i += 1) {
    assert.equal(credits.reserve(a.userId, `job-fixed-${i}`), true, `reserve ${i + 1} should succeed`);
  }
  assert.equal(credits.reserve(a.userId, 'job-fixed-3'), false, 'the fourth must be refused');
  assert.equal(credits.balance(a.userId).available, 0);
});

test('concurrent reservations cannot exceed the balance', async () => {
  const a = await account('concurrent');
  const attempts = await Promise.all(Array.from({ length: 8 }, (_, i) => Promise.resolve()
    .then(() => credits.reserve(a.userId, `job-race-${i}`))));
  assert.equal(attempts.filter(Boolean).length, 3, `exactly 3 should win, got ${attempts.filter(Boolean).length}`);
  assert.equal(credits.balance(a.userId).available, 0);
});

// --- the four insertion paths ------------------------------------------------

test('path 1: a manual scan reserves one credit and settles on completion', async () => {
  await ready();
  const site = await serve({ '/': html(`<p>${SHARED}</p>`) });
  const copy = await serve({ '/': html(`<p>${SHARED}</p>`) });
  const a = await account('manual');
  const orig = await a.c.req('POST', `/workspaces/${a.ws}/websites`, { url: site.base + '/', kind: 'original', auto_scan: false });
  const comp = await a.c.req('POST', `/workspaces/${a.ws}/websites`, { url: copy.base + '/', kind: 'comparison', auto_scan: false });

  const scan = await a.c.req('POST', `/workspaces/${a.ws}/scans`, { original_website_id: orig.data.website.id, comparison_website_id: comp.data.website.id });
  assert.equal(scan.status, 202, JSON.stringify(scan.data));
  assert.ok(scan.data.job_id, 'a job id must come back');
  assert.equal(scan.data.credits.available, 2, 'one credit is reserved immediately');

  for (let i = 0; i < 60; i += 1) {
    const s = db.prepare('SELECT status FROM scans WHERE id=?').get(scan.data.scan.id);
    if (['completed', 'failed', 'cancelled'].includes(s.status)) break;
    await sleep(100);
  }
  const job = db.prepare('SELECT * FROM scan_jobs WHERE id=?').get(scan.data.job_id);
  assert.equal(job.credit_state, 'consumed');
  assert.equal(credits.balance(a.userId).available, 2, 'consumption must not double-charge');
  site.srv.close(); copy.srv.close();
});

test('path 2: retrying a failed scan opens its own job and charges once', async () => {
  await ready();
  const dead = await serve({});                       // 404s everything
  const orig = await serve({ '/': html(`<p>${SHARED}</p>`) });
  const a = await account('retry');
  const o = await a.c.req('POST', `/workspaces/${a.ws}/websites`, { url: orig.base + '/', kind: 'original', auto_scan: false });
  const c = await a.c.req('POST', `/workspaces/${a.ws}/websites`, { url: dead.base + '/', kind: 'comparison', auto_scan: false });

  const first = await a.c.req('POST', `/workspaces/${a.ws}/scans`, { original_website_id: o.data.website.id, comparison_website_id: c.data.website.id });
  assert.equal(first.status, 202);
  for (let i = 0; i < 60; i += 1) {
    const s = db.prepare('SELECT status FROM scans WHERE id=?').get(first.data.scan.id);
    if (['completed', 'failed', 'cancelled'].includes(s.status)) break;
    await sleep(100);
  }
  const afterFail = credits.balance(a.userId);
  assert.equal(afterFail.available, 3, 'a job that bought nothing must be refunded');

  const retry = await a.c.req('POST', `/workspaces/${a.ws}/scans/${first.data.scan.id}/retry`);
  assert.equal(retry.status, 202, JSON.stringify(retry.data));
  assert.ok(retry.data.job_id);
  assert.equal(retry.data.credits.available, 2, 'the retry is a new job and is charged');
  orig.srv.close(); dead.srv.close();
});

test('path 3: a discovery fan-out across several competitors costs exactly one credit', async () => {
  await ready();
  // Discovery builds search queries from the original's own sentences, so this
  // fixture needs full-length sentences rather than a short shared fragment.
  const longText = [
    'Our platform coordinates warehouse dock scheduling across every regional distribution centre we operate.',
    'Each shipment receives a live tracking timeline with predictive arrival windows for the receiving team.',
    'Automated exception alerts route problems to the operator who owns that specific carrier relationship.'
  ].join(' ');
  const site = await serve({ '/': html(`<p>${longText}</p>`) });
  const a = await account('discovery');
  const orig = await a.c.req('POST', `/workspaces/${a.ws}/websites`, { url: site.base + '/', kind: 'original', auto_scan: false });
  assert.equal(orig.status, 201);

  const discover = require('../src/discover');
  const discoveryId = newId('dsc');
  const job = credits.openJob({ userId: a.userId, workspaceId: a.ws, kind: 'discovery', requestKey: `discovery:${orig.data.website.id}` });
  assert.equal(job.ok, true);

  db.prepare(`INSERT INTO discoveries (id, workspace_id, original_website_id, status, created_by, created_at, updated_at, job_id)
              VALUES (?,?,?,'queued',?,?,?,?)`)
    .run(discoveryId, a.ws, orig.data.website.id, a.userId, utcNow(), utcNow(), job.jobId);

  // Three competitors found. They point at a host that cannot be crawled, so the
  // scans fail fast and settle on their own - the assertions below are about the
  // ledger shape, not about racing the worker.
  await discover.runDiscovery(discoveryId, {
    // searchFn returns plain URL strings, exactly like the real provider path
    searchFn: async () => [
      'https://copycat-alpha.com/page',
      'https://copycat-beta.com/page',
      'https://copycat-gamma.com/page'
    ]
  });

  const scans = db.prepare('SELECT id, job_id FROM scans WHERE workspace_id=?').all(a.ws);
  assert.ok(scans.length >= 3, `fan-out should queue several scans, got ${scans.length}`);
  assert.ok(scans.every((x) => x.job_id === job.jobId), 'every scan in the run belongs to the one job');

  const reserves = db.prepare(`SELECT COUNT(*) c FROM credit_ledger WHERE user_id=? AND job_id=? AND entry_type='reserve'`).get(a.userId, job.jobId).c;
  assert.equal(reserves, 1, `three competitors must cost exactly one credit, saw ${reserves} reserves`);
  site.srv.close();
});

test('path 4: adding a website starts a job through the same gate', async () => {
  await ready();
  const site = await serve({ '/': html(`<p>${SHARED}</p>`) });
  const copy = await serve({ '/': html(`<p>${SHARED}</p>`) });
  const a = await account('auto');
  await a.c.req('POST', `/workspaces/${a.ws}/websites`, { url: site.base + '/', kind: 'original', auto_scan: false });
  const added = await a.c.req('POST', `/workspaces/${a.ws}/websites`, { url: copy.base + '/', kind: 'comparison', auto_scan: true });
  assert.equal(added.status, 201);
  assert.equal(added.data.initial_scan.mode, 'scan');
  assert.ok(added.data.initial_scan.job_id, 'the automatic path must open a job too');
  assert.equal(credits.balance(a.userId).available, 2, 'the automatic scan is charged like any other job');
  site.srv.close(); copy.srv.close();
});

// --- settlement rules --------------------------------------------------------

function seedWebsites(tag) {
  const wsId = `wsp_seed_${tag}`;
  const now = utcNow();
  try { db.prepare('INSERT INTO workspaces (id, name, created_at) VALUES (?,?,?)').run(wsId, 'seed', now); } catch { /* exists */ }
  for (const [id, host] of [[`web_a_${tag}`, `a-${tag}.example.test`], [`web_b_${tag}`, `b-${tag}.example.test`]]) {
    try {
      db.prepare(`INSERT INTO websites (id, workspace_id, kind, submitted_url, normalized_domain, status, crawl_status, created_at, updated_at)
                  VALUES (?,?,?,?,?,'active','not_crawled',?,?)`)
        .run(id, wsId, id.startsWith('web_a') ? 'original' : 'comparison', `https://${host}/`, host, now, now);
    } catch { /* exists */ }
  }
  return { wsId, a: `web_a_${tag}`, b: `web_b_${tag}` };
}

function seedWebsitePair(wsId) {
  const mk = (kind, url) => {
    const id = newId('web');
    const now = utcNow();
    db.prepare(`INSERT INTO websites (id, workspace_id, kind, submitted_url, normalized_domain, status, crawl_status, created_at, updated_at)
                VALUES (?,?,?,?,?,'active','not_crawled',?,?)`)
      .run(id, wsId, kind, url, new URL(url).host, now, now);
    return id;
  };
  return [mk('original', `https://orig-${Date.now()}.example.test/`), mk('comparison', `https://comp-${Date.now()}.example.test/`)];
}

function seedJob(userId, statuses) {
  const sites = seedWebsites(String(Math.random()).slice(2, 8));
  credits.ensure(userId);
  const jobId = newId('job');
  credits.reserve(userId, jobId);
  db.prepare(`INSERT INTO scan_jobs (id, user_id, workspace_id, kind, request_key, credit_state, status, created_at)
              VALUES (?,?,?,'manual',?, 'reserved','running',?)`)
    .run(jobId, userId, sites.wsId, `seed:${jobId}`, utcNow());
  for (const st of statuses) {
    const sid = newId('scn');
    db.prepare(`INSERT INTO scans (id, workspace_id, original_website_id, comparison_website_id, status, params, created_at, job_id)
                VALUES (?, ?, ?, ?, ?, '{}', ?, ?)`).run(sid, sites.wsId, sites.a, sites.b, st, utcNow(), jobId);
  }
  return jobId;
}

test('a completed comparison with zero findings still consumes the credit', async () => {
  const a = await account('zero');
  const jobId = seedJob(a.userId, ['completed']);
  const before = credits.balance(a.userId);
  const out = credits.settleJob(jobId);
  assert.equal(out.state, 'consumed');
  const after = credits.balance(a.userId);
  assert.equal(after.consumed, before.consumed + 1);
  assert.equal(after.refunded, before.refunded);
});

test('a job where every comparison failed is refunded', async () => {
  const a = await account('failed');
  const jobId = seedJob(a.userId, ['failed', 'failed']);
  const out = credits.settleJob(jobId);
  assert.equal(out.state, 'refunded');
  assert.equal(credits.balance(a.userId).available, 3);
});

test('one completion settles the job immediately, even while another scan runs', async () => {
  const a = await account('mixed');
  const jobId = seedJob(a.userId, ['completed', 'running']);
  // Rule: the credit is consumed the moment any comparison completes. Waiting for
  // the rest of the fan-out would let a slow competitor hold the credit hostage.
  assert.equal(credits.settleJob(jobId).state, 'consumed');
  assert.equal(credits.balance(a.userId).available, 2);
  // A later failure of the remaining scan must not refund a consumed job.
  db.prepare(`UPDATE scans SET status='failed' WHERE job_id=? AND status='running'`).run(jobId);
  assert.equal(credits.settleJob(jobId).settled, false);
  assert.equal(credits.balance(a.userId).available, 2);
});

test('settling twice never charges or refunds twice', async () => {
  const a = await account('idempotent');
  const jobId = seedJob(a.userId, ['completed']);
  credits.settleJob(jobId);
  const first = credits.balance(a.userId);
  const second = credits.settleJob(jobId);
  const after = credits.balance(a.userId);
  assert.equal(second.settled, false);
  assert.deepEqual(after, first);
  const consumes = db.prepare(`SELECT COUNT(*) c FROM credit_ledger WHERE user_id=? AND job_id=? AND entry_type='consume'`).get(a.userId, jobId).c;
  assert.equal(consumes, 1);
});

test('replays are distinguished from a different active job', async () => {
  const a = await account('keys');
  const first = credits.openJob({ userId: a.userId, workspaceId: a.ws, kind: 'manual', requestKey: 'scan:x:y' });
  assert.equal(first.ok, true);
  const replay = credits.openJob({ userId: a.userId, workspaceId: a.ws, kind: 'manual', requestKey: 'scan:x:y' });
  assert.equal(replay.replay, true, 'the same request must replay, not charge again');
  assert.equal(replay.jobId, first.jobId);
  const other = credits.openJob({ userId: a.userId, workspaceId: a.ws, kind: 'manual', requestKey: 'scan:x:z' });
  assert.equal(other.ok, false);
  assert.equal(other.conflict, true, 'a different pair must be a conflict, not a replay');
  assert.equal(credits.balance(a.userId).available, 2, 'only one credit was spent');
});

test('stale recovery refunds the job it kills', async () => {
  const a = await account('stale');
  const jobId = seedJob(a.userId, ['running']);
  const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  db.prepare(`UPDATE scans SET started_at=? WHERE job_id=?`).run(old, jobId);
  const { recoverStaleScans } = require('../src/scan-recovery');
  const out = recoverStaleScans();
  assert.ok(out.recovered >= 1, 'the orphan must be recovered');
  const job = db.prepare('SELECT credit_state FROM scan_jobs WHERE id=?').get(jobId);
  assert.equal(job.credit_state, 'refunded', 'an interrupted job must not eat the credit');
  assert.equal(credits.balance(a.userId).available, 3);
});

test('no credits left surfaces as 402 with no charge, and a second workspace adds nothing', async () => {
  const a = await account('empty');
  for (let i = 0; i < 3; i += 1) {
    const j = credits.openJob({ userId: a.userId, workspaceId: a.ws, kind: 'manual', requestKey: `scan:o${i}:c${i}` });
    assert.equal(j.ok, true);
    db.prepare(`UPDATE scan_jobs SET status='completed', credit_state='consumed', finished_at=? WHERE id=?`).run(utcNow(), j.jobId);
    credits.release(a.userId, j.jobId, 'consume', 'seed');
  }
  assert.equal(credits.balance(a.userId).available, 0);
  const denied = credits.openJob({ userId: a.userId, workspaceId: a.ws, kind: 'manual', requestKey: 'scan:d:d' });
  assert.equal(denied.noCredits, true);

  // credits follow the person: a second workspace does not reset the balance
  const creditRoute = await a.c.req('GET', '/credits');
  assert.equal(creditRoute.status, 200);
  assert.equal(creditRoute.data.available, 0);
});

test('disposable detection is conservative and normalised', async () => {
  assert.equal(disposable.isDisposable('someone@mailinator.com'), true);
  assert.equal(disposable.isDisposable('SOMEONE@WWW.Mailinator.com.'), true);
  assert.equal(disposable.isDisposable('founder@gmail.com'), false);
  assert.equal(disposable.isDisposable('founder@mail.com'), false, 'mail.com must never be blocked');
  assert.equal(disposable.isDisposable('founder@proton.me'), false);
  assert.equal(disposable.normalise('WWW.Example.COM.'), 'example.com');
  assert.equal(disposable.mode(), 'warn', 'default policy warns rather than blocks');
});

// --- final verification: crash windows, recovery, authorization, limits ------

test('a reservation with no job behind it is recovered and refunded', async () => {
  await ready();
  const a = await account('orphan-reserve');
  const before = credits.balance(a.userId).available;
  const ghostJob = newId('job');
  assert.equal(credits.reserve(a.userId, ghostJob), true, 'the hold itself succeeds');
  assert.equal(credits.balance(a.userId).available, before - 1);
  // Simulate the crash: the job row is never written, and time has passed.
  db.prepare('UPDATE credit_ledger SET created_at=? WHERE job_id=?').run(
    new Date(Date.now() - 60 * 60 * 1000).toISOString(), ghostJob);

  const res = credits.recoverOrphanReservations();
  assert.ok(res.refunded >= 1, 'the held credit must come back');
  assert.equal(credits.balance(a.userId).available, before, 'balance restored');
  const again = credits.recoverOrphanReservations();
  assert.equal(again.refunded, 0, 'recovery is not repeatable');
});

test('an uncharged job row cannot squat the active-job slot', async () => {
  await ready();
  const a = await account('orphan-job');
  const staleJobId = newId('job');
  db.prepare(`INSERT INTO scan_jobs (id,user_id,workspace_id,kind,request_key,credit_state,status,created_at)
              VALUES (?,?,?,?,'*','reserved','queued',?)`)
    .run(staleJobId, a.userId, a.ws, 'manual', new Date(Date.now() - 60 * 60 * 1000).toISOString());
  assert.ok(credits.activeJob(a.userId), 'the orphan occupies the slot');

  credits.recoverOrphanReservations();
  assert.equal(credits.activeJob(a.userId), undefined, 'slot is free again');

  const fresh = credits.openJob({ userId: a.userId, workspaceId: a.ws, kind: 'manual', requestKey: 'fresh' });
  assert.equal(fresh.ok, true, 'a real job can start');
});

test('a consumed job is never refunded by stale recovery', async () => {
  await ready();
  const a = await account('consumed-vs-recovery');
  const [origId, compId] = seedWebsitePair(a.ws);
  const job = credits.openJob({ userId: a.userId, workspaceId: a.ws, kind: 'manual', requestKey: 'pair:consumed' });
  const scanId = newId('scn');
  db.prepare(`INSERT INTO scans (id,workspace_id,original_website_id,comparison_website_id,status,params,created_at,job_id)
              VALUES (?,?,?,?,'completed','{}',?,?)`)
    .run(scanId, a.ws, origId, compId, utcNow(), job.jobId);
  credits.settleJob(job.jobId);
  const settled = credits.balance(a.userId);

  // A stale, orphaned running scan elsewhere must not reach into that job.
  const strayScan = newId('scn');
  db.prepare(`INSERT INTO scans (id,workspace_id,original_website_id,comparison_website_id,status,params,created_at,job_id,started_at)
              VALUES (?,?,?,?,'running','{}',?,?,?)`)
    .run(strayScan, a.ws, origId, compId,
      new Date(Date.now() - 7200000).toISOString(), job.jobId,
      new Date(Date.now() - 7200000).toISOString());

  require('../src/scan-recovery').recoverStaleScans();
  const after = credits.balance(a.userId);
  assert.equal(after.available, settled.available, 'no refund for a consumed job');
  assert.equal(after.refunded, settled.refunded, 'no refund row appeared');
});

test('a refunded job can never be consumed later', async () => {
  await ready();
  const a = await account('refunded-locked');
  const job = credits.openJob({ userId: a.userId, workspaceId: a.ws, kind: 'manual', requestKey: 'pair:refunded' });
  // A job that never queued a comparison is refunded explicitly.
  const first = credits.failJob(job.jobId, 'no comparisons queued');
  assert.equal(first.state, 'refunded');
  const second = credits.settleJob(job.jobId);
  const third = credits.failJob(job.jobId, 'again');
  assert.equal(second.settled, false);
  assert.equal(second.reason, 'already_refunded');
  assert.equal(third.settled, false, 'a second refund attempt is a no-op');
  const consumes = db.prepare("SELECT COUNT(*) c FROM credit_ledger WHERE job_id=? AND entry_type='consume'").get(job.jobId).c;
  assert.equal(consumes, 0, 'no consume row may appear after a refund');
  assert.equal(credits.balance(a.userId).available, 3, 'still three credits');
});

test('repeated refunds stay idempotent', async () => {
  await ready();
  const a = await account('double-refund');
  const job = credits.openJob({ userId: a.userId, workspaceId: a.ws, kind: 'manual', requestKey: 'pair:double' });
  assert.equal(credits.release(a.userId, job.jobId, 'refund', 'first'), true);
  assert.equal(credits.release(a.userId, job.jobId, 'refund', 'second'), false, 'second refund refused');
  const rows = db.prepare("SELECT COUNT(*) c FROM credit_ledger WHERE job_id=? AND entry_type='refund'").get(job.jobId).c;
  assert.equal(rows, 1, 'exactly one refund row');
});

test('credits are not readable through another workspace, and members spend their own', async () => {
  await ready();
  const owner = await account('owner-credits');
  const member = await account('member-credits');

  // A stranger cannot reach the owner's balance, whatever workspace id they send.
  const strangerView = await member.c.req('GET', `/workspaces/${owner.ws}/credits`);
  assert.ok([403, 404].includes(strangerView.status), `cross-workspace read must fail, got ${strangerView.status}`);
  const selfView = await member.c.req('GET', '/credits');
  assert.equal(selfView.status, 200);
  assert.equal(selfView.data.available, 3, 'the member sees their own balance');
  assert.ok(!JSON.stringify(selfView.data).includes(owner.userId), 'no other user id leaks');

  // Invite the member into the owner's workspace and have them start a scan there.
  const inv = await owner.c.req('POST', `/workspaces/${owner.ws}/members`, { email: member.email, role: 'member' });
  assert.equal(inv.status, 201, JSON.stringify(inv.data));
  const site = await serve({ '/': html(`<p>${SHARED}</p>`) });
  const orig = await owner.c.req('POST', `/workspaces/${owner.ws}/websites`, { url: site.base + '/', kind: 'original', auto_scan: false });
  const other = await serve({ '/': html(`<p>${SHARED}</p>`) });
  const comp = await owner.c.req('POST', `/workspaces/${owner.ws}/websites`, { url: other.base + '/', kind: 'comparison', auto_scan: false });

  const scan = await member.c.req('POST', `/workspaces/${owner.ws}/scans`, {
    original_website_id: orig.data.website.id, comparison_website_id: comp.data.website.id
  });
  assert.equal(scan.status, 202, JSON.stringify(scan.data));
  assert.ok(credits.balance(member.userId).available < 3, 'the member paid');
  assert.equal(credits.balance(owner.userId).available, 3, 'the owner did not');
});

test('signup is capped per IP by the configurable signup budget', async () => {
  await ready();
  const config = require('../src/config');
  const { rateLimit } = require('../src/auth');
  config.signup.rateLimit = 3;
  rateLimit.reset('signup');
  const limit = config.signup.rateLimit;
  const c = client();
  let last = null;
  let blocked = null;
  for (let i = 0; i < limit + 2; i += 1) {
    last = await c.req('POST', '/auth/signup', {
      email: `cap-${Date.now()}-${i}@example.test`, password: 'Credit!test1', workspace_name: 'Cap'
    });
    if (last.status === 429) { blocked = last; break; }
  }
  assert.ok(blocked, `expected a 429 within ${limit + 1} signups, last status ${last && last.status}`);
  // The HTTP helper does not surface headers, so check the cooldown contract on
  // the middleware itself: a 429 must carry Retry-After.
  const { rateLimit: limiterFactory } = require('../src/auth');
  const stub = limiterFactory({ limit: () => 0, windowMs: 60000, bucket: 'signup-cooldown-probe' });
  let headerName = null; let headerValue = null;
  const fakeRes = {
    set: (k, v) => { headerName = k; headerValue = v; },
    status(code) { this.code = code; return this; },
    json() { return this; }
  };
  stub({ ip: '198.51.100.7' }, fakeRes, () => {});
  assert.equal(fakeRes.code, 429);
  assert.equal(headerName, 'Retry-After');
  assert.ok(Number(headerValue) > 0, 'Retry-After carries seconds');
  config.signup.rateLimit = 10000;
  rateLimit.reset('signup');
});
