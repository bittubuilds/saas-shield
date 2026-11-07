'use strict';
// Incremental analysis engine.
//
// One competitor, one stage at a time, always over evidence that exists in the
// database. Three properties matter here:
//   * idempotent: the input hash covers the evidence ids, their content hashes,
//     the analysis version and the prompt version, so unchanged evidence is never
//     re-analysed and a retried batch cannot duplicate findings.
//   * resumable: state lives in ai_analyses, so a crash or a quota wall leaves
//     completed work intact and runScanAI() simply continues.
//   * honest: a stage that fails or is skipped records why. The scan is never
//     reported as fully analysed when it is not.

const crypto = require('node:crypto');
const db = require('../db/index');
const provider = require('./provider');
const prompts = require('./prompts');
const schema = require('./schema');
const store = require('./store');

const STAGES = ['overview', 'features', 'pricing', 'positioning'];

function limits() {
  return {
    maxCompetitors: Number(process.env.AI_MAX_COMPETITORS || 6),
    maxPagesPerCompetitor: Number(process.env.AI_MAX_PAGES || 3),
    maxPageChars: Number(process.env.AI_MAX_PAGE_CHARS || 4000),
    maxRequestsPerScan: Number(process.env.AI_MAX_REQUESTS_PER_SCAN || 40),
    maxRequestsPerDay: Number(process.env.AI_MAX_REQUESTS_PER_DAY || 200),
    maxAttempts: Number(process.env.AI_MAX_ATTEMPTS || 3),
    minPageChars: Number(process.env.AI_MIN_PAGE_CHARS || 80)
  };
}

// Evidence for one competitor, chosen deterministically: classified product
// pages first, then anything else that actually has text.
function evidenceFor({ workspaceId, websiteId }) {
  const rows = db.prepare(`SELECT id, url, title, meta_description, text_content, content_hash
    FROM pages WHERE workspace_id=? AND website_id=? AND text_content IS NOT NULL AND LENGTH(text_content) >= ?
    ORDER BY fetched_at DESC`).all(workspaceId, websiteId, limits().minPageChars);
  const scored = rows.map((p) => {
    const u = String(p.url || '').toLowerCase();
    let rank = 3;
    if (/pricing|plans/.test(u)) rank = 0;
    else if (/features|product/.test(u)) rank = 1;
    else if (u.endsWith('/') || /\/$/.test(u)) rank = 2;
    return { p, rank };
  }).sort((a, b) => a.rank - b.rank || String(a.p.url).localeCompare(String(b.p.url)));
  return scored.slice(0, limits().maxPagesPerCompetitor).map((s) => s.p);
}

function inputHash({ stage, pages, analysisVersion, promptVersion }) {
  const parts = [stage, `v${analysisVersion}`, `p${promptVersion}`,
    ...pages.map((p) => `${p.id}:${p.content_hash || ''}`).sort()];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 40);
}

function competitorRows({ workspaceId, scanId }) {
  const scan = db.prepare('SELECT * FROM scans WHERE id=? AND workspace_id=?').get(scanId, workspaceId);
  if (!scan) return { scan: null, competitors: [] };
  const rows = db.prepare(`SELECT c.* FROM competitors c
    WHERE c.workspace_id=? AND c.website_id=?`).all(workspaceId, scan.comparison_website_id || '');
  if (rows.length) return { scan, competitors: rows.slice(0, limits().maxCompetitors) };

  // Fall back to the scan's comparison website when discovery never registered a
  // competitor row: the evidence is real even if the identification is not.
  const site = db.prepare('SELECT * FROM websites WHERE id=? AND workspace_id=?')
    .get(scan.comparison_website_id, workspaceId);
  if (!site) return { scan, competitors: [] };
  return {
    scan,
    competitors: [{
      id: `adhoc_${site.id}`, workspace_id: workspaceId, website_id: site.id,
      domain: site.normalized_domain || site.domain || site.url,
      name: site.normalized_domain || site.domain || site.url,
      workspace_scoped: true
    }]
  };
}

function validateFindings({ stage, parsed, pages }) {
  const allowed = new Set(pages.map((p) => p.id));
  const urls = new Map(pages.map((p) => [p.id, p.url]));
  const out = [];

  if (stage === 'features') {
    for (const f of parsed.features) {
      const found = schema.makeFinding({ statement: f.statement || f.name, detail: f.name, claim: f.claim, confidence: f.confidence, evidence_ids: [...allowed] }, allowed);
      if (found) out.push({ ...found, kind: 'feature' });
    }
  } else if (stage === 'pricing') {
    for (const p of parsed.plans) {
      const found = schema.makeFinding({
        statement: `${p.name}: ${p.price}${p.interval && p.interval !== 'unknown' ? ` / ${p.interval}` : ''}`,
        detail: p.notes, claim: p.claim, confidence: p.confidence, evidence_ids: [...allowed]
      }, allowed);
      if (found) out.push({ ...found, kind: 'pricing' });
    }
  } else if (stage === 'overview') {
    const one = (text, kind) => {
      if (!text || text === 'unknown') return null;
      const found = schema.makeFinding({ statement: text, claim: 'explicit', confidence: 0.6, evidence_ids: [...allowed] }, allowed);
      return found ? { ...found, kind } : null;
    };
    out.push(one(parsed.summary, 'overview'));
    out.push(one(parsed.category !== 'unknown' ? `Category: ${parsed.category}` : null, 'category'));
    out.push(one(parsed.audience !== 'unknown' ? `Audience: ${parsed.audience}` : null, 'audience'));
    out.push(one(parsed.positioning !== 'unknown' ? `Positioning: ${parsed.positioning}` : null, 'positioning'));
  } else if (stage === 'positioning') {
    const found = schema.makeFinding({
      statement: parsed.value_proposition !== 'unknown' ? parsed.value_proposition : null,
      claim: 'explicit', confidence: 0.6, evidence_ids: [...allowed]
    }, allowed);
    if (found) out.push({ ...found, kind: 'positioning' });
    for (const d of parsed.differentiators) {
      const f = schema.makeFinding({ statement: d, claim: 'inferred', confidence: 0.4, evidence_ids: [...allowed] }, allowed);
      if (f) out.push({ ...f, kind: 'differentiator' });
    }
  }

  return out.filter(Boolean).map((f) => ({ ...f, sources: f.evidence_ids.map((id) => urls.get(id)).filter(Boolean) }));
}

