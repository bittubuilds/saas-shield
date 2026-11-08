'use strict';
// HTTP-level tests for the AI routes: authentication, workspace isolation,
// invalid and missing resources, refusal to analyse an unfinished scan, refusal
// to resume someone else's job, concurrent runs, and the route rate limiter.
//
// The app runs in-process with the mock provider, so no test spends AI quota.

process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.DATABASE_FILE = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'shield-ai-api-')) + '/test.db';
process.env.AUTH_RATE_LIMIT = '1000';
process.env.COOKIE_SECURE = 'false';
process.env.AUTH_REQUIRE_EMAIL_VERIFICATION = 'false';
process.env.AI_PROVIDER = 'mock';
// A real key in the environment must never be used by a test: the mock provider
// is the only one wired here, and the "not configured" case is simulated.
process.env.AI_API_KEY = '';
process.env.GROQ_API_KEY = '';
process.env.AI_MIN_PAGE_CHARS = '20';
// the limiter has its own test below; the others must not trip it
process.env.AI_ANALYSE_RATE_LIMIT = '1000';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { server } = require('../src/server');
const db = require('../src/db/index');
const provider = require('../src/ai/provider');
const { newId, utcNow } = require('../src/util');

let BASE = null;
async function ready() {
  if (BASE) return;
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  // the listening socket must not keep this process alive once the tests end
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
      return { status: res.status, data, headers: res.headers };
    }
  };
}

const OVERVIEW = { summary: 'Acme tracks keyword rankings for startups.', category: 'seo', use_case: 'rank tracking', audience: 'startups', positioning: 'simple SEO', differentiators: ['rank alerts'], unknowns: [] };
const FEATURES = { features: [{ name: 'Rank tracking', category: 'analytics', statement: 'Tracks keyword rankings', claim: 'explicit', confidence: 0.9 }] };
const PRICING = { plans: [{ name: 'Pro', price: '$29', interval: 'month', notes: null, claim: 'explicit', confidence: 0.8 }], has_free_tier: false, enterprise: null, model: 'subscription', unstated: [] };
const POSITIONING = { value_proposition: 'SEO without busywork', audience: 'startups', differentiators: ['fast setup'], messaging_patterns: ['simple'], claims_to_verify: [] };
const SYNTH = {
  executive_summary: 'One SEO tool is compared here.',
  common_features: [], unique_features: [{ feature: 'Rank alerts', competitor: 'acme.test' }],
  gaps: [], swot: [],
  recommendations: [{ recommendation: 'Ship a free tier', reason: 'the compared page shows no free plan', supporting_competitors: ['acme.test'], confidence: 0.5, limitations: 'one competitor' }]
};

let providerDelayMs = 0;
provider.setMockResponder(async ({ stage, user }) => {
  if (providerDelayMs) await new Promise((r) => setTimeout(r, providerDelayMs));
  const which = stage || (/Competitors analysed:/.test(user || '') ? 'synthesis'
    : /List the product capabilities/.test(user || '') ? 'features'
      : /Extract only pricing/.test(user || '') ? 'pricing'
        : /positions itself/.test(user || '') ? 'positioning' : 'overview');
  // callMock treats the responder's return value as the parsed JSON body
  return { overview: OVERVIEW, features: FEATURES, pricing: PRICING, positioning: POSITIONING, synthesis: SYNTH }[which];
});

