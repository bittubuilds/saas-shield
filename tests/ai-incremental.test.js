'use strict';
// Incremental AI behaviour over Phase 4 structured evidence.
//
// The provider is mocked through the engine's own mock hook, so these tests
// assert exactly how many model calls happen and what the prompt carried. The
// point of the suite is the promise "unchanged evidence costs nothing, changed
// evidence costs one call, and nothing historical is lost".

process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.DATABASE_FILE = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'shield-aii-')) + '/test.db';
process.env.AUTH_RATE_LIMIT = '1000';
process.env.COOKIE_SECURE = 'false';
process.env.AI_PROVIDER = 'mock';
process.env.AI_MODEL = 'mock-1';
process.env.AI_MAX_COMPETITORS = '3';
process.env.AI_MAX_PAGES = '3';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { app, server } = require('../src/server');
const db = require('../src/db/index');
const engine = require('../src/ai/engine');
const provider = require('../src/ai/provider');
const aiStore = require('../src/ai/store');
const intel = require('../src/competitor/intel-store');
const versions = require('../src/competitor/evidence-versions');
const evidenceSource = require('../src/ai/evidence-source');
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

// --- seeding ---------------------------------------------------------------

function seedWebsite(workspaceId, kind = 'comparison', domain = `ai-${newId('w')}.test`) {
  const now = utcNow();
  const id = newId('web');
  db.prepare(`INSERT INTO websites (id, workspace_id, kind, submitted_url, normalized_domain, status,
      crawl_status, accessible_page_count, created_at, updated_at)
      VALUES (?,?,?,?,?, 'active', 'crawled', 3, ?, ?)`)
    .run(id, workspaceId, kind, `https://${domain}/`, domain, now, now);
  return { id, domain };
}

function seedScan(workspaceId, originalId, comparisonId) {
  const now = utcNow();
  const id = newId('scn');
  db.prepare(`INSERT INTO scans (id, workspace_id, original_website_id, comparison_website_id, status, params, created_at)
      VALUES (?,?,?,?, 'completed', '{}', ?)`).run(id, workspaceId, originalId, comparisonId, now);
  return id;
}

function seedCompetitor(workspaceId, websiteId, domain = `comp-${newId('c')}.test`) {
  const now = utcNow();
  const id = newId('cmp');
  db.prepare(`INSERT INTO competitors (id, workspace_id, website_id, domain, site_url, name, status, discovered_at, created_at)
      VALUES (?,?,?,?,?,?, 'verified', ?, ?)`)
    .run(id, workspaceId, websiteId, domain, `https://${domain}/`, domain, now, now);
  return id;
}

// Phase 4 collection output, written the way collect.js writes it.
function seedCollection({ workspaceId, competitorId, plans = [], features = [], pageText = null }) {
  const now = utcNow();
  const pageId = intel.saveCollectedPage({
    workspaceId, competitorId, url: 'https://comp.test/pricing', pageType: 'pricing',
    httpStatus: 200, finalUrl: 'https://comp.test/pricing', title: 'Pricing',
    textContent: pageText || 'Pricing. Starter plan costs $29 per month and includes 3 seats and 10 projects. '
      + 'Pro plan costs $79 per month and includes 10 seats and unlimited projects. Enterprise is custom pricing.',
    contentHash: 'pagehash-' + newId('h').slice(0, 6), fetchedBytes: 2048, fetchStatus: 'ok'
  });
  const planIds = plans.map((p) => {
    const evidence = versions.recordVersion({
      workspaceId, competitorId, pageId, sourceUrl: 'https://comp.test/pricing',
      evidenceType: 'pricing_plan', field: `plan:${p.identity_key}`,
      excerpt: p.original_text || `${p.plan_name} ${p.price_display}`
    });
    return intel.savePlan({
      workspaceId, competitorId, pageId, sourceUrl: 'https://comp.test/pricing',
      identityKey: p.identity_key, planName: p.plan_name, priceDisplay: p.price_display,
      priceValue: p.price_value, priceStated: p.price_value !== null,
      billingInterval: 'month', originalText: p.original_text || `${p.plan_name} ${p.price_display}`,
      evidenceId: evidence.id, contentHash: `planhash-${p.identity_key}`
    }).id;
  });
  const featureIds = features.map((f) => {
    const evidence = versions.recordVersion({
      workspaceId, competitorId, pageId, sourceUrl: 'https://comp.test/features',
      evidenceType: 'feature_claim', field: `feature:${f.identity_key}`,
      excerpt: f.name
    });
    return intel.saveFeature({
      workspaceId, competitorId, pageId, sourceUrl: 'https://comp.test/features',
      pageType: 'features', identityKey: f.identity_key, name: f.name,
      claimLevel: f.claim_level || 'marketing', confidence: 0.8,
      verificationStatus: 'observed', evidenceId: evidence.id,
      contentHash: `feathash-${f.identity_key}`
    }).id;
  });
  intel.savePricingSummary({
    workspaceId, competitorId, hasPricingEvidence: true, freePlan: 0, freeTrial: 1,
    trialDays: 14, startingPriceDisplay: '$29', startingPriceValue: 29,
    billingInterval: 'month', usageBased: 0, enterpriseCustom: 1,
    plansCount: plans.length, sourceUrl: 'https://comp.test/pricing', confidence: 0.9
  });
  return { pageId, planIds, featureIds };
}

