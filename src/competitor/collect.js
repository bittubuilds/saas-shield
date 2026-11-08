'use strict';
// Phase 4 orchestrator: from an accepted competitor to structured intelligence.
//
//   competitor -> bounded page discovery (deep-crawl)
//              -> secure fetch of each target (crawler.fetchPage)
//              -> stored pages with fetch status
//              -> deterministic feature extraction
//              -> deterministic pricing extraction + per-competitor summary
//
// The collector owns no parsing rules of its own: it wires the modules together
// and records what happened. Failures are part of the result, never an exception
// that loses the pages that did load.
const crawler = require('../crawler');
const config = require('../config');
const db = require('../db/index');
const store = require('./store');
const versions = require('./evidence-versions');
const intel = require('./intel-store');
const deepCrawl = require('./deep-crawl');
const featureExtract = require('./extract-features');
const pricingExtract = require('./extract-pricing');
const screenshots = require('../screenshots/capture');
const { newId, utcNow } = require('../util');

function loadCompetitor(workspaceId, competitorId) {
  return db.prepare('SELECT * FROM competitors WHERE workspace_id=? AND id=?').get(workspaceId, competitorId);
}

function siteUrlOf(competitor) {
  return competitor.site_url || `https://${competitor.domain}/`;
}

// Sitemap seeds widen coverage without widening the budget. A sitemap that cannot
// be read is not an error worth failing the run over.
async function sitemapSeeds(siteUrl, { enabled = true } = {}) {
  if (!enabled) return { urls: [], error: null };
  try {
    const sitemap = require('../sitemap');
    const found = await sitemap.discoverFromSitemaps(siteUrl);
    return { urls: (found && found.urls) || [], error: null };
  } catch (e) {
    return { urls: [], error: e.message };
  }
}

function pageTypeOf(target) {
  return target.pageType || target.page_type || 'other';
}

