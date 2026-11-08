'use strict';
// Persistence for collected competitor intelligence (Phase 4).
//
// Same rule as competitor/store.js: every query names the workspace, so a wrong
// or foreign workspace id returns nothing rather than someone else's rows.
//
// Two shapes are deliberately append-only:
//   - competitor_features and competitor_plans keep every observation, keyed by
//     (competitor, identity, content_hash). A changed page adds a row; it never
//     overwrites the evidence an older claim rested on.
//   - competitor_crawls keeps each attempt, so a partial or failed collection
//     stays visible after a retry succeeds.
const db = require('../db/index');
const { newId, utcNow } = require('../util');

function startCrawl({ workspaceId, competitorId, scanId = null, pageBudget = null }) {
  const id = newId('cwl');
  const now = utcNow();
  db.prepare(`INSERT INTO competitor_crawls
      (id, workspace_id, competitor_id, scan_id, status, page_budget, pages_attempted, pages_ok, pages_failed, started_at, created_at)
      VALUES (?,?,?,?, 'running', ?, 0, 0, 0, ?, ?)`)
    .run(id, workspaceId, competitorId, scanId, pageBudget, now, now);
  return id;
}

function finishCrawl(crawlId, { status, pagesAttempted, pagesOk, pagesFailed, reason = null }) {
  db.prepare(`UPDATE competitor_crawls
      SET status=?, pages_attempted=?, pages_ok=?, pages_failed=?, reason=?, finished_at=?
      WHERE id=?`)
    .run(status, pagesAttempted, pagesOk, pagesFailed, reason, utcNow(), crawlId);
}

// A process that died mid-collection leaves a crawl 'running' and its pages
// unfetched. This closes those rows so the next run starts from a known state.
function recoverStaleCrawls({ workspaceId, staleAfterMs }) {
  const cutoff = new Date(Date.now() - staleAfterMs).toISOString();
  const stale = db.prepare(`SELECT id, competitor_id FROM competitor_crawls
      WHERE workspace_id=? AND status='running' AND started_at < ?`).all(workspaceId, cutoff);
  for (const row of stale) {
    db.prepare(`UPDATE competitor_crawls SET status='partial', reason=?, finished_at=? WHERE id=?`)
      .run('collection process stopped before finishing; recovered on the next run', utcNow(), row.id);
    db.prepare(`UPDATE competitor_pages SET fetch_status='skipped', fetch_error=?
        WHERE competitor_id=? AND fetch_status='pending'`)
      .run('collection was interrupted', row.competitor_id);
  }
  return stale.length;
}

function crawlsFor({ workspaceId, competitorId, limit = 10 }) {
  return db.prepare(`SELECT * FROM competitor_crawls
      WHERE workspace_id=? AND competitor_id=? ORDER BY started_at DESC LIMIT ?`)
    .all(workspaceId, competitorId, limit);
}

