'use strict';
const express = require('express');
const db = require('../db');
const config = require('../config');
const { newId, utcNow } = require('../util');
const { requireAuth, requireWorkspace, audit, rateLimit } = require('../auth');
const scanner = require('../scanner');

const router = express.Router();
router.use(requireAuth);

const createLimiter = rateLimit({ limit: 10, windowMs: 5 * 60 * 1000, bucket: 'scan-create' });

// Create + enqueue a scan
router.post('/workspaces/:workspaceId/scans', requireWorkspace(), createLimiter, (req, res) => {
  const { original_website_id, comparison_website_id, recrawl, max_pages, max_depth } = req.body || {};
  const orig = db.prepare('SELECT * FROM websites WHERE id=? AND workspace_id=?').get(original_website_id, req.workspace.id);
  const comp = db.prepare('SELECT * FROM websites WHERE id=? AND workspace_id=?').get(comparison_website_id, req.workspace.id);
  if (!orig || !comp) return res.status(404).json({ error: 'Website not found in this workspace.' });
  if (orig.status === 'paused' || comp.status === 'paused') {
    return res.status(400).json({ error: 'Both websites must be active to scan. Resume paused websites first.' });
  }

  const active = scanner.pairHasActiveScan(req.workspace.id, original_website_id, comparison_website_id);
  if (active) {
    return res.status(409).json({ error: 'A scan for this website pair is already running or queued.', scan_id: active });
  }

  const id = newId('scn');
  const params = {
    recrawl: recrawl === true,
    maxPages: clampNum(max_pages, 1, config.crawl.maxPagesPerSite, config.crawl.maxPagesPerSite),
    maxDepth: clampNum(max_depth, 0, config.crawl.maxDepth, config.crawl.maxDepth)
  };
  db.prepare(`INSERT INTO scans (id, workspace_id, original_website_id, comparison_website_id, status, params, created_by, created_at)
              VALUES (?,?,?,?, 'queued', ?, ?, ?)`)
    .run(id, req.workspace.id, original_website_id, comparison_website_id, JSON.stringify(params), req.user.id, utcNow());
  audit(req.workspace.id, req.user.id, 'scan.created', { id, original_website_id, comparison_website_id, params });
  scanner.enqueueScan(id);
  res.status(202).json({ scan: { id, status: 'queued', params } });
});

function clampNum(v, lo, cap, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(n, cap));
}

// List scans
router.get('/workspaces/:workspaceId/scans', requireWorkspace(), (req, res) => {
  const rows = db.prepare(`
    SELECT s.*, wo.submitted_url AS original_url, wc.submitted_url AS comparison_url
    FROM scans s
    JOIN websites wo ON wo.id = s.original_website_id
    JOIN websites wc ON wc.id = s.comparison_website_id
    WHERE s.workspace_id = ? ORDER BY s.created_at DESC LIMIT 100`).all(req.workspace.id);
  res.json({ scans: rows.map((r) => ({ ...r, params: safeParse(r.params) })) });
});

// Poll scan status
router.get('/workspaces/:workspaceId/scans/:id', requireWorkspace(), (req, res) => {
  const s = db.prepare(`SELECT s.*, wo.submitted_url AS original_url, wc.submitted_url AS comparison_url
                        FROM scans s JOIN websites wo ON wo.id=s.original_website_id
                        JOIN websites wc ON wc.id=s.comparison_website_id
                        WHERE s.id=? AND s.workspace_id=?`).get(req.params.id, req.workspace.id);
  if (!s) return res.status(404).json({ error: 'Scan not found.' });
  res.json({ scan: { ...s, params: safeParse(s.params), running: scanner.isRunning(s.id) } });
});

// Cancel
router.post('/workspaces/:workspaceId/scans/:id/cancel', requireWorkspace(), (req, res) => {
  const s = db.prepare('SELECT * FROM scans WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!s) return res.status(404).json({ error: 'Scan not found.' });
  if (!['queued', 'running'].includes(s.status)) return res.status(400).json({ error: 'Scan is not running.' });
  const ok = scanner.requestCancel(s.id);
  res.json({ ok, cancelling: ok });
});

// Retry a failed scan (idempotent: same params, dedupe keeps findings stable)
router.post('/workspaces/:workspaceId/scans/:id/retry', requireWorkspace(), (req, res) => {
  const s = db.prepare('SELECT * FROM scans WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!s) return res.status(404).json({ error: 'Scan not found.' });
  if (['queued', 'running'].includes(s.status)) return res.status(409).json({ error: 'Scan is already active.' });
  const active = scanner.pairHasActiveScan(req.workspace.id, s.original_website_id, s.comparison_website_id);
  if (active) return res.status(409).json({ error: 'Another scan for this pair is already running.', scan_id: active });
  const id = newId('scn');
  db.prepare(`INSERT INTO scans (id, workspace_id, original_website_id, comparison_website_id, status, params, created_by, created_at)
              VALUES (?,?,?,?, 'queued', ?, ?, ?)`)
    .run(id, req.workspace.id, s.original_website_id, s.comparison_website_id, s.params, req.user.id, utcNow());
  scanner.enqueueScan(id);
  res.status(202).json({ scan: { id, status: 'queued' } });
});

function safeParse(s) { try { return JSON.parse(s || '{}'); } catch { return {}; } }

module.exports = router;
