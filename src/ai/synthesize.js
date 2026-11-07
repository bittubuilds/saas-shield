'use strict';
// Cross-competitor synthesis.
//
// Runs only over findings that already exist in the database, which means the
// comparison can never know more than the evidence did. Coverage is explicit:
// stages that produced nothing are passed to the model as gaps and reported to
// the caller, so a thin report says it is thin instead of sounding confident.

const provider = require('./provider');
const prompts = require('./prompts');
const schema = require('./schema');
const store = require('./store');
const engine = require('./engine');

// How long a claim may sit in 'running' before it is treated as abandoned. The
// same knob the analysis engine uses, so one env var controls both.
function staleClaimMs() {
  return Number(process.env.AI_STALE_RUNNING_MINUTES || 10) * 60 * 1000;
}

// The same claim re-derived by a later analysis is not new information. Without
// this, every re-analysis would repeat statements inside the next report and make
// the findings hash look changed when nothing the reader sees has changed. The
// newest record wins; the older one stays in ai_findings for audit.
function latestPerClaim(findings) {
  const newest = new Map();
  for (const f of findings) {
    const key = `${f.competitor_id}|${f.kind}|${f.statement}`;
    const held = newest.get(key);
    if (!held || String(f.created_at || '') >= String(held.created_at || '')) newest.set(key, f);
  }
  return [...newest.values()].sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
}

function groupFindings(findings) {
  const byCompetitor = new Map();
  for (const f of findings) {
    if (!byCompetitor.has(f.competitor_id)) byCompetitor.set(f.competitor_id, []);
    const list = byCompetitor.get(f.competitor_id);
    if (list.length < 12) list.push({ kind: f.kind, statement: f.statement, claim: f.claim, confidence: f.confidence });
  }
  return byCompetitor;
}

// Synthesis is incremental in the same sense as per-stage analysis: the report is
// a pure function of the findings it was built from, so the findings hash is the
// job's identity. Unchanged findings resolve to the stored report and cost nothing;
// changed findings produce a new version and leave the old one readable.
async function synthesize({ workspaceId, scanId }) {
  const { competitors } = engine.competitorRows({ workspaceId, scanId });
  const findings = latestPerClaim(store.findingsFor({ workspaceId, scanId }));
  if (!findings.length) {
    return { ok: false, code: 'no_findings', error: 'no AI findings to synthesise' };
  }

  const inputHash = store.synthesisInputHash({
    findings,
    analysisVersion: prompts.ANALYSIS_VERSION,
    promptVersion: prompts.PROMPT_VERSION
  });

  // Reuse a report built from exactly this evidence.
  const reusable = store.reportForHash({ workspaceId, scanId, inputHash });
  if (reusable) {
    return { ok: true, unchanged: true, report_id: reusable.id, version: reusable.version };
  }

  // A crashed run leaves a 'running' row behind; reclaim it once it is stale.
  store.releaseStaleReportClaims({ scanId, olderThanMs: staleClaimMs() });

  const cfg = provider.config();
  const claim = store.claimReport({
    workspaceId, scanId, inputHash, provider: cfg.provider, model: cfg.model,
    analysisVersion: prompts.ANALYSIS_VERSION,
    competitors: competitors.map((c) => ({ id: c.id, name: (c.name || c.domain || ''), domain: c.domain }))
  });
  if (!claim.claimed) {
    // Someone else is already synthesising this scan. Report it, do not duplicate.
    return { ok: false, code: 'synthesis_in_progress', error: 'a report is already being generated for this scan' };
  }

  const byCompetitor = groupFindings(findings);
  const names = competitors.map((c) => (c.name || c.domain || '').toLowerCase()).filter(Boolean);
  const knownFor = (competitor) => String(competitor.name || competitor.domain || '').toLowerCase();
  const labels = {};
  for (const c of competitors) labels[knownFor(c)] = c;

  const findingsByCompetitor = {};
  const unparsed = [];
  for (const c of competitors) {
    const rows = byCompetitor.get(c.id) || [];
    if (!rows.length) unparsed.push(knownFor(c));
    findingsByCompetitor[knownFor(c)] = rows;
  }

  const prompt = prompts.buildSynthesisPrompt({ competitors, findingsByCompetitor, unparsed });
  let result;
  try {
    result = await provider.complete({ system: prompt.system, user: prompt.user, stage: 'synthesis' });
  } catch (e) {
    // Release the claim: a failed or quota-paused synthesis must not block the
    // next attempt, and it must not look like a report that exists.
    store.failReport({ id: claim.id, error: provider.sanitize(e && e.message) });
    throw e;
  }
  store.trackUsage({ workspaceId, scanId, provider: result.provider, model: result.model,
    requests: result.usage.requests, tokensIn: result.usage.tokens_in, tokensOut: result.usage.tokens_out });

  const parsed = schema.makeSynthesis(result.json || {}, new Set(names));
  const evidenceByCompetitor = {};
  for (const f of findings) {
    if (!evidenceByCompetitor[f.competitor_id]) evidenceByCompetitor[f.competitor_id] = [];
    for (const url of f.source_urls) if (!evidenceByCompetitor[f.competitor_id].includes(url)) evidenceByCompetitor[f.competitor_id].push(url);
  }

  const body = {
    executive_summary: parsed.executive_summary,
    competitors: competitors.map((c) => ({
      competitor_id: c.id,
      name: knownFor(c),
      domain: c.domain,
      findings: (byCompetitor.get(c.id) || []),
      sources: evidenceByCompetitor[c.id] || []
    })),
    comparison: {
      common_features: parsed.common_features,
      unique_features: parsed.unique_features
    },
    gaps: parsed.gaps,
    swot: parsed.swot,
    recommendations: parsed.recommendations,
    coverage: {
      competitors_analysed: competitors.length - unparsed.length,
      competitors_without_findings: unparsed,
      stages_expected: engine.STAGES,
      limitation: unparsed.length
        ? 'Some competitors produced no findings. Their absence is not evidence of missing capability.'
        : null
    },
    provider: result.provider,
    model: result.model,
    analysis_version: prompts.ANALYSIS_VERSION,
    prompt_version: prompts.PROMPT_VERSION,
    generated_at: new Date().toISOString()
  };

  store.completeReport({
    id: claim.id,
    body,
    evidenceSnapshot: { findings: findings.map((f) => f.id), pages: [...new Set(findings.flatMap((f) => f.evidence_ids))] },
    provider: result.provider, model: result.model
  });

  return { ok: true, unchanged: false, report_id: claim.id, version: claim.version, body };
}

module.exports = { synthesize, groupFindings, latestPerClaim };
