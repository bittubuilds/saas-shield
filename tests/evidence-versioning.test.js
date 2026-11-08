'use strict';
// Evidence versioning and freshness.
//
// These tests run against the real database layer (no mocks) because the whole
// point of the feature is what is stored: a duplicate must not create a row, a
// change must create a version, and a historical row must never be rewritten.

process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.DATABASE_FILE = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'shield-ev-')) + '/test.db';
process.env.AUTH_RATE_LIMIT = '1000';
process.env.COOKIE_SECURE = 'false';
process.env.EVIDENCE_FRESH_TTL_HOURS = '24';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');

const { server } = require('../src/server');
const db = require('../src/db/index');
const versions = require('../src/competitor/evidence-versions');
const freshness = require('../src/competitor/freshness');
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

const WS = 'ws_ev';
function seedWorkspace(id = WS) {
  const now = utcNow();
  if (!db.prepare('SELECT id FROM workspaces WHERE id=?').get(id)) {
    db.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)').run(id, id, now);
  }
  return id;
}

let domainCounter = 0;
function seedCompetitor(workspaceId = WS) {
  seedWorkspace(workspaceId);
  const now = utcNow();
  const id = newId('cmp');
  domainCounter += 1;
  const domain = `ev-${domainCounter}.test`;
  db.prepare(`INSERT INTO competitors (id, workspace_id, domain, site_url, name, status, discovered_at, created_at)
              VALUES (?,?,?,?,?, 'verified', ?, ?)`)
    .run(id, workspaceId, domain, `https://${domain}/`, domain, now, now);
  return id;
}

function record(competitorId, overrides = {}) {
  return versions.recordVersion({
    workspaceId: overrides.workspaceId || WS,
    competitorId,
    sourceUrl: overrides.sourceUrl || 'https://ev.test/pricing',
    evidenceType: overrides.evidenceType || 'pricing_plan',
    field: overrides.field || 'plan:starter',
    excerpt: overrides.excerpt === undefined ? 'Starter - $29 per month, 3 seats included' : overrides.excerpt,
    confidence: overrides.confidence === undefined ? 0.9 : overrides.confidence,
    verificationStatus: overrides.verificationStatus || 'observed',
    observedAt: overrides.observedAt
  });
}

// --- A. stable content hashing ---------------------------------------------

test('hashing is stable across formatting but not across wording', () => {
  const base = 'Starter - $29 per month, 3 seats included';
  const variants = [
    'Starter - $29 per month, 3 seats included',
    '  Starter -  $29 per month,   3 seats included  ',
    'STARTER - $29 PER MONTH, 3 SEATS INCLUDED',
    'Starter - $29 per month, 3 seats included\u200B',
    'Starter - $29 per month,\n3 seats included'
  ];
  const hashes = variants.map((v) => versions.contentHash(v));
  assert.equal(new Set(hashes).size, 1, 'formatting noise must not create a new content hash');

  const changed = ['Starter - $39 per month, 3 seats included', 'Starter - $29 per month, 5 seats included'];
  for (const c of changed) assert.notEqual(versions.contentHash(c), hashes[0], `${c} is a content change`);

  // Normalisation is exposed and idempotent, so a caller can reason about it.
  const once = versions.normaliseExcerpt(variants[1]);
  assert.equal(versions.normaliseExcerpt(once), once);
});

// --- A. duplicate detection ------------------------------------------------

test('recording the same content twice stores one row and counts the sighting', () => {
  const competitorId = seedCompetitor();
  const first = record(competitorId);
  assert.equal(first.status, 'created');
  assert.equal(first.version, 1);

  const second = record(competitorId, { excerpt: 'STARTER -  $29 per month, 3 seats included' });
  assert.equal(second.status, 'duplicate', 'formatting-only difference is a duplicate');
  assert.equal(second.id, first.id);

  const rows = db.prepare('SELECT * FROM competitor_evidence WHERE competitor_id=?').all(competitorId);
  assert.equal(rows.length, 1, 'no second row for the same content');
  assert.equal(rows[0].observations, 2);
  assert.ok(rows[0].last_seen_at);
  assert.equal(rows[0].superseded_at, null, 'the only version stays current');
});

test('a duplicate from a different page is still a duplicate, and the source is kept', () => {
  const competitorId = seedCompetitor();
  record(competitorId, { sourceUrl: 'https://ev.test/pricing' });
  const again = record(competitorId, { sourceUrl: 'https://ev.test/plans' });
  assert.equal(again.status, 'duplicate');
  assert.equal(again.source_changed, true, 'a second URL is reported, not silently merged');
  const rows = db.prepare('SELECT * FROM competitor_evidence WHERE competitor_id=?').all(competitorId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source_url, 'https://ev.test/pricing', 'the original source is not overwritten');
});

