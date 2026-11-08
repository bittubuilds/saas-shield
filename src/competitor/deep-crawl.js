'use strict';
// Phase 4A: bounded, prioritised page discovery for one competitor.
//
// Nothing here decides *what* a page says - that is extract-features.js and
// extract-pricing.js. This module only answers "which public pages are worth
// fetching, in what order, and what happened when we fetched them".
//
// Guarantees, in order of importance:
//   1. Bounded. At most maxPages fetches per competitor and maxPerType per page
//      type, so a large site cannot turn one competitor into an unbounded crawl.
//   2. Same-site only. A discovered URL must stay on the competitor's host; a
//      redirect that leaves the site is recorded, not followed into another site.
//   3. Explicit failure. Every target ends up 'ok', 'failed', 'blocked' or
//      'skipped' with a reason. A partial collection is reported as partial and
//      the pages that did load stay usable.
//   4. No restrictions bypassed: fetching goes through crawler.fetchPage, which
//      enforces robots.txt, SSRF checks on every redirect hop, timeouts and byte
//      limits.
const config = require('../config');
const { normalizeUrl, domainOf } = require('../ssrf');
const { extractReadable, extractLinks } = require('../extract');
const { classifyPage } = require('./classify');
const { sha256 } = require('../util');

const TYPE_WEIGHT = {
  pricing: 100, features: 92, product: 84, docs: 76, homepage: 120, about: 55, blog: 45, other: 20
};

// Words that make a URL more likely to be the page a competitor describes itself
// on. They only re-order candidates; classification already decided the type.
const PATH_HINTS = [
  { re: /pricing|plans|billing/i, weight: 20 },
  { re: /feature|capabilit|what-you-get/i, weight: 16 },
  { re: /product|platform|solution/i, weight: 12 },
  { re: /docs|documentation|guide|api/i, weight: 8 },
  { re: /about|company/i, weight: 6 },
  { re: /blog|changelog|news/i, weight: 4 }
];

const ASSET_EXT = /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|json|xml|pdf|zip|gz|mp4|mp3|woff2?|ttf|eot)$/i;
const NOISE_PATH = /\/(login|signin|sign-in|signup|sign-up|register|logout|cart|checkout|account|dashboard|admin|wp-admin|search|tag|author|feed|rss)(\/|$|\?)/i;

// Accepts either a bare host or a full URL: callers pass both, and silently
// comparing a host to a URL string made every page look off-site.
function canonicalHost(value) {
  const raw = String(value || '');
  let host = raw;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try { host = new URL(raw).hostname; } catch { host = ''; }
  }
  return host.replace(/^www\./i, '').toLowerCase();
}

// True when a URL still belongs to the competitor: same host, or a subdomain of
// the competitor's registrable host (docs.example.com under example.com).
function sameSite(url, siteHost) {
  try {
    const host = canonicalHost(new URL(url).hostname);
    const base = canonicalHost(siteHost);
    return host === base || host.endsWith('.' + base) || base.endsWith('.' + host);
  } catch {
    return false;
  }
}

function isCandidate(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (ASSET_EXT.test(u.pathname)) return false;
  if (NOISE_PATH.test(u.pathname)) return false;
  return true;
}

function scoreTarget({ pageType, url, anchorText = '', depth = 1, source = 'link' }) {
  const base = TYPE_WEIGHT[pageType] ?? TYPE_WEIGHT.other;
  let score = base;
  for (const hint of PATH_HINTS) if (hint.re.test(url)) score += hint.weight;
  const text = String(anchorText || '').toLowerCase();
  if (text && /pricing|plans/.test(text)) score += 8;
  if (text && /feature/.test(text)) score += 6;
  score -= Math.min(depth - 1, 3) * 4;          // shallower pages first
  if (source === 'sitemap') score -= 2;         // a link is a stronger signal
  return score;
}

