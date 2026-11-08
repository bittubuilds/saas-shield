'use strict';
// Transparent relevance scoring.
//
// The point is not a magic number: it is that every point can be explained.
// Each component returns the evidence it matched, so a "verified" verdict can
// be audited term by term, and a rejected candidate says why.

const { tokens } = require('./identify');

const WEIGHTS = {
  category: 30,      // same detected product category
  features: 30,      // overlap of product/feature vocabulary
  audience: 15,      // same stated audience
  positioning: 15,   // shared positioning words
  search: 10         // how high the search result ranked
};

const VERIFIED_AT = 60;
const POSSIBLE_AT = 35;

function jaccard(a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

function sharedTerms(a, b, limit = 8) {
  const out = [];
  if (!a || !b) return out;
  for (const t of a) if (b.has(t)) out.push(t);
  return out.sort().slice(0, limit);
}

// candidate and original are the objects returned by identifyProduct().
function scoreRelevance(candidate, original, { searchRank = null } = {}) {
  const components = {};

  const sameCategory = Boolean(candidate.category && original.category
    && candidate.category === original.category);
  components.category = {
    weight: WEIGHTS.category,
    points: sameCategory ? WEIGHTS.category : 0,
    evidence: sameCategory
      ? `both classified as "${candidate.category}"`
      : `candidate "${candidate.category || 'unknown'}" vs original "${original.category || 'unknown'}"`
  };

  const featureOverlap = jaccard(candidate.tokens, original.tokens);
  components.features = {
    weight: WEIGHTS.features,
    points: Math.round(featureOverlap * WEIGHTS.features),
    evidence: sharedTerms(candidate.tokens, original.tokens).join(', ') || 'no shared vocabulary'
  };

  const sameAudience = Boolean(candidate.targetAudience && original.targetAudience
    && candidate.targetAudience === original.targetAudience);
  components.audience = {
    weight: WEIGHTS.audience,
    points: sameAudience ? WEIGHTS.audience : 0,
    evidence: sameAudience
      ? `both target ${candidate.targetAudience}`
      : (candidate.targetAudience || original.targetAudience || 'audience not stated')
  };

  const positioningOverlap = jaccard(
    tokens(candidate.positioning || ''),
    tokens(original.positioning || '')
  );
  components.positioning = {
    weight: WEIGHTS.positioning,
    points: Math.round(positioningOverlap * WEIGHTS.positioning),
    evidence: positioningOverlap > 0
      ? 'headline wording overlaps'
      : 'headline wording does not overlap'
  };

  // Search callers pass a zero-based position from the provider's results.
  // Rank only amplifies a real content signal: a bakery that ranks first for a
  // SaaS query is still not a competitor, and must not look like one.
  const contentSignal = sameCategory || featureOverlap > 0 || sameAudience || positioningOverlap > 0;
  const rankPoints = (searchRank === null || !contentSignal) ? 0
    : searchRank <= 2 ? WEIGHTS.search
      : searchRank <= 5 ? Math.round(WEIGHTS.search * 0.6)
        : Math.round(WEIGHTS.search * 0.3);
  components.search = {
    weight: WEIGHTS.search,
    points: rankPoints,
    evidence: searchRank === null ? 'rank unknown'
      : (contentSignal ? `search position ${searchRank + 1}` : 'ignored: no content signal')
  };

  const total = Object.values(components).reduce((n, c) => n + c.points, 0);
  const verdict = total >= VERIFIED_AT ? 'verified'
    : total >= POSSIBLE_AT ? 'possible'
      : 'rejected';

  return {
    score: Math.max(0, Math.min(100, total)),
    verdict,
    components,
    thresholds: { verified: VERIFIED_AT, possible: POSSIBLE_AT }
  };
}

// Human-readable reason for the stored decision, built from the components that
// carried the score rather than a generic label.
function verdictReason(result) {
  const parts = Object.entries(result.components)
    .filter(([, c]) => c.points > 0)
    .sort((a, b) => b[1].points - a[1].points)
    .map(([name, c]) => `${name} +${c.points}`);
  if (parts.length === 0) return 'no matching signal (different category, vocabulary and audience)';
  return parts.join(', ');
}

module.exports = { scoreRelevance, verdictReason, WEIGHTS, VERIFIED_AT, POSSIBLE_AT, jaccard };
