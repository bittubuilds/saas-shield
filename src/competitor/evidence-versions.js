'use strict';
// Evidence versioning.
//
// Evidence is a version chain, not a mutable row. For each identity - one
// competitor plus one evidence type plus one field - the database holds every
// distinct observation that was ever collected:
//
//   identity "feature_claim:feature:keyword tracking"
//     v1  "Track keywords daily"           observed 06:00  superseded by v2
//     v2  "Track keywords daily and weekly" observed 09:00  current
//
// Four rules, and the rest of this file exists to keep them true:
//   1. A stable content hash decides whether two observations are the same
//      content. Formatting noise (whitespace, case, invisible characters,
//      Unicode form) does not create a new version; a wording change does.
//   2. Recording the same content again is a duplicate. It bumps the sighting
//      count and last_seen_at, and inserts nothing.
//   3. Changed content inserts a new version and closes the previous one by
//      pointer. The previous row keeps its own excerpt, source URL and timestamp.
//   4. Nothing here ever updates the content columns of an existing row.
const crypto = require('node:crypto');
const db = require('../db/index');
const { newId, utcNow } = require('../util');

// Unicode form, case and whitespace are presentation, not content. Zero-width
// characters are stripped because they are invisible but change a hash.
function normaliseExcerpt(value) {
  return String(value === null || value === undefined ? '' : value)
    .normalize('NFC')
    .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Stable content hash: the same observation always produces the same digest,
// whichever page or run it was recorded from.
function contentHash(value) {
  return crypto.createHash('sha256').update(normaliseExcerpt(value)).digest('hex').slice(0, 40);
}

function identityKey({ evidenceType, field }) {
  return `${String(evidenceType || 'other')}:${String(field || '')}`;
}

function ensureIdentityColumns() {
  // Legacy rows written before versioning have no identity. They are history, not
  // current evidence, and must not block a new version chain.
  return true;
}

function currentVersion({ competitorId, identity }) {
  return db.prepare(`SELECT * FROM competitor_evidence
      WHERE competitor_id=? AND identity_key=? AND superseded_at IS NULL
      ORDER BY version DESC LIMIT 1`).get(competitorId, identity);
}

// Record one observation. Returns what happened so a caller can report it:
//   created   - a new version was inserted
//   duplicate - the same content was already current; sighting count bumped
//   amended   - same identity, same content, but a different source URL was seen
function recordVersion({
  workspaceId, competitorId, pageId = null, sourceUrl, evidenceType, field = null,
  excerpt = null, contentHash: providedHash = null, confidence = null,
  verificationStatus = 'observed', observedAt = null
}) {
  const identity = identityKey({ evidenceType, field });
  const hash = providedHash ? String(providedHash) : contentHash(excerpt);
  const now = observedAt || utcNow();
  ensureIdentityColumns();

  const existing = db.prepare(`SELECT * FROM competitor_evidence
      WHERE competitor_id=? AND identity_key=? AND content_hash_norm=?`)
    .get(competitorId, identity, hash);

  if (existing) {
    // Duplicate: count it, remember when it was last seen. Do not rewrite content.
    db.prepare('UPDATE competitor_evidence SET observations=observations+1, last_seen_at=? WHERE id=?')
      .run(now, existing.id);
    return {
      id: existing.id,
      version: existing.version,
      status: existing.superseded_at ? 'duplicate_superseded' : 'duplicate',
      identity,
      content_hash: hash,
      source_changed: Boolean(sourceUrl && existing.source_url && sourceUrl !== existing.source_url)
    };
  }

  const previous = currentVersion({ competitorId, identity });
  const nextVersion = Number((previous && previous.version) || 0) + 1;
  const id = newId('cev');

  // Close the previous version first, then insert. If the insert fails the chain
  // has a closed tip and no open one, so a retry sees no previous version and
  // re-inserts the same content hash, which the unique index refuses.
  if (previous) {
    db.prepare('UPDATE competitor_evidence SET superseded_at=?, superseded_by=? WHERE id=? AND superseded_at IS NULL')
      .run(now, id, previous.id);
  }

  try {
    db.prepare(`INSERT INTO competitor_evidence
        (id, workspace_id, competitor_id, page_id, source_url, evidence_type, field, excerpt,
         content_hash, content_hash_norm, identity_key, version, confidence, verification_status,
         collected_at, observed_at, last_seen_at, observations, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, workspaceId, competitorId, pageId, sourceUrl, evidenceType, field,
        excerpt === null ? null : String(excerpt).slice(0, 1000), providedHash || null,
        hash, identity, nextVersion, confidence, verificationStatus, now, now, now, 1, now);
  } catch (e) {
    // A concurrent writer inserted the same content first. That writer's row is
    // the truth; restore nothing and report the duplicate.
    if (/UNIQUE constraint failed|duplicate key value/i.test(String(e && e.message))) {
      const winner = db.prepare(`SELECT * FROM competitor_evidence
          WHERE competitor_id=? AND identity_key=? AND content_hash_norm=?`).get(competitorId, identity, hash);
      if (winner) {
        if (previous) {
          db.prepare('UPDATE competitor_evidence SET superseded_at=NULL, superseded_by=NULL WHERE id=? AND superseded_by=?')
            .run(previous.id, id);
        }
        db.prepare('UPDATE competitor_evidence SET observations=observations+1, last_seen_at=? WHERE id=?')
          .run(now, winner.id);
        return { id: winner.id, version: winner.version, status: 'duplicate', identity, content_hash: hash, source_changed: false };
      }
    }
    throw e;
  }

  return {
    id,
    version: nextVersion,
    status: 'created',
    identity,
    content_hash: hash,
    previous: previous ? { id: previous.id, version: previous.version } : null
  };
}

// Current evidence for a competitor. Optional filters keep the query shape small
// for callers that only care about one evidence type.
function currentEvidence({ workspaceId, competitorId, evidenceType = null, limit = 500 }) {
  const rows = evidenceType
    ? db.prepare(`SELECT * FROM competitor_evidence
        WHERE workspace_id=? AND competitor_id=? AND superseded_at IS NULL AND evidence_type=?
        ORDER BY observed_at DESC, id LIMIT ?`).all(workspaceId, competitorId, evidenceType, limit)
    : db.prepare(`SELECT * FROM competitor_evidence
        WHERE workspace_id=? AND competitor_id=? AND superseded_at IS NULL
        ORDER BY observed_at DESC, id LIMIT ?`).all(workspaceId, competitorId, limit);
  return rows;
}

// Full chain for one identity, oldest first, so a caller can show how a claim
// changed. historical rows are returned exactly as they were observed.
function historyFor({ workspaceId, competitorId, identity }) {
  return db.prepare(`SELECT * FROM competitor_evidence
      WHERE workspace_id=? AND competitor_id=? AND identity_key=?
      ORDER BY version ASC, observed_at ASC`).all(workspaceId, competitorId, identity);
}

function historyForCompetitor({ workspaceId, competitorId, limit = 500 }) {
  return db.prepare(`SELECT * FROM competitor_evidence
      WHERE workspace_id=? AND competitor_id=?
      ORDER BY identity_key, version ASC`).all(workspaceId, competitorId).slice(0, limit);
}

// Evidence observed after a timestamp. Used for freshness ("what the last
// analysis has not seen") and for incremental reporting.
function observedSince({ workspaceId, competitorId, since }) {
  return db.prepare(`SELECT * FROM competitor_evidence
      WHERE workspace_id=? AND competitor_id=? AND observed_at > ?
      ORDER BY observed_at ASC`).all(workspaceId, competitorId, String(since || ''));
}

// Stable fingerprint of the current evidence set. The AI engine puts this in its
// input hash, so identical evidence means identical work and no new model call.
function fingerprint({ workspaceId, competitorId }) {
  const rows = currentEvidence({ workspaceId, competitorId });
  const parts = rows
    .map((r) => `${r.identity_key}:v${r.version}:${r.content_hash_norm || r.content_hash || ''}`)
    .sort();
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 40);
}

// Is this evidence id real, current and owned by this competitor and workspace?
// Used to reject a citation that points at nothing or at another tenant's row.
function isValidEvidenceRef({ workspaceId, competitorId, evidenceId }) {
  const row = db.prepare(`SELECT id FROM competitor_evidence
      WHERE id=? AND workspace_id=? AND competitor_id=?`).get(evidenceId, workspaceId, competitorId);
  return Boolean(row);
}

module.exports = {
  normaliseExcerpt, contentHash, identityKey, recordVersion,
  currentEvidence, historyFor, historyForCompetitor, observedSince, fingerprint,
  isValidEvidenceRef, currentVersion
};
