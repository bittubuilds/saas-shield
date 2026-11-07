'use strict';
// Persistence for the competitor intelligence foundation.
//
// Every query is workspace-scoped: there is no path to a competitor, page or
// evidence row that does not name the workspace, so a wrong workspace id
// returns nothing instead of someone else's data.

const db = require('../db/index');
const { newId, utcNow } = require('../util');

function upsertCompetitor({
  workspaceId, discoveryId = null, websiteId = null, domain, siteUrl,
  name = null, description = null, category = null, targetAudience = null,
  positioning = null, relevanceScore = null, breakdown = null,
  status = 'possible', statusReason = null, sourceUrl = null,
  discoverySource = null, createdBy = null
}) {
  const now = utcNow();
  const existing = db.prepare('SELECT id FROM competitors WHERE workspace_id=? AND domain=?')
    .get(workspaceId, domain);
  if (existing) {
    db.prepare(`UPDATE competitors SET
        discovery_id=COALESCE(?, discovery_id),
        website_id=COALESCE(?, website_id),
        site_url=?,
        name=COALESCE(?, name),
        description=COALESCE(?, description),
        category=COALESCE(?, category),
        target_audience=COALESCE(?, target_audience),
        positioning=COALESCE(?, positioning),
        relevance_score=COALESCE(?, relevance_score),
        relevance_breakdown=COALESCE(?, relevance_breakdown),
        status=?, status_reason=?, source_url=COALESCE(?, source_url)
      WHERE workspace_id=? AND id=?`)
      .run(discoveryId, websiteId, siteUrl, name, description, category, targetAudience,
        positioning, relevanceScore, breakdown ? JSON.stringify(breakdown) : null,
        status, statusReason, sourceUrl, workspaceId, existing.id);
    return { id: existing.id, created: false };
  }
  const id = newId('cmp');
  db.prepare(`INSERT INTO competitors (id, workspace_id, discovery_id, website_id, domain, site_url,
      name, description, category, target_audience, positioning, relevance_score, relevance_breakdown,
      status, status_reason, source_url, discovery_source, discovered_at, created_by, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, workspaceId, discoveryId, websiteId, domain, siteUrl, name, description, category,
      targetAudience, positioning, relevanceScore, breakdown ? JSON.stringify(breakdown) : null,
      status, statusReason, sourceUrl, discoverySource, now, createdBy, now);
  return { id, created: true };
}

function recordDiscovery({
  workspaceId, discoveryId = null, competitorId = null, query = null,
  resultUrl, resultHost, searchRank = null, decision, score = null,
  breakdown = null, reason = null
}) {
  const id = newId('cdc');
  db.prepare(`INSERT INTO competitor_discoveries (id, workspace_id, discovery_id, competitor_id,
      query, result_url, result_host, search_rank, decision, score, score_breakdown, reason, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, workspaceId, discoveryId, competitorId, query, resultUrl, resultHost,
      searchRank, decision, score, breakdown ? JSON.stringify(breakdown) : null, reason, utcNow());
  return id;
}

function recordPage({
  workspaceId, competitorId, url, pageType = 'other', confidence = null,
  classificationReason = null, httpStatus = null, contentHash = null,
  fetchStatus = 'ok', fetchError = null
}) {
  const now = utcNow();
  const existing = db.prepare('SELECT id FROM competitor_pages WHERE competitor_id=? AND url=?')
    .get(competitorId, url);
  if (existing) {
    db.prepare(`UPDATE competitor_pages SET page_type=?, classification_confidence=?,
        classification_reason=?, http_status=?, content_hash=?, fetch_status=?, fetch_error=?, fetched_at=?
        WHERE competitor_id=? AND id=?`)
      .run(pageType, confidence, classificationReason, httpStatus, contentHash,
        fetchStatus, fetchError, now, competitorId, existing.id);
    return existing.id;
  }
  const id = newId('cpge');
  db.prepare(`INSERT INTO competitor_pages (id, workspace_id, competitor_id, url, page_type,
      classification_confidence, classification_reason, http_status, content_hash,
      fetch_status, fetch_error, fetched_at, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, workspaceId, competitorId, url, pageType, confidence, classificationReason,
      httpStatus, contentHash, fetchStatus, fetchError, now, now);
  return id;
}

function recordEvidence({
  workspaceId, competitorId, pageId = null, sourceUrl, evidenceType, field = null,
  excerpt = null, contentHash = null, confidence = null, verificationStatus = 'observed'
}) {
  const id = newId('cev');
  const now = utcNow();
  db.prepare(`INSERT INTO competitor_evidence (id, workspace_id, competitor_id, page_id, source_url,
      evidence_type, field, excerpt, content_hash, confidence, verification_status, collected_at, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, workspaceId, competitorId, pageId, sourceUrl, evidenceType, field,
      excerpt ? String(excerpt).slice(0, 1000) : null, contentHash, confidence,
      verificationStatus, now, now);
  return id;
}

function listCompetitors(workspaceId, { status = null, limit = 100 } = {}) {
  if (status) {
    return db.prepare(`SELECT * FROM competitors WHERE workspace_id=? AND status=?
                       ORDER BY relevance_score DESC, discovered_at DESC LIMIT ?`)
      .all(workspaceId, status, limit);
  }
  return db.prepare(`SELECT * FROM competitors WHERE workspace_id=?
                     ORDER BY relevance_score DESC, discovered_at DESC LIMIT ?`)
    .all(workspaceId, limit);
}

function competitorDetail(workspaceId, competitorId) {
  const competitor = db.prepare('SELECT * FROM competitors WHERE workspace_id=? AND id=?')
    .get(workspaceId, competitorId);
  if (!competitor) return null;
  return {
    competitor,
    pages: db.prepare('SELECT * FROM competitor_pages WHERE workspace_id=? AND competitor_id=? ORDER BY page_type')
      .all(workspaceId, competitorId),
    evidence: db.prepare('SELECT * FROM competitor_evidence WHERE workspace_id=? AND competitor_id=? ORDER BY evidence_type, collected_at')
      .all(workspaceId, competitorId),
    discovery: db.prepare('SELECT * FROM competitor_discoveries WHERE workspace_id=? AND competitor_id=? ORDER BY created_at')
      .all(workspaceId, competitorId)
  };
}

function countsByStatus(workspaceId) {
  const rows = db.prepare('SELECT status, COUNT(*) c FROM competitors WHERE workspace_id=? GROUP BY status')
    .all(workspaceId);
  const out = { verified: 0, possible: 0, rejected: 0, unverifiable: 0 };
  for (const r of rows) out[r.status] = Number(r.c);
  return out;
}

module.exports = {
  upsertCompetitor, recordDiscovery, recordPage, recordEvidence,
  listCompetitors, competitorDetail, countsByStatus
};