// --- A. new version when content changes, history preserved ----------------

test('changed content creates a new version and closes the old one by pointer', () => {
  const competitorId = seedCompetitor();
  const firstSeen = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const v1 = record(competitorId, { excerpt: 'Starter - $29 per month, 3 seats included', observedAt: firstSeen });
  const v2 = record(competitorId, { excerpt: 'Starter - $39 per month, 5 seats included', sourceUrl: 'https://ev.test/plans' });

  assert.equal(v2.status, 'created');
  assert.equal(v2.version, 2);
  assert.deepEqual(v2.previous, { id: v1.id, version: 1 });

  const v1Row = db.prepare('SELECT * FROM competitor_evidence WHERE id=?').get(v1.id);
  const v2Row = db.prepare('SELECT * FROM competitor_evidence WHERE id=?').get(v2.id);
  assert.ok(v1Row.superseded_at, 'the previous version is closed');
  assert.equal(v1Row.superseded_by, v2.id);
  assert.equal(v1Row.version, 1);
  assert.equal(v1Row.excerpt, 'Starter - $29 per month, 3 seats included', 'historical text is untouched');
  assert.equal(v1Row.source_url, 'https://ev.test/pricing', 'historical source is untouched');
  assert.equal(v2Row.superseded_at, null);
  assert.equal(v2Row.excerpt, 'Starter - $39 per month, 5 seats included');

  const current = versions.currentEvidence({ workspaceId: WS, competitorId });
  assert.equal(current.length, 1);
  assert.equal(current[0].id, v2.id, 'only the newest version is current');

  const history = versions.historyFor({ workspaceId: WS, competitorId, identity: 'pricing_plan:plan:starter' });
  assert.equal(history.length, 2);
  assert.deepEqual(history.map((h) => h.version), [1, 2], 'history is ordered oldest first');
  assert.equal(history[0].observed_at, firstSeen, 'the first observation keeps its own timestamp');
  assert.ok(history[1].observed_at > history[0].observed_at, 'the new version has a later timestamp');
});

test('a previously superseded content does not resurrect as current', () => {
  const competitorId = seedCompetitor();
  record(competitorId, { excerpt: 'Starter - $29 per month' });
  record(competitorId, { excerpt: 'Starter - $39 per month' });
  const back = record(competitorId, { excerpt: 'Starter - $29 per month' });
  assert.equal(back.status, 'duplicate_superseded');
  assert.equal(back.version, 1, 'the old version is reported, not reopened');
  const current = versions.currentEvidence({ workspaceId: WS, competitorId });
  assert.equal(current.length, 1);
  assert.equal(current[0].excerpt, 'Starter - $39 per month', 'the chain tip is unchanged');
  const history = versions.historyFor({ workspaceId: WS, competitorId, identity: 'pricing_plan:plan:starter' });
  assert.equal(history.length, 2, 'no third version is invented for returning content');
});

test('identities are independent: two fields never share a version chain', () => {
  const competitorId = seedCompetitor();
  const a = record(competitorId, { field: 'plan:starter', excerpt: 'Starter - $29' });
  const b = record(competitorId, { field: 'plan:pro', excerpt: 'Pro - $79' });
  assert.equal(a.version, 1);
  assert.equal(b.version, 1);
  const current = versions.currentEvidence({ workspaceId: WS, competitorId });
  assert.equal(current.length, 2);
});

test('the evidence fingerprint changes only when current evidence changes', () => {
  const competitorId = seedCompetitor();
  record(competitorId, { excerpt: 'Starter - $29' });
  const first = versions.fingerprint({ workspaceId: WS, competitorId });
  assert.equal(versions.fingerprint({ workspaceId: WS, competitorId }), first, 'stable across reads');

  record(competitorId, { excerpt: 'Starter - $29' });     // duplicate
  assert.equal(versions.fingerprint({ workspaceId: WS, competitorId }), first, 'a duplicate is not a change');

  record(competitorId, { excerpt: 'Starter - $39' });     // new version
  assert.notEqual(versions.fingerprint({ workspaceId: WS, competitorId }), first);
});

// --- B. freshness ----------------------------------------------------------

