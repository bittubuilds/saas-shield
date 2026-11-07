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