async function collectCompetitor({
  workspaceId, competitorId, scanId = null,
  fetchPage: fetchPageOption = null, useSitemaps = true,
  maxPages = config.competitorIntel.maxPages,
  maxPerType = config.competitorIntel.maxPerType,
  staleAfterMs = config.competitorIntel.staleAfterMs,
  // Screenshot capture is injectable so tests never need a browser, and can be
  // switched off entirely without touching the text pipeline.
  screenshotOptions = null
}) {
  const fetchPage = typeof fetchPageOption === 'function' ? fetchPageOption : crawler.fetchPage;
  const competitor = loadCompetitor(workspaceId, competitorId);
  if (!competitor) return { ok: false, code: 'not_found', error: 'competitor not found in this workspace' };

  // Close anything a dead process left open before starting a new attempt.
  intel.recoverStaleCrawls({ workspaceId, staleAfterMs });

  const siteUrl = siteUrlOf(competitor);
  const crawlId = intel.startCrawl({ workspaceId, competitorId, scanId, pageBudget: maxPages });

  // --- homepage first: every other target is discovered from it ---------------
  let homepage = null;
  let homepageError = null;
  try {
    homepage = await fetchPage(siteUrl);
  } catch (e) {
    homepageError = e && e.message ? e.message : 'homepage fetch failed';
  }

  if (!homepage) {
    intel.saveCollectedPage({
      workspaceId, competitorId, url: siteUrl, pageType: 'homepage',
      discoverySource: 'seed', depth: 0, fetchStatus: deepCrawl.sameSite
        ? 'failed' : 'failed', fetchError: homepageError
    });
    intel.finishCrawl(crawlId, {
      status: 'failed', pagesAttempted: 1, pagesOk: 0, pagesFailed: 1,
      reason: homepageError
    });
    return {
      ok: false, code: 'homepage_unreachable', error: homepageError, crawl_id: crawlId,
      status: 'failed', pages_ok: 0, pages_failed: 1, features: 0, plans: 0
    };
  }

  const homepageUrl = deepCrawl.sameSite(homepage.finalUrl || siteUrl, siteUrl) ? (homepage.finalUrl || siteUrl) : siteUrl;
  const links = require('../extract').extractLinks(homepage.html || '', homepageUrl, true)
    .map((url) => ({ url, text: '' }));
  const seeds = await sitemapSeeds(homepageUrl, { enabled: useSitemaps });

  const targets = deepCrawl.rankTargets({
    siteUrl: homepageUrl, links, sitemapUrls: seeds.urls, maxPages, maxPerType
  });

  // The homepage was already fetched; serve it from cache so the budget is spent
  // on new pages.
  const cached = new Map([[homepageUrl, homepage], [siteUrl, homepage]]);
  const cachedFetch = async (url) => {
    if (cached.has(url)) return cached.get(url);
    return fetchPage(url);
  };

  const pages = [];
  const failures = [];
  const results = await deepCrawl.fetchTargets({
    targets,
    fetchPage: cachedFetch,
    maxTextChars: config.competitorIntel.maxTextChars,
    onPage: async (record) => {
      const pageId = intel.saveCollectedPage({
        workspaceId, competitorId, url: record.url, pageType: pageTypeOf(record),
        classificationConfidence: record.classification_confidence,
        classificationReason: record.classification_reason,
        relevanceScore: record.score,
        discoverySource: record.discovery_source,
        depth: record.depth,
        httpStatus: record.http_status,
        finalUrl: record.final_url,
        title: record.title,
        textContent: record.text_content,
        contentHash: record.content_hash,
        fetchedBytes: record.fetched_bytes,
        duplicateOf: record.duplicate_of,
        fetchStatus: 'ok'
      });
      pages.push({
        page_id: pageId,
        url: record.url,
        page_type: pageTypeOf(record),
        title: record.title,
        text_content: record.text_content,
        content_hash: record.content_hash,
        fetched_at: utcNow()
      });
    },
    onFailure: async ({ target, status, error }) => {
      intel.saveCollectedPage({
        workspaceId, competitorId, url: target.url, pageType: pageTypeOf(target),
        classificationConfidence: target.classification_confidence,
        classificationReason: target.classification_reason,
        relevanceScore: target.score,
        discoverySource: target.discovery_source,
        depth: target.depth,
        fetchStatus: status,
        fetchError: error
      });
      failures.push({ url: target.url, status, error, page_type: pageTypeOf(target) });
    }
  });

  // --- extraction ------------------------------------------------------------
  const features = featureExtract.extractAll(pages);
  let featuresSaved = 0;
  for (const feature of features) {
    // Versioned write: identical content is a duplicate sighting, changed wording
    // becomes a new version, and the previous version keeps its own record.
    const evidence = versions.recordVersion({
      workspaceId, competitorId, pageId: feature.page_id, sourceUrl: feature.source_url,
      evidenceType: 'feature_claim', field: `feature:${feature.identity_key}`,
      excerpt: feature.evidence_excerpt, confidence: feature.confidence,
      verificationStatus: feature.verification_status
    });
    const evidenceId = evidence.id;
    const saved = intel.saveFeature({
      workspaceId, competitorId, pageId: feature.page_id, crawlId,
      sourceUrl: feature.source_url, pageType: feature.page_type,
      identityKey: feature.identity_key, name: feature.name,
      description: feature.description, category: feature.category,
      claimLevel: feature.claim_level, confidence: feature.confidence,
      verificationStatus: feature.verification_status, evidenceId,
      evidenceExcerpt: feature.evidence_excerpt, contentHash: feature.content_hash
    });
    if (saved.inserted) featuresSaved += 1;
    // Pages that mentioned the same feature are recorded as supporting evidence,
    // so a deduped feature still shows every place it was seen.
    for (const support of feature.support) {
      versions.recordVersion({
        workspaceId, competitorId, pageId: support.page_id, sourceUrl: support.source_url,
        evidenceType: 'feature_mention', field: `feature:${feature.identity_key}`,
        excerpt: support.evidence_excerpt,
        confidence: support.confidence, verificationStatus: support.verification_status
      });
    }
  }

  const { plans, summary } = pricingExtract.extractAll(pages);
  let plansSaved = 0;
  for (const plan of plans) {
    const evidence = versions.recordVersion({
      workspaceId, competitorId, pageId: plan.page_id, sourceUrl: plan.source_url,
      evidenceType: 'pricing_plan', field: `plan:${plan.identity_key}`,
      excerpt: plan.original_text, confidence: plan.confidence, verificationStatus: 'observed'
    });
    const evidenceId = evidence.id;
    const saved = intel.savePlan({
      workspaceId, competitorId, pageId: plan.page_id, crawlId,
      sourceUrl: plan.source_url, identityKey: plan.identity_key,
      planName: plan.plan_name, priceDisplay: plan.price_display, priceValue: plan.price_value,
      currency: plan.currency, currencyDisplay: plan.currency_display,
      billingInterval: plan.billing_interval, billingNote: plan.billing_note,
      priceStated: plan.price_stated, freePlan: plan.free_plan, trialDays: plan.trial_days,
      trialDisplay: plan.trial_display, usageBased: plan.usage_based,
      enterpriseCustom: plan.enterprise_custom, limits: plan.limits,
      planFeatures: plan.plan_features, originalText: plan.original_text,
      confidence: plan.confidence, evidenceId, contentHash: plan.content_hash
    });
    if (saved.inserted) plansSaved += 1;
  }

  intel.savePricingSummary({
    workspaceId, competitorId, crawlId,
    hasPricingEvidence: summary.has_pricing_evidence === 1,
    freePlan: summary.free_plan, freeTrial: summary.free_trial,
    trialDays: summary.trial_days, trialDisplay: summary.trial_display,
    startingPriceDisplay: summary.starting_price_display,
    startingPriceValue: summary.starting_price_value,
    currency: summary.currency, billingInterval: summary.billing_interval,
    usageBased: summary.usage_based, enterpriseCustom: summary.enterprise_custom,
    plansCount: summary.plans_count, sourceUrl: summary.source_url,
    confidence: summary.confidence
  });

  // --- screenshots (optional, isolated) --------------------------------------
  // This block is deliberately last and doubly guarded: capture has its own
  // timeouts and catches everything, and this try/catch exists so a future bug in
  // it still cannot turn a successful text collection into a failed one.
  const shotOptions = screenshotOptions || {};
  let shots = { enabled: false, reason: 'screenshots_disabled', results: [] };
  // Injecting the capture implementation keeps the isolation guarantee testable:
  // a broken capture subsystem must not be able to fail this function.
  const captureImpl = shotOptions.captureImpl || screenshots.captureFor;
  try {
    shots = await captureImpl({
      workspaceId, competitorId, pages,
      settings: shotOptions.settings || undefined,
      storage: shotOptions.storage || null,
      provider: shotOptions.provider || null,
      enabled: shotOptions.enabled === undefined ? config.screenshots.enabled : Boolean(shotOptions.enabled)
    });
  } catch (e) {
    shots = { enabled: true, reason: 'capture_error', error: e && e.message ? e.message : 'unknown', results: [] };
  }

  const totals = deepCrawl.summarise(results);
  // A failure on the only page we had, or no page at all, is a failed run;
  // anything in between is honestly partial.
  const status = totals.status;
  intel.finishCrawl(crawlId, {
    status, pagesAttempted: totals.pagesAttempted, pagesOk: totals.pagesOk,
    pagesFailed: totals.pagesFailed,
    reason: status === 'completed' ? null : `${totals.pagesFailed} of ${totals.pagesAttempted} target(s) could not be collected`
  });

  return {
    ok: status !== 'failed',
    crawl_id: crawlId,
    status,
    pages_ok: totals.pagesOk,
    pages_failed: totals.pagesFailed,
    pages_attempted: totals.pagesAttempted,
    duplicates: results.filter((r) => r.duplicate_of).length,
    features: features.length,
    features_saved: featuresSaved,
    evidence_versions: versions.currentEvidence({ workspaceId, competitorId }).length,
    plans: plans.length,
    plans_saved: plansSaved,
    pricing: summary,
    failures,
    sitemap_error: seeds.error,
    site_url: homepageUrl,
    screenshots: {
      enabled: Boolean(shots.enabled),
      reason: shots.reason || null,
      error: shots.error || null,
      captured: shots.captured || 0,
      duplicates: shots.duplicates || 0,
      failed: shots.failed || 0,
      unavailable: shots.unavailable || 0,
      targets: shots.targets || 0,
      duration_ms: shots.duration_ms || null,
      // Says plainly that this is capture, not analysis.
      analysis: 'none: screenshots are stored, never interpreted'
    }
  };
}

