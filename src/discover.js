'use strict';
// Auto-discovery engine: reads the original website's distinctive sentences,
// searches the web for exact copies, registers every foreign site that shows
// up as a comparison website, and queues a similarity scan for each of them.
//
// Everything downstream reuses the existing scan pipeline (SSRF-hardened
// crawler, similarity engine, evidence records). Nothing is fabricated:
// discovered sites are simply search results; whether they actually copied
// content is decided by the scan, with evidence.

const db = require('./db');
const config = require('./config');
const sim = require('./similarity');
const scanner = require('./scanner');
const search = require('./search');
const { searchWeb, SearchUnavailableError } = search;
const { newId, utcNow } = require('./util');
const { audit } = require('./auth');
const { parseHttpUrl, domainOf } = require('./ssrf');

const MAX_QUERIES = 5;       // sentences searched per discovery run
const MAX_SITES = 6;         // comparison sites registered per run
const MIN_WORDS = 8;         // per search sentence
const MIN_CHARS = 45;
const MAX_CHARS = 180;

// Social networks / aggregators: copies there are not actionable website
// content theft for this product, and they pollute discovery results.
const PLATFORM_BLOCKLIST = new Set([
  'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'linkedin.com',
  'youtube.com', 'tiktok.com', 'pinterest.com', 'reddit.com', 'quora.com',
  'medium.com', 'substack.com', 'tumblr.com', 'discord.com', 'telegram.org',
  'whatsapp.com', 'amazon.com', 'flipkart.com', 'google.com', 'google.co.in',
  'bing.com', 'yahoo.com', 'duckduckgo.com', 'archive.org', 'web.archive.org',
  'wikipedia.org', 'github.com', 'gitlab.com', 'stackoverflow.com',
  'ycombinator.com', 'producthunt.com', 'gstatic.com'
]);

const running = new Set(); // discoveryId set while a job is active

function isRunning(id) { return running.has(id); }

