'use strict';
// Deterministic page classification.
//
// Order matters: path rules beat title hints, because /pricing that says
// "plans and pricing" should not be re-classified by a keyword accident.
// Every result carries a confidence and the reason it was chosen, so a wrong
// classification is visible rather than silent.

const PATH_RULES = [
  { type: 'homepage', re: /^\/?$/, confidence: 0.99, reason: 'site root' },
  { type: 'pricing', re: /^\/(pricing|plans|pricing-plans)\/?$/i, confidence: 0.97, reason: 'pricing path' },
  { type: 'features', re: /^\/(features|product-features|capabilities)\/?$/i, confidence: 0.95, reason: 'features path' },
  { type: 'product', re: /^\/(product|platform|solutions|use-cases)\/?/i, confidence: 0.88, reason: 'product path' },
  { type: 'docs', re: /^\/(docs|documentation|developers|api|reference|guides)\/?/i, confidence: 0.93, reason: 'documentation path' },
  { type: 'blog', re: /^\/(blog|posts|news|changelog)\/?/i, confidence: 0.9, reason: 'blog or changelog path' },
  { type: 'about', re: /^\/(about|company|team|careers)\/?/i, confidence: 0.9, reason: 'company path' }
];

const TITLE_HINTS = [
  { type: 'pricing', words: ['pricing', 'plans'], confidence: 0.7 },
  { type: 'features', words: ['features', 'capabilities'], confidence: 0.68 },
  { type: 'docs', words: ['documentation', 'docs', 'api reference'], confidence: 0.7 },
  { type: 'about', words: ['about us', 'our story', 'company'], confidence: 0.66 }
];

function pathOf(url) {
  try {
    const u = new URL(url);
    return { path: u.pathname || '/', host: u.hostname };
  } catch {
    return { path: '/', host: null };
  }
}

function classifyPage(url, hints = {}) {
  const { path } = pathOf(url);
  for (const rule of PATH_RULES) {
    if (rule.re.test(path)) {
      return { page_type: rule.type, confidence: rule.confidence, reason: rule.reason };
    }
  }
  const title = String(hints.title || '').toLowerCase();
  const heading = String(hints.h1 || '').toLowerCase();
  const hay = `${title} ${heading}`;
  for (const hint of TITLE_HINTS) {
    const hit = hint.words.find((w) => hay.includes(w));
    if (hit) {
      return { page_type: hint.type, confidence: hint.confidence, reason: `title mentions "${hit}"` };
    }
  }
  return { page_type: 'other', confidence: 0.4, reason: 'no path or title signal' };
}

// Pages worth fetching first when a crawl budget is limited.
const PRIORITY = ['homepage', 'pricing', 'features', 'product', 'about', 'docs', 'blog', 'other'];
function priorityOf(pageType) {
  const i = PRIORITY.indexOf(pageType);
  return i === -1 ? PRIORITY.length : i;
}

module.exports = { classifyPage, priorityOf, PRIORITY };