// --- mock provider ---------------------------------------------------------

let calls = [];
let responder = null;
function installResponder(fn) {
  responder = fn;
  provider.setMockResponder(async ({ system, user, stage }) => {
    calls.push({ stage, system, user });
    return responder({ system, user, stage, call: calls.length });
  });
}

function firstCitableId(user) {
  const m = String(user).match(/Cite evidence using these ids exactly: ([^\n]+)/);
  return m ? m[1].split(',')[0].trim() : null;
}

// A well-behaved model: one cited finding per stage.
function goodResponder({ user, stage }) {
  const id = firstCitableId(user);
  if (stage === 'features') {
    return { features: [{ name: 'Keyword tracking', category: 'analytics', statement: 'Tracks keywords', claim: 'explicit', confidence: 0.8, evidence_ids: [id] }] };
  }
  if (stage === 'pricing') {
    return {
      plans: [{ name: 'Starter', price: '$29', interval: 'month', notes: '3 seats', claim: 'explicit', confidence: 0.9, evidence_ids: [id] }],
      has_free_tier: false, enterprise: true, model: 'subscription', unstated: []
    };
  }
  if (stage === 'overview') {
    return { summary: 'A keyword tracker', category: 'SEO', use_case: 'rank tracking', audience: 'agencies', positioning: 'cheap rank tracking', differentiators: [], unknowns: [], evidence_ids: [id] };
  }
  return { value_proposition: 'affordable rank tracking', audience: 'agencies', differentiators: [], messaging_patterns: [], claims_to_verify: [], evidence_ids: [id] };
}

let owner;
let stranger;
before(async () => {
  const signup = async (email, name) => {
    const c = client();
    const res = await c.req('POST', '/auth/signup', { email, password: 'longpassword1', workspace_name: name });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    return { client: c, wsId: res.data.workspace.id };
  };
  owner = await signup('aii-owner@example.test', 'AII Owner');
  stranger = await signup('aii-stranger@example.test', 'AII Stranger');
});

after(() => { provider.setMockResponder(null); });

function setupScan({ workspaceId = owner.wsId } = {}) {
  const original = seedWebsite(workspaceId, 'original');
  const comparison = seedWebsite(workspaceId, 'comparison');
  const scanId = seedScan(workspaceId, original.id, comparison.id);
  const competitorId = seedCompetitor(workspaceId, comparison.id);
  return { scanId, competitorId, comparisonWebsiteId: comparison.id, originalWebsiteId: original.id };
}

// --- C. structured evidence reaches the engine -----------------------------

