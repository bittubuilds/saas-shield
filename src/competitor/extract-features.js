'use strict';
// Phase 4B: structured feature extraction.
//
// Deterministic on purpose: the same page text always yields the same features,
// so a feature list can be diffed between two collections. No model is called.
//
// What counts as a feature here: a short self-contained line on a page where a
// competitor describes its own product, optionally followed by a sentence that
// explains it. Navigation, cookie banners and calls to action are not features,
// and a line with no readable meaning is dropped rather than stored.
//
// Claim levels, which the report and UI must keep distinct:
//   documented - stated on a documentation page (spec-like)
//   marketing  - stated on a marketing page (homepage, features, product, pricing)
//   inferred   - mentioned on a page that is not about the product (about, blog)
//   unverified - a heading with no supporting sentence; recorded, not trusted
const { createHash } = require('crypto');

const FEATURE_PAGE_TYPES = ['features', 'product', 'docs', 'homepage', 'pricing'];
const MENTION_ONLY_TYPES = ['about', 'blog'];

const BASE_CONFIDENCE = {
  docs: 0.85, features: 0.8, product: 0.72, pricing: 0.7, homepage: 0.62, about: 0.5, blog: 0.45
};

const CLAIM_RANK = { documented: 4, marketing: 3, inferred: 2, unverified: 1 };

// Lines that are page furniture, not product capabilities.
// A line made only of site navigation words is a nav row that lost its markup.
const NAV_ONLY = /^(?:(?:home|product|products|pricing|plans|features|solutions|docs|documentation|api|blog|about|company|careers|customers|contact|login|sign in|sign up|get started|free trial|menu)\s*)+$/i;

const NOISE = new RegExp([
  'cookie', 'privacy policy', 'terms of service', 'terms and conditions', 'all rights reserved',
  'sign in', 'sign up', 'log in', 'login', 'start free trial', 'book a demo', 'request a demo',
  'contact sales', 'talk to sales', 'read more', 'learn more', 'see more', 'get started',
  'skip to content', 'follow us', 'subscribe', 'newsletter', 'accept all', 'manage preferences',
  '^\\u00a9', 'copyright', '^share this$', '^menu$', '^home$', '^blog$', '^pricing$', '^features$'
].join('|'), 'i');

// Phrases that promise rather than describe. Kept as a signal only: the claim is
// still recorded with its own level and wording, never rewritten.
const MARKETING_PUFF = /\b(best|fastest|leading|world[-\s]?class|revolutionary|cutting[-\s]?edge|game[-\s]?chang|seamless|powerful|effortless|supercharge|unlock|10x)\b/i;

const CATEGORY_HINTS = [
  ['analytics', /\banalytics|insights|reporting|dashboard|metrics|attribution\b/i],
  ['automation', /\bautomat|workflow|trigger|orchestrat\b/i],
  ['integration', /\bintegrat|connect|api|sdk|webhook|zapier|import|export\b/i],
  ['collaboration', /\bcollaborat|team|share|comment|permission|role\b/i],
  ['security', /\bsecurity|sso|saml|encrypt|compliance|soc ?2|gdpr|audit log\b/i],
  ['billing', /\bbilling|invoice|subscription|payment|usage[-\s]?based|seat\b/i],
  ['content', /\bcontent|document|template|editor|page builder|asset\b/i],
  ['ai', /\bai\b|machine learning|llm|generative|assistant|copilot\b/i],
  ['support', /\bsupport|help ?desk|chat|ticket|knowledge base|onboarding\b/i],
  ['mobile', /\bmobile|ios|android|app store\b/i],
  ['email', /\bemail|campaign|inbox|sequence|deliverab\b/i],
  ['search', /\bsearch|index|query|filter|vector\b/i]
];

