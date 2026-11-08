'use strict';
// Persistence for AI analyses, findings, usage and reports.
//
// Every function takes workspaceId and filters on it. There is no query here
// that can read a competitor, finding or report belonging to another workspace.

const crypto = require('node:crypto');
const db = require('../db/index');
const { utcNow } = require('../util');

function id(prefix) { return `${prefix}_${crypto.randomBytes(9).toString('base64url')}`; }
function day() { return new Date().toISOString().slice(0, 10); }

function findAnalysis({ workspaceId, competitorId, stage, inputHash, analysisVersion }) {
  return db.prepare(`SELECT * FROM ai_analyses
    WHERE workspace_id=? AND competitor_id=? AND stage=? AND input_hash=? AND analysis_version=?`)
    .get(workspaceId, competitorId, stage, inputHash, analysisVersion);
}

function createAnalysis({ workspaceId, competitorId, scanId, stage, inputHash, analysisVersion, promptVersion, provider, model, status = 'pending' }) {
  const now = utcNow();
  const row = {
    id: id('aia'), workspace_id: workspaceId, competitor_id: competitorId, scan_id: scanId,
    stage, status, input_hash: inputHash, provider, model,
    analysis_version: analysisVersion, prompt_version: promptVersion,
    attempts: 0, created_at: now, updated_at: now
  };
  db.prepare(`INSERT INTO ai_analyses
    (id, workspace_id, competitor_id, scan_id, stage, status, input_hash, provider, model,
     analysis_version, prompt_version, attempts, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(row.id, row.workspace_id, row.competitor_id, row.scan_id, row.stage, row.status,
      row.input_hash, row.provider, row.model, row.analysis_version, row.prompt_version,
      0, now, now);
  return row;
}

function markAnalysis(aid, patch) {
  const allowed = ['status', 'attempts', 'error', 'tokens_in', 'tokens_out', 'started_at', 'finished_at'];
  const keys = Object.keys(patch).filter((k) => allowed.includes(k));
  if (!keys.length) return;
  const sets = keys.map((k) => `${k}=?`).join(', ');
  db.prepare(`UPDATE ai_analyses SET ${sets}, updated_at=? WHERE id=?`)
    .run(...keys.map((k) => patch[k]), utcNow(), aid);
}

// Atomically take ownership of an analysis row. Exactly one caller can win, so a
// double click or two workers cannot both spend provider quota on one stage.
// A row left 'running' by a crashed process is reclaimable once it is older than
// staleAfterMs: that is how interrupted work recovers without a manual reset.
function claimAnalysis(aid, { staleAfterMs = 10 * 60 * 1000, maxAttempts = 3 } = {}) {
  const now = utcNow();
  const staleBefore = new Date(Date.now() - Math.max(0, Number(staleAfterMs))).toISOString();
  const res = db.prepare(`UPDATE ai_analyses
    SET status='running', attempts=attempts+1, started_at=?, updated_at=?, error=NULL
    WHERE id=? AND attempts < ?
      AND (status IN ('pending','paused','failed')
           OR (status='running' AND (started_at IS NULL OR started_at < ?)))`)
    .run(now, now, aid, maxAttempts, staleBefore);
  return (res && res.changes) === 1;
}

// Findings are written once per (analysis, kind, statement): a retried batch
// cannot duplicate what an earlier attempt already stored.
function addFinding({ workspaceId, competitorId, scanId, analysisId, kind, statement, detail, claim, confidence, evidenceIds, sourceUrls }) {
  const now = utcNow();
  const res = db.prepare(`INSERT INTO ai_findings
    (id, workspace_id, competitor_id, scan_id, analysis_id, kind, statement, detail, claim,
     confidence, evidence_ids, source_urls, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT (analysis_id, kind, statement) DO NOTHING`)
    .run(id('aif'), workspaceId, competitorId, scanId, analysisId, kind, statement, detail || null,
      claim, confidence, JSON.stringify(evidenceIds), JSON.stringify(sourceUrls), now);
  return (res && res.changes) === 1;
}

function findingsFor({ workspaceId, scanId, competitorId }) {
  const rows = competitorId
    ? db.prepare('SELECT * FROM ai_findings WHERE workspace_id=? AND scan_id=? AND competitor_id=? ORDER BY kind, created_at').all(workspaceId, scanId, competitorId)
    : db.prepare('SELECT * FROM ai_findings WHERE workspace_id=? AND scan_id=? ORDER BY competitor_id, kind').all(workspaceId, scanId);
  return rows.map((r) => ({
    ...r,
    evidence_ids: JSON.parse(r.evidence_ids || '[]'),
    source_urls: JSON.parse(r.source_urls || '[]')
  }));
}

// Record the evidence an analysis consumed. Idempotent: a retried completion
// cannot duplicate a snapshot row.
function snapshotAnalysisEvidence({ workspaceId, scanId = null, competitorId, analysisId, items = [] }) {
  const now = utcNow();
  let inserted = 0;
  for (const item of items) {
    const res = db.prepare(`INSERT INTO ai_analysis_evidence
      (id, workspace_id, analysis_id, scan_id, competitor_id, evidence_kind, evidence_id,
       source_url, content_hash, observed_at, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT (analysis_id, evidence_kind, evidence_id, content_hash) DO NOTHING`)
      .run(id('aiev'), workspaceId, analysisId, scanId, competitorId, item.kind, item.id,
        item.url || null, item.contentHash === null || item.contentHash === undefined ? '' : String(item.contentHash),
        item.observedAt || null, now);
    if (res && res.changes === 1) inserted += 1;
  }
  return inserted;
}

function analysisEvidence({ workspaceId, analysisId }) {
  return db.prepare(`SELECT * FROM ai_analysis_evidence
    WHERE workspace_id=? AND analysis_id=? ORDER BY evidence_kind, evidence_id`)
    .all(workspaceId, analysisId);
}

// Every analysis ever run for this competitor, newest first. Historical rows are
// kept when evidence changes, so a previous read of the same evidence stays
// reproducible instead of being replaced.
function analysisHistory({ workspaceId, competitorId, stage = null, limit = 50 }) {
  const rows = stage
    ? db.prepare(`SELECT * FROM ai_analyses WHERE workspace_id=? AND competitor_id=? AND stage=?
        ORDER BY created_at DESC, id DESC LIMIT ?`).all(workspaceId, competitorId, stage, limit)
    : db.prepare(`SELECT * FROM ai_analyses WHERE workspace_id=? AND competitor_id=?
        ORDER BY created_at DESC, id DESC LIMIT ?`).all(workspaceId, competitorId, limit);
  return rows;
}

function findingsForAnalysis({ workspaceId, analysisId }) {
  return db.prepare('SELECT * FROM ai_findings WHERE workspace_id=? AND analysis_id=? ORDER BY kind, statement')
    .all(workspaceId, analysisId)
    .map((r) => ({
      ...r,
      evidence_ids: JSON.parse(r.evidence_ids || '[]'),
      source_urls: JSON.parse(r.source_urls || '[]')
    }));
}

function trackUsage({ workspaceId, scanId, provider, model, requests = 1, tokensIn = 0, tokensOut = 0 }) {
  const now = utcNow();
  const existing = db.prepare('SELECT * FROM ai_usage WHERE workspace_id=? AND scan_id=? AND provider=? AND model=? AND day=?')
    .get(workspaceId, scanId || '', provider, model, day());
  if (existing) {
    db.prepare('UPDATE ai_usage SET requests=requests+?, tokens_in=tokens_in+?, tokens_out=tokens_out+? WHERE id=?')
      .run(requests, tokensIn, tokensOut, existing.id);
    return;
  }
  db.prepare(`INSERT INTO ai_usage (id, workspace_id, scan_id, provider, model, requests, tokens_in, tokens_out, day, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id('aiu'), workspaceId, scanId || '', provider, model, requests, tokensIn, tokensOut, day(), now);
}

function requestsForScan(scanId) {
  const row = db.prepare('SELECT COALESCE(SUM(requests),0) n FROM ai_usage WHERE scan_id=?').get(scanId);
  return Number(row.n || 0);
}

function requestsToday(workspaceId) {
  const row = db.prepare('SELECT COALESCE(SUM(requests),0) n FROM ai_usage WHERE workspace_id=? AND day=?').get(workspaceId, day());
  return Number(row.n || 0);
}

function analysesFor({ workspaceId, scanId }) {
  return db.prepare('SELECT * FROM ai_analyses WHERE workspace_id=? AND scan_id=? ORDER BY stage').all(workspaceId, scanId);
}

function saveReport({ workspaceId, scanId, provider, model, analysisVersion, competitors, evidenceSnapshot, body }) {
  const now = utcNow();
  // (scan_id, version) is unique, so two simultaneous syntheses cannot silently
  // write the same version: the loser recomputes and writes the next one.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const last = db.prepare('SELECT MAX(version) v FROM ai_reports WHERE scan_id=?').get(scanId);
    const version = Number((last && last.v) || 0) + 1;
    const rid = id('air');
    try {
      db.prepare(`INSERT INTO ai_reports
        (id, workspace_id, scan_id, version, status, provider, model, analysis_version, competitors, evidence_snapshot, body, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(rid, workspaceId, scanId, version, 'completed', provider, model, analysisVersion,
          JSON.stringify(competitors), JSON.stringify(evidenceSnapshot), JSON.stringify(body), now);
      return { id: rid, version };
    } catch (e) {
      const clash = /UNIQUE constraint failed|duplicate key value/i.test(String(e && e.message));
      if (!clash || attempt === 2) throw e;
    }
  }
  throw new Error('could not allocate a report version');
}

function latestReport({ workspaceId, scanId }) {
  // Only completed reports are readable. A 'running' claim row is bookkeeping:
  // it holds no body yet and must never be served as if it were a report.
  const row = db.prepare(`SELECT * FROM ai_reports
    WHERE workspace_id=? AND scan_id=? AND status='completed'
    ORDER BY version DESC LIMIT 1`).get(workspaceId, scanId);
  if (!row) return null;
  return { ...row, competitors: JSON.parse(row.competitors), evidence_snapshot: JSON.parse(row.evidence_snapshot), body: JSON.parse(row.body) };
}

// One specific stored version, for reproducible exports. Historical reports are
// never rewritten, so a version resolved once keeps printing the same content.
function reportByVersion({ workspaceId, scanId, version }) {
  const row = db.prepare(`SELECT * FROM ai_reports
    WHERE workspace_id=? AND scan_id=? AND version=? AND status='completed'`)
    .get(workspaceId, scanId, Number(version));
  if (!row) return null;
  return { ...row, competitors: JSON.parse(row.competitors), evidence_snapshot: JSON.parse(row.evidence_snapshot), body: JSON.parse(row.body) };
}

function reportHistory({ workspaceId, scanId }) {
  return db.prepare(`SELECT id, version, status, provider, model, analysis_version, created_at, finished_at
    FROM ai_reports WHERE workspace_id=? AND scan_id=? ORDER BY version DESC`).all(workspaceId, scanId);
}

// --- incremental synthesis -------------------------------------------------
// What a report would be built from: the findings, and the versions that shaped
// the prompt. Identical input therefore resolves to the same hash and a stored
// report can be reused without calling the model again.
function synthesisInputHash({ findings, analysisVersion, promptVersion }) {
  const parts = [`v${analysisVersion}`, `p${promptVersion}`,
    ...[...findings].map((f) => `${f.id}:${f.kind || ''}:${f.statement || ''}`).sort()];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 40);
}

function reportForHash({ workspaceId, scanId, inputHash }) {
  return db.prepare(`SELECT * FROM ai_reports
    WHERE workspace_id=? AND scan_id=? AND input_hash=? AND status='completed'
    ORDER BY version DESC LIMIT 1`).get(workspaceId, scanId, inputHash);
}

// A claim that nobody is working on any more (the process died mid-synthesis) is
// released so the next run can take the job instead of waiting forever.
function releaseStaleReportClaims({ scanId, olderThanMs }) {
  const cutoff = new Date(Date.now() - Number(olderThanMs || 0)).toISOString();
  const res = db.prepare(`UPDATE ai_reports SET status='failed', finished_at=?, error=?
    WHERE scan_id=? AND status='running' AND created_at < ?`)
    .run(utcNow(), 'interrupted: synthesis did not finish inside the stale window', scanId, cutoff);
  return Number((res && res.changes) || 0);
}

function isRunningClash(e) {
  const m = String((e && e.message) || '');
  if (/idx_ai_reports_running/.test(m)) return true;
  // SQLite reports the violated unique index as a column list: the running claim
  // lists one column, the version index lists two.
  return /UNIQUE constraint failed: ai_reports\.scan_id\s*$/.test(m.trim());
}

// Reserve the right to synthesise this scan. The row is inserted as 'running'
// before any model call, so a concurrent worker loses the unique index and is
// told the job is in progress rather than duplicating it.
function claimReport({ workspaceId, scanId, inputHash, provider: providerName, model, analysisVersion, competitors }) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const last = db.prepare('SELECT MAX(version) v FROM ai_reports WHERE scan_id=?').get(scanId);
    const version = Number((last && last.v) || 0) + 1;
    const rid = id('air');
    try {
      db.prepare(`INSERT INTO ai_reports
        (id, workspace_id, scan_id, version, status, provider, model, analysis_version,
         competitors, evidence_snapshot, body, input_hash, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(rid, workspaceId, scanId, version, 'running', providerName || null, model || null,
          analysisVersion, JSON.stringify(competitors || []), '{}', '{}', inputHash || null, utcNow());
      return { claimed: true, id: rid, version };
    } catch (e) {
      if (isRunningClash(e)) {
        const running = db.prepare("SELECT * FROM ai_reports WHERE scan_id=? AND status='running'").get(scanId);
        return { claimed: false, reason: 'in_progress', running };
      }
      const clash = /UNIQUE constraint failed|duplicate key value/i.test(String(e && e.message));
      // A version clash means another writer allocated this version; recompute.
      if (!clash || attempt === 3) throw e;
    }
  }
  throw new Error('could not allocate a report version');
}

function completeReport({ id: reportId, body, evidenceSnapshot, provider: providerName, model }) {
  db.prepare(`UPDATE ai_reports
    SET status='completed', body=?, evidence_snapshot=?, provider=COALESCE(?, provider),
        model=COALESCE(?, model), error=NULL, finished_at=?
    WHERE id=?`)
    .run(JSON.stringify(body), JSON.stringify(evidenceSnapshot || {}), providerName || null,
      model || null, utcNow(), reportId);
  return reportId;
}

function failReport({ id: reportId, error }) {
  db.prepare("UPDATE ai_reports SET status='failed', error=?, finished_at=? WHERE id=?")
    .run(String(error || 'synthesis failed').slice(0, 500), utcNow(), reportId);
}

module.exports = {
  findAnalysis, createAnalysis, claimAnalysis, markAnalysis, addFinding, findingsFor, trackUsage,
  requestsForScan, requestsToday, analysesFor, saveReport, latestReport, reportByVersion, reportHistory,
  snapshotAnalysisEvidence, analysisEvidence, analysisHistory, findingsForAnalysis,
  synthesisInputHash, reportForHash, releaseStaleReportClaims, claimReport, completeReport, failReport
};
