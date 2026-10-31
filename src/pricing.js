'use strict';
// Conservative structured pricing extraction.
//
// Rules that keep this honest:
//   1. A plan is only reported when an actual price token was found in the page
//      text. Nothing is inferred, defaulted, or invented.
//   2. Every plan keeps the exact matched substring (`raw`) and the source line
//      so a human can confirm it.
//   3. Anything that does not line up (price but no interval, name but no price)
//      gets a low confidence label instead of being dropped or guessed.
//
// When extraction finds nothing on a page the caller records a general page
// content change instead of a structured pricing change.

const CURRENCY_SYMBOLS = {
  '$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR', '₩': 'KRW',
  'R$': 'BRL', 'A$': 'AUD', 'C$': 'CAD', 'CHF': 'CHF', 'kr': 'SEK'
};

const CURRENCY_CODES = ['USD', 'EUR', 'GBP', 'INR', 'CAD', 'AUD', 'JPY', 'BRL', 'SGD', 'AED', 'CHF'];

const LIMIT_NOUNS = [
  'projects', 'project', 'seats', 'seat', 'users', 'user', 'members', 'member',
  'pages', 'page', 'sites', 'site', 'domains', 'domain', 'workspaces', 'workspace',
  'credits', 'credit', 'tokens', 'token', 'requests', 'request', 'calls', 'call',
  'emails', 'email', 'templates', 'template', 'boards', 'board', 'tasks', 'task',
  'invoices', 'invoice', 'clients', 'client', 'locations', 'location', 'events',
  'event', 'automations', 'automation', 'workflows', 'workflow', 'integrations',
  'integration', 'monitors', 'monitor', 'scans', 'scan', 'checks', 'check',
  'bots', 'bots/month', 'messages', 'message', 'contacts', 'contact', 'GB', 'MB',
  'TB', 'storage', 'minutes', 'hours', 'team members', 'campaigns', 'lists',
  'subscribers', 'visitors', 'views', 'downloads', 'exports', 'records'
];

const NOISE_LINE = /^(?:most popular|recommended|best value|save \d+%|billed (?:monthly|annually|yearly)|per (?:month|user|seat)|start (?:free )?trial|get started|choose (?:this )?plan|contact sales|talk to sales|free trial|try (?:it )?free|learn more|see (?:all )?plans?|compare plans?|pricing|plans?|faq|sign ?up|buy now|add to cart)$/i;

const INTERVAL_WORDS = [
  [/\b(?:per|a|\/)\s*(?:month|mo|monthly)\b/i, 'month'],
  [/\b(?:per|a|\/)\s*(?:year|yr|annually|annual)\b/i, 'year'],
  [/\b(?:per|a|\/)\s*(?:quarter|quarterly)\b/i, 'quarter'],
  [/\b(?:per|a|\/)\s*(?:week|wk|weekly)\b/i, 'week'],
  [/\b(?:per|a|\/)\s*(?:day|daily)\b/i, 'day'],
  [/\bmonthly\b/i, 'month'],
  [/\bannual(?:ly)?\b/i, 'year'],
  [/\byearly\b/i, 'year']
];