function normaliseName(raw) {
  return String(raw || '')
    .replace(/^[\s\-*•·‣–—>|]+/, '')
    .replace(/[\s:•·|]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Stable identity for dedupe: lowercase, punctuation removed, trivial plurals
// folded. Deliberately conservative - "forms" and "form" are the same feature,
// "report" and "reporting" are not forced together.
function identityKey(name) {
  return normaliseName(name)
    .toLowerCase()
    .replace(/[^a-z0-9\s+#/-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
    .join(' ');
}

function looksLikeHeading(line, nextLine) {
  const clean = normaliseName(line);
  if (!clean) return false;
  if (clean.length < 3 || clean.length > 60) return false;
  const words = clean.split(' ').length;
  if (words > 8) return false;
  if (/[.!?]$/.test(clean)) return false;               // a sentence, not a title
  if (NOISE.test(clean)) return false;
  // A heading-ish line is followed by an explanatory sentence.
  return Boolean(nextLine && normaliseName(nextLine).length >= 25 && !NOISE.test(nextLine));
}

function looksLikeBullet(line) {
  const clean = normaliseName(line);
  if (!clean) return false;
  if (clean.length < 6 || clean.length > 90) return false;
  const words = clean.split(' ').length;
  if (words < 2 || words > 12) return false;
  if (NOISE.test(clean)) return false;
  if (NAV_ONLY.test(clean)) return false;
  if (/^(https?:|\/|www\.)/i.test(clean)) return false;
  if (clean.split(' ').filter((w) => /^[A-Z0-9]{2,}$/.test(w)).length > 3) return false; // nav row
  return true;
}

function describeWith(nextLine) {
  const clean = normaliseName(nextLine);
  if (!clean) return null;
  if (clean.length < 25 || clean.length > 400) return null;
  return clean;
}

function categoryOf(name, description) {
  const hay = `${name} ${description || ''}`;
  for (const [label, re] of CATEGORY_HINTS) if (re.test(hay)) return label;
  return null;
}

function claimLevelFor(pageType, { hasDescription, hasPuff }) {
  if (pageType === 'docs') return 'documented';
  if (FEATURE_PAGE_TYPES.includes(pageType)) return hasDescription || hasPuff ? 'marketing' : 'unverified';
  if (MENTION_ONLY_TYPES.includes(pageType)) return 'inferred';
  return 'unverified';
}

function confidenceFor(pageType, { hasDescription, claimLevel, name }) {
  const base = BASE_CONFIDENCE[pageType] ?? 0.4;
  let c = base;
  if (!hasDescription) c *= 0.75;                       // a bare heading is weaker
  const words = normaliseName(name).split(' ').length;
  if (words > 6) c *= 0.9;                              // long "names" are usually sentences
  if (claimLevel === 'inferred') c *= 0.8;
  if (claimLevel === 'unverified') c *= 0.6;
  return Math.round(Math.min(c, 0.95) * 100) / 100;
}

function verificationFor(claimLevel) {
  if (claimLevel === 'documented' || claimLevel === 'marketing') return 'observed';
  if (claimLevel === 'inferred') return 'inferred';
  return 'unverified';
}

function contentHashOf(page, name) {
  return createHash('sha256')
    .update(`${page.content_hash || ''}|${identityKey(name)}`)
    .digest('hex')
    .slice(0, 32);
}

// Extract feature candidates from one page. Returns raw candidates; dedupe across
// pages happens in extractAll.
function extractFromPage(page) {
  const pageType = String(page.page_type || 'other');
  const text = String(page.text_content || '');
  if (!text) return [];
  if (!FEATURE_PAGE_TYPES.includes(pageType) && !MENTION_ONLY_TYPES.includes(pageType)) return [];

  const lines = text.split('\n').map((l) => normaliseName(l)).filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const next = lines[i + 1];
    const isHeading = looksLikeHeading(line, next);
    const isBullet = !isHeading && looksLikeBullet(line);
    if (!isHeading && !isBullet) continue;

    const description = isHeading ? describeWith(next) : null;
    if (isHeading && !description) continue;
    // A bullet that is a full sentence with a trailing period is prose, not a
    // capability label; allow it only when it is short and verb-led.
    if (isBullet && /[.]$/.test(line) && line.split(' ').length > 8) continue;

    const name = line;
    const claimLevel = claimLevelFor(pageType, {
      hasDescription: Boolean(description),
      hasPuff: MARKETING_PUFF.test(`${name} ${description || ''}`)
    });
    out.push({
      name,
      description,
      category: categoryOf(name, description),
      page_type: pageType,
      source_url: page.url,
      page_id: page.page_id || null,
      claim_level: claimLevel,
      confidence: confidenceFor(pageType, { hasDescription: Boolean(description), claimLevel, name }),
      verification_status: verificationFor(claimLevel),
      evidence_excerpt: description ? `${name} - ${description}` : name,
      content_hash: contentHashOf(page, name),
      identity_key: identityKey(name),
      observed_at: page.fetched_at || new Date().toISOString()
    });
  }
  return out;
}

// Dedupe across pages: one feature per identity, chosen by claim strength, then
// confidence, then description length. Every other page that mentioned it is
// returned as additional support so the caller can record the extra evidence.
function extractAll(pages) {
  const byIdentity = new Map();
  for (const page of pages) {
    for (const candidate of extractFromPage(page)) {
      const key = candidate.identity_key;
      if (!key) continue;
      const prev = byIdentity.get(key);
      if (!prev) {
        byIdentity.set(key, { primary: candidate, support: [] });
        continue;
      }
      const better = CLAIM_RANK[candidate.claim_level] > CLAIM_RANK[prev.primary.claim_level]
        || (CLAIM_RANK[candidate.claim_level] === CLAIM_RANK[prev.primary.claim_level]
          && candidate.confidence > prev.primary.confidence);
      if (better) {
        byIdentity.set(key, { primary: candidate, support: [...prev.support, prev.primary] });
      } else {
        prev.support.push(candidate);
      }
    }
  }
  const features = [];
  for (const { primary, support } of byIdentity.values()) {
    // Same-page repeats are noise; only distinct pages are extra support.
    const extra = support.filter((s) => s.source_url !== primary.source_url);
    features.push({ ...primary, support: extra });
  }
  return features.sort((a, b) => a.identity_key.localeCompare(b.identity_key));
}

module.exports = {
  extractFromPage, extractAll, identityKey, categoryOf, normaliseName,
  claimLevelFor, confidenceFor, CLAIM_RANK, FEATURE_PAGE_TYPES
};