function seedPage(competitorId, { status = 'ok', fetchedAt = utcNow(), workspaceId = WS, url = 'https://ev.test/pricing' } = {}) {
  db.prepare(`INSERT INTO competitor_pages
      (id, workspace_id, competitor_id, url, page_type, fetch_status, fetch_error, fetched_at, created_at)
      VALUES (?,?,?,?, 'pricing', ?, ?, ?, ?)`)
    .run(newId('cpge'), workspaceId, competitorId, url, status,
      status === 'ok' ? null : 'HTTP 500', fetchedAt, utcNow());
}

function hoursAgo(h) { return new Date(Date.now() - h * 3600 * 1000).toISOString(); }

test('a competitor with nothing collected is never_collected, not stale', () => {
  const competitorId = seedCompetitor();
  const f = freshness.freshnessFor({ workspaceId: WS, competitorId });
  assert.equal(f.state, 'never_collected');
  assert.equal(f.last_success_at, null);
  assert.equal(freshness.shouldRecollect({ workspaceId: WS, competitorId }).recollect, true);
});

test('a failed latest attempt is unavailable even when older content exists', () => {
  const competitorId = seedCompetitor();
  seedPage(competitorId, { status: 'ok', fetchedAt: hoursAgo(2) });
  seedPage(competitorId, { status: 'failed', fetchedAt: hoursAgo(1), url: 'https://ev.test/plans' });
  record(competitorId);
  const f = freshness.freshnessFor({ workspaceId: WS, competitorId });
  assert.equal(f.state, 'unavailable');
  assert.match(f.reason, /failed/);
  assert.equal(freshness.shouldRecollect({ workspaceId: WS, competitorId }).recollect, true);
});

test('evidence the last analysis has not seen reads changed, and does not force a recrawl', () => {
  const competitorId = seedCompetitor();
  seedPage(competitorId, { status: 'ok', fetchedAt: hoursAgo(1) });
  record(competitorId, { observedAt: hoursAgo(1) });

  const beforeAnalysis = freshness.freshnessFor({ workspaceId: WS, competitorId });
  assert.equal(beforeAnalysis.state, 'changed');
  assert.match(beforeAnalysis.reason, /never analysed/);

  const recrawl = freshness.shouldRecollect({ workspaceId: WS, competitorId });
  assert.equal(recrawl.recollect, false, 'the evidence is already here; only analysis is behind');
  assert.match(recrawl.reason, /only the analysis is behind/);
});

test('fresh evidence is fresh, and stale evidence is due again', () => {
  const freshId = seedCompetitor();
  seedPage(freshId, { status: 'ok', fetchedAt: hoursAgo(2) });
  record(freshId, { observedAt: hoursAgo(2) });
  markAnalysed(freshId, hoursAgo(1));
  const fresh = freshness.freshnessFor({ workspaceId: WS, competitorId: freshId });
  assert.equal(fresh.state, 'fresh');
  assert.equal(freshness.shouldRecollect({ workspaceId: WS, competitorId: freshId }).recollect, false);

  const staleId = seedCompetitor();
  seedPage(staleId, { status: 'ok', fetchedAt: hoursAgo(30) });
  record(staleId, { observedAt: hoursAgo(30) });
  markAnalysed(staleId, hoursAgo(28));
  const stale = freshness.freshnessFor({ workspaceId: WS, competitorId: staleId });
  assert.equal(stale.state, 'stale', 'older than the 24h test window');
  assert.ok(stale.recrawl_due_at);
  assert.equal(freshness.shouldRecollect({ workspaceId: WS, competitorId: staleId }).recollect, true);
});

function markAnalysed(competitorId, finishedAt) {
  const now = utcNow();
  db.prepare(`INSERT INTO ai_analyses
      (id, workspace_id, competitor_id, scan_id, stage, status, input_hash, analysis_version,
       prompt_version, attempts, finished_at, created_at, updated_at)
      VALUES (?,?,?,?, 'overview', 'completed', ?, 1, 1, 1, ?, ?, ?)`)
    .run(newId('aia'), WS, competitorId, null, `h_${newId('x')}`, finishedAt, now, now);
}

test('every state is one of the five documented names', () => {
  assert.deepEqual(freshness.STATES,
    ['never_collected', 'unavailable', 'changed', 'stale', 'fresh']);
});

// --- A/B through the API ---------------------------------------------------

let owner;
let stranger;
before(async () => {
  const signup = async (email, name) => {
    const c = client();
    const res = await c.req('POST', '/auth/signup', { email, password: 'longpassword1', workspace_name: name });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    return { client: c, wsId: res.data.workspace.id };
  };
  owner = await signup('ev-owner@example.test', 'EV Owner');
  stranger = await signup('ev-stranger@example.test', 'EV Stranger');
});