test('structured pricing, features and page text all reach the prompt', async () => {
  calls = [];
  installResponder(goodResponder);
  const { scanId, competitorId } = setupScan();
  const seeded = seedCollection({
    workspaceId: owner.wsId, competitorId,
    plans: [{ identity_key: 'starter', plan_name: 'Starter', price_display: '$29', price_value: 29 }],
    features: [{ identity_key: 'keyword tracking', name: 'Keyword tracking' }]
  });

  const result = await engine.runScanAI({ workspaceId: owner.wsId, scanId });
  assert.equal(result.ok, true);

  const pricingPrompt = calls.find((c) => c.stage === 'pricing');
  assert.ok(pricingPrompt, 'a pricing call happened');
  assert.match(pricingPrompt.user, /STRUCTURED EVIDENCE/);
  assert.match(pricingPrompt.user, /STRUCTURED EVIDENCE[\s\S]*PLAN: Starter/);
  assert.ok(pricingPrompt.user.includes(seeded.planIds[0]), 'the plan id is citable');
  assert.ok(pricingPrompt.user.includes(seeded.pageId), 'the collected page is citable');

  const featuresPrompt = calls.find((c) => c.stage === 'features');
  assert.match(featuresPrompt.user, /structured feature .*cft_/);
  assert.ok(featuresPrompt.user.includes(seeded.featureIds[0]));

  // Findings cite the structured refs they were given, and resolve to a source URL.
  const findings = aiStore.findingsFor({ workspaceId: owner.wsId, scanId, competitorId });
  assert.ok(findings.length >= 3);
  const pricingFinding = findings.find((f) => f.kind === 'pricing');
  assert.ok(pricingFinding, 'the pricing finding was stored');
  assert.ok(pricingFinding.evidence_ids.length > 0);
  assert.ok(pricingFinding.source_urls.some((u) => String(u).includes('comp.test')));

  // The engine recorded exactly what it consumed.
  const analyses = aiStore.analysesFor({ workspaceId: owner.wsId, scanId });
  const completed = analyses.filter((a) => a.status === 'completed');
  assert.equal(completed.length, engine.STAGES.length);
  const snapshot = aiStore.analysisEvidence({ workspaceId: owner.wsId, analysisId: completed[0].id });
  assert.ok(snapshot.length > 0, 'the analysis snapshot lists the evidence it read');
  assert.ok(snapshot.some((e) => e.evidence_kind === 'competitor_page'));
});

test('collected Phase 4 pages win over the older website crawl', async () => {
  calls = [];
  installResponder(goodResponder);
  const { scanId, competitorId, comparisonWebsiteId } = setupScan();
  // A page in the old crawl table that must NOT be preferred.
  const now = utcNow();
  db.prepare(`INSERT INTO pages (id, workspace_id, website_id, url, title, text_content, content_hash, http_status, fetched_at)
      VALUES (?,?,?,?,?,?,?, 200, ?)`)
    .run(newId('pg'), owner.wsId, comparisonWebsiteId, 'https://legacy.test/pricing', 'Legacy',
      'Legacy page text that mentions pricing but is stale and should not be read at all.', 'legacyhash', now);
  seedCollection({ workspaceId: owner.wsId, competitorId, pageText: 'Collected text from Phase 4: pricing starts at 29 dollars per month for the starter plan and 79 dollars per month for the pro plan.' });

  await engine.runScanAI({ workspaceId: owner.wsId, scanId });
  const pricingPrompt = calls.find((c) => c.stage === 'pricing');
  assert.match(pricingPrompt.user, /Collected text from Phase 4/);
  assert.equal(/Legacy page text/.test(pricingPrompt.user), false, 'the collected evidence is preferred');
});

// --- C. unchanged evidence costs nothing ----------------------------------

test('unchanged evidence makes no second set of model calls', async () => {
  calls = [];
  installResponder(goodResponder);
  const { scanId, competitorId } = setupScan();
  seedCollection({
    workspaceId: owner.wsId, competitorId,
    plans: [{ identity_key: 'starter', plan_name: 'Starter', price_display: '$29', price_value: 29 }],
    features: [{ identity_key: 'keyword tracking', name: 'Keyword tracking' }]
  });

  await engine.runScanAI({ workspaceId: owner.wsId, scanId });
  const firstRunCalls = calls.length;
  assert.equal(firstRunCalls, engine.STAGES.length);

  const second = await engine.runScanAI({ workspaceId: owner.wsId, scanId });
  assert.equal(calls.length, firstRunCalls, 'a second run over identical evidence calls nothing');
  const statuses = second.perCompetitor[competitorId].map((r) => r.status);
  assert.ok(statuses.every((s) => s === 'unchanged'), `expected unchanged, got ${statuses.join(',')}`);
  assert.equal(aiStore.requestsForScan(scanId), engine.STAGES.length, 'usage was not double counted');
});

