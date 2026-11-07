'use strict';
// Screenshot metadata persistence.
//
// The image bytes live in the storage provider; this table holds what a client
// needs to understand a capture without reading the file: which page, which type,
// when, what status, and an opaque storage reference. Every query is
// workspace-scoped.
const db = require('../db/index');
const { newId, utcNow } = require('../util');

function recordScreenshot({
  workspaceId, competitorId, pageId = null, url, pageType, status, reason = null,
  contentHash = null, storageProvider = null, storageKey = null, storageUrl = null,
  bytes = null, width = null, height = null, durationMs = null, capturedAt = null,
  duplicateOf = null
}) {
  const id = newId('shot');
  const now = utcNow();
  db.prepare(`INSERT INTO competitor_screenshots
    (id, workspace_id, competitor_id, page_id, url, page_type, status, reason, content_hash,
     storage_provider, storage_key, storage_url, bytes, width, height, duration_ms,
     captured_at, duplicate_of, capture_version, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`)
    .run(id, workspaceId, competitorId, pageId, url, pageType, status, reason, contentHash,
      storageProvider, storageKey, storageUrl, bytes, width, height, durationMs,
      capturedAt, duplicateOf, now, now);
  return db.prepare('SELECT * FROM competitor_screenshots WHERE id=?').get(id);
}

function findByHash({ competitorId, contentHash }) {
  if (!contentHash) return null;
  return db.prepare(`SELECT * FROM competitor_screenshots
      WHERE competitor_id=? AND content_hash=? AND status IN ('captured','duplicate')
      ORDER BY created_at ASC LIMIT 1`).get(competitorId, contentHash) || null;
}

function screenshotFor({ workspaceId, id }) {
  return db.prepare('SELECT * FROM competitor_screenshots WHERE workspace_id=? AND id=?')
    .get(workspaceId, id) || null;
}

function screenshotsFor({ workspaceId, competitorId, pageType = null, limit = 50 }) {
  return pageType
    ? db.prepare(`SELECT * FROM competitor_screenshots
        WHERE workspace_id=? AND competitor_id=? AND page_type=?
        ORDER BY captured_at DESC, created_at DESC LIMIT ?`).all(workspaceId, competitorId, pageType, limit)
    : db.prepare(`SELECT * FROM competitor_screenshots
        WHERE workspace_id=? AND competitor_id=?
        ORDER BY captured_at DESC, created_at DESC LIMIT ?`).all(workspaceId, competitorId, limit);
}

// Latest successful capture per page type. A deduplicated row points at the same
// image, so it counts as a current screenshot.
function latestPerType({ workspaceId, competitorId }) {
  const rows = screenshotsFor({ workspaceId, competitorId, limit: 200 });
  const out = new Map();
  for (const r of rows) {
    if (r.status !== 'captured' && r.status !== 'duplicate') continue;
    if (!out.has(r.page_type)) out.set(r.page_type, r);
  }
  return [...out.values()];
}

function summaryFor({ workspaceId, competitorId }) {
  const rows = db.prepare(`SELECT status, COUNT(*) c FROM competitor_screenshots
      WHERE workspace_id=? AND competitor_id=? GROUP BY status`).all(workspaceId, competitorId);
  const counts = {};
  for (const r of rows) counts[r.status] = Number(r.c);
  return {
    counts,
    captured: (counts.captured || 0) + (counts.duplicate || 0),
    failed: counts.failed || 0,
    unavailable: counts.unavailable || 0,
    skipped: counts.skipped || 0
  };
}

module.exports = { recordScreenshot, findByHash, screenshotFor, screenshotsFor, latestPerType, summaryFor };
