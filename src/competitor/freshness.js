'use strict';
// Evidence freshness.
//
// Five states, one meaning each, decided from timestamps we actually stored
// rather than from a hunch:
//
//   never_collected  no successful fetch has ever stored content for this competitor
//   unavailable      the most recent attempt did not succeed (error, robots block,
//                    empty page), so the last known content cannot be confirmed
//   changed          evidence exists that the latest completed AI analysis never
//                    consumed: new versions, or a competitor never analysed
//   stale            the last successful fetch is older than the freshness window
//   fresh            last successful fetch is inside the window and nothing is unseen
//
// Priority is that order: a competitor that is both stale and unavailable reads
// "unavailable", because we cannot currently see it at all.
//
// Recrawling rule (avoiding unnecessary work): recrawl only when the state is
// never_collected, unavailable or stale. "changed" means the evidence is already
// in the database and only the analysis is behind, so fetching again would cost a
// request and change nothing.
const db = require('../db/index');

const STATES = ['never_collected', 'unavailable', 'changed', 'stale', 'fresh'];

function ttlMs() {
  return Number(process.env.EVIDENCE_FRESH_TTL_HOURS || 168) * 60 * 60 * 1000;
}

function iso(ms) { return new Date(ms).toISOString(); }

// Last successful page fetch for a competitor, across both storage layers Phase 4
// uses (competitor_pages today; pages for the original site's own crawl).
function lastSuccessfulFetch({ workspaceId, competitorId }) {
  const row = db.prepare(`SELECT MAX(fetched_at) AS at FROM competitor_pages
      WHERE workspace_id=? AND competitor_id=? AND fetch_status='ok'`)
    .get(workspaceId, competitorId);
  return (row && row.at) || null;
}

function lastAttempt({ workspaceId, competitorId }) {
  return db.prepare(`SELECT fetch_status, fetched_at, url, fetch_error
      FROM competitor_pages WHERE workspace_id=? AND competitor_id=?
      ORDER BY fetched_at DESC, created_at DESC LIMIT 1`).get(workspaceId, competitorId) || null;
}

// The newest completed analysis for this competitor. "Completed" only: a paused or
// failed run has not consumed the evidence, so it cannot mark evidence as seen.
function lastCompletedAnalysis({ workspaceId, competitorId }) {
  return db.prepare(`SELECT * FROM ai_analyses
      WHERE workspace_id=? AND competitor_id=? AND status='completed'
      ORDER BY finished_at DESC, created_at DESC LIMIT 1`).get(workspaceId, competitorId) || null;
}

// Evidence the last completed analysis did not consume: either observed after it
// finished, or (when nothing has been analysed) any evidence at all.
function unseenEvidence({ workspaceId, competitorId, since }) {
  if (!since) return { count: 0, newest: null };
  const row = db.prepare(`SELECT COUNT(*) c, MAX(observed_at) newest FROM competitor_evidence
      WHERE workspace_id=? AND competitor_id=? AND superseded_at IS NULL AND observed_at >= ?`)
    .get(workspaceId, competitorId, since);
  return { count: Number(row.c || 0), newest: row.newest || null };
}

// Per-page freshness, for operators who need to know which URL is out of date.
function pageStates({ workspaceId, competitorId, now = Date.now() }) {
  const rows = db.prepare(`SELECT url, fetch_status, fetched_at, fetch_error, content_hash
      FROM competitor_pages WHERE workspace_id=? AND competitor_id=? ORDER BY url`)
    .all(workspaceId, competitorId);
  const window = ttlMs();
  return rows.map((r) => {
    let state;
    if (r.fetch_status === 'ok' && r.fetched_at) {
      const age = now - Date.parse(r.fetched_at);
      state = Number.isFinite(age) && age <= window ? 'fresh' : 'stale';
    } else if (r.fetch_status === 'pending') {
      state = 'never_collected';
    } else {
      state = 'unavailable';
    }
    return { url: r.url, state, fetched_at: r.fetched_at, error: r.fetch_error || null };
  });
}

function freshnessFor({ workspaceId, competitorId, now = Date.now() }) {
  const window = ttlMs();
  const success = lastSuccessfulFetch({ workspaceId, competitorId });
  const attempt = lastAttempt({ workspaceId, competitorId });
  const analysis = lastCompletedAnalysis({ workspaceId, competitorId });
  // Start of the window, not the end of it: an analysis reads a snapshot taken
  // when it started, so evidence observed after `created_at` was never consumed
  // even if it landed before `finished_at`. Using finished_at dropped that
  // evidence permanently ("new evidence silently skipped").
  const since = analysis ? (analysis.created_at || analysis.finished_at) : null;
  const unseen = unseenEvidence({ workspaceId, competitorId, since });
  const evidenceCount = Number(db.prepare(`SELECT COUNT(*) c FROM competitor_evidence
      WHERE workspace_id=? AND competitor_id=? AND superseded_at IS NULL`)
    .get(workspaceId, competitorId).c || 0);

  let state;
  let reason;
  if (!success) {
    state = 'never_collected';
    reason = attempt
      ? `no successful fetch yet; last attempt ${attempt.fetch_status}${attempt.fetch_error ? ` (${attempt.fetch_error})` : ''}`
      : 'nothing has been collected for this competitor';
  } else if (attempt && attempt.fetch_status !== 'ok') {
    state = 'unavailable';
    reason = `most recent attempt at ${attempt.url} was ${attempt.fetch_status}${attempt.fetch_error ? ` (${attempt.fetch_error})` : ''}`;
  } else if (evidenceCount > 0 && (!analysis || unseen.count > 0)) {
    state = 'changed';
    reason = analysis
      ? `${unseen.count} evidence version(s) observed after the last completed analysis at ${since}`
      : 'evidence collected but never analysed';
  } else if (now - Date.parse(success) > window) {
    state = 'stale';
    reason = `last successful fetch at ${success} is older than ${Math.round(window / 3600000)}h`;
  } else {
    state = 'fresh';
    reason = `last successful fetch at ${success} is inside the ${Math.round(window / 3600000)}h window`;
  }

  const dueAt = success ? iso(Date.parse(success) + window) : null;
  return {
    state,
    reason,
    last_success_at: success,
    last_attempt_at: attempt ? attempt.fetched_at : null,
    last_analysis_at: since,
    unseen_evidence: unseen.count,
    evidence_versions: evidenceCount,
    fresh_for_hours: Math.round(window / 3600000),
    recrawl_due_at: dueAt,
    pages: pageStates({ workspaceId, competitorId, now })
  };
}

// Should we fetch this competitor again? Only when we cannot rely on what we hold.
function shouldRecollect({ workspaceId, competitorId, now = Date.now() }) {
  const f = freshnessFor({ workspaceId, competitorId, now });
  const recollect = f.state === 'never_collected' || f.state === 'unavailable' || f.state === 'stale';
  return {
    recollect,
    state: f.state,
    reason: recollect
      ? f.reason
      : (f.state === 'changed'
        ? 'evidence already collected; only the analysis is behind'
        : 'evidence is fresh; no fetch needed'),
    next_due_at: f.recrawl_due_at
  };
}

module.exports = { freshnessFor, shouldRecollect, pageStates, STATES, ttlMs, lastSuccessfulFetch };
