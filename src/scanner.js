'use strict';
// Scan orchestration: crawls both websites (when stale), compares every
// eligible page pair with the similarity engine, deduplicates findings across
// scans, and records evidence.
//
// Resource discipline: at most MAX_CONCURRENT_SCANS run at once, the rest wait
// in a FIFO queue. A scan compares page pairs within a page/depth budget, so a
// large pair of sites cannot exhaust the process.
const db = require('./db');
const config = require('./config');
const sim = require('./similarity');
const { crawlSite } = require('./crawler');
const { newId, sha256, utcNow } = require('./util');
const { audit } = require('./auth');
const { UnsafeUrlError } = require('./ssrf');

const MAX_CONCURRENT_SCANS = 2;
const MIN_WORDS = 50;

const running = new Map();     // scanId -> { cancelRequested }
const queue = [];              // scan ids waiting for a slot
let activeScans = 0;

function isRunning(scanId) { return running.has(scanId); }
function isQueued(scanId) { return queue.includes(scanId); }

function requestCancel(scanId) {
  const job = running.get(scanId);
  if (job) {
    job.cancelRequested = true;
    return true;
  }
  const idx = queue.indexOf(scanId);
  if (idx !== -1) {
    queue.splice(idx, 1);
    db.prepare(`UPDATE scans SET status='cancelled', error='Cancelled before it started', finished_at=? WHERE id=?`)
      .run(utcNow(), scanId);
    return true;
  }
  return false;
}

// Prevent duplicate concurrent scans of the same pair.
function pairHasActiveScan(wsId, originalId, comparisonId) {
  const rows = db.prepare(`SELECT id FROM scans WHERE workspace_id=? AND original_website_id=? AND comparison_website_id=? AND status IN ('queued','running')`)
    .all(wsId, originalId, comparisonId);
  return rows.length > 0 ? rows[0].id : null;
}

function pump() {
  while (activeScans < MAX_CONCURRENT_SCANS && queue.length > 0) {
    const scanId = queue.shift();
    activeScans++;
    running.set(scanId, { cancelRequested: false });
    setImmediate(() => {
      runScan(scanId)
        .catch((e) => console.error('[scanner] scan failed unexpectedly:', e.message))
        .finally(() => {
          running.delete(scanId);
          activeScans--;
          pump();
        });
    });
  }
}

function enqueueScan(scanId) {
  queue.push(scanId);
  pump();
}