test('the evidence API returns current versions, freshness and recrawl advice', async () => {
  const competitorId = seedCompetitor(owner.wsId);
  record(competitorId, { workspaceId: owner.wsId, excerpt: 'Starter - $29 per month' });
  record(competitorId, { workspaceId: owner.wsId, excerpt: 'Starter - $39 per month' });

  const res = await owner.client.req('GET', `/workspaces/${owner.wsId}/competitors/${competitorId}/evidence`);
  assert.equal(res.status, 200);
  assert.equal(res.data.current.length, 1);
  assert.equal(res.data.current[0].version, 2);
  assert.equal(res.data.freshness.state, 'never_collected');
  assert.equal(res.data.recrawl.recollect, true);
  assert.ok(res.data.fingerprint);

  const history = await owner.client.req('GET', `/workspaces/${owner.wsId}/competitors/${competitorId}/evidence/history?identity=pricing_plan:plan:starter`);
  assert.equal(history.status, 200);
  assert.deepEqual(history.data.history.map((h) => h.version), [1, 2]);
  assert.ok(history.data.history[0].superseded_at);
});

test('evidence and its history are not visible to another workspace', async () => {
  const competitorId = seedCompetitor(owner.wsId);
  record(competitorId, { workspaceId: owner.wsId });
  const asStranger = await stranger.client.req('GET', `/workspaces/${stranger.wsId}/competitors/${competitorId}/evidence`);
  assert.equal(asStranger.status, 404);
  const history = await stranger.client.req('GET', `/workspaces/${stranger.wsId}/competitors/${competitorId}/evidence/history`);
  assert.equal(history.status, 404);
  const missing = await owner.client.req('GET', `/workspaces/${owner.wsId}/competitors/cmp_does_not_exist/evidence`);
  assert.equal(missing.status, 404);
});

// --- K. analysis window boundary and same-instant identity -------------------
// Regression for the 2026-11-07 finding: "unseen" was measured from the moment an
// analysis finished, so evidence observed while it was running was counted as
// already consumed and never surfaced again. The window now starts when the
// analysis began. These tests assert stored rows, not return values.

function seedAnalysisWindow(competitorId, { createdAt, finishedAt = createdAt, status = 'completed' }) {
  markAnalysed(competitorId, finishedAt);
  db.prepare("UPDATE ai_analyses SET created_at=?, status=? WHERE competitor_id=?")
    .run(createdAt, status, competitorId);
}

test('evidence observed while the analysis was running is not treated as seen', () => {
  const competitorId = seedCompetitor();
  seedPage(competitorId, { fetchedAt: hoursAgo(1) });
  record(competitorId, { observedAt: '2026-11-07T10:00:00.500Z', excerpt: 'Pricing page changed to $59' });
  seedAnalysisWindow(competitorId, { createdAt: '2026-11-07T10:00:00.000Z', finishedAt: '2026-11-07T10:00:02.000Z' });

  const view = freshness.freshnessFor({ workspaceId: WS, competitorId });
  assert.equal(view.state, 'changed', 'a mid-run observation was never consumed by that analysis');
  assert.ok(view.unseen_evidence >= 1, 'it must be reported as unseen');
});

test('evidence observed exactly at the analysis start is not lost to a boundary', () => {
  const competitorId = seedCompetitor();
  seedPage(competitorId, { fetchedAt: hoursAgo(1) });
  const at = '2026-11-07T10:00:00.000Z';
  record(competitorId, { observedAt: at, excerpt: 'Boundary observation' });
  seedAnalysisWindow(competitorId, { createdAt: at });

  const view = freshness.freshnessFor({ workspaceId: WS, competitorId });
  assert.equal(view.state, 'changed');
  assert.equal(view.unseen_evidence, 1, 'an equal timestamp is still unpaid work');
});

test('evidence fully consumed before the analysis started counts as fresh', () => {
  const competitorId = seedCompetitor();
  seedPage(competitorId, { fetchedAt: hoursAgo(1) });
  record(competitorId, { observedAt: '2026-11-07T09:00:00.000Z', excerpt: 'Old pricing $29' });
  seedAnalysisWindow(competitorId, { createdAt: '2026-11-07T10:00:00.000Z' });

  const view = freshness.freshnessFor({ workspaceId: WS, competitorId });
  assert.equal(view.state, 'fresh');
  assert.equal(view.unseen_evidence, 0);
  const recrawl = freshness.shouldRecollect({ workspaceId: WS, competitorId });
  assert.equal(Boolean(recrawl.due), false, 'nothing to re-fetch: the evidence is already analysed');
});

