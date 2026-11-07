'use strict';
// Strict validation of model output.
//
// The model is a free-tier LLM reading scraped web pages. Its output is data we
// cannot trust, so every field is validated here before anything is written to
// the database. Unknown or unsupported values are dropped rather than repaired:
// a missing finding is honest, an invented one is not.

const CLAIM_LEVELS = ['explicit', 'inferred', 'unverified'];

function isStr(v, { min = 1, max = 2000 } = {}) {
  return typeof v === 'string' && v.trim().length >= min && v.length <= max;
}
function arr(v, max = 40) {
  return Array.isArray(v) ? v.slice(0, max) : [];
}
function clean(s, max = 2000) {
  return String(s).replace(/\s+/g, ' ').trim().slice(0, max);
}
function confidence(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}
function level(v) {
  return CLAIM_LEVELS.includes(v) ? v : 'unverified';
}

// Every finding must cite at least one evidence id that the caller supplied.
function makeFinding(raw, allowedEvidence) {
  if (!raw || typeof raw !== 'object') return null;
  const statement = isStr(raw.statement) ? clean(raw.statement, 400) : null;
  if (!statement) return null;
  const ids = arr(raw.evidence_ids, 8)
    .map((x) => String(x))
    .filter((x) => allowedEvidence.has(x));
  if (!ids.length) return null; // uncited claim -> discarded
  return {
    statement,
    detail: isStr(raw.detail, { max: 1200 }) ? clean(raw.detail, 1200) : null,
    claim: level(raw.claim),
    confidence: confidence(raw.confidence),
    evidence_ids: ids
  };
}

const STAGE_SHAPES = {
  overview: (o) => ({
    summary: isStr(o.summary, { max: 900 }) ? clean(o.summary, 900) : null,
    category: isStr(o.category, { max: 120 }) ? clean(o.category, 120) : 'unknown',
    use_case: isStr(o.use_case, { max: 300 }) ? clean(o.use_case, 300) : 'unknown',
    audience: isStr(o.audience, { max: 300 }) ? clean(o.audience, 300) : 'unknown',
    positioning: isStr(o.positioning, { max: 500 }) ? clean(o.positioning, 500) : 'unknown',
    differentiators: arr(o.differentiators, 8).filter((x) => isStr(x, { max: 240 })).map((x) => clean(x, 240)),
    unknowns: arr(o.unknowns, 8).filter((x) => isStr(x, { max: 240 })).map((x) => clean(x, 240))
  }),
  features: (o) => ({
    features: arr(o.features, 30).filter((f) => f && isStr(f.name, { max: 120 })).map((f) => ({
      name: clean(f.name, 120),
      category: isStr(f.category, { max: 80 }) ? clean(f.category, 80) : 'uncategorised',
      statement: isStr(f.statement, { max: 300 }) ? clean(f.statement, 300) : null,
      claim: level(f.claim),
      confidence: confidence(f.confidence)
    }))
  }),
  pricing: (o) => ({
    plans: arr(o.plans, 12).filter((p) => p && isStr(p.name, { max: 80 })).map((p) => ({
      name: clean(p.name, 80),
      price: isStr(p.price, { max: 60 }) ? clean(p.price, 60) : 'unknown',
      interval: isStr(p.interval, { max: 40 }) ? clean(p.interval, 40) : 'unknown',
      notes: isStr(p.notes, { max: 300 }) ? clean(p.notes, 300) : null,
      claim: level(p.claim),
      confidence: confidence(p.confidence)
    })),
    has_free_tier: typeof o.has_free_tier === 'boolean' ? o.has_free_tier : null,
    enterprise: typeof o.enterprise === 'boolean' ? o.enterprise : null,
    model: isStr(o.model, { max: 120 }) ? clean(o.model, 120) : 'unknown',
    unstated: arr(o.unstated, 8).filter((x) => isStr(x, { max: 240 })).map((x) => clean(x, 240))
  }),
  positioning: (o) => ({
    value_proposition: isStr(o.value_proposition, { max: 400 }) ? clean(o.value_proposition, 400) : 'unknown',
    audience: isStr(o.audience, { max: 300 }) ? clean(o.audience, 300) : 'unknown',
    differentiators: arr(o.differentiators, 8).filter((x) => isStr(x, { max: 240 })).map((x) => clean(x, 240)),
    messaging_patterns: arr(o.messaging_patterns, 8).filter((x) => isStr(x, { max: 240 })).map((x) => clean(x, 240)),
    claims_to_verify: arr(o.claims_to_verify, 8).filter((x) => isStr(x, { max: 240 })).map((x) => clean(x, 240))
  })
};

// Cross-competitor synthesis: every item must name a competitor we analysed.
function makeSynthesis(raw, knownCompetitors) {
  if (!raw || typeof raw !== 'object') return null;
  const known = (name) => knownCompetitors.has(String(name).toLowerCase());
  const item = (x, fields) => {
    if (!x || typeof x !== 'object') return null;
    const who = String(x.competitor || '').toLowerCase();
    if (x.competitor && !known(who)) return null; // invented competitor
    return fields(x);
  };

  return {
    executive_summary: isStr(raw.executive_summary, { max: 1200 }) ? clean(raw.executive_summary, 1200) : null,
    common_features: arr(raw.common_features, 20).map((f) => item(f, (x) => ({
      feature: clean(x.feature, 120),
      competitors: arr(x.competitors, 10).map((c) => String(c)).filter((c) => known(c.toLowerCase()))
    }))).filter((f) => f && f.feature),
    unique_features: arr(raw.unique_features, 20).map((f) => item(f, (x) => ({
      feature: clean(x.feature, 120),
      competitor: String(x.competitor || '').toLowerCase()
    }))).filter((f) => f && f.feature),
    gaps: arr(raw.gaps, 12).map((g) => item(g, (x) => ({
      gap: clean(x.gap, 240),
      evidence: arr(x.evidence, 6).map((e) => clean(e, 240)),
      confidence: confidence(x.confidence)
    }))).filter((g) => g && g.gap),
    swot: arr(raw.swot, 16).map((s) => item(s, (x) => ({
      bucket: ['strength', 'weakness', 'opportunity', 'threat'].includes(String(x.bucket)) ? x.bucket : 'unknown',
      point: clean(x.point, 300),
      competitor: x.competitor ? String(x.competitor).toLowerCase() : null,
      confidence: confidence(x.confidence)
    }))).filter((s) => s && s.point && s.bucket !== 'unknown'),
    recommendations: arr(raw.recommendations, 10).map((r) => (r && typeof r === 'object' ? {
      recommendation: isStr(r.recommendation, { max: 300 }) ? clean(r.recommendation, 300) : null,
      reason: isStr(r.reason, { max: 500 }) ? clean(r.reason, 500) : null,
      supporting_competitors: arr(r.supporting_competitors, 8).map(String).filter((c) => known(c.toLowerCase())),
      confidence: confidence(r.confidence),
      limitations: isStr(r.limitations, { max: 300 }) ? clean(r.limitations, 300) : null
    } : null)).filter((r) => r && r.recommendation && r.reason)
  };
}

module.exports = { STAGE_SHAPES, makeSynthesis, makeFinding, CLAIM_LEVELS, clean };