// Everything collected for one competitor, for the API and the report layer.
function intelligenceFor({ workspaceId, competitorId, includeHistory = false }) {
  const competitor = loadCompetitor(workspaceId, competitorId);
  if (!competitor) return null;
  return {
    competitor,
    crawls: intel.crawlsFor({ workspaceId, competitorId }),
    pages: db.prepare(`SELECT id, url, final_url, page_type, http_status, fetch_status, fetch_error,
        relevance_score, discovery_source, depth, title, text_chars, duplicate_of, fetched_at
        FROM competitor_pages WHERE workspace_id=? AND competitor_id=?
        ORDER BY COALESCE(relevance_score, -1) DESC, url`).all(workspaceId, competitorId),
    features: intel.featuresFor({ workspaceId, competitorId, includeHistory }),
    plans: intel.plansFor({ workspaceId, competitorId, includeHistory }),
    pricing: intel.pricingFor({ workspaceId, competitorId }),
    evidence_count: db.prepare('SELECT COUNT(*) c FROM competitor_evidence WHERE workspace_id=? AND competitor_id=?')
      .get(workspaceId, competitorId).c,
    screenshots: require('../screenshots/store').screenshotsFor({ workspaceId, competitorId, limit: 20 }),
    screenshot_summary: require('../screenshots/store').summaryFor({ workspaceId, competitorId })
  };
}

module.exports = { collectCompetitor, intelligenceFor, loadCompetitor, siteUrlOf };