// ---------------------------------------------------------------------------
// Sentence selection
// ---------------------------------------------------------------------------
function splitSentences(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Pick distinctive, searchable sentences from original pages.
// Heuristic: content sentences of 45-180 chars with >= MIN_WORDS words that
// are not dominated by boilerplate tokens; at most one per page, spread across
// as many pages as possible.
function pickSearchSentences(pages, boilerTokens) {
  const boiler = new Set(boilerTokens || []);
  const picked = [];
  for (const p of pages) {
    if (picked.length >= MAX_QUERIES) break;
    const candidates = splitSentences(p.text_content)
      .filter((s) => s.length >= MIN_CHARS && s.length <= MAX_CHARS)
      .map((s) => {
        const words = sim.tokenize(s);
        return { s, words };
      })
      .filter((c) => c.words.length >= MIN_WORDS)
      .filter((c) => c.words.filter((w) => boiler.has(w)).length / c.words.length < 0.4);
    if (candidates.length === 0) continue;
    // Prefer the sentence with the most content words.
    candidates.sort((a, b) => b.words.length - a.words.length);
    picked.push(candidates[0].s);
  }
  return picked;
}

// ---------------------------------------------------------------------------
// Result filtering
// ---------------------------------------------------------------------------
function hostOfUrl(u) {
  try { return new URL(u).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return null; }
}

function isBlockedHost(host) {
  if (!host) return true;
  const bare = host.replace(/^www\./, '');
  if (PLATFORM_BLOCKLIST.has(bare)) return true;
  // e.g. "en.wikipedia.org" -> "wikipedia.org" match against blocklist suffixes
  for (const b of PLATFORM_BLOCKLIST) {
    if (bare.endsWith('.' + b)) return true;
  }
  return false;
}

function sameSite(host, ownDomain) {
  if (!host || !ownDomain) return false;
  const strip = (s) => String(s).replace(/^www\./, '').replace(/:\d+$/, '').replace(/[\[\]]/g, '');
  const h = strip(host), d = strip(ownDomain);
  return h === d || h.endsWith('.' + d) || d.endsWith('.' + h);
}

// Dedupe by host, drop the original's own domain and blocked platforms,
// keep only valid http(s) URLs, cap at MAX_SITES.
function filterResultHosts(urls, ownDomain) {
  const out = [];
  const seen = new Set();
  for (const u of urls) {
    if (out.length >= MAX_SITES) break;
    let host;
    try {
      const parsed = new URL(u);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
      host = hostOfUrl(u);
    } catch {
      continue;
    }
    if (isBlockedHost(host)) continue;
    if (sameSite(host, ownDomain)) continue;
    if (seen.has(host)) continue;
    seen.add(host);
    out.push(u);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Job runner
// ---------------------------------------------------------------------------
async function runDiscovery(discoveryId, opts = {}) {
  const searchFn = opts.searchFn || searchWeb;
  const d = db.prepare('SELECT * FROM discoveries WHERE id=?').get(discoveryId);
  if (!d) return;
  running.add(discoveryId);
  try {
    db.prepare(`UPDATE discoveries SET status='running', started_at=? WHERE id=?`).run(utcNow(), discoveryId);
    const original = db.prepare('SELECT * FROM websites WHERE id=?').get(d.original_website_id);
    if (!original || original.status === 'paused') throw new Error('Original website is missing or paused.');

    // 1. Make sure we have the original's content.
    const job = { cancelRequested: false };
    const pageRows = db.prepare('SELECT COUNT(*) c FROM pages WHERE website_id=?').get(original.id);
    if (pageRows.c === 0) {
      await scanner.crawlAndStore(original, { maxPages: 10, maxDepth: 1 }, job);
    }
    const pages = scanner.contentUniquePages(original.id);
    if (pages.length === 0) {
      throw new Error('No readable content could be extracted from the original website.');
    }

    // 2. Distinctive sentences -> web search.
    const boiler = sim.boilerplateTokens(pages.map((p) => p.text_content));
    const sentences = pickSearchSentences(pages, boiler);
    if (sentences.length === 0) {
      throw new Error('The original site has no distinctive text sentences long enough to search for.');
    }
    const foundUrls = [];
    const queriesUsed = [];
    for (const s of sentences) {
      if (foundUrls.length >= MAX_SITES * 3) break;
      const q = `"${s.replace(/"/g, '')}"`;
      let urls = [];
      try {
        urls = await searchFn(q, { num: 10 });
      } catch (e) {
        if (e.code === 'SEARCH_UNAVAILABLE') throw e;
        // A single failing query should not kill the whole run.
        continue;
      }
      queriesUsed.push(q);
      foundUrls.push(...urls);
    }
    if (queriesUsed.length === 0) {
      throw new SearchUnavailableError('Search was unavailable for every query. Try again shortly.');
    }

    // 3. Register foreign sites as comparison websites + queue scans.
    const sites = filterResultHosts(foundUrls, original.normalized_domain);
    let createdScans = 0;
    const registered = [];
    for (const u of sites) {
      let host;
      try {
        const parsed = parseHttpUrl(u);   // SSRF guard, throws on unsafe URLs
        host = domainOf(parsed.toString());
      } catch {
        continue;   // skip unsafe/invalid URLs entirely
      }
      const existing = db.prepare('SELECT id FROM websites WHERE workspace_id=? AND kind=? AND normalized_domain=?')
        .get(d.workspace_id, 'comparison', host);
      let siteId = existing ? existing.id : null;
      if (!siteId) {
        siteId = newId('web');
        db.prepare(`INSERT INTO websites (id, workspace_id, kind, submitted_url, normalized_domain, label, status, crawl_status, created_at, updated_at)
                    VALUES (?,?,?,?,?, 'Found by auto-discovery', 'pending', 'not_crawled', ?, ?)`)
          .run(siteId, d.workspace_id, 'comparison', u, host, utcNow(), utcNow());
      }
      // Skip if a scan for this pair is already active (same rule as manual scans).
      const active = scanner.pairHasActiveScan(d.workspace_id, original.id, siteId);
      if (active) { registered.push({ url: u, scan_id: active, already: true }); continue; }
      const scanId = newId('scn');
      const params = { recrawl: true, maxPages: 10, maxDepth: 1, discovered: true };
      db.prepare(`INSERT INTO scans (id, workspace_id, original_website_id, comparison_website_id, status, params, created_by, created_at)
                  VALUES (?,?,?,?, 'queued', ?, ?, ?)`)
        .run(scanId, d.workspace_id, original.id, siteId, JSON.stringify(params), d.created_by || null, utcNow());
      scanner.enqueueScan(scanId);
      createdScans++;
      registered.push({ url: u, scan_id: scanId, already: false });
    }

    db.prepare(`UPDATE discoveries SET status='completed', provider=?, queries=?, found_hosts=?, created_scan_count=?, finished_at=?, updated_at=? WHERE id=?`)
      .run(
        search.isSearchConfigured() ? 'serper' : (opts.searchFn ? 'test' : 'none'),
        JSON.stringify(queriesUsed),
        JSON.stringify(registered),
        createdScans,
        utcNow(), utcNow(), discoveryId
      );
    audit(d.workspace_id, null, 'discovery.completed', { discoveryId, queries: queriesUsed.length, sites: registered.length });
  } catch (e) {
    const msg = e.code === 'SEARCH_UNAVAILABLE'
      ? e.message
      : (e.message || 'Discovery failed.');
    db.prepare(`UPDATE discoveries SET status='failed', error=?, finished_at=?, updated_at=? WHERE id=?`)
      .run(msg, utcNow(), utcNow(), discoveryId);
    audit(d.workspace_id, null, 'discovery.failed', { discoveryId, error: msg });
  } finally {
    running.delete(discoveryId);
  }
}

function enqueueDiscovery(id) {
  setImmediate(() => runDiscovery(id));
}

module.exports = {
  runDiscovery, enqueueDiscovery, isRunning,
  splitSentences, pickSearchSentences, filterResultHosts, isBlockedHost,
  MAX_QUERIES, MAX_SITES
};