async function runStage({ workspaceId, competitor, scanId, stage }) {
  const pages = evidenceFor({ workspaceId, websiteId: competitor.website_id });
  if (!pages.length) return { stage, status: 'skipped', reason: 'no_evidence' };

  const version = prompts.ANALYSIS_VERSION;
  const hash = inputHash({ stage, pages, analysisVersion: version, promptVersion: prompts.PROMPT_VERSION });
  const existing = store.findAnalysis({ workspaceId, competitorId: competitor.id, stage, inputHash: hash, analysisVersion: version });
  if (existing && existing.status === 'completed') return { stage, status: 'unchanged', analysisId: existing.id };
  if (existing && existing.status === 'failed' && Number(existing.attempts) >= limits().maxAttempts) {
    return { stage, status: 'failed', analysisId: existing.id, reason: 'max_attempts' };
  }

  const cfg = provider.config();
  const analysis = existing || store.createAnalysis({
    workspaceId, competitorId: competitor.id, scanId, stage, inputHash: hash,
    analysisVersion: version, promptVersion: prompts.PROMPT_VERSION,
    provider: cfg.provider, model: cfg.model
  });

  if (store.requestsForScan(scanId) >= limits().maxRequestsPerScan) {
    store.markAnalysis(analysis.id, { status: 'paused', error: 'scan_request_cap' });
    return { stage, status: 'paused', reason: 'scan_request_cap' };
  }
  if (store.requestsToday(workspaceId) >= limits().maxRequestsPerDay) {
    store.markAnalysis(analysis.id, { status: 'paused', error: 'daily_request_cap' });
    return { stage, status: 'paused', reason: 'daily_request_cap' };
  }

  store.markAnalysis(analysis.id, { status: 'running', started_at: new Date().toISOString(), attempts: Number(analysis.attempts || 0) + 1, error: null });
  try {
    const prompt = prompts.buildStagePrompt({ stage, competitor, pages });
    const result = await provider.complete({ system: prompt.system, user: prompt.user, stage });
    store.trackUsage({
      workspaceId, scanId, provider: result.provider, model: result.model,
      requests: result.usage.requests, tokensIn: result.usage.tokens_in, tokensOut: result.usage.tokens_out
    });

    const shape = schema.STAGE_SHAPES[stage];
    const parsed = shape(result.json || {});
    const findings = validateFindings({ stage, parsed, pages });
    for (const f of findings) {
      store.addFinding({
        workspaceId, competitorId: competitor.id, scanId, analysisId: analysis.id,
        kind: f.kind, statement: f.statement, detail: f.detail, claim: f.claim,
        confidence: f.confidence, evidenceIds: f.evidence_ids, sourceUrls: f.sources
      });
    }
    store.markAnalysis(analysis.id, {
      status: 'completed', finished_at: new Date().toISOString(),
      tokens_in: result.usage.tokens_in, tokens_out: result.usage.tokens_out
    });
    return { stage, status: 'completed', analysisId: analysis.id, findings: findings.length };
  } catch (e) {
    const paused = ['quota_exhausted', 'not_configured', 'auth_failed', 'timeout', 'provider_outage'].includes(e.code);
    store.markAnalysis(analysis.id, {
      status: paused ? 'paused' : 'failed',
      error: provider.sanitize(e.message),
      finished_at: new Date().toISOString()
    });
    return { stage, status: paused ? 'paused' : 'failed', analysisId: analysis.id, reason: e.code || 'error' };
  }
}

async function analyzeCompetitor({ workspaceId, competitor, scanId }) {
  const results = [];
  for (const stage of STAGES) {
    const r = await runStage({ workspaceId, competitor, scanId, stage });
    results.push(r);
    if (r.status === 'paused') break; // stop the competitor, keep completed stages
  }
  return results;
}

async function runScanAI({ workspaceId, scanId }) {
  const { scan, competitors } = competitorRows({ workspaceId, scanId });
  if (!scan) return { ok: false, error: 'scan not found', code: 'not_found' };
  if (!competitors.length) return { ok: false, error: 'no competitor evidence to analyse', code: 'no_competitors' };

  const perCompetitor = {};
  let paused = false;
  for (const competitor of competitors) {
    perCompetitor[competitor.id] = await analyzeCompetitor({ workspaceId, competitor, scanId });
    if (perCompetitor[competitor.id].some((r) => r.status === 'paused')) { paused = true; break; }
  }

  const analyses = store.analysesFor({ workspaceId, scanId });
  return {
    ok: true,
    paused,
    competitors: competitors.length,
    analyses: analyses.map((a) => ({ competitor_id: a.competitor_id, stage: a.stage, status: a.status })),
    perCompetitor,
    canSynthesize: !paused && analyses.some((a) => a.status === 'completed')
  };
}

module.exports = { runScanAI, analyzeCompetitor, evidenceFor, inputHash, STAGES, competitorRows, limits, validateFindings };