test('an interrupted analysis does not mark evidence as seen', () => {
  const competitorId = seedCompetitor();
  seedPage(competitorId, { fetchedAt: hoursAgo(1) });
  record(competitorId, { observedAt: '2026-11-07T09:30:00.000Z' });
  seedAnalysisWindow(competitorId, { createdAt: '2026-11-07T10:00:00.000Z', status: 'running' });

  const view = freshness.freshnessFor({ workspaceId: WS, competitorId });
  assert.equal(view.state, 'changed', 'a run that never completed consumed nothing');
});

test('different content in the same millisecond creates two distinct versions', () => {
  const competitorId = seedCompetitor();
  const at = '2026-11-07T11:00:00.000Z';
  const a = record(competitorId, { observedAt: at, excerpt: 'Pro plan $49 per month' });
  const b = record(competitorId, { observedAt: at, excerpt: 'Pro plan $59 per month' });

  assert.equal(a.version, 1);
  assert.equal(b.version, 2, 'content identity, not the clock, decides the version');
  const rows = db.prepare('SELECT * FROM competitor_evidence WHERE competitor_id=? ORDER BY version').all(competitorId);
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].content_hash_norm, rows[1].content_hash_norm);
  assert.ok(rows[0].superseded_at, 'the older version is closed by pointer');
  assert.equal(rows[1].superseded_at, null);
});

test('identical content in the same millisecond is one version, two sightings', () => {
  const competitorId = seedCompetitor();
  const at = '2026-11-07T11:00:00.000Z';
  record(competitorId, { observedAt: at, excerpt: 'Free plan available' });
  const again = record(competitorId, { observedAt: at, excerpt: 'Free plan available' });

  assert.equal(again.status, 'duplicate');
  const rows = db.prepare('SELECT * FROM competitor_evidence WHERE competitor_id=?').all(competitorId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].observations, 2);
  assert.equal(rows[0].version, 1);
});

test('identical content at a later timestamp updates sightings without a new version', () => {
  const competitorId = seedCompetitor();
  const first = record(competitorId, { observedAt: '2026-11-07T11:00:00.000Z', excerpt: 'SSO on enterprise' });
  record(competitorId, { observedAt: '2026-11-07T12:00:00.000Z', excerpt: 'SSO on enterprise' });

  const rows = db.prepare('SELECT * FROM competitor_evidence WHERE competitor_id=?').all(competitorId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, first.version);
  assert.equal(rows[0].last_seen_at, '2026-11-07T12:00:00.000Z');
  assert.equal(rows[0].observed_at, '2026-11-07T11:00:00.000Z', 'first sighting is preserved');
});

test('repeated identical submissions never move the version number', () => {
  const competitorId = seedCompetitor();
  for (let i = 0; i < 5; i += 1) record(competitorId, { excerpt: 'Audit log retention 90 days' });
  const rows = db.prepare('SELECT version, observations FROM competitor_evidence WHERE competitor_id=?').all(competitorId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, 1);
  assert.equal(rows[0].observations, 5);
});

test('a superseded version keeps its own content and timestamp', () => {
  const competitorId = seedCompetitor();
  record(competitorId, { observedAt: '2026-11-07T11:00:00.000Z', excerpt: 'Starter $19' });
  record(competitorId, { observedAt: '2026-11-07T11:05:00.000Z', excerpt: 'Starter $29' });
  const rows = db.prepare('SELECT * FROM competitor_evidence WHERE competitor_id=? ORDER BY version').all(competitorId);
  assert.equal(rows[0].excerpt, 'Starter $19');
  assert.equal(rows[0].observed_at, '2026-11-07T11:00:00.000Z');
  assert.equal(rows[1].excerpt, 'Starter $29');
});

test('observedSince returns a stable order when timestamps collide', () => {
  const competitorId = seedCompetitor();
  const at = '2026-11-07T13:00:00.000Z';
  record(competitorId, { observedAt: at, excerpt: 'Claim A' });
  record(competitorId, { observedAt: at, excerpt: 'Claim B' });
  record(competitorId, { observedAt: at, excerpt: 'Claim C' });

  const one = versions.observedSince({ workspaceId: WS, competitorId, since: '2026-11-07T12:00:00.000Z' });
  const two = versions.observedSince({ workspaceId: WS, competitorId, since: '2026-11-07T12:00:00.000Z' });
  assert.equal(one.length, 3);
  assert.deepEqual(one.map((r) => r.id), two.map((r) => r.id), 'same rows, same order, every call');
});
