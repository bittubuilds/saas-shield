'use strict';
// Phase 4 API: collected competitor intelligence.
//
// Read routes return only what was collected; the collect route runs the bounded
// collection once. Everything is workspace-scoped through requireWorkspace, so a
// competitor in another workspace is indistinguishable from a missing one.
const express = require('express');
const db = require('../db/index');
const collect = require('../competitor/collect');
const intel = require('../competitor/intel-store');
const versions = require('../competitor/evidence-versions');
const freshness = require('../competitor/freshness');
const aiStore = require('../ai/store');
const shotStore = require('../screenshots/store');
const shotBrowser = require('../screenshots/browser');
const { getStorage } = require('../storage');
const vision = require('../ai/vision');
const shotConfig = require('../config').screenshots;
const { requireAuth, requireWorkspace, audit, rateLimit } = require('../auth');

const router = express.Router();
router.use(requireAuth);

const collectLimiter = rateLimit({ limit: 10, windowMs: 10 * 60 * 1000, bucket: 'competitor-collect' });

function publicFeature(f) {
  return {
    id: f.id,
    name: f.name,
    description: f.description,
    category: f.category,
    competitor_id: f.competitor_id,
    source_url: f.source_url,
    page_type: f.page_type,
    claim_level: f.claim_level,
    confidence: f.confidence,
    verification_status: f.verification_status,
    evidence_id: f.evidence_id,
    evidence_excerpt: f.evidence_excerpt,
    observed_at: f.observed_at
  };
}

function publicPlan(p) {
  let limits = null;
  let features = null;
  try { limits = p.limits ? JSON.parse(p.limits) : null; } catch { limits = null; }
  try { features = p.plan_features ? JSON.parse(p.plan_features) : null; } catch { features = null; }
  return {
    id: p.id,
    plan_name: p.plan_name,
    price_display: p.price_display,
    price_value: p.price_value,
    price_stated: p.price_stated === 1,
    currency: p.currency,
    currency_display: p.currency_display,
    billing_interval: p.billing_interval,
    billing_note: p.billing_note,
    free_plan: p.free_plan,
    trial_days: p.trial_days,
    trial_display: p.trial_display,
    usage_based: p.usage_based,
    enterprise_custom: p.enterprise_custom,
    limits,
    plan_features: features,
    original_text: p.original_text,
    source_url: p.source_url,
    evidence_id: p.evidence_id,
    confidence: p.confidence,
    verification_status: p.verification_status,
    observed_at: p.observed_at
  };
}

router.get('/workspaces/:workspaceId/competitors', requireWorkspace(), (req, res) => {
  const rows = db.prepare(`SELECT c.*,
      (SELECT COUNT(*) FROM competitor_features f WHERE f.competitor_id=c.id) AS feature_rows,
      (SELECT COUNT(*) FROM competitor_plans p WHERE p.competitor_id=c.id) AS plan_rows
      FROM competitors c WHERE c.workspace_id=?
      ORDER BY c.relevance_score DESC, c.discovered_at DESC LIMIT 100`).all(req.workspace.id);
  res.json({
    competitors: rows.map((c) => ({
      id: c.id, domain: c.domain, name: c.name, category: c.category, status: c.status,
      site_url: c.site_url, relevance_score: c.relevance_score,
      feature_rows: Number(c.feature_rows), plan_rows: Number(c.plan_rows)
    }))
  });
});

router.get('/workspaces/:workspaceId/competitors/:competitorId/intelligence', requireWorkspace(), (req, res) => {
  const includeHistory = req.query.history === '1' || req.query.history === 'true';
  const data = collect.intelligenceFor({
    workspaceId: req.workspace.id, competitorId: req.params.competitorId, includeHistory
  });
  if (!data) return res.status(404).json({ error: 'Competitor not found.' });
  res.json({
    competitor: {
      id: data.competitor.id, domain: data.competitor.domain, name: data.competitor.name,
      status: data.competitor.status, site_url: data.competitor.site_url
    },
    crawls: data.crawls,
    pages: data.pages,
    features: data.features.map(publicFeature),
    plans: data.plans.map(publicPlan),
    pricing: data.pricing,
    evidence_count: data.evidence_count
  });
});

// Run a bounded collection for one competitor. Synchronous on purpose: the work is
// capped (maxPages fetches) and the caller wants the outcome, including partial
// failure detail.
router.post('/workspaces/:workspaceId/competitors/:competitorId/collect', requireWorkspace(), collectLimiter, async (req, res, next) => {
  try {
    // Tests inject a fetcher through app.locals; production always uses the
    // secure crawler, so no request can point the collector somewhere else.
    const injected = req.app && req.app.locals ? req.app.locals.competitorFetcher : null;
    const body = req.body || {};
    const result = await collect.collectCompetitor({
      workspaceId: req.workspace.id,
      competitorId: req.params.competitorId,
      scanId: body.scan_id || null,
      fetchPage: typeof injected === 'function' ? injected : undefined,
      useSitemaps: body.use_sitemaps !== false
    });
    if (result.code === 'not_found') return res.status(404).json({ error: 'Competitor not found.' });
    audit(req.workspace.id, req.user.id, 'competitor.collected', {
      competitor_id: req.params.competitorId,
      crawl_id: result.crawl_id,
      status: result.status,
      pages_ok: result.pages_ok,
      pages_failed: result.pages_failed
    });
    res.status(result.ok ? 200 : 502).json(result);
  } catch (e) {
    next(e);
  }
});