function saveFeature({
  workspaceId, competitorId, pageId = null, crawlId = null, sourceUrl, pageType,
  identityKey, name, description = null, category = null, claimLevel,
  confidence = null, verificationStatus = 'observed', evidenceId = null,
  evidenceExcerpt = null, contentHash = null
}) {
  const id = newId('cft');
  const now = utcNow();
  try {
    db.prepare(`INSERT INTO competitor_features
        (id, workspace_id, competitor_id, page_id, crawl_id, source_url, page_type, identity_key,
         name, description, category, claim_level, confidence, verification_status, evidence_id,
         evidence_excerpt, content_hash, observed_at, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, workspaceId, competitorId, pageId, crawlId, sourceUrl, pageType, identityKey,
        name, description, category, claimLevel, confidence, verificationStatus, evidenceId,
        evidenceExcerpt ? String(evidenceExcerpt).slice(0, 1000) : null, contentHash, now, now);
    return { id, inserted: true };
  } catch (e) {
    // The same observation from the same page content is not a new fact.
    if (/UNIQUE constraint failed|duplicate key value/i.test(String(e && e.message))) {
      const existing = db.prepare(`SELECT id FROM competitor_features
          WHERE competitor_id=? AND identity_key=? AND content_hash=?`).get(competitorId, identityKey, contentHash);
      return { id: existing ? existing.id : null, inserted: false };
    }
    throw e;
  }
}

function savePlan({
  workspaceId, competitorId, pageId = null, crawlId = null, sourceUrl, identityKey,
  planName, priceDisplay = null, priceValue = null, currency = null, currencyDisplay = null,
  billingInterval = 'unknown', billingNote = null, isStartingPrice = false, priceStated = false,
  freePlan = null, trialDays = null, trialDisplay = null, usageBased = null,
  enterpriseCustom = null, limits = null, planFeatures = null, originalText,
  confidence = null, verificationStatus = 'observed', evidenceId = null, contentHash = null
}) {
  const id = newId('cpl');
  const now = utcNow();
  try {
    db.prepare(`INSERT INTO competitor_plans
        (id, workspace_id, competitor_id, page_id, crawl_id, source_url, identity_key, plan_name,
         price_display, price_value, currency, currency_display, billing_interval, billing_note,
         is_starting_price, price_stated, free_plan, trial_days, trial_display, usage_based,
         enterprise_custom, limits, plan_features, original_text, confidence, verification_status,
         evidence_id, content_hash, observed_at, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, workspaceId, competitorId, pageId, crawlId, sourceUrl, identityKey, planName,
        priceDisplay, priceValue, currency, currencyDisplay, billingInterval, billingNote,
        isStartingPrice ? 1 : 0, priceStated ? 1 : 0, freePlan, trialDays, trialDisplay, usageBased,
        enterpriseCustom, limits ? JSON.stringify(limits) : null,
        planFeatures ? JSON.stringify(planFeatures) : null,
        originalText, confidence, verificationStatus, evidenceId, contentHash, now, now);
    return { id, inserted: true };
  } catch (e) {
    if (/UNIQUE constraint failed|duplicate key value/i.test(String(e && e.message))) {
      const existing = db.prepare(`SELECT id FROM competitor_plans
          WHERE competitor_id=? AND identity_key=? AND content_hash=?`).get(competitorId, identityKey, contentHash);
      return { id: existing ? existing.id : null, inserted: false };
    }
    throw e;
  }
}

// The current answer per competitor. NULL columns stay NULL: unknown is a state,
// not a zero.
function savePricingSummary({
  workspaceId, competitorId, crawlId = null, hasPricingEvidence, freePlan = null,
  freeTrial = null, trialDays = null, trialDisplay = null, startingPriceDisplay = null,
  startingPriceValue = null, currency = null, billingInterval = null, usageBased = null,
  enterpriseCustom = null, plansCount = 0, sourceUrl = null, confidence = null
}) {
  const now = utcNow();
  const existing = db.prepare('SELECT competitor_id FROM competitor_pricing WHERE competitor_id=?')
    .get(competitorId);
  if (existing) {
    db.prepare(`UPDATE competitor_pricing SET
        crawl_id=?, has_pricing_evidence=?, free_plan=?, free_trial=?, trial_days=?, trial_display=?,
        starting_price_display=?, starting_price_value=?, currency=?, billing_interval=?,
        usage_based=?, enterprise_custom=?, plans_count=?, source_url=?, confidence=?, extracted_at=?
        WHERE competitor_id=? AND workspace_id=?`)
      .run(crawlId, hasPricingEvidence ? 1 : 0, freePlan, freeTrial, trialDays, trialDisplay,
        startingPriceDisplay, startingPriceValue, currency, billingInterval, usageBased,
        enterpriseCustom, plansCount, sourceUrl, confidence, now, competitorId, workspaceId);
    return;
  }
  db.prepare(`INSERT INTO competitor_pricing
      (competitor_id, workspace_id, crawl_id, has_pricing_evidence, free_plan, free_trial, trial_days,
       trial_display, starting_price_display, starting_price_value, currency, billing_interval,
       usage_based, enterprise_custom, plans_count, source_url, confidence, extracted_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(competitorId, workspaceId, crawlId, hasPricingEvidence ? 1 : 0, freePlan, freeTrial, trialDays,
      trialDisplay, startingPriceDisplay, startingPriceValue, currency, billingInterval,
      usageBased, enterpriseCustom, plansCount, sourceUrl, confidence, now);
}

// Latest observation per identity, newest first. Keeps history in the table while
// giving callers one row per feature or plan.
function latestByIdentity(rows, identityOf = (r) => r.identity_key) {
  const seen = new Map();
  for (const r of rows) {
    const key = identityOf(r);
    const prev = seen.get(key);
    if (!prev || String(r.observed_at) > String(prev.observed_at)) seen.set(key, r);
  }
  return [...seen.values()];
}

// Upsert a collected page with its fetched content and fetch metadata. Keyed by
// (competitor, url): a re-collection refreshes the same row instead of piling up
// duplicates, while the fetch status and error always describe the last attempt.
function saveCollectedPage({
  workspaceId, competitorId, url, pageType = 'other', classificationConfidence = null,
  classificationReason = null, relevanceScore = null, discoverySource = null, depth = null,
  httpStatus = null, finalUrl = null, title = null, textContent = null, contentHash = null,
  fetchedBytes = null, duplicateOf = null, fetchStatus = 'ok', fetchError = null, fetchedAt = null
}) {
  const now = fetchedAt || utcNow();
  const existing = db.prepare('SELECT id FROM competitor_pages WHERE competitor_id=? AND url=?')
    .get(competitorId, url);
  const text = textContent === null ? null : String(textContent);
  if (existing) {
    db.prepare(`UPDATE competitor_pages SET page_type=?, classification_confidence=?,
        classification_reason=?, relevance_score=?, discovery_source=?, depth=?, http_status=?,
        final_url=?, title=?, text_content=?, text_chars=?, content_hash=?, fetched_bytes=?,
        duplicate_of=?, fetch_status=?, fetch_error=?, fetched_at=?
        WHERE competitor_id=? AND id=?`)
      .run(pageType, classificationConfidence, classificationReason, relevanceScore, discoverySource,
        depth, httpStatus, finalUrl, title, text, text ? text.length : null, contentHash,
        fetchedBytes, duplicateOf, fetchStatus, fetchError, now, competitorId, existing.id);
    return existing.id;
  }
  const id = newId('cpge');
  db.prepare(`INSERT INTO competitor_pages
      (id, workspace_id, competitor_id, url, page_type, classification_confidence,
       classification_reason, relevance_score, discovery_source, depth, http_status, final_url,
       title, text_content, text_chars, content_hash, fetched_bytes, duplicate_of,
       fetch_status, fetch_error, fetched_at, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, workspaceId, competitorId, url, pageType, classificationConfidence,
      classificationReason, relevanceScore, discoverySource, depth, httpStatus, finalUrl,
      title, text, text ? text.length : null, contentHash, fetchedBytes, duplicateOf,
      fetchStatus, fetchError, now, now);
  return id;
}

function featuresFor({ workspaceId, competitorId, includeHistory = false }) {
  const rows = db.prepare(`SELECT * FROM competitor_features
      WHERE workspace_id=? AND competitor_id=? ORDER BY observed_at DESC, id`)
    .all(workspaceId, competitorId);
  return includeHistory ? rows : latestByIdentity(rows);
}

function plansFor({ workspaceId, competitorId, includeHistory = false }) {
  const rows = db.prepare(`SELECT * FROM competitor_plans
      WHERE workspace_id=? AND competitor_id=? ORDER BY observed_at DESC, id`)
    .all(workspaceId, competitorId);
  return includeHistory ? rows : latestByIdentity(rows);
}

function pricingFor({ workspaceId, competitorId }) {
  const row = db.prepare('SELECT * FROM competitor_pricing WHERE workspace_id=? AND competitor_id=?')
    .get(workspaceId, competitorId);
  return row || null;
}

module.exports = {
  startCrawl, finishCrawl, recoverStaleCrawls, crawlsFor,
  saveCollectedPage, saveFeature, savePlan, savePricingSummary,
  featuresFor, plansFor, pricingFor, latestByIdentity
};
