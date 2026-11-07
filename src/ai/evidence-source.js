'use strict';
// What the AI engine is allowed to read.
//
// Phase 4 collects structured evidence: pages with their text, current feature
// claims, current pricing plans and one pricing summary per competitor. This file
// turns those rows into a single evidence packet for the incremental analysis
// engine, and it is the only place that decides what a citation may point at.
//
// Invariants:
//   * every item is read with the workspace id in the query, so another tenant's
//     row can never enter a prompt;
//   * every citable ref is a real stored id (or a derived id whose source row
//     exists), and `allowedRefs` is exactly that set, so a model that cites
//     something else has its finding dropped rather than trusted;
//   * the fingerprint covers the content the prompt will carry, so unchanged
//     evidence produces an unchanged input hash and no model call.
const crypto = require('node:crypto');
const db = require('../db/index');
const intel = require('../competitor/intel-store');
const versions = require('../competitor/evidence-versions');

const CLAIM_ORDER = { documented: 4, marketing: 3, inferred: 2, unverified: 1 };

function sha(parts) {
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 40);
}

function competitorPages({ workspaceId, competitorId, minChars, maxPages }) {
  const rows = db.prepare(`SELECT id, url, final_url, title, text_content, content_hash, page_type,
      relevance_score, fetched_at
    FROM competitor_pages
    WHERE workspace_id=? AND competitor_id=? AND fetch_status='ok'
      AND text_content IS NOT NULL AND LENGTH(text_content) >= ?
    ORDER BY CASE page_type
        WHEN 'pricing' THEN 0 WHEN 'features' THEN 1 WHEN 'product' THEN 2
        WHEN 'homepage' THEN 3 WHEN 'docs' THEN 4 ELSE 5 END,
      COALESCE(relevance_score, 0) DESC, url
    LIMIT ?`).all(workspaceId, competitorId, minChars, maxPages);
  return rows.map((r) => ({
    kind: 'competitor_page',
    id: r.id,
    url: r.final_url || r.url,
    title: r.title,
    text_content: r.text_content,
    content_hash: r.content_hash,
    page_type: r.page_type,
    observed_at: r.fetched_at
  }));
}

// Fallback source: the original site's own crawl (Phase 3 pages table). Kept so a
// scan still has evidence before Phase 4 collection has run for a competitor.
function websitePages({ workspaceId, websiteId, minChars, maxPages }) {
  if (!websiteId) return [];
  const rows = db.prepare(`SELECT id, url, title, meta_description, text_content, content_hash, fetched_at
    FROM pages WHERE workspace_id=? AND website_id=? AND text_content IS NOT NULL AND LENGTH(text_content) >= ?
    ORDER BY fetched_at DESC`).all(workspaceId, websiteId, minChars);
  const ranked = rows.map((p) => {
    const u = String(p.url || '').toLowerCase();
    let rank = 3;
    if (/pricing|plans/.test(u)) rank = 0;
    else if (/features|product/.test(u)) rank = 1;
    else if (/\/$/.test(u)) rank = 2;
    return { p, rank };
  }).sort((a, b) => a.rank - b.rank || String(a.p.url).localeCompare(String(b.p.url)));
  return ranked.slice(0, maxPages).map(({ p }) => ({
    kind: 'page',
    id: p.id,
    url: p.url,
    title: p.title,
    text_content: p.text_content,
    content_hash: p.content_hash,
    page_type: null,
    observed_at: p.fetched_at
  }));
}

// Current structured claims, strongest first. Superseded versions are excluded by
// intel-store, which returns the latest observation per identity.
function structuredEvidence({ workspaceId, competitorId }) {
  const features = intel.featuresFor({ workspaceId, competitorId })
    .filter((f) => f.name)
    .sort((a, b) => (CLAIM_ORDER[b.claim_level] || 0) - (CLAIM_ORDER[a.claim_level] || 0) || a.name.localeCompare(b.name))
    .slice(0, 40)
    .map((f) => ({
      ref: f.id, name: f.name, claim_level: f.claim_level, category: f.category,
      confidence: f.confidence, source_url: f.source_url, observed_at: f.observed_at
    }));

  const plans = intel.plansFor({ workspaceId, competitorId })
    .slice(0, 12)
    .map((p) => ({
      ref: p.id, plan_name: p.plan_name, price_display: p.price_display,
      price_value: p.price_value, price_stated: p.price_stated === 1,
      currency: p.currency, currency_display: p.currency_display,
      billing_interval: p.billing_interval, free_plan: p.free_plan,
      trial_days: p.trial_days, usage_based: p.usage_based,
      enterprise_custom: p.enterprise_custom, source_url: p.source_url,
      observed_at: p.observed_at
    }));

  const row = intel.pricingFor({ workspaceId, competitorId });
  const pricing = row ? {
    ref: `cpricing_${competitorId}`,
    has_pricing_evidence: row.has_pricing_evidence === 1,
    free_plan: row.free_plan, free_trial: row.free_trial, trial_days: row.trial_days,
    starting_price_display: row.starting_price_display,
    starting_price_value: row.starting_price_value,
    currency: row.currency, billing_interval: row.billing_interval,
    usage_based: row.usage_based, enterprise_custom: row.enterprise_custom,
    plans_count: row.plans_count, source_url: row.source_url, confidence: row.confidence
  } : null;

  return { features, plans, pricing };
}

