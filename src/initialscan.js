'use strict';
// One-time initial scan for a newly added website.
//
// The free product is a single scan per website, not recurring monitoring, so
// this module runs exactly once per add and then gets out of the way. It never
// invents progress: every stage it reports is read back from crawl_status, the
// scans row, or the pages/results rows those jobs wrote.
//
// Comparison sources, in order of preference:
//   1. another website already in the workspace (manual competitor URL)
//   2. the existing discovery job, which searches for overlapping pages and
//      queues a scan per hit - only when a search provider is configured
//   3. nothing: the caller is told comparison is unavailable and why

const db = require('./db/index');
const scanner = require('./scanner');
const discover = require('./discover');
const search = require('./search');
const { newId, utcNow } = require('./util');
const { recoverStaleScans } = require('./scan-recovery');

// Pick a site to compare against: a real comparison site first, then any other
// active site in the workspace. Paused sites are skipped - the scan route would
// reject them anyway.
function pickComparison(workspaceId, excludeId, excludeDomain) {
  return db.prepare(`
    SELECT id, submitted_url FROM websites
    WHERE workspace_id=? AND id!=? AND status!='paused' AND archived_at IS NULL
      AND normalized_domain != COALESCE(?, '')
    ORDER BY (kind='comparison') DESC, created_at ASC
    LIMIT 1`).get(workspaceId, excludeId, excludeDomain || '');
}

function queueScan(workspaceId, originalId, comparisonId, userId) {
  const id = newId('scn');
  const params = JSON.stringify({ recrawl: false });
  const now = utcNow();
  // INSERT ... SELECT ... WHERE NOT EXISTS is one atomic statement in both SQLite
  // and PostgreSQL, so two concurrent requests cannot both create the free scan.
  const res = db.prepare(`INSERT INTO scans (id, workspace_id, original_website_id, comparison_website_id, status, params, created_by, created_at)
    SELECT ?,?,?,?, 'queued', ?, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM scans
      WHERE workspace_id=? AND (original_website_id=? OR comparison_website_id=?)
        AND (status IN ('queued','running')
             OR (status='completed' AND COALESCE(pages_compared,0) > 0))
    )`).run(id, workspaceId, originalId, comparisonId, params, userId, now,
    workspaceId, originalId, originalId);
  if (!res || res.changes < 1) return null;
  scanner.enqueueScan(id);
  return id;
}

function queueDiscovery(workspaceId, originalId, userId) {
  // The progress screen polls, and this decision runs on every poll. Reuse a live
  // attempt, or one from the last ten minutes, so a page refresh cannot stack
  // discovery jobs against the same search quota.
  // A run that already failed must not block the next attempt for ten minutes: the
  // reason it failed (no browser, no readable page, a dead key) is often fixed a
  // moment later, and the user is looking at the screen waiting for progress. Only
  // live runs, and successes, are reused for the longer window; a failure may be
  // retried after a short pause so a broken state cannot hammer the search quota.
  const recent = db.prepare(`SELECT id, status FROM discoveries
      WHERE workspace_id=? AND original_website_id=?
        AND (status IN ('queued','running')
             OR (status='completed' AND created_at >= ?)
             OR (status='failed' AND created_at >= ?))
      ORDER BY created_at DESC LIMIT 1`)
    .get(workspaceId, originalId,
      new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      new Date(Date.now() - 45 * 1000).toISOString());
  if (recent) return recent.id;

  const id = newId('dsc');
  const now = utcNow();
  db.prepare(`INSERT INTO discoveries (id, workspace_id, original_website_id, status, created_by, created_at, updated_at)
              VALUES (?,?,?, 'queued', ?, ?, ?)`)
    .run(id, workspaceId, originalId, userId, now, now);
  discover.enqueueDiscovery(id);
  return id;
}