function parseStructure(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

async function runScan(scanId) {
  const scan = db.prepare('SELECT * FROM scans WHERE id = ?').get(scanId);
  if (!scan) return;
  if (scan.status === 'cancelled') return;
  const job = running.get(scanId) || { cancelRequested: false };
  running.set(scanId, job);

  const params = safeParse(scan.params);
  const checkCancel = () => {
    if (job.cancelRequested) throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
  };

  try {
    db.prepare(`UPDATE scans SET status='running', started_at=? WHERE id=?`).run(utcNow(), scanId);

    const original = db.prepare('SELECT * FROM websites WHERE id=?').get(scan.original_website_id);
    const comparison = db.prepare('SELECT * FROM websites WHERE id=?').get(scan.comparison_website_id);
    if (!original || !comparison) throw new Error('Website not found.');
    if (original.id === comparison.id) throw new Error('A website cannot be compared with itself.');

    const shouldCrawl = (site) => {
      if (params.recrawl === true) return true;
      const rows = db.prepare('SELECT COUNT(*) c FROM pages WHERE website_id=?').get(site.id);
      return rows.c === 0;
    };
    const crawlOpts = { maxPages: params.maxPages, maxDepth: params.maxDepth };

    async function ensureCrawled(site) {
      db.prepare(`UPDATE websites SET crawl_status='crawling' WHERE id=?`).run(site.id);
      const onPage = (page) => {
        checkCancel();
        db.prepare(`INSERT INTO pages (id, website_id, workspace_id, url, submitted_url, canonical_url, title, text_content, meta_description, content_hash, http_status, fetched_at, structure)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT (website_id, url) DO UPDATE SET
                      text_content=excluded.text_content, content_hash=excluded.content_hash,
                      title=excluded.title, meta_description=excluded.meta_description,
                      fetched_at=excluded.fetched_at, http_status=excluded.http_status,
                      canonical_url=excluded.canonical_url, structure=excluded.structure`)
          .run(page.id, page.website_id, page.workspace_id, page.url, page.submitted_url,
               page.canonical_url, page.title, page.text_content, page.meta_description,
               page.content_hash, page.http_status, page.fetched_at, page.structure || null);
      };
      const summary = await crawlSite(site, onPage, crawlOpts);
      const liveCount = db.prepare(`SELECT COUNT(DISTINCT content_hash) c FROM pages WHERE website_id=?`).get(site.id).c;
      db.prepare(`UPDATE websites SET crawl_status='crawled', crawl_error=NULL, accessible_page_count=?, last_scanned_at=?, status=CASE WHEN status IN ('pending','error') THEN 'active' ELSE status END, updated_at=? WHERE id=?`)
        .run(liveCount, utcNow(), utcNow(), site.id);
      return summary;
    }

    async function failCrawl(site, err) {
      db.prepare(`UPDATE websites SET crawl_status='failed', crawl_error=?, updated_at=? WHERE id=?`).run(err.message, utcNow(), site.id);
      throw err;
    }

    for (const site of [original, comparison]) {
      checkCancel();
      if (!shouldCrawl(site)) continue;
      try {
        await ensureCrawled(site);
      } catch (e) {
        if (e.code === 'CANCELLED') throw e;
        await failCrawl(site, e);
      }
    }
    checkCancel();

    // ---- Load pages ----
    const originalPages = contentUniquePages(original.id);
    const comparisonPages = contentUniquePages(comparison.id);

    if (originalPages.length === 0) throw new Error('No accessible pages could be extracted from the original website.');
    if (comparisonPages.length === 0) throw new Error('No accessible pages could be extracted from the comparison website.');

    // ---- Boilerplate tokens per site (template words in >=80% of pages) ----
    const boilerA = sim.boilerplateTokens(originalPages.map((p) => p.text_content));
    const boilerB = sim.boilerplateTokens(comparisonPages.map((p) => p.text_content));

    // ---- Eligible pairs: both texts have >= MIN_WORDS words ----
    const eligible = [];
    for (const a of originalPages) {
      const wa = sim.tokenize(a.text_content).length;
      if (wa < MIN_WORDS) continue;
      for (const b of comparisonPages) {
        const wb = sim.tokenize(b.text_content).length;
        if (wb < MIN_WORDS) continue;
        eligible.push([a, b]);
      }
    }

    // Corpus token streams for TF-IDF idf values (capped for performance).
    const corpusTokens = [];
    for (const [a, b] of eligible.slice(0, 100)) {
      corpusTokens.push(sim.tokenize(a.text_content));
      corpusTokens.push(sim.tokenize(b.text_content));
      if (corpusTokens.length >= 200) break;
    }

    let pairsCompared = 0;
    let findings = 0;
    let textsCompared = 0;

    for (const [a, b] of eligible) {
      checkCancel();
      const result = sim.compareTexts(a.text_content, b.text_content, {
        boilerplateA: boilerA,
        boilerplateB: boilerB,
        corpusTokens,
        structureA: parseStructure(a.structure),
        structureB: parseStructure(b.structure)
      });
      pairsCompared++;
      if (!result.isFinding) continue;

      // Dedupe key: page pair + the exact longest passage (or the overlap
      // signature when no passage exists). Re-running a scan does not duplicate.
      const longestHash = result.passages.length ? sha256(result.passages[0].aText) : sha256(`${result.jaccard}|${result.cosine}`);
      const dedupeKey = sha256(`${a.url}\u0000${b.url}\u0000${longestHash}`);

      const existing = db.prepare('SELECT id FROM results WHERE workspace_id=? AND dedupe_key=?').get(scan.workspace_id, dedupeKey);
      if (existing) {
        // Same finding re-observed: refresh recency, keep review status.
        db.prepare('UPDATE results SET last_observed_at=?, latest_scan_id=?, updated_at=? WHERE id=?')
          .run(utcNow(), scanId, utcNow(), existing.id);
        continue;
      }

      const resultId = newId('res');
      const first = utcNow();
      db.prepare(`INSERT INTO results (id, workspace_id, scan_id, latest_scan_id, original_page_id, comparison_page_id,
                    original_url, comparison_url, match_type, jaccard_score, cosine_score, structural_score,
                    signals, limitations, status, dedupe_key, first_observed_at, last_observed_at, updated_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'new', ?,?,?,?)`)
        .run(resultId, scan.workspace_id, scanId, scanId, a.id, b.id, a.url, b.url,
          result.matchType, result.jaccard, result.cosine,
          result.structural ? result.structural.score : null,
          JSON.stringify({
            ...result.signals,
            verdict: result.verdict,
            verdict_explanation: sim.verdictExplanation(result.verdict),
            structural: result.structural,
            method: result.method,
            explanation: result.explanation
          }),
          JSON.stringify(result.limitations),
          dedupeKey, first, first, first);

      for (const p of result.passages.slice(0, 20)) {
        db.prepare('INSERT INTO passages (id, result_id, original_text, comparison_text, word_count, score, created_at) VALUES (?,?,?,?,?,?,?)')
          .run(newId('pas'), resultId, p.aText, p.bText, p.wordCount,
            Math.round((p.wordCount / Math.max(result.wordsB, 1)) * 10000) / 10000, first);
      }

      // Evidence: the matched passage itself when there is one, because that is
      // what a reviewer needs to check. Page heads are only a fallback.
      const topPassage = result.passages[0];
      const origExcerpt = topPassage ? topPassage.aText.slice(0, 4000) : a.text_content.slice(0, 1500);
      const compExcerpt = topPassage ? topPassage.bText.slice(0, 4000) : b.text_content.slice(0, 1500);
      db.prepare(`INSERT INTO evidence (id, result_id, capture_status, capture_error, original_excerpt,
                    comparison_excerpt, original_hash, comparison_hash, screenshot_ref, captured_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(newId('ev'), resultId, topPassage ? 'captured' : 'partial',
          topPassage ? null : 'No contiguous matched passage; excerpts are the start of each page.',
          origExcerpt, compExcerpt, a.content_hash, b.content_hash, null, first);

      findings++;
      textsCompared++;
    }

    db.prepare(`UPDATE scans SET status='completed', pages_compared=?, findings=?, finished_at=? WHERE id=?`)
      .run(pairsCompared, findings, utcNow(), scanId);
    audit(scan.workspace_id, null, 'scan.completed', { scanId, pairsCompared, findings });
  } catch (e) {
    const cancelled = e.code === 'CANCELLED';
    db.prepare(`UPDATE scans SET status=?, error=?, finished_at=? WHERE id=?`)
      .run(cancelled ? 'cancelled' : 'failed', cancelled ? 'Cancelled by user' : e.message, utcNow(), scanId);
    audit(scan.workspace_id, null, cancelled ? 'scan.cancelled' : 'scan.failed', { scanId, error: cancelled ? null : e.message });
  }
}

function safeParse(s) {
  try { return JSON.parse(s || '{}'); } catch { return {}; }
}

// One representative page per distinct content hash (drops template duplicates).
function contentUniquePages(websiteId) {
  return db.prepare(`SELECT * FROM pages WHERE website_id=?
                    AND id IN (SELECT MIN(id) FROM pages WHERE website_id=? GROUP BY content_hash)
                    ORDER BY fetched_at`).all(websiteId, websiteId);
}

function stats() {
  return { active: activeScans, queued: queue.length, max_concurrent: MAX_CONCURRENT_SCANS };
}

module.exports = {
  runScan, enqueueScan, requestCancel, isRunning, isQueued, pairHasActiveScan, stats, contentUniquePages
};