// Seed a finished scan with evidence directly: the crawler has its own suites.
// Domains are unique per call because a workspace may hold each domain once.
let seedSeq = 0;
function seedCompletedScan(workspaceId, { status = 'completed' } = {}) {
  seedSeq += 1;
  const mine = `mine${seedSeq}.test`;
  const acme = `acme${seedSeq}.test`;
  const now = utcNow();
  const origId = newId('web');
  const compId = newId('web');
  db.prepare('INSERT INTO websites (id, workspace_id, submitted_url, normalized_domain, kind, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(origId, workspaceId, `https://${mine}/`, mine, 'original', now, now);
  db.prepare('INSERT INTO websites (id, workspace_id, submitted_url, normalized_domain, kind, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(compId, workspaceId, `https://${acme}/`, acme, 'comparison', now, now);
  const scanId = newId('scn');
  db.prepare(`INSERT INTO scans (id, workspace_id, original_website_id, comparison_website_id, status, params, created_at)
              VALUES (?,?,?,?,?, '{}', ?)`).run(scanId, workspaceId, origId, compId, status, now);
  db.prepare(`INSERT INTO pages (id, website_id, workspace_id, url, title, meta_description, text_content, content_hash, fetched_at)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(newId('pag'), compId, workspaceId, `https://${acme}/pricing`, 'Acme pricing', 'Simple SEO pricing',
      'Acme is an SEO platform for startups with keyword rank tracking, alerts and a $29 Pro plan.', 'h1', now);
  return { scanId, origId, compId, acme };
}

async function signup(email, workspaceName) {
  const c = client();
  const res = await c.req('POST', '/auth/signup', { email, password: 'longpassword1', workspace_name: workspaceName });
  assert.equal(res.status, 201, `signup failed: ${JSON.stringify(res.data)}`);
  return { client: c, wsId: res.data.workspace.id };
}

let owner;
let stranger;

// Two independent tenants, created once. Each test seeds its own scan, so the
// tests stay meaningful even when run in isolation by name.
before(async () => {
  owner = await signup('ai-owner@example.test', 'Owner Workspace');
  stranger = await signup('ai-stranger@example.test', 'Other Workspace');
});

after(() => {
  provider.setMockResponder(null);
});

test('every AI route rejects an unauthenticated caller', async () => {
  const { scanId } = seedCompletedScan(owner.wsId);
  const anon = client();
  const paths = [
    ['GET', `/workspaces/${owner.wsId}/scans/${scanId}/ai`],
    ['POST', `/workspaces/${owner.wsId}/scans/${scanId}/ai`],
    ['GET', `/workspaces/${owner.wsId}/scans/${scanId}/ai/findings`],
    ['GET', `/workspaces/${owner.wsId}/scans/${scanId}/ai/report`]
  ];
  for (const [method, path] of paths) {
    const res = await anon.req(method, path);
    assert.equal(res.status, 401, `${method} ${path} must require a session`);
  }
});

test('a member of another workspace cannot read or run this scan', async () => {
  const { scanId } = seedCompletedScan(owner.wsId);
  const rowsBefore = db.prepare('SELECT COUNT(*) c FROM ai_analyses WHERE scan_id=?').get(scanId).c;

  const statusRes = await stranger.client.req('GET', `/workspaces/${owner.wsId}/scans/${scanId}/ai`);
  assert.equal(statusRes.status, 404, 'another workspace is indistinguishable from a missing workspace');

  const runRes = await stranger.client.req('POST', `/workspaces/${owner.wsId}/scans/${scanId}/ai`);
  assert.equal(runRes.status, 404, 'an outsider cannot resume or start this job');

  const findingsRes = await stranger.client.req('GET', `/workspaces/${owner.wsId}/scans/${scanId}/ai/findings`);
  assert.equal(findingsRes.status, 404);

  const reportRes = await stranger.client.req('GET', `/workspaces/${owner.wsId}/scans/${scanId}/ai/report`);
  assert.equal(reportRes.status, 404);

  const rowsAfter = db.prepare('SELECT COUNT(*) c FROM ai_analyses WHERE scan_id=?').get(scanId).c;
  assert.equal(rowsAfter, rowsBefore, 'the refused run created no analysis rows');

  // the stranger may use the same scan id inside a workspace they do belong to,
  // and still gets nothing, because that scan does not exist there
  // a stranger cannot even ask about their own workspace with a foreign scan id
  const fetched = await stranger.client.req('GET', `/workspaces/${stranger.wsId}/scans/${scanId}/ai`);
  assert.equal(fetched.status, 404, JSON.stringify(fetched.data));
});

test('unknown scan ids are 404, never 500 and never another scan', async () => {
  for (const badId of ['scn_does_not_exist', 'nope', '0']) {
    const r1 = await owner.client.req('GET', `/workspaces/${owner.wsId}/scans/${badId}/ai`);
    assert.equal(r1.status, 404);
    const r2 = await owner.client.req('POST', `/workspaces/${owner.wsId}/scans/${badId}/ai`);
    assert.equal(r2.status, 404);
  }
  const missingWs = await owner.client.req('GET', `/workspaces/wsp_missing/scans/scn_missing/ai`);
  assert.equal(missingWs.status, 404);
});

test('a scan that has not finished cannot be analysed', async () => {
  const { scanId } = seedCompletedScan(owner.wsId, { status: 'running' });
  const res = await owner.client.req('POST', `/workspaces/${owner.wsId}/scans/${scanId}/ai`);
  assert.equal(res.status, 409);
  assert.equal(res.data.code, 'scan_not_completed');
  const rows = db.prepare('SELECT COUNT(*) c FROM ai_analyses WHERE scan_id=?').get(scanId).c;
  assert.equal(rows, 0, 'no analysis is started on unfinished evidence');
});

test('analysis is refused clearly when the server has no AI provider', async () => {
  const { scanId } = seedCompletedScan(owner.wsId);
  process.env.AI_PROVIDER = 'groq';
  try {
    const res = await owner.client.req('POST', `/workspaces/${owner.wsId}/scans/${scanId}/ai`);
    assert.equal(res.status, 503);
    assert.equal(res.data.code, 'not_configured');
    const statusRes = await owner.client.req('GET', `/workspaces/${owner.wsId}/scans/${scanId}/ai`);
    assert.equal(statusRes.status, 200);
    assert.equal(statusRes.data.ai_configured, false);
  } finally {
    process.env.AI_PROVIDER = 'mock';
  }
});

test('the owner runs analysis and reads cited findings and a report', async () => {
  const { scanId } = seedCompletedScan(owner.wsId);
  const run = await owner.client.req('POST', `/workspaces/${owner.wsId}/scans/${scanId}/ai`);
  assert.equal(run.status, 200, `run failed: ${JSON.stringify(run.data)}`);
  const diag = {
    analyses: db.prepare('SELECT stage, status, error FROM ai_analyses WHERE scan_id=?').all(scanId),
    findings: db.prepare('SELECT COUNT(*) c FROM ai_findings WHERE scan_id=?').get(scanId).c,
    pages: db.prepare('SELECT COUNT(*) c FROM pages WHERE workspace_id=?').get(owner.wsId).c
  };
  assert.equal(run.data.busy, false, `unexpected busy: ${JSON.stringify(run.data.perCompetitor)}`);
  assert.equal(run.data.status.status, 'completed', `synthesis failed: ${JSON.stringify(run.data.synthesis)}`);

  const findings = await owner.client.req('GET', `/workspaces/${owner.wsId}/scans/${scanId}/ai/findings`);
  assert.equal(findings.status, 200);
  assert.ok(findings.data.count > 0, 'findings are returned');
  assert.ok(findings.data.findings.every((f) => f.evidence_ids.length > 0), 'every finding cites evidence');
  assert.ok(findings.data.findings.every((f) => f.source_urls.length === 0 || f.source_urls.every((u) => u.includes('acme'))));

  const report = await owner.client.req('GET', `/workspaces/${owner.wsId}/scans/${scanId}/ai/report`);
  assert.equal(report.status, 200);
  assert.equal(report.data.report.version, 1);
  assert.equal(report.data.history.length, 1);

  const status = await owner.client.req('GET', `/workspaces/${owner.wsId}/scans/${scanId}/ai`);
  assert.equal(status.data.status, 'completed');
  assert.equal(status.data.report.version, 1);
  assert.ok(status.data.requests_used > 0);
});

test('a missing report is 404 with a code, not an empty success', async () => {
  const { scanId } = seedCompletedScan(owner.wsId);
  const res = await owner.client.req('GET', `/workspaces/${owner.wsId}/scans/${scanId}/ai/report`);
  assert.equal(res.status, 404);
  assert.equal(res.data.code, 'no_report');
});

test('two simultaneous requests cannot start the same job twice', async () => {
  const { scanId } = seedCompletedScan(owner.wsId);
  providerDelayMs = 25;
  try {
    const [a, b] = await Promise.all([
      owner.client.req('POST', `/workspaces/${owner.wsId}/scans/${scanId}/ai`),
      owner.client.req('POST', `/workspaces/${owner.wsId}/scans/${scanId}/ai`)
    ]);
    const codes = [a.status, b.status].sort();
    assert.deepEqual(codes, [200, 409], `expected one winner and one refusal, got ${codes} ${JSON.stringify([a.data, b.data]).slice(0, 300)}`);
    const loser = a.status === 409 ? a : b;
    assert.equal(loser.data.code, 'analysis_in_progress');
  } finally {
    providerDelayMs = 0;
  }
  const rows = db.prepare('SELECT COUNT(*) c FROM ai_analyses WHERE scan_id=?').get(scanId).c;
  assert.equal(Number(rows), 4, 'one row per stage, no duplicates');
});

test('the analyse route is rate limited and says when to retry', async () => {
  const { scanId } = seedCompletedScan(owner.wsId);
  process.env.AI_ANALYSE_RATE_LIMIT = '2';   // read per request, so this applies now
  let limited = null;
  for (let i = 0; i < 12; i += 1) {
    const res = await owner.client.req('POST', `/workspaces/${owner.wsId}/scans/${scanId}/ai`);
    if (res.status === 429) { limited = res; break; }
  }
  assert.ok(limited, 'repeated runs are eventually limited');
  assert.ok(Number(limited.headers.get('retry-after')) > 0, 'the limiter reports a retry delay');
});
