'use strict';
// Phase 4C: structured pricing extraction.
//
// The rules that matter more than the parsing:
//   * A missing price stays unknown. It is never 0, and it never implies "free".
//   * No currency conversion, ever. The number is stored exactly as printed and
//     the wording is kept verbatim in price_display/original_text.
//   * Ambiguous currency symbols stay ambiguous: "$" is recorded as a symbol, not
//     assumed to be USD, unless the page spells the currency out.
//   * Plan limits and features are only recorded when the page states them.
//
// Everything is deterministic, so two runs over the same page produce the same
// plans and can be diffed.
const { createHash } = require('crypto');

const PRICING_PAGE_TYPES = ['pricing'];

// Symbols that have exactly one common meaning in the English web. '$' is not
// here on purpose: it is USD, CAD, AUD, NZD, SGD and more.
const UNAMBIGUOUS_SYMBOLS = [
  { symbol: '\u20ac', currency: 'EUR', pattern: '\u20ac' },
  { symbol: '\u00a3', currency: 'GBP', pattern: '\u00a3' },
  { symbol: '\u20b9', currency: 'INR', pattern: '\u20b9' },
  { symbol: '\u00a5', currency: 'JPY', pattern: '\u00a5' },
  { symbol: '\u20a9', currency: 'KRW', pattern: '\u20a9' },
  { symbol: 'R$', currency: 'BRL', pattern: 'R\\$' }
];