// Rank candidate URLs for one competitor. Pure function: no fetching, so the
// ordering rules are directly testable.
function rankTargets({ siteUrl, links = [], sitemapUrls = [], pageTypes = config.competitorIntel.pageTypes, maxPages = config.competitorIntel.maxPages, maxPerType = config.competitorIntel.maxPerType }) {
  const host = domainOf(siteUrl);
  const seen = new Set();
  const candidates = [];

  const consider = (rawUrl, { source, depth, anchorText }) => {
    if (candidates.length > 400) return;         // hard guard on pathological pages
    let url;
    try { url = normalizeUrl(rawUrl); } catch { return; }
    if (!sameSite(url, host)) return;
    if (!isCandidate(url)) return;
    const key = url.toLowerCase();
    if (seen.has(key)) return;                   // URL dedupe, before ranking
    seen.add(key);
    const cls = classifyPage(url, { title: anchorText });
    const pageType = pageTypes.includes(cls.page_type) ? cls.page_type : 'other';
    candidates.push({
      url,
      pageType,
      classification_confidence: cls.confidence,
      classification_reason: cls.reason,
      discovery_source: source,
      depth,
      score: scoreTarget({ pageType, url, anchorText, depth, source })
    });
  };

  // Homepage always comes first: it is the competitor's own summary of itself and
  // the page every other target is discovered from.
  consider(siteUrl, { source: 'seed', depth: 0, anchorText: '' });
  for (const u of sitemapUrls) consider(u, { source: 'sitemap', depth: 1, anchorText: '' });
  for (const link of links) consider(link.url || link, { source: 'link', depth: 1, anchorText: link.text || '' });

  const ranked = candidates.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));

  // Apply the caps: total budget and a per-type ceiling, so one huge docs tree
  // cannot crowd out pricing.
  const out = [];
  const perType = new Map();
  for (const c of ranked) {
    if (out.length >= maxPages) break;
    const used = perType.get(c.pageType) || 0;
    if (used >= maxPerType && c.pageType !== 'homepage') continue;
    perType.set(c.pageType, used + 1);
    out.push(c);
  }
  return out;
}

function expectedStatusForError(err) {
  const code = String((err && err.code) || '');
  if (code === 'ROBOTS') return 'blocked';
  if (code === 'UNSAFE_URL' || code === 'SSRF' || code === 'UNSUPPORTED_TYPE') return 'skipped';
  return 'failed';
}

// Fetch the ranked targets and hand each outcome to the caller for persistence.
// fetchPage is injected so tests can drive inaccessible, slow and redirecting
// pages without networking.
async function fetchTargets({
  targets, fetchPage, maxTextChars = config.competitorIntel.maxTextChars,
  onPage = async () => {}, onFailure = async () => {}
}) {
  const seenHashes = new Map();   // content hash -> first url that had it
  const results = [];
  for (const target of targets) {
    let fetched;
    try {
      fetched = await fetchPage(target.url);
    } catch (e) {
      const status = expectedStatusForError(e);
      await onFailure({ target, status, error: e && e.message ? e.message : 'fetch failed' });
      results.push({ ...target, fetch_status: status, error: e && e.message });
      continue;
    }

    const finalUrl = (fetched && fetched.finalUrl) || target.url;
    // Redirect validation: the hop chain already re-checked SSRF on each step;
    // this rejects a redirect that silently moved us to a different site.
    if (!sameSite(finalUrl, target.url)) {
      await onFailure({ target, status: 'blocked', error: `redirected off-site to ${finalUrl}` });
      results.push({ ...target, fetch_status: 'blocked', error: `redirected off-site to ${finalUrl}` });
      continue;
    }

    const html = (fetched && fetched.html) || '';
    const page = extractReadable(html, finalUrl);
    const text = String(page.text || '').slice(0, maxTextChars);
    if (!text || text.length < 40) {
      // A page with no readable text is not evidence of anything. Record it as
      // skipped rather than storing an empty document that looks like content.
      await onFailure({ target, status: 'skipped', error: 'no readable text' });
      results.push({ ...target, fetch_status: 'skipped', error: 'no readable text' });
      continue;
    }

    const hash = sha256(text);
    const duplicateOf = seenHashes.get(hash) || null;
    if (!duplicateOf) seenHashes.set(hash, target.url);

    const record = {
      ...target,
      final_url: normalizeUrl(finalUrl),
      title: page.title || null,
      text_content: text,
      text_chars: text.length,
      content_hash: hash,
      fetched_bytes: Buffer.byteLength(html, 'utf8'),
      http_status: (fetched && fetched.httpStatus) || 200,
      duplicate_of: duplicateOf,
      fetch_status: 'ok',
      error: null
    };
    await onPage(record);
    results.push(record);
  }
  return results;
}

// Aggregated status for a collection run. 'partial' means some pages worked and
// some did not, which is a usable result that must not look like a success.
function summarise(results, { failedFatal = false } = {}) {
  const ok = results.filter((r) => r.fetch_status === 'ok').length;
  const failed = results.length - ok;
  let status = 'completed';
  if (ok === 0 && (failed > 0 || failedFatal)) status = 'failed';
  else if (failed > 0) status = 'partial';
  return { status, pagesOk: ok, pagesFailed: failed, pagesAttempted: results.length };
}

module.exports = {
  rankTargets, fetchTargets, summarise, sameSite, isCandidate, scoreTarget, canonicalHost
};