// Screenshot capability, so a client can say what is and is not available before
// offering a "view screenshot" affordance.
router.get('/workspaces/:workspaceId/screenshots/capability', requireWorkspace(), (req, res) => {
  const cap = shotBrowser.capability();
  let storage = null;
  try {
    const s = getStorage({ provider: shotConfig.storageProvider, dir: shotConfig.dir });
    storage = s.describe();
  } catch (e) {
    storage = { provider: shotConfig.storageProvider, durable: false, error: e.message };
  }
  res.json({
    enabled: shotConfig.enabled,
    browser: cap,
    storage,
    limits: {
      max_per_competitor: shotConfig.maxPerCompetitor,
      concurrency: shotConfig.concurrency,
      timeout_ms: shotConfig.timeoutMs,
      max_bytes: shotConfig.maxBytes
    },
    // Capture and analysis are different features; say so in the API itself.
    analysis: vision.capability()
  });
});

// Screenshot metadata for one competitor. No image bytes, no visual claims.
router.get('/workspaces/:workspaceId/competitors/:competitorId/screenshots', requireWorkspace(), (req, res) => {
  const competitor = collect.loadCompetitor(req.workspace.id, req.params.competitorId);
  if (!competitor) return res.status(404).json({ error: 'Competitor not found.' });
  let storage = null;
  try {
    storage = getStorage({ provider: shotConfig.storageProvider, dir: shotConfig.dir }).describe();
  } catch (e) {
    storage = { provider: shotConfig.storageProvider, durable: false, error: e.message };
  }
  const rows = shotStore.screenshotsFor({
    workspaceId: req.workspace.id, competitorId: competitor.id,
    pageType: typeof req.query.page_type === 'string' ? req.query.page_type : null
  });
  res.json({
    competitor_id: competitor.id,
    durability: { durable: Boolean(storage && storage.durable), warning: storage && storage.warning },
    analysis: vision.capability(),
    summary: shotStore.summaryFor({ workspaceId: req.workspace.id, competitorId: competitor.id }),
    screenshots: rows.map((r) => ({
      id: r.id, url: r.url, page_type: r.page_type, status: r.status, reason: r.reason,
      content_hash: r.content_hash, storage_provider: r.storage_provider,
      storage_reference: r.storage_key, bytes: r.bytes, width: r.width, height: r.height,
      duration_ms: r.duration_ms, captured_at: r.captured_at,
      duplicate_of: r.duplicate_of, page_id: r.page_id
    }))
  });
});

// One image, streamed from whatever provider captured it. Durable nowhere: if the
// file is gone (a redeploy on an ephemeral host) this is a 410, not a 404 mystery.
router.get('/workspaces/:workspaceId/competitors/:competitorId/screenshots/:shotId/image', requireWorkspace(), async (req, res) => {
  const competitor = collect.loadCompetitor(req.workspace.id, req.params.competitorId);
  if (!competitor) return res.status(404).json({ error: 'Competitor not found.' });
  const shot = shotStore.screenshotFor({ workspaceId: req.workspace.id, id: req.params.shotId });
  if (!shot || shot.competitor_id !== competitor.id) return res.status(404).json({ error: 'Screenshot not found.' });
  if (!shot.storage_key) return res.status(409).json({ error: 'This screenshot has no stored image.', status: shot.status, reason: shot.reason });
  try {
    const storage = getStorage({ provider: shot.storage_provider || shotConfig.storageProvider, dir: shotConfig.dir });
    const blob = await storage.get(shot.storage_key);
    res.setHeader('content-type', 'image/png');
    res.setHeader('cache-control', 'private, max-age=300');
    res.setHeader('content-length', String(blob.buffer.length));
    return res.end(blob.buffer);
  } catch (e) {
    if (e.code === 'STORAGE_NOT_FOUND') {
      return res.status(410).json({
        error: 'Screenshot image is no longer available in storage.',
        hint: 'Local or ephemeral storage does not survive a redeploy; recapture to restore it.'
      });
    }
    return res.status(500).json({ error: 'Screenshot storage error.' });
  }
});