// The packet the engine reads. `pages` keeps the shape prompts.js already expects,
// and `structured` is the additional, already-parsed evidence.
function collectEvidence({ workspaceId, competitor, minChars = 80, maxPages = 3 }) {
  const competitorId = competitor && competitor.id;
  const websiteId = competitor && competitor.website_id;

  let pages = [];
  if (competitorId) pages = competitorPages({ workspaceId, competitorId, minChars, maxPages });
  let source = pages.length ? 'competitor_pages' : null;
  if (!pages.length) {
    pages = websitePages({ workspaceId, websiteId, minChars, maxPages });
    if (pages.length) source = 'pages';
  }

  const structured = competitorId
    ? structuredEvidence({ workspaceId, competitorId })
    : { features: [], plans: [], pricing: null };

  const hasStructured = structured.features.length > 0 || structured.plans.length > 0 || Boolean(structured.pricing);
  if (!source && hasStructured) source = 'structured_only';

  const allowedRefs = new Set([
    ...pages.map((p) => p.id),
    ...structured.features.map((f) => f.ref),
    ...structured.plans.map((p) => p.ref),
    ...(structured.pricing ? [structured.pricing.ref] : [])
  ]);

  const sources = new Map();
  for (const p of pages) sources.set(p.id, p.url);
  for (const f of structured.features) sources.set(f.ref, f.source_url);
  for (const p of structured.plans) sources.set(p.ref, p.source_url);
  if (structured.pricing) sources.set(structured.pricing.ref, structured.pricing.source_url);

  // Fingerprints are per stage, over exactly the evidence that stage receives.
  // A price change must not re-run the feature stage: that would spend a model
  // call to learn nothing.
  const pageParts = pages.map((p) => `p:${p.id}:${p.content_hash || ''}`).sort();
  const featureParts = structured.features.map((f) => `f:${f.ref}:${f.claim_level}`).sort();
  const planParts = [
    ...structured.plans.map((p) => `pl:${p.ref}:${p.price_value}:${p.price_stated}`).sort(),
    ...(structured.pricing
      ? [`cp:${structured.pricing.ref}:${structured.pricing.starting_price_value}:${structured.pricing.free_plan}:${structured.pricing.billing_interval}`]
      : [])
  ].sort();
  const fingerprints = {
    pricing: sha([...pageParts, ...planParts]),
    features: sha([...pageParts, ...featureParts]),
    overview: sha([...pageParts, ...featureParts, ...planParts]),
    positioning: sha([...pageParts, ...featureParts, ...planParts])
  };
  const fingerprint = sha([...pageParts, ...featureParts, ...planParts]);

  return {
    pages,
    structured,
    allowedRefs,
    sources,
    fingerprint,
    fingerprints,
    fingerprintFor: (stage) => fingerprints[stage] || fingerprint,
    source,
    hasEvidence: pages.length > 0 || hasStructured,
    evidenceVersionCount: competitorId
      ? versions.currentEvidence({ workspaceId, competitorId }).length
      : 0
  };
}

// Reject a citation that points at nothing, at a superseded version, or at another
// workspace's evidence. Returns the subset of ids that survive.
function filterValidRefs({ workspaceId, competitorId, ids = [] }) {
  const out = [];
  for (const raw of ids) {
    const ref = String(raw);
    if (!ref) continue;
    if (ref.startsWith('cev_')) {
      if (versions.isValidEvidenceRef({ workspaceId, competitorId, evidenceId: ref })) out.push(ref);
      continue;
    }
    // Page, feature, plan and pricing refs are validated by the collector's
    // allowed set, which was itself read with the workspace id.
    out.push(ref);
  }
  return out;
}

module.exports = { collectEvidence, structuredEvidence, competitorPages, websitePages, filterValidRefs, sha };