// Currency codes are only accepted when the page writes them out.
const CURRENCY_CODES = ['USD', 'EUR', 'GBP', 'INR', 'CAD', 'AUD', 'NZD', 'SGD', 'JPY', 'BRL', 'ZAR', 'AED', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN'];

const PLAN_NAME = /^(free|starter|start|basic|essential|essentials|individual|personal|pro|professional|plus|team|teams|business|growth|scale|premium|advanced|enterprise|company|organisation|organization|custom|pay as you go|pay-as-you-go|developer|hobby|standard|unlimited|agency|ultimate|elite|self[-\s]?hosted|cloud|solo)\b/i;

const TRIAL = /(?:(\d{1,3})[-\s]?(day|days|week|weeks|month|months)\s+(?:free\s+)?trial)|(?:free\s+trial[^.\n]{0,40}?(\d{1,3})[-\s]?(day|day|week|weeks|month|months))/i;
const FREE_TRIAL_TEXT = /free\s+trial|try\s+(?:it\s+)?free|two\s+weeks\s+free|start\s+free/i;
const FREE_PLAN_TEXT = /free\s+(?:forever|plan|tier)|\bno\s+credit\s+card\b.*free/i;
const ENTERPRISE_TEXT = /contact\s+(?:us|sales)|talk\s+to\s+sales|request\s+(?:a\s+)?quote|custom\s+pric(?:e|ing)|enterprise\s+pric/i;
const USAGE_TEXT = /usage[-\s]?based|metered|pay\s+as\s+you\s+go|per\s+(?:seat|user|member|scan|request|api\s+call|credit|token)|overage|credit[-\s]?based/i;
const PRICE_STOP = /^(features?|includes?|everything in|what'?s included|limits?|support)\b/i;

function normaliseLine(raw) {
  return String(raw || '').replace(/\s+/g, ' ').trim();
}

function parseAmount(raw) {
  const cleaned = String(raw).replace(/[,\s]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function intervalOf(text) {
  const t = String(text || '');
  if (/per\s*month|\/\s*mo\b|\bmo\b|monthly|\/\s*month/i.test(t)) return 'month';
  if (/per\s*year|\/\s*yr\b|\byr\b|annual|yearly|\/\s*year/i.test(t)) return 'year';
  if (/per\s*week|\/\s*wk\b|weekly/i.test(t)) return 'week';
  if (/per\s*day|\/\s*day|daily/i.test(t)) return 'day';
  if (/one[-\s]?time|lifetime|perpetual/i.test(t)) return 'one_time';
  if (/contact|custom|quote/i.test(t)) return 'custom';
  return 'unknown';
}

// Finds a printed price and its currency. Returns null when the line has no
// number, which is the normal case for "Contact sales".
function priceOf(line) {
  const text = String(line || '');

  // 1. Symbol before the number: 49, $29, €49
  for (const c of UNAMBIGUOUS_SYMBOLS) {
    const m = text.match(new RegExp(`${c.pattern}\\s?([0-9][0-9.,]*)`));
    if (m) {
      return { value: parseAmount(m[1]), display: m[0].trim(), currency: c.currency, currencyDisplay: c.symbol };
    }
  }
  // 2. Currency code written out: 29 USD, USD 29
  const codeBefore = text.match(new RegExp(`\\b(${CURRENCY_CODES.join('|')})\\s?([0-9][0-9.,]*)`, 'i'));
  if (codeBefore) {
    return { value: parseAmount(codeBefore[2]), display: codeBefore[0].trim(), currency: codeBefore[1].toUpperCase(), currencyDisplay: codeBefore[1].toUpperCase() };
  }
  const codeAfter = text.match(new RegExp(`([0-9][0-9.,]*)\\s?(${CURRENCY_CODES.join('|')})\\b`, 'i'));
  if (codeAfter) {
    return { value: parseAmount(codeAfter[1]), display: codeAfter[0].trim(), currency: codeAfter[2].toUpperCase(), currencyDisplay: codeAfter[2].toUpperCase() };
  }
  // 3. Bare dollar sign: the symbol is recorded, the currency is left unknown.
  const dollar = text.match(/\$\s?([0-9][0-9.,]*)/);
  if (dollar) {
    return { value: parseAmount(dollar[1]), display: dollar[0].trim(), currency: null, currencyDisplay: '$' };
  }
  return null;
}

function trialDaysOf(text) {
  const m = String(text || '').match(TRIAL);
  if (!m) return null;
  const n = Number(m[1] || m[3]);
  const unit = String(m[2] || m[4] || 'day').toLowerCase();
  if (!Number.isFinite(n) || n <= 0 || n > 365) return null;
  if (unit.startsWith('week')) return n * 7;
  if (unit.startsWith('month')) return n * 30;
  return n;
}

function isPlanName(line, next) {
  const clean = normaliseLine(line);
  if (!clean || clean.length > 40) return false;
  const words = clean.split(' ').length;
  if (words > 4) return false;
  if (/[.!?]$/.test(clean)) return false;
  if (PRICE_STOP.test(clean)) return false;
  if (priceOf(clean)) return false;                       // a price is not a name
  if (PLAN_NAME.test(clean)) return true;
  // An unknown but title-like name followed by a price line is still a plan.
  const looksTitle = /^[A-Z0-9][\w\s&+/-]*$/.test(clean) && !/[a-z]{4,}\s+[a-z]{4,}\s+[a-z]{4,}/i.test(clean);
  return looksTitle && Boolean(next && priceOf(next));
}

function limitsFrom(lines) {
  const limits = [];
  for (const line of lines) {
    if (!/\d/.test(line)) continue;
    // A price is not a limit. "$29 per month" contains "month" but says nothing
    // about what the plan allows.
    if (priceOf(line)) continue;
    if (!/\b(seat|seats|user|users|member|members|project|projects|site|sites|scan|scans|page|pages|request|requests|call|calls|credit|credits|gb|mb|tb|event|events|contact|contacts|email|emails|workspace|workspaces|month|day)\b/i.test(line)) continue;
    limits.push(normaliseLine(line).slice(0, 200));
  }
  return limits;
}

function planFeaturesFrom(lines) {
  const out = [];
  for (const line of lines) {
    if (PRICE_STOP.test(line)) continue;
    if (priceOf(line)) continue;               // the price is recorded as a price

    if (line.length < 4 || line.length > 160) continue;
    if (!/[a-z]/i.test(line)) continue;
    out.push(normaliseLine(line).slice(0, 160));
  }
  return out.slice(0, 20);
}

// Split a pricing page into plan blocks. A plan starts at a plan-name line; its
// block runs until the next plan name.
function blocksOf(text) {
  const lines = String(text || '').split('\n').map(normaliseLine).filter(Boolean);
  const blocks = [];
  let current = null;
  let pageTrial = null;
  let pageFree = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (TRIAL.test(line) && !pageTrial) pageTrial = { days: trialDaysOf(line), display: line.slice(0, 200) };
    if (FREE_PLAN_TEXT.test(line)) pageFree = true;

    if (isPlanName(line, lines[i + 1])) {
      if (current) blocks.push(current);
      current = { name: line, lines: [], startLine: line };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) blocks.push(current);
  return { blocks, pageTrial, pageFree };
}

function hashOf(page, name) {
  return createHash('sha256')
    .update(`${page.content_hash || ''}|${String(name).toLowerCase()}`)
    .digest('hex')
    .slice(0, 32);
}

function extractFromPage(page) {
  const pageType = String(page.page_type || 'other');
  if (!PRICING_PAGE_TYPES.includes(pageType)) return { plans: [], pageTrial: null, pageFree: false };
  const text = String(page.text_content || '');
  if (!text) return { plans: [], pageTrial: null, pageFree: false };

  const { blocks, pageTrial, pageFree } = blocksOf(text);
  const plans = [];
  for (const block of blocks) {
    const blockText = [block.name, ...block.lines].join(' ');
    const price = priceOf(blockText.slice(0, 400)) || priceOf(block.name);
    const enterprise = ENTERPRISE_TEXT.test(blockText);
    const usage = USAGE_TEXT.test(blockText);
    const freeByName = /^free\b/i.test(block.name);
    const zeroPrice = price && price.value === 0;
    const explicitlyFree = FREE_PLAN_TEXT.test(blockText);
    const trialLine = block.lines.find((l) => TRIAL.test(l));
    const trialDays = trialLine ? trialDaysOf(trialLine) : (pageTrial ? pageTrial.days : null);

    // Plan state: recorded only when the page says it. A plan with no printed
    // price keeps price_value NULL and price_stated 0.
    plans.push({
      plan_name: block.name,
      price_display: price ? price.display : null,
      price_value: price ? price.value : null,
      price_stated: Boolean(price),
      currency: price ? price.currency : null,
      currency_display: price ? price.currencyDisplay : null,
      billing_interval: price ? intervalOf(blockText) : (enterprise ? 'custom' : 'unknown'),
      billing_note: null,
      // Tri-state on purpose: only "yes" when the page says free. "No" is decided
      // per competitor, once we know a pricing page was actually read.
      free_plan: freeByName || zeroPrice || explicitlyFree ? 1 : null,
      trial_days: trialDays,
      trial_display: trialLine || (pageTrial ? pageTrial.display : null),
      usage_based: usage ? 1 : null,
      enterprise_custom: enterprise ? 1 : null,
      limits: limitsFrom(block.lines),
      plan_features: planFeaturesFrom(block.lines),
      original_text: [block.name, ...block.lines].join(' | ').slice(0, 2000),
      confidence: price ? 0.9 : (enterprise ? 0.75 : 0.55),
      identity_key: String(block.name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
      source_url: page.url,
      page_id: page.page_id || null,
      content_hash: hashOf(page, block.name),
      observed_at: page.fetched_at || new Date().toISOString()
    });
  }

  // A page can state a free trial or free plan outside any plan block.
  if (pageFree && plans.length && !plans.some((p) => p.free_plan === 1)) {
    const freeLine = text.split('\n').map(normaliseLine).find((l) => FREE_PLAN_TEXT.test(l));
    if (freeLine) {
      plans.push({
        plan_name: 'free',
        price_display: null,
        price_value: 0,
        price_stated: false,
        currency: null,
        currency_display: null,
        billing_interval: 'unknown',
        billing_note: 'free tier stated in page text without a price block',
        free_plan: 1,
        trial_days: pageTrial ? pageTrial.days : null,
        trial_display: pageTrial ? pageTrial.display : null,
        usage_based: null,
        enterprise_custom: null,
        limits: [],
        plan_features: [],
        original_text: freeLine.slice(0, 500),
        confidence: 0.7,
        identity_key: 'free',
        source_url: page.url,
        page_id: page.page_id || null,
        content_hash: hashOf(page, 'free'),
        observed_at: page.fetched_at || new Date().toISOString()
      });
    }
  }

  return { plans, pageTrial, pageFree };
}

// Merge plans across pricing pages, preferring the stated price. Identical
// (identity, content) pairs collapse; different observations both survive.
function mergePlans(bundles) {
  const byKey = new Map();
  for (const bundle of bundles) {
    for (const plan of bundle.plans) {
      const key = `${plan.identity_key}|${plan.content_hash}`;
      const prev = byKey.get(key);
      if (!prev || (plan.price_stated && !prev.price_stated) || plan.confidence > prev.confidence) {
        byKey.set(key, plan);
      }
    }
  }
  return [...byKey.values()].sort((a, b) => {
    const av = a.price_value === null ? Number.POSITIVE_INFINITY : a.price_value;
    const bv = b.price_value === null ? Number.POSITIVE_INFINITY : b.price_value;
    return av - bv || a.plan_name.localeCompare(b.plan_name);
  });
}

// Build the per-competitor pricing answer.
//
// has_pricing_evidence is 1 whenever a pricing page was read. free_plan is 1 only
// on explicit evidence, 0 only when a pricing page was read and listed plans with
// no free option, and NULL when nothing about pricing was read - so "unknown" is
// never rendered as "paid", and a missing price is never rendered as "free".
function summariseFrom({ plans, pageTrial, pageFree, pricingPageRead, sourceUrl }) {
  // "Starting price" is the cheapest paid plan. A free tier is recorded as a free
  // tier, not as a $0 starting price, and a custom/quote plan has no number.
  const priced = plans.filter((p) => p.price_stated && p.price_value !== null
    && p.price_value > 0 && p.billing_interval !== 'custom');
  const currencies = new Set(priced.map((p) => `${p.currency || p.currency_display || '?'}`));
  // Never compare across currencies: if the page mixes them, no starting price is
  // claimed at all.
  const comparable = currencies.size <= 1;
  const cheapest = comparable && priced.length ? priced[0] : null;

  const freePlan = plans.some((p) => p.free_plan === 1) || pageFree ? 1
    : (pricingPageRead ? 0 : null);
  const trialDays = plans.reduce((best, p) => (p.trial_days && (!best || p.trial_days > best) ? p.trial_days : best), null)
    || (pageTrial && pageTrial.days) || null;
  const trialStated = plans.some((p) => p.trial_display) || Boolean(pageTrial);
  const usageBased = plans.some((p) => p.usage_based === 1) ? 1 : (pricingPageRead ? 0 : null);
  const enterprise = plans.some((p) => p.enterprise_custom === 1) ? 1 : (pricingPageRead ? 0 : null);

  return {
    has_pricing_evidence: pricingPageRead ? 1 : 0,
    free_plan: freePlan,
    free_trial: trialStated ? 1 : (pricingPageRead ? 0 : null),
    trial_days: trialDays,
    trial_display: plans.find((p) => p.trial_display)?.trial_display || (pageTrial ? pageTrial.display : null),
    starting_price_display: cheapest ? cheapest.price_display : null,
    starting_price_value: cheapest ? cheapest.price_value : null,
    currency: cheapest ? (cheapest.currency || null) : null,
    currency_display: cheapest ? (cheapest.currency_display || null) : null,
    billing_interval: cheapest ? cheapest.billing_interval : null,
    usage_based: usageBased,
    enterprise_custom: enterprise,
    plans_count: plans.length,
    source_url: sourceUrl || null,
    confidence: cheapest ? 0.9 : (pricingPageRead && plans.length ? 0.65 : (pricingPageRead ? 0.4 : 0)),
    mixed_currencies: currencies.size > 1
  };
}

function extractAll(pages) {
  const bundles = [];
  for (const page of pages) {
    if (String(page.page_type || '') !== 'pricing') continue;
    bundles.push(extractFromPage(page));
  }
  const plans = mergePlans(bundles);
  const pageTrial = bundles.map((b) => b.pageTrial).find(Boolean) || null;
  const pageFree = bundles.some((b) => b.pageFree);
  const pricingPageRead = bundles.length > 0;
  const summary = summariseFrom({
    plans, pageTrial, pageFree, pricingPageRead,
    sourceUrl: pages.find((p) => p.page_type === 'pricing')?.url || null
  });
  return { plans, summary };
}

module.exports = {
  extractFromPage, extractAll, mergePlans, summariseFrom,
  priceOf, intervalOf, trialDaysOf, isPlanName, blocksOf, PRICING_PAGE_TYPES
};