test('a duplicate evidence sighting does not trigger reanalysis', async () => {
  calls = [];
  installResponder(goodResponder);
  const { scanId, competitorId } = setupScan();
  seedCollection({
    workspaceId: owner.wsId, competitorId,
    plans: [{ identity_key: 'starter', plan_name: 'Starter', price_display: '$29', price_value: 29 }]
  });
  await engine.runScanAI({ workspaceId: owner.wsId, scanId });
  const before = calls.length;

  // Same content, recorded again: a duplicate, not a change.
  versions.recordVersion({
    workspaceId: owner.wsId, competitorId, evidenceType: 'pricing_plan',
    field: 'plan:starter', sourceUrl: 'https://comp.test/pricing',
    excerpt: 'Starter $29'
  });
  const second = await engine.runScanAI({ workspaceId: owner.wsId, scanId });
  assert.equal(calls.length, before);
  assert.ok(second.perCompetitor[competitorId].every((r) => r.status === 'unchanged'));
});

// --- C. changed evidence triggers reanalysis, history preserved -----------

test('changed pricing triggers reanalysis and keeps the previous version readable', async () => {
  calls = [];
  installResponder(goodResponder);
  const { scanId, competitorId } = setupScan();
  seedCollection({
    workspaceId: owner.wsId, competitorId,
    plans: [{ identity_key: 'starter', plan_name: 'Starter', price_display: '$29', price_value: 29 }]
  });
  await engine.runScanAI({ workspaceId: owner.wsId, scanId });
  const firstPricing = calls.find((c) => c.stage === 'pricing');
  assert.match(firstPricing.user, /STARTING PRICE: \$29/);

  const historyBefore = aiStore.analysisHistory({ workspaceId: owner.wsId, competitorId, stage: 'pricing' });
  assert.equal(historyBefore.length, 1);
  const oldAnalysisId = historyBefore[0].id;
  const oldFindings = aiStore.findingsForAnalysis({ workspaceId: owner.wsId, analysisId: oldAnalysisId });
  const oldSnapshot = aiStore.analysisEvidence({ workspaceId: owner.wsId, analysisId: oldAnalysisId });
  assert.ok(oldSnapshot.length > 0);

  // The competitor raises its price: new plan row, new pricing summary.
  intel.savePricingSummary({
    workspaceId: owner.wsId, competitorId, hasPricingEvidence: true, freePlan: 0,
    startingPriceDisplay: '$39', startingPriceValue: 39, billingInterval: 'month',
    usageBased: 0, enterpriseCustom: 1, plansCount: 1, sourceUrl: 'https://comp.test/pricing', confidence: 0.9
  });
  const pageId = db.prepare('SELECT id FROM competitor_pages WHERE competitor_id=?').get(competitorId).id;
  const evidence = versions.recordVersion({
    workspaceId: owner.wsId, competitorId, pageId, sourceUrl: 'https://comp.test/pricing',
    evidenceType: 'pricing_plan', field: 'plan:starter', excerpt: 'Starter $39 per month'
  });
  intel.savePlan({
    workspaceId: owner.wsId, competitorId, pageId, sourceUrl: 'https://comp.test/pricing',
    identityKey: 'starter', planName: 'Starter', priceDisplay: '$39', priceValue: 39,
    priceStated: true, billingInterval: 'month', originalText: 'Starter $39 per month',
    evidenceId: evidence.id, contentHash: 'planhash-starter-v2'
  });

  calls = [];
  const second = await engine.runScanAI({ workspaceId: owner.wsId, scanId });
  const pricingResult = second.perCompetitor[competitorId].find((r) => r.stage === 'pricing');
  assert.equal(pricingResult.status, 'completed', 'the changed pricing was re-analysed');
  const newPricing = calls.find((c) => c.stage === 'pricing');
  assert.match(newPricing.user, /STARTING PRICE: \$39/);

  const historyAfter = aiStore.analysisHistory({ workspaceId: owner.wsId, competitorId, stage: 'pricing' });
  assert.equal(historyAfter.length, 2, 'both analyses are kept');
  assert.ok(historyAfter.some((a) => a.id === oldAnalysisId), 'the previous analysis still exists');
  assert.deepEqual(
    aiStore.findingsForAnalysis({ workspaceId: owner.wsId, analysisId: oldAnalysisId }).map((f) => f.id).sort(),
    oldFindings.map((f) => f.id).sort(),
    'the previous findings are unchanged'
  );
  assert.deepEqual(
    aiStore.analysisEvidence({ workspaceId: owner.wsId, analysisId: oldAnalysisId }).map((e) => e.content_hash),
    oldSnapshot.map((e) => e.content_hash),
    'the previous evidence snapshot is unchanged'
  );
  // The feature stage did not change, so it was not re-run.
  assert.equal(calls.filter((c) => c.stage === 'features').length, 0);
});

