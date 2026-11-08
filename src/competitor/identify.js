'use strict';
// Deterministic product identification from a page we actually fetched.
//
// Nothing is invented: every field is either copied from the page (name,
// description, positioning) or matched against a fixed taxonomy (category,
// audience). When a signal is absent the field stays null and the caller can
// record that as missing information instead of guessing.

const CATEGORY_TAXONOMY = {
  'seo tools': ['seo', 'keyword research', 'backlinks', 'serp'],
  'content marketing': ['content marketing', 'blogging', 'editorial calendar'],
  'email marketing': ['email marketing', 'newsletter', 'email automation', 'drip campaign'],
  crm: ['crm', 'sales pipeline', 'contact management', 'deal stages'],
  analytics: ['analytics', 'product analytics', 'funnel analysis', 'tracking'],
  'project management': ['project management', 'task management', 'kanban', 'sprint planning'],
  'customer support': ['help desk', 'customer support', 'ticketing', 'live chat'],
  'website monitoring': ['website monitoring', 'uptime', 'content change', 'competitor monitoring'],
  'design tools': ['design tool', 'ui design', 'prototyping', 'wireframe'],
  'social media': ['social media', 'post scheduling', 'social analytics'],
  'ai writing': ['ai writer', 'ai writing', 'content generation', 'copywriting ai'],
  'developer tools': ['api', 'sdk', 'developer platform', 'devops'],
  'ecommerce': ['ecommerce', 'online store', 'shopify', 'checkout'],
  'hr and recruiting': ['applicant tracking', 'recruiting', 'hr software', 'hiring'],
  finance: ['invoicing', 'accounting', 'expense management', 'bookkeeping']
};

const AUDIENCE_PATTERNS = [
  { label: 'founders and startups', re: /\b(for|built for|helps)\s+(founders|startups|indie hackers|solopreneurs)\b/i },
  { label: 'agencies', re: /\b(for|built for|helps)\s+(agencies|freelancers|consultants)\b/i },
  { label: 'marketing teams', re: /\b(for|built for|helps)\s+(marketers|marketing teams|growth teams)\b/i },
  { label: 'product teams', re: /\b(for|built for|helps)\s+(product teams|product managers|design teams)\b/i },
  { label: 'developers', re: /\b(for|built for|helps)\s+(developers|engineers|devops)\b/i },
  { label: 'enterprise', re: /\b(enterprise|large teams|fortune 500)\b/i }
];

const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'that', 'your', 'you', 'our', 'are', 'all',
  'from', 'this', 'have', 'has', 'can', 'will', 'more', 'than', 'into', 'their', 'they', 'them',
  'what', 'when', 'where', 'who', 'how', 'its', 'not', 'but', 'get', 'out', 'one', 'use', 'using',
  'about', 'also', 'any', 'each', 'which', 'while', 'over', 'such', 'just', 'only', 'well', 'very']);

function tokens(text) {
  return new Set(String(text || '').toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w)));
}

function cleanText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

// Category via keyword counts. Returns null when nothing matches, rather than
// forcing the closest-looking category.
function detectCategory(page) {
  const hay = `${page.title || ''} ${page.description || ''} ${page.h1 || ''} ${page.text || ''}`
    .toLowerCase().slice(0, 20000);
  let best = null;
  for (const [category, keywords] of Object.entries(CATEGORY_TAXONOMY)) {
    const hits = keywords.filter((k) => hay.includes(k));
    if (hits.length === 0) continue;
    if (!best || hits.length > best.hits.length) best = { category, hits };
  }
  if (!best) return { category: null, confidence: 0, matched: [] };
  const confidence = Math.min(0.9, 0.45 + best.hits.length * 0.15);
  return { category: best.category, confidence, matched: best.hits };
}

function detectAudience(page) {
  const hay = `${page.title || ''} ${page.description || ''} ${page.h1 || ''} ${page.text || ''}`.slice(0, 20000);
  for (const p of AUDIENCE_PATTERNS) {
    const m = hay.match(p.re);
    if (m) return { audience: p.label, confidence: 0.6, matched: cleanText(m[0]) };
  }
  return { audience: null, confidence: 0, matched: null };
}

// The product name is the site's own title, trimmed of common separators.
function detectName(page, domain) {
  const title = cleanText(page.title);
  if (title) {
    const head = title.split(/\s[|\-–—:]\s|:\s/)[0].trim();
    if (head && head.length >= 2 && head.length <= 60) return head;
    return title.slice(0, 60);
  }
  if (domain) return domain.replace(/^www\./, '').split('.')[0];
  return null;
}

function identifyProduct(page = {}, { domain = null } = {}) {
  const description = cleanText(page.description || page.ogDescription || '').slice(0, 320) || null;
  const h1 = cleanText(page.h1 || '').slice(0, 200) || null;
  const category = detectCategory(page);
  const audience = detectAudience(page);
  return {
    name: detectName(page, domain),
    description,
    category: category.category,
    categoryConfidence: category.confidence,
    categoryMatched: category.matched,
    targetAudience: audience.audience,
    audienceConfidence: audience.confidence,
    audienceMatched: audience.matched,
    positioning: h1,
    title: cleanText(page.title).slice(0, 200) || null,
    tokens: tokens(`${page.title || ''} ${page.description || ''} ${page.h1 || ''} ${String(page.text || '').slice(0, 8000)}`)
  };
}

module.exports = { identifyProduct, detectCategory, detectAudience, tokens, cleanText, CATEGORY_TAXONOMY };