// Decide what the automatic next step is and start it. Returns a description of
// what was actually started, so the UI can say something true immediately.
function start({ workspaceId, siteId, userId }) {
  // An orphaned scan from a crashed process must not eat the one free scan.
  try { recoverStaleScans(); } catch (e) { console.error('[initialscan] recovery failed:', e.message); }
  const site = db.prepare('SELECT * FROM websites WHERE id=? AND workspace_id=?').get(siteId, workspaceId);
  if (!site) return { mode: 'missing', started: false };
  if (site.status === 'paused') {
    return { mode: 'paused', started: false, message: 'This website is paused, so no scan was started.' };
  }

  // Every scan needs the user's own site on one side. If the site just added is a
  // competitor, the original is the thing it gets compared against.
  const original = site.kind === 'original'
    ? site
    : db.prepare(`SELECT * FROM websites WHERE workspace_id=? AND kind='original' AND status!='paused' AND archived_at IS NULL ORDER BY created_at ASC LIMIT 1`).get(workspaceId);

  if (!original) {
    return {
      mode: 'needs_comparison', started: false,
      message: 'Add your own website first. Scans compare it against the site you want to check.'
    };
  }

  // The free plan is a single scan per website, so an original that has already
  // been scanned - running or finished - never triggers another automatically.
  // Only a live or finished scan counts as "already used". A failed or cancelled
  // scan must not burn the free scan, otherwise one bad competitor URL would lock
  // the user out of their own website forever.
  const priorScan = db.prepare(`
    SELECT id, status, pages_compared FROM scans
    WHERE workspace_id=? AND (original_website_id=? OR comparison_website_id=?)
      AND status IN ('queued','running','completed')
    ORDER BY created_at ASC`).all(workspaceId, original.id, original.id)
    // A scan that finished having compared zero pages is evidence of a broken
    // crawl, not of original copy: it must not count as the website's scan, or the
    // workspace stays stuck on a result that proves nothing.
    .find((row) => row.status !== 'completed' || Number(row.pages_compared || 0) > 0);
  if (priorScan) {
    return {
      mode: 'already_scanned', started: false, scan_id: priorScan.id,
      message: 'This website has already had its free scan. Open Findings to review it, or start another scan yourself.'
    };
  }

  // A pair always needs two different sites. Adding your own site means pairing it
  // with a site already registered; adding a competitor means pairing that new site
  // with your own.
  const comparison = site.kind === 'original'
    ? pickComparison(workspaceId, site.id, original.normalized_domain)
    : site;

  if (site.kind === 'comparison' && site.normalized_domain === original.normalized_domain) {
    return {
      mode: 'same_site', started: false,
      message: 'That is the same site as the one you are checking, so it was registered but no scan was started.'
    };
  }

  if (comparison && comparison.id !== original.id) {
    const active = scanner.pairHasActiveScan(workspaceId, original.id, comparison.id);
    if (active) {
      return { mode: 'scan', started: true, reused: true, scan_id: active, comparison_url: comparison.submitted_url };
    }
    const scanId = queueScan(workspaceId, original.id, comparison.id, userId);
    if (!scanId) {
      // Another request created the free scan between the read and the write.
      const existing = db.prepare(`SELECT id FROM scans WHERE workspace_id=? AND (original_website_id=? OR comparison_website_id=?) ORDER BY created_at ASC LIMIT 1`).get(workspaceId, original.id, original.id);
      return { mode: 'already_scanned', started: false, scan_id: existing ? existing.id : null, message: 'This website already has its scan, so nothing new was started.' };
    }
    return { mode: 'scan', started: true, scan_id: scanId, comparison_url: comparison.submitted_url };
  }

  let searchAvailable = false;
  try { searchAvailable = search.isSearchConfigured(); } catch { searchAvailable = false; }
  if (searchAvailable) {
    const discoveryId = queueDiscovery(workspaceId, original.id, userId);
    return { mode: 'discovery', started: true, discovery_id: discoveryId };
  }

  return {
    mode: 'needs_comparison',
    started: false,
    message: 'Automatic competitor discovery is not available on this deployment, so no comparison has run yet. Add the site you want to check against and the scan starts on its own.'
  };
}

// Read back what has actually happened for one website. The dashboard renders
// these values verbatim - there is no simulated progress anywhere.
function status(workspaceId, siteId) {
  const site = db.prepare('SELECT * FROM websites WHERE id=? AND workspace_id=?').get(siteId, workspaceId);
  if (!site) return null;

  const pages = db.prepare('SELECT COUNT(*) AS n FROM pages WHERE website_id=?').get(site.id).n;
  const scan = db.prepare(`
    SELECT * FROM scans
    WHERE workspace_id=? AND (original_website_id=? OR comparison_website_id=?)
    ORDER BY created_at DESC LIMIT 1`).get(workspaceId, site.id, site.id);
  const findings = scan
    ? db.prepare('SELECT COUNT(*) AS n FROM results WHERE scan_id=?').get(scan.id).n
    : 0;
  const discovery = db.prepare(`
    SELECT id, status, error FROM discoveries
    WHERE workspace_id=? AND original_website_id=?
    ORDER BY created_at DESC LIMIT 1`).get(workspaceId, site.id);
  const competitorCount = db.prepare(`
    SELECT COUNT(*) AS n FROM websites WHERE workspace_id=? AND id!=? AND status!='paused'`)
    .get(workspaceId, site.id).n;

  return {
    website: {
      id: site.id,
      url: site.submitted_url,
      kind: site.kind,
      crawl_status: site.crawl_status,
      crawl_error: site.crawl_error,
      pages_discovered: pages,
      registered: true
    },
    comparison: {
      available: competitorCount > 0,
      competitors_in_workspace: competitorCount
    },
    discovery: discovery ? { id: discovery.id, status: discovery.status, error: discovery.error || null } : null,
    scan: scan ? {
      id: scan.id,
      status: scan.status,
      pages_compared: scan.pages_compared ?? null,
      findings: scan.findings ?? null,
      notice: scan.notice || null,
      error: scan.error || null,
      started_at: scan.started_at || null,
      // True only when this process holds a live worker for the scan. A row that
      // says queued with worker:false is orphaned (restart lost it), not slow.
      worker: scanner.isRunning(scan.id),
      created_at: scan.created_at,
      finished_at: scan.finished_at || null
    } : null,
    findings_total: findings,
    // A completed scan that compared no pages is not an answer: nothing was
    // examined. Reporting it as done is what left the screen frozen at 0% with no
    // way forward, because the self-healing poll only acts when nothing is done.
    empty_scan: !!(scan && scan.status === 'completed' && !(Number(scan.pages_compared || 0) > 0) && !(Number(scan.findings || 0) > 0)),
    done: !!(scan && (
      scan.status === 'failed' || scan.status === 'cancelled' ||
      (scan.status === 'completed' && (Number(scan.pages_compared || 0) > 0 || Number(scan.findings || 0) > 0))
    ))
  };
}

module.exports = { start, status, pickComparison };