// --- C. invalid evidence references are rejected --------------------------

test('findings citing unknown or foreign evidence are dropped', async () => {
  calls = [];
  const other = setupScan({ workspaceId: stranger.wsId });
  const foreign = seedCollection({
    workspaceId: stranger.wsId, competitorId: other.competitorId,
    plans: [{ identity_key: 'foreign', plan_name: 'Foreign', price_display: '$99', price_value: 99 }]
  });

  installResponder(({ user, stage }) => {
    const real = firstCitableId(user);
    if (stage !== 'pricing') return { features: [], plans: [] , summary: 'x', value_proposition: 'x', differentiators: [] };
    return {
      plans: [
        { name: 'Invented', price: '$999', interval: 'month', claim: 'explicit', confidence: 0.9, evidence_ids: ['evt_forged'] },
        { name: 'Stolen', price: '$99', interval: 'month', claim: 'explicit', confidence: 0.9, evidence_ids: [foreign.planIds[0]] },
        { name: 'Real', price: '$29', interval: 'month', claim: 'explicit', confidence: 0.9, evidence_ids: [real] }
      ],
      has_free_tier: null, enterprise: null, model: 'subscription', unstated: []
    };
  });

  const { scanId, competitorId } = setupScan();
  seedCollection({
    workspaceId: owner.wsId, competitorId,
    plans: [{ identity_key: 'starter', plan_name: 'Starter', price_display: '$29', price_value: 29 }]
  });

  await engine.runScanAI({ workspaceId: owner.wsId, scanId });
  const findings = aiStore.findingsFor({ workspaceId: owner.wsId, scanId, competitorId });
  const statements = findings.filter((f) => f.kind === 'pricing').map((f) => f.statement);
  assert.ok(statements.some((s) => s.startsWith('Real')), 'the properly cited finding is kept');
  assert.equal(statements.some((s) => s.startsWith('Invented')), false, 'a forged ref is rejected');
  assert.equal(statements.some((s) => s.startsWith('Stolen')), false, 'another workspace’s evidence is rejected');
  for (const f of findings) {
    for (const id of f.evidence_ids) {
      assert.equal(id.startsWith('evt_'), false, 'no unresolved reference is stored');
    }
  }
});

test('evidence collection is workspace scoped', () => {
  const { competitorId } = setupScan();
  seedCollection({
    workspaceId: owner.wsId, competitorId,
    plans: [{ identity_key: 'starter', plan_name: 'Starter', price_display: '$29', price_value: 29 }]
  });
  const mine = evidenceSource.collectEvidence({
    workspaceId: owner.wsId, competitor: { id: competitorId, website_id: null }, minChars: 80, maxPages: 3
  });
  assert.equal(mine.hasEvidence, true);
  const theirs = evidenceSource.collectEvidence({
    workspaceId: stranger.wsId, competitor: { id: competitorId, website_id: null }, minChars: 80, maxPages: 3
  });
  assert.equal(theirs.hasEvidence, false, 'a foreign workspace reads nothing');
  assert.equal(theirs.pages.length, 0);
});

// --- C. resumability, duplicate jobs, quota -------------------------------

test('an interrupted stage resumes instead of restarting from scratch', async () => {
  calls = [];
  installResponder(goodResponder);
  const { scanId, competitorId } = setupScan();
  seedCollection({
    workspaceId: owner.wsId, competitorId,
    plans: [{ identity_key: 'starter', plan_name: 'Starter', price_display: '$29', price_value: 29 }]
  });

  // Simulate a worker that died mid-stage: a 'running' row, stale, one attempt used.
  await engine.runScanAI({ workspaceId: owner.wsId, scanId });
  const pricing = aiStore.analysisHistory({ workspaceId: owner.wsId, competitorId, stage: 'pricing' })[0];
  db.prepare('UPDATE ai_analyses SET status=?, started_at=?, attempts=1 WHERE id=?')
    .run('running', new Date(Date.now() - 60 * 60 * 1000).toISOString(), pricing.id);
  db.prepare('DELETE FROM ai_findings WHERE analysis_id=?').run(pricing.id);

  calls = [];
  const resumed = await engine.runScanAI({ workspaceId: owner.wsId, scanId });
  const pricingResult = resumed.perCompetitor[competitorId].find((r) => r.stage === 'pricing');
  assert.equal(pricingResult.status, 'completed', 'the stale run was adopted and finished');
  assert.equal(pricingResult.analysisId, pricing.id, 'the same row was resumed, not replaced');
  assert.equal(calls.filter((c) => c.stage === 'pricing').length, 1);
});

