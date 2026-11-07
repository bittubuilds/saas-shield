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

function groupFindings(findings) {
  const byCompetitor = new Map();
  for (const f of findings) {
    if (!byCompetitor.has(f.competitor_id)) byCompetitor.set(f.competitor_id, []);
    const list = byCompetitor.get(f.competitor_id);
    if (list.length < 12) list.push({ kind: f.kind, statement: f.statement, claim: f.claim, confidence: f.confidence });
  }
  return byCompetitor;
}

async function synthesize({ workspaceId, scanId }) {
  const { competitors } = engine.competitorRows({ workspaceId, scanId });
  const findings = store.findingsFor({ workspaceId, scanId });
  if (!findings.length) {
    return { ok: false, code: 'no_findings', error: 'no AI findings to synthesise' };
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
  const result = await provider.complete({ system: prompt.system, user: prompt.user, stage: 'synthesis' });
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

  const saved = store.saveReport({
    workspaceId, scanId, provider: result.provider, model: result.model,
    analysisVersion: prompts.ANALYSIS_VERSION, competitors: competitors.map((c) => ({ id: c.id, name: knownFor(c), domain: c.domain })),
    evidenceSnapshot: { findings: findings.map((f) => f.id), pages: [...new Set(findings.flatMap((f) => f.evidence_ids))] },
    body
  });

  return { ok: true, report_id: saved.id, version: saved.version, body };
}

module.exports = { synthesize, groupFindings };