function toNumber(rawNumber) {
  if (rawNumber == null) return null;
  let s = String(rawNumber).trim();
  if (!s) return null;
  // "1,299" -> 1299 ; "29,99" (comma decimal) -> 29.99 ; "1.299,00" -> 1299.00
  const hasComma = s.includes(',');
  const hasDot = s.includes('.');
  if (hasComma && hasDot) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      s = s.replace(/,/g, '');
    }
  } else if (hasComma) {
    const parts = s.split(',');
    s = parts.length === 2 && parts[1].length !== 3 ? parts.join('.') : parts.join('');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function detectInterval(context) {
  for (const [re, label] of INTERVAL_WORDS) {
    if (re.test(context)) return label;
  }
  return null;
}

function detectCurrency(symbol, code) {
  if (code) return code.toUpperCase();
  if (symbol) {
    if (symbol === 'A$') return 'AUD';
    if (symbol === 'C$') return 'CAD';
    if (symbol === 'R$') return 'BRL';
    return CURRENCY_SYMBOLS[symbol] || symbol;
  }
  return null;
}

const PRICE_RE = new RegExp(
  '(' + ['R\\$', 'A\\$', 'C\\$', '[$€£¥₹₩]'].join('|') + ')\\s?([0-9][0-9.,]{0,12})' +
  '|\\b(' + CURRENCY_CODES.join('|') + ')\\s?([0-9][0-9.,]{0,12})',
  'i'
);

function extractLimits(lines) {
  const limits = [];
  for (const line of lines) {
    if (limits.length >= 8) break;
    if (PRICE_RE.test(line)) break;            // next plan's price ends this block
    if (/\bunlimited\b/i.test(line)) {
      limits.push('unlimited');
      continue;
    }
    const re = new RegExp(`(\\d[\\d,]*)\\s*(?:${LIMIT_NOUNS.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i');
    const m = line.match(re);
    if (m) {
      const phrase = line.trim().slice(0, 120);
      if (!limits.some((l) => l.toLowerCase() === phrase.toLowerCase())) limits.push(phrase);
    }
  }
  return limits;
}

const LIMIT_LINE_RE = new RegExp(
  `\\d[\\d,]*\\s*(?:${LIMIT_NOUNS.map((n) => n.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')).join('|')})\\b`, 'i');

function looksLikePlanName(line) {
  if (!line) return false;
  const t = line.trim();
  if (t.length < 2 || t.length > 60) return false;
  if (NOISE_LINE.test(t)) return false;
  if (PRICE_RE.test(t)) return false;
  if (LIMIT_LINE_RE.test(t)) return false;                 // "up to 3 projects"
  if (/[.!?]$/.test(t) && t.split(/\s+/).length > 6) return false;  // sentence
  return true;
}

/**
 * Extract pricing plans from a page's visible text.
 * @param {string} text - readable page text (lines separated by \n)
 * @param {object} [opts]
 * @param {Array} [opts.headings] - structured headings [{level,text}]
 * @returns {Array} plans
 */
function extractPlans(text, opts = {}) {
  const lines = String(text || '')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const headingTexts = new Set((opts.headings || []).map((h) => h.text.trim().toLowerCase()));
  const plans = [];
  const seen = new Set();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(PRICE_RE);
    if (!m) continue;

    const symbol = m[1] || null;
    const code = m[3] || null;
    const numberRaw = m[2] || m[4] || null;
    const amount = toNumber(numberRaw);
    if (amount === null) continue;

    const currency = detectCurrency(symbol, code);

    // Context: the price line plus the next few lines, which is where
    // "/month" and plan limits normally render.
    const contextLines = [line, lines[i + 1] || '', lines[i + 2] || ''];
    const context = contextLines.join(' ');
    const interval = detectInterval(context);

    // Plan name: nearest preceding short non-noise line, preferring a heading.
    let name = null;
    for (let back = 1; back <= 4 && i - back >= 0; back++) {
      const candidate = lines[i - back];
      if (!looksLikePlanName(candidate)) continue;
      name = candidate;
      break;                                   // nearest acceptable line wins
    }

    const limits = extractLimits(lines.slice(i + 1, i + 9));

    let confidence = 'low';
    if (name && interval) confidence = 'high';
    else if (interval || (name && limits.length > 0)) confidence = 'medium';

    const key = `${(name || '').toLowerCase()}|${amount}|${currency || ''}|${interval || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);

    plans.push({
      name: name || null,
      amount,
      currency,
      interval,
      limits,
      raw: m[0].trim(),
      sourceLine: line.slice(0, 200),
      confidence
    });

    if (plans.length >= 20) break;
  }

  return plans;
}

// A stable, comparable signature per plan. Used for pricing change detection so
// a re-ordered pricing table is not reported as a change.
function planSignature(plan) {
  return [
    (plan.name || '').trim().toLowerCase(),
    plan.amount === null || plan.amount === undefined ? '' : String(plan.amount),
    (plan.currency || '').toUpperCase(),
    plan.interval || ''
  ].join(' | ');
}

// Compare two plan lists. Returns added/removed/changed entries with evidence.
function diffPlans(previous, current) {
  const prev = new Map((previous || []).map((p) => [planSignature(p), p]));
  const curr = new Map((current || []).map((p) => [planSignature(p), p]));

  const added = [];
  const removed = [];
  const changed = [];

  for (const [sig, plan] of curr) {
    if (!prev.has(sig)) {
      // A plan with the same name but a different price/interval is a price
      // change, not a new plan. Detect that explicitly.
      const sameName = [...prev.values()].find((p) =>
        (p.name || '').trim().toLowerCase() === (plan.name || '').trim().toLowerCase() && (p.name || '').trim() !== '');
      if (sameName) {
        changed.push({ previous: sameName, current: plan });
      } else {
        added.push(plan);
      }
    }
  }
  for (const [sig, plan] of prev) {
    if (curr.has(sig)) continue;
    const sameName = [...curr.values()].find((p) =>
      (p.name || '').trim().toLowerCase() === (plan.name || '').trim().toLowerCase() && (p.name || '').trim() !== '');
    if (sameName) continue;   // already recorded as a change
    removed.push(plan);
  }

  return { added, removed, changed };
}

function formatPlan(plan) {
  if (!plan) return '';
  const price = plan.amount === null || plan.amount === undefined
    ? 'no price'
    : `${plan.currency ? plan.currency + ' ' : ''}${plan.amount}${plan.interval ? ' / ' + plan.interval : ''}`;
  const name = plan.name ? `${plan.name}: ` : '';
  const limits = plan.limits && plan.limits.length ? ` (${plan.limits.slice(0, 3).join('; ')})` : '';
  return `${name}${price}${limits}`;
}

module.exports = {
  extractPlans,
  diffPlans,
  planSignature,
  formatPlan,
  toNumber,
  PRICE_RE
};
