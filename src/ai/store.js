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
  const row = db.prepare('SELECT * FROM ai_reports WHERE workspace_id=? AND scan_id=? ORDER BY version DESC LIMIT 1').get(workspaceId, scanId);
  if (!row) return null;
  return { ...row, competitors: JSON.parse(row.competitors), evidence_snapshot: JSON.parse(row.evidence_snapshot), body: JSON.parse(row.body) };
}

// One specific stored version, for reproducible exports. Historical reports are
// never rewritten, so a version resolved once keeps printing the same content.
function reportByVersion({ workspaceId, scanId, version }) {
  const row = db.prepare('SELECT * FROM ai_reports WHERE workspace_id=? AND scan_id=? AND version=?')
    .get(workspaceId, scanId, Number(version));
  if (!row) return null;
  return { ...row, competitors: JSON.parse(row.competitors), evidence_snapshot: JSON.parse(row.evidence_snapshot), body: JSON.parse(row.body) };
}

function reportHistory({ workspaceId, scanId }) {
  return db.prepare('SELECT id, version, status, provider, model, analysis_version, created_at FROM ai_reports WHERE workspace_id=? AND scan_id=? ORDER BY version DESC').all(workspaceId, scanId);
}

module.exports = {
  findAnalysis, createAnalysis, claimAnalysis, markAnalysis, addFinding, findingsFor, trackUsage,
  requestsForScan, requestsToday, analysesFor, saveReport, latestReport, reportByVersion, reportHistory
};
