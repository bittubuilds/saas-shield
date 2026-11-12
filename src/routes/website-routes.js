'use strict';
const express = require('express');
const db = require('../db/index');
const { newId, utcNow } = require('../util');
const { requireAuth, requireWorkspace, audit, rateLimit } = require('../auth');
const { domainOf, parseHttpUrl, UnsafeUrlError, normalizeUrl } = require('../ssrf');
const initialScan = require('../initialscan');

const router = express.Router();
router.use(requireAuth);

const KINdS = ['original', 'comparison'];

function serializeSite(w) {
  return {
    id: w.id,
    kind: w.kind,
    url: w.submitted_url,
    domain: w.normalized_domain,
    label: w.label || null,
    status: w.status,
    crawl_status: w.crawl_status,
    crawl_error: w.crawl_error,
    accessible_page_count: w.accessible_page_count,
    last_scanned_at: w.last_scanned_at,
    created_at: w.created_at,
    archived_at: w.archived_at || null
  };
}

// Validate and normalize a submitted website URL. Rejects unsafe/internal URLs
// (private IPs, weird schemes, disallowed ports) before anything is stored.
function validateWebsiteUrl(raw) {
  const u = parseHttpUrl(raw);          // throws UnsafeUrlError
  return {
    submittedUrl: u.toString(),
    domain: domainOf(u.toString())
  };
}

// List websites for workspace
router.get('/workspaces/:workspaceId/websites', requireWorkspace(), (req, res) => {
  // Removing a site archives it: the row, its scans and its reports stay readable,
  // it simply stops appearing in the dashboard. ?include_archived=1 shows them again.
  const includeArchived = String(req.query.include_archived || '') === '1';
  const rows = includeArchived
    ? db.prepare('SELECT * FROM websites WHERE workspace_id=? ORDER BY created_at DESC').all(req.workspace.id)
    : db.prepare('SELECT * FROM websites WHERE workspace_id=? AND archived_at IS NULL ORDER BY created_at DESC').all(req.workspace.id);
  res.json({ websites: rows.map(serializeSite) });
});