// Current evidence versions plus what we know about how fresh they are.
router.get('/workspaces/:workspaceId/competitors/:competitorId/evidence', requireWorkspace(), (req, res) => {
  const competitor = collect.loadCompetitor(req.workspace.id, req.params.competitorId);
  if (!competitor) return res.status(404).json({ error: 'Competitor not found.' });
  const current = versions.currentEvidence({
    workspaceId: req.workspace.id, competitorId: competitor.id,
    evidenceType: typeof req.query.evidence_type === 'string' ? req.query.evidence_type : null
  });
  res.json({
    competitor: { id: competitor.id, domain: competitor.domain },
    fingerprint: versions.fingerprint({ workspaceId: req.workspace.id, competitorId: competitor.id }),
    freshness: freshness.freshnessFor({ workspaceId: req.workspace.id, competitorId: competitor.id }),
    recrawl: freshness.shouldRecollect({ workspaceId: req.workspace.id, competitorId: competitor.id }),
    current: current.map((e) => ({
      id: e.id, identity_key: e.identity_key, version: e.version, evidence_type: e.evidence_type,
      field: e.field, excerpt: e.excerpt, source_url: e.source_url, confidence: e.confidence,
      verification_status: e.verification_status, observed_at: e.observed_at,
      last_seen_at: e.last_seen_at, observations: e.observations,
      superseded_at: e.superseded_at
    })),
    versions: current.length
  });
});

// Full chain for one identity, oldest first: nothing is overwritten, so this is
// the record of how a claim changed over time.
router.get('/workspaces/:workspaceId/competitors/:competitorId/evidence/history', requireWorkspace(), (req, res) => {
  const competitor = collect.loadCompetitor(req.workspace.id, req.params.competitorId);
  if (!competitor) return res.status(404).json({ error: 'Competitor not found.' });
  const identity = typeof req.query.identity === 'string' ? req.query.identity : null;
  const rows = identity
    ? versions.historyFor({ workspaceId: req.workspace.id, competitorId: competitor.id, identity })
    : versions.historyForCompetitor({ workspaceId: req.workspace.id, competitorId: competitor.id });
  res.json({
    competitor_id: competitor.id,
    identity,
    history: rows.map((e) => ({
      id: e.id, identity_key: e.identity_key, version: e.version, excerpt: e.excerpt,
      source_url: e.source_url, observed_at: e.observed_at, superseded_at: e.superseded_at,
      superseded_by: e.superseded_by, observations: e.observations
    }))
  });
});

// AI analysis history for a competitor, with the evidence each run consumed.
router.get('/workspaces/:workspaceId/competitors/:competitorId/ai/analyses', requireWorkspace(), (req, res) => {
  const competitor = collect.loadCompetitor(req.workspace.id, req.params.competitorId);
  if (!competitor) return res.status(404).json({ error: 'Competitor not found.' });
  const stage = typeof req.query.stage === 'string' ? req.query.stage : null;
  const rows = aiStore.analysisHistory({
    workspaceId: req.workspace.id, competitorId: competitor.id, stage,
    limit: Number(req.query.limit || 50)
  });
  res.json({
    competitor_id: competitor.id,
    analyses: rows.map((a) => ({
      id: a.id, stage: a.stage, status: a.status, input_hash: a.input_hash,
      analysis_version: a.analysis_version, prompt_version: a.prompt_version,
      attempts: a.attempts, provider: a.provider, model: a.model, error: a.error,
      started_at: a.started_at, finished_at: a.finished_at, created_at: a.created_at,
      evidence: aiStore.analysisEvidence({ workspaceId: req.workspace.id, analysisId: a.id })
        .map((e) => ({ kind: e.evidence_kind, evidence_id: e.evidence_id, source_url: e.source_url, content_hash: e.content_hash, observed_at: e.observed_at })),
      findings: aiStore.findingsForAnalysis({ workspaceId: req.workspace.id, analysisId: a.id }).length
    }))
  });
});

// Feature list across collected competitors, optionally filtered by claim level.
router.get('/workspaces/:workspaceId/features', requireWorkspace(), (req, res) => {
  const level = typeof req.query.claim_level === 'string' ? req.query.claim_level : null;
  const rows = db.prepare(`SELECT * FROM competitor_features WHERE workspace_id=?
      ${level ? 'AND claim_level=?' : ''} ORDER BY observed_at DESC LIMIT 500`)
    .all(...(level ? [req.workspace.id, level] : [req.workspace.id]));
  res.json({ features: rows.map(publicFeature), count: rows.length });
});

router.get('/workspaces/:workspaceId/pricing', requireWorkspace(), (req, res) => {
  const rows = db.prepare(`SELECT cp.*, c.domain, c.name FROM competitor_pricing cp
      JOIN competitors c ON c.id = cp.competitor_id
      WHERE cp.workspace_id=? ORDER BY c.domain`).all(req.workspace.id);
  res.json({ pricing: rows });
});

module.exports = router;
module.exports.__intel = intel;
