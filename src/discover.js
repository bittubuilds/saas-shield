'use strict';
// Auto-discovery engine: reads the original website's distinctive sentences,
// searches the web for exact copies, registers every foreign site that shows
// up as a comparison website, and queues a similarity scan for each of them.
//
// Everything downstream reuses the existing scan pipeline (SSRF-hardened
// crawler, similarity engine, evidence records). Nothing is fabricated:
// discovered sites are simply search results; whether they actually copied
// content is decided by the scan, with evidence.

const db = require('./db/index');
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
// Repeated runs must not stack sites and scans until the queue looks frozen: the
// progress screen retries discovery, and every run used to add up to six more
// comparison websites and six more scans. Seen live as a workspace sitting on
// dozens of comparisons with nothing visibly moving.
const MAX_DISCOVERED_TOTAL = 8;   // auto-discovered comparisons alive per workspace
const MAX_PENDING_SCANS = 3;      // queued/running scans before discovery stops adding
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

  // Three tiers, tried in order. The strict rule is the best evidence, but a short
  // marketing portfolio can contain no 8-word sentence at all, and that used to end
  // discovery with "no distinctive text sentences" even though the page was read
  // perfectly. Falling back beats refusing to search.
  const tiers = [
    { minWords: MIN_WORDS, minChars: MIN_CHARS, maxChars: MAX_CHARS, maxBoiler: 0.4 },
    { minWords: 5, minChars: 24, maxChars: 220, maxBoiler: 0.6 },
    { minWords: 4, minChars: 16, maxChars: 240, maxBoiler: 1 }
  ];

  for (const tier of tiers) {
    const picked = [];
    for (const p of pages) {
      if (picked.length >= MAX_QUERIES) break;
      const candidates = splitSentences(p.text_content)
        .filter((s) => s.length >= tier.minChars && s.length <= tier.maxChars)
        .map((s) => ({ s, words: sim.tokenize(s) }))
        .filter((c) => c.words.length >= tier.minWords)
        .filter((c) => c.words.filter((w) => boiler.has(w)).length / c.words.length < tier.maxBoiler);
      if (candidates.length === 0) continue;
      candidates.sort((a, b) => b.words.length - a.words.length);
      picked.push(candidates[0].s);
    }
    if (picked.length > 0) return picked;
  }
  return [];
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
// Auto-discovery caps only work if old rows cannot lock them shut. Earlier builds
// added up to six sites per run, so a workspace could carry dozens and then sit at a
// budget of zero forever: every run "completed" without adding anything, which is
// exactly what the progress screen showed.
function trimAutoDiscovered(workspaceId, keep = MAX_DISCOVERED_TOTAL) {
  const rows = db.prepare(`
    SELECT w.id,
           (SELECT COUNT(*) FROM scans s
             WHERE s.workspace_id=w.workspace_id AND s.comparison_website_id=w.id
               AND s.status IN ('queued','running')) AS active,
           (SELECT COALESCE(SUM(s.findings),0) FROM scans s
             WHERE s.workspace_id=w.workspace_id AND s.comparison_website_id=w.id) AS findings
      FROM websites w
     WHERE w.workspace_id=? AND w.kind='comparison' AND w.archived_at IS NULL
       AND w.label='Found by auto-discovery'
     ORDER BY findings DESC, w.created_at ASC`).all(workspaceId);
  if (rows.length <= keep) return { archived: 0, kept: rows.length };
  let archived = 0;
  for (const row of rows.slice(keep)) {
    if (Number(row.active) > 0) continue;   // never archive something a scan is using
    db.prepare('UPDATE websites SET archived_at=?, updated_at=? WHERE id=?')
      .run(utcNow(), utcNow(), row.id);
    archived++;
  }
  if (archived) console.warn(`[discover] archived ${archived} extra auto-discovered site(s) to respect the ${keep} cap`);
  return { archived, kept: rows.length - archived };
}

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
    // Crawl when nothing is stored, and also when everything stored is an empty
    // shell (a JavaScript challenge page). Counting rows alone made discovery trust
    // that stale page forever and fail with "no readable content" on a site that is
    // perfectly readable now.
    const stored = db.prepare('SELECT text_content FROM pages WHERE website_id=?').all(original.id);
    // "Empty shell" means no page has a usable sentence, not "no page is long":
    // a short landing page is a real page and must not be re-fetched every run.
    const hasReadable = stored.some((p) => String(p.text_content || '').trim().split(/\s+/).filter(Boolean).length >= 15);
    if (stored.length === 0 || !hasReadable) {
      await scanner.crawlAndStore(original, { maxPages: 10, maxDepth: 1 }, job);
    }
    const pages = scanner.contentUniquePages(original.id);
    if (pages.length === 0) {
      throw new Error('No readable content could be extracted from the original website.');
    }
    // Distinguish "we stored a page but it had no text" from "we found no sentence
    // worth searching": they need different fixes and the old message conflated them.
    const hasAnyText = pages.some((p) => String(p.text_content || '').trim().length > 0);
    if (!hasAnyText) {
      throw new Error('The page was fetched but its text was empty. If the site renders with JavaScript, run the scan again in a minute so the browser can be installed.');
    }

    // 2. Distinctive sentences -> web search.
    const boiler = sim.boilerplateTokens(pages.map((p) => p.text_content));
    const sentences = pickSearchSentences(pages, boiler);
    if (sentences.length === 0) {
      throw new Error('The original site has no distinctive text sentences long enough to search for.');
    }
    const foundUrls = [];
    // Search position is evidence: it is what tells a later scorer whether the
    // candidate actually ranked for the original site's own wording. It has to be
    // carried from the search response into the competitor, not dropped here.
    const rankOf = new Map();
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
      urls.forEach((u, i) => {
        foundUrls.push(u);
        if (!rankOf.has(u)) rankOf.set(u, i);
      });
    }
    if (queriesUsed.length === 0) {
      throw new SearchUnavailableError('Search was unavailable for every query. Try again shortly.');
    }

    // 3. Register foreign sites as comparison websites + queue scans.
    const sites = filterResultHosts(foundUrls, original.normalized_domain);
    let createdScans = 0;
    const registered = [];

    // Old rows must not be able to lock the caps shut.
    const trimmed = trimAutoDiscovered(d.workspace_id);
    const discoveredSoFar = db.prepare(
      `SELECT COUNT(*) c FROM websites WHERE workspace_id=? AND kind='comparison' AND archived_at IS NULL AND label='Found by auto-discovery'`
    ).get(d.workspace_id).c;
    let siteBudget = Math.max(0, MAX_DISCOVERED_TOTAL - discoveredSoFar);
    const pendingScans = db.prepare(
      `SELECT COUNT(*) c FROM scans WHERE workspace_id=? AND status IN ('queued','running')`).get(d.workspace_id).c;
    let scanBudget = Math.max(0, MAX_PENDING_SCANS - pendingScans);

    // A discovered site that never got a scan consumes the budget and produces
    // nothing. Hand those their scan first, inside the same budget.
    let healedScans = 0;
    if (scanBudget > 0) {
      const orphans = db.prepare(`
        SELECT w.id FROM websites w
         WHERE w.workspace_id=? AND w.kind='comparison' AND w.archived_at IS NULL
           AND w.normalized_domain != ?
           AND NOT EXISTS (SELECT 1 FROM scans s
                 WHERE s.workspace_id=w.workspace_id AND s.comparison_website_id=w.id)
         ORDER BY w.created_at ASC LIMIT ?`)
        .all(d.workspace_id, original.normalized_domain, scanBudget);
      for (const row of orphans) {
        const scanId = newId('scn');
        db.prepare(`INSERT INTO scans (id, workspace_id, original_website_id, comparison_website_id, status, params, created_by, created_at)
                    VALUES (?,?,?,?, 'queued', ?, ?, ?)`)
          .run(scanId, d.workspace_id, original.id, row.id,
               JSON.stringify({ recrawl: true, maxPages: 10, maxDepth: 1, discovered: true }),
               d.created_by || null, utcNow());
        scanner.enqueueScan(scanId);
        scanBudget--;
        createdScans++;
        healedScans++;
      }
      if (healedScans) console.warn(`[discover] queued ${healedScans} scan(s) for discovered sites that had none`);
    }

    let skipped = 0;
    for (const u of sites) {
      if (siteBudget <= 0 || scanBudget <= 0) { skipped++; continue; }
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
        siteBudget--;
        siteId = newId('web');
        db.prepare(`INSERT INTO websites (id, workspace_id, kind, submitted_url, normalized_domain, label, status, crawl_status, created_at, updated_at)
                    VALUES (?,?,?,?,?, 'Found by auto-discovery', 'pending', 'not_crawled', ?, ?)`)
          .run(siteId, d.workspace_id, 'comparison', u, host, utcNow(), utcNow());
      }
      // Skip if a scan for this pair is already active (same rule as manual scans).
      const active = scanner.pairHasActiveScan(d.workspace_id, original.id, siteId);
      const rank = rankOf.has(u) ? rankOf.get(u) : null;
      if (active) { registered.push({ url: u, site_id: siteId, scan_id: active, already: true, rank }); continue; }
      const scanId = newId('scn');
      const params = { recrawl: true, maxPages: 10, maxDepth: 1, discovered: true };
      db.prepare(`INSERT INTO scans (id, workspace_id, original_website_id, comparison_website_id, status, params, created_by, created_at)
                  VALUES (?,?,?,?, 'queued', ?, ?, ?)`)
        .run(scanId, d.workspace_id, original.id, siteId, JSON.stringify(params), d.created_by || null, utcNow());
      scanner.enqueueScan(scanId);
      scanBudget--;
      createdScans++;
      registered.push({ url: u, site_id: siteId, scan_id: scanId, already: false, rank });
    }

    // 3b. Structured competitor intelligence. Best-effort by design: a candidate
    // we cannot evaluate must never fail the discovery run that already found it.
    try {
      const { evaluateCandidate, profileFromPages } = require('./competitor/pipeline');
      const originalProfile = profileFromPages(pages);
      for (const reg of registered) {
        try {
          await evaluateCandidate({
            workspaceId: d.workspace_id,
            discoveryId: d.id,
            websiteId: reg.site_id || null,
            url: reg.url,
            searchRank: Number.isInteger(reg.rank) ? reg.rank : null,
            original: originalProfile,
            createdBy: d.created_by || null
          });
        } catch (e) {
          console.error('[discover] competitor evaluation failed:', e.message);
        }
      }
    } catch (e) {
      console.error('[discover] competitor layer unavailable:', e.message);
    }

    // "Completed" with nothing to compare is not a success the user can act on. Say
    // why in the row, so the screen can explain it instead of sitting on "queued".
    let nothingFoundReason = null;
    if (registered.length === 0 && createdScans > 0) {
      nothingFoundReason = null;   // work was queued for sites found earlier
    } else if (registered.length === 0) {
      nothingFoundReason = foundUrls.length === 0
        ? `Search returned no results for ${queriesUsed.length} quoted sentence(s) from your site. Your wording may not appear anywhere else yet.`
        : `Search returned ${foundUrls.length} link(s), but all were your own site, a large platform, or an unsafe address, so none were kept.`;
    } else if (createdScans === 0) {
      nothingFoundReason = siteBudget <= 0
        ? `This workspace already tracks ${MAX_DISCOVERED_TOTAL} auto-discovered sites (the limit), so nothing new was added. Remove one you do not need and discovery can add more.`
        : 'The sites found already had a scan running, or the queue limit was reached.';
    }

    db.prepare(`UPDATE discoveries SET status='completed', error=?, provider=?, queries=?, found_hosts=?, created_scan_count=?, finished_at=?, updated_at=? WHERE id=?`)
      .run(
        nothingFoundReason,
        search.isSearchConfigured() ? 'serper' : (opts.searchFn ? 'test' : 'none'),
        JSON.stringify(queriesUsed),
        JSON.stringify(registered),
        createdScans,
        utcNow(), utcNow(), discoveryId
      );
    audit(d.workspace_id, null, 'discovery.completed', { discoveryId, queries: queriesUsed.length, sites: registered.length, skipped, healedScans, archived: trimmed.archived });
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
  trimAutoDiscovered,
  MAX_QUERIES, MAX_SITES, MAX_DISCOVERED_TOTAL, MAX_PENDING_SCANS
};