// Add website
router.post('/workspaces/:workspaceId/websites', requireWorkspace(), rateLimit({ limit: 30, windowMs: 60 * 1000, bucket: 'site-create' }), (req, res) => {
  const { url, kind, label } = req.body || {};
  if (!KINdS.includes(kind)) return res.status(400).json({ error: 'kind must be "original" or "comparison".' });
  let parsed;
  try {
    parsed = validateWebsiteUrl(url);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  // Only one "original" per workspace by design; multiple comparisons allowed.
  if (kind === 'original') {
    const existingOriginal = db.prepare(`SELECT id FROM websites WHERE workspace_id=? AND kind='original' AND status != 'paused' AND archived_at IS NULL`).get(req.workspace.id);
    if (existingOriginal) return res.status(409).json({ error: 'This workspace already has an original website. Pause or remove it first.' });
  }

  const dup = db.prepare('SELECT id FROM websites WHERE workspace_id=? AND kind=? AND normalized_domain=? AND archived_at IS NULL').get(req.workspace.id, kind, parsed.domain);
  if (dup) return res.status(409).json({ error: `This ${kind} website is already registered.` });

  // Re-adding a site the user removed restores the archived row instead of
  // refusing the URL: the pages, scans and reports already point at it, and a
  // second row for the same domain would split that history in half.
  const archivedSame = db.prepare(
    `SELECT * FROM websites WHERE workspace_id=? AND kind=? AND normalized_domain=? AND archived_at IS NOT NULL
     ORDER BY created_at DESC LIMIT 1`).get(req.workspace.id, kind, parsed.domain);
  if (archivedSame) {
    db.prepare('UPDATE websites SET archived_at=NULL, status=?, submitted_url=?, label=?, updated_at=? WHERE id=?')
      .run('active', parsed.submittedUrl, label || archivedSame.label || null, utcNow(), archivedSame.id);
    audit(req.workspace.id, req.user.id, 'website.restored', { id: archivedSame.id, url: parsed.submittedUrl });
    // A restored site should behave like a new one: its old pages may be empty
    // shells, so run the same initial-scan decision instead of leaving the user
    // on a scan screen that can never progress.
    let initial = { mode: 'restored', started: false };
    if (req.body && req.body.auto_scan !== false) {
      try {
        initial = initialScan.start({ workspaceId: req.workspace.id, siteId: archivedSame.id, userId: req.user.id });
      } catch (e) {
        initial = { mode: 'error', started: false, message: 'The automatic scan could not be started.' };
      }
    }
    return res.status(200).json({
      website: serializeSite(db.prepare('SELECT * FROM websites WHERE id=?').get(archivedSame.id)),
      restored: true,
      initial_scan: initial
    });
  }

  // A competitor that normalises to the site you are checking would pair a site
  // with itself, which can only produce noise. Refuse it at creation.
  if (kind === 'comparison') {
    const original = db.prepare(`SELECT normalized_domain FROM websites WHERE workspace_id=? AND kind='original' AND status!='paused' AND archived_at IS NULL`).get(req.workspace.id);
    if (original && original.normalized_domain === parsed.domain) {
      return res.status(409).json({ error: 'That is the same site you are checking. Add the other website you want to compare against.' });
    }
  }

  const id = newId('web');
  const now = utcNow();
  db.prepare(`INSERT INTO websites (id, workspace_id, kind, submitted_url, normalized_domain, label, status, crawl_status, created_at, updated_at)
              VALUES (?,?,?,?,?,?, 'pending','not_crawled',?,?)`)
    .run(id, req.workspace.id, kind, parsed.submittedUrl, parsed.domain, label || null, now, now);
  audit(req.workspace.id, req.user.id, 'website.added', { id, kind, url: parsed.submittedUrl });
  const row = db.prepare('SELECT * FROM websites WHERE id=?').get(id);

  // The free product is one scan per website: start the automatic next step now
  // (compare against a known competitor, or discover one) unless the caller opts
  // out. This is deliberately one-shot - nothing here schedules repeats.
  let initial = null;
  if ((req.body || {}).auto_scan !== false) {
    try {
      initial = initialScan.start({ workspaceId: req.workspace.id, siteId: id, userId: req.user.id });
      audit(req.workspace.id, req.user.id, 'website.initial_scan', {
        id, mode: initial.mode, started: initial.started,
        scan_id: initial.scan_id || null, discovery_id: initial.discovery_id || null
      });
    } catch (e) {
      initial = { mode: 'error', started: false, message: 'The automatic scan could not be started. Open the website and start a scan from there.' };
    }
  }

  res.status(201).json({ website: serializeSite(row), initial_scan: initial });
});

// Live status of the one-time initial scan for a website. Every field is read
// back from what the jobs actually wrote - pages, scans, results.
router.get('/workspaces/:workspaceId/websites/:id/initial-scan', requireWorkspace(), (req, res) => {
  let out = initialScan.status(req.workspace.id, req.params.id);
  if (!out) return res.status(404).json({ error: 'Website not found.' });

  // A scan that says 'queued' while no worker in this process holds it was lost to a
  // restart: hand it back to the queue now instead of waiting for the next boot or
  // the stale window. Only a never-started row is touched, so nothing runs twice.
  if (out.scan && out.scan.status === 'queued' && !out.scan.started_at && !out.scan.worker) {
    try {
      require('../scanner').enqueueScan(out.scan.id);
      out = initialScan.status(req.workspace.id, req.params.id) || out;
    } catch (e) {
      console.error('[initial-scan] could not resume a queued scan:', e.message);
    }
  }

  // Self-healing poll. A workspace can sit on "needs a comparison site" for
  // reasons the user cannot fix from this screen: the website was added before
  // rendering or search worked, so nothing was ever started. When nothing is
  // running and no comparison exists, take the decision again - initialScan.start()
  // is guarded, so repeated polls cannot stack scans or discovery jobs.
  const idle = !out.scan && !out.discovery && !(out.comparison && out.comparison.available) && !out.done;
  if (idle && req.query.auto !== '0') {
    try {
      const started = initialScan.start({ workspaceId: req.workspace.id, siteId: req.params.id, userId: req.user.id });
      if (started && started.started) out = initialScan.status(req.workspace.id, req.params.id) || out;
    } catch (e) {
      console.error('[initial-scan] automatic start failed:', e.message);
    }
  }
  res.json(out);
});

// Update (rename/pause/resume/label)
router.patch('/workspaces/:workspaceId/websites/:id', requireWorkspace(), (req, res) => {
  const w = db.prepare('SELECT * FROM websites WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!w) return res.status(404).json({ error: 'Website not found.' });
  const { label, status, url } = req.body || {};
  let newStatus = w.status;
  if (status !== undefined) {
    if (!['active', 'paused'].includes(status)) return res.status(400).json({ error: 'status must be "active" or "paused".' });
    newStatus = status;
  }
  let newUrl = w.submitted_url;
  let newDomain = w.normalized_domain;
  if (url !== undefined) {
    let parsed;
    try {
      parsed = validateWebsiteUrl(url);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    newUrl = parsed.submittedUrl;
    newDomain = parsed.domain;
  }
  const newLabel = label !== undefined ? (label || null) : w.label;
  db.prepare('UPDATE websites SET label=?, status=?, submitted_url=?, normalized_domain=?, updated_at=? WHERE id=?')
    .run(newLabel, newStatus, newUrl, newDomain, utcNow(), w.id);
  audit(req.workspace.id, req.user.id, 'website.updated', { id: w.id, status: newStatus });
  res.json({ website: serializeSite(db.prepare('SELECT * FROM websites WHERE id=?').get(w.id)) });
});

// Remove website from the dashboard.
//
// This is deliberately an archive, not a DELETE: the site stops being scanned and
// disappears from the list, but its scans, findings and reports stay readable.
// Destroying evidence a report already cited would break historical reports.
router.delete('/workspaces/:workspaceId/websites/:id', requireWorkspace(), (req, res) => {
  const w = db.prepare('SELECT * FROM websites WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!w) return res.status(404).json({ error: 'Website not found.' });
  if (!w.archived_at) {
    db.prepare("UPDATE websites SET archived_at=?, monitor_enabled=0, updated_at=? WHERE id=? AND workspace_id=?")
      .run(utcNow(), utcNow(), w.id, req.workspace.id);
    audit(req.workspace.id, req.user.id, 'website.archived', { id: w.id, url: w.submitted_url });
  }
  res.json({ ok: true, archived: true, website: serializeSite(db.prepare('SELECT * FROM websites WHERE id=?').get(w.id)) });
});

// List crawled pages for a website (monitoring detail)
router.get('/workspaces/:workspaceId/websites/:id/pages', requireWorkspace(), (req, res) => {
  const w = db.prepare('SELECT * FROM websites WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!w) return res.status(404).json({ error: 'Website not found.' });
  const rows = db.prepare(`SELECT id, url, title, content_hash, http_status, fetched_at,
                           LENGTH(text_content) AS text_length
                           FROM pages WHERE website_id=? ORDER BY url`).all(w.id);
  res.json({ pages: rows });
});

module.exports = { router, serializeSite, validateWebsiteUrl };