test('a live stage is not claimed twice, so duplicate jobs cannot double-spend', async () => {
  calls = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  provider.setMockResponder(async ({ user, stage }) => {
    calls.push({ stage, user });
    if (stage === 'pricing') await gate;      // hold the first caller inside the stage
    return goodResponder({ user, stage });
  });

  const { scanId, competitorId } = setupScan();
  seedCollection({
    workspaceId: owner.wsId, competitorId,
    plans: [{ identity_key: 'starter', plan_name: 'Starter', price_display: '$29', price_value: 29 }]
  });

  const first = engine.analyzeCompetitor({
    workspaceId: owner.wsId, competitor: { id: competitorId, website_id: null }, scanId
  });
  // Wait until the first run is inside the pricing stage.
  for (let i = 0; i < 50 && !calls.some((c) => c.stage === 'pricing'); i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
  const second = await engine.analyzeCompetitor({
    workspaceId: owner.wsId, competitor: { id: competitorId, website_id: null }, scanId
  });
  const secondPricing = second.find((r) => r.stage === 'pricing');
  assert.ok(['in_progress', 'unchanged'].includes(secondPricing.status), `got ${secondPricing.status}`);
  assert.equal(calls.filter((c) => c.stage === 'pricing').length, 1, 'the provider was called once');

  release();
  const firstResults = await first;
  assert.ok(firstResults.some((r) => r.stage === 'pricing' && r.status === 'completed'));
  assert.equal(calls.filter((c) => c.stage === 'pricing').length, 1);
});

test('the per-scan request cap still pauses instead of over-spending', async () => {
  calls = [];
  installResponder(goodResponder);
  const previous = process.env.AI_MAX_REQUESTS_PER_SCAN;
  process.env.AI_MAX_REQUESTS_PER_SCAN = '1';
  try {
    const { scanId, competitorId } = setupScan();
    seedCollection({
      workspaceId: owner.wsId, competitorId,
      plans: [{ identity_key: 'starter', plan_name: 'Starter', price_display: '$29', price_value: 29 }],
      features: [{ identity_key: 'keyword tracking', name: 'Keyword tracking' }]
    });
    const result = await engine.runScanAI({ workspaceId: owner.wsId, scanId });
    assert.equal(calls.length, 1, 'exactly one model call was allowed');
    assert.equal(result.paused, true);
    const statuses = result.perCompetitor[competitorId].map((r) => r.status);
    assert.equal(statuses[0], 'completed');
    assert.equal(statuses[1], 'paused');
    const paused = aiStore.analysisHistory({ workspaceId: owner.wsId, competitorId })
      .find((a) => a.status === 'paused');
    assert.equal(paused.error, 'scan_request_cap');
  } finally {
    if (previous === undefined) delete process.env.AI_MAX_REQUESTS_PER_SCAN;
    else process.env.AI_MAX_REQUESTS_PER_SCAN = previous;
  }
});

test('the analysis history API reports versions and their evidence', async () => {
  calls = [];
  installResponder(goodResponder);
  const { scanId, competitorId } = setupScan();
  seedCollection({
    workspaceId: owner.wsId, competitorId,
    plans: [{ identity_key: 'starter', plan_name: 'Starter', price_display: '$29', price_value: 29 }]
  });
  await engine.runScanAI({ workspaceId: owner.wsId, scanId });

  const res = await owner.client.req('GET', `/workspaces/${owner.wsId}/competitors/${competitorId}/ai/analyses`);
  assert.equal(res.status, 200);
  assert.equal(res.data.analyses.length, engine.STAGES.length);
  const pricing = res.data.analyses.find((a) => a.stage === 'pricing');
  assert.equal(pricing.status, 'completed');
  assert.ok(pricing.evidence.length > 0, 'the response lists the evidence consumed');
  assert.ok(pricing.findings >= 1);

  const asStranger = await stranger.client.req('GET', `/workspaces/${stranger.wsId}/competitors/${competitorId}/ai/analyses`);
  assert.equal(asStranger.status, 404);
});
