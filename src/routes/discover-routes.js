'use strict';
const express = require('express');
const db = require('../db');
const discover = require('../discover');
const { requireAuth, requireWorkspace, audit, rateLimit } = require('../auth');
const { newId, utcNow } = require('../util');

const router = express.Router();
router.use(requireAuth);

const createLimiter = rateLimit({ limit: 5, windowMs: 10 * 60 * 1000, bucket: 'discovery-create' });

function serializeDiscovery(d) {
  return {
    id: d.id,
    original_website_id: d.original_website_id,
    status: d.status,
    running: discover.isRunning(d.id),
    provider: d.provider,
    queries: safeParse(d.queries),
    found_hosts: safeParse(d.found_hosts),
    created_scan_count: d.created_scan_count,
    error: d.error,
    created_at: d.created_at,
    finished_at: d.finished_at,
    search_available: Boolean(process.env.SERPER_API_KEY)
  };
}

function safeParse(s) { try { return JSON.parse(s || 'null'); } catch { return null; } }

// Start an auto-discovery run: searches the web for the original site's
// content and queues a scan for every foreign site found.
router.post('/workspaces/:workspaceId/discover', requireWorkspace(), createLimiter, (req, res) => {
  const { original_website_id } = req.body || {};
  const orig = db.prepare('SELECT * FROM websites WHERE id=? AND workspace_id=?').get(original_website_id, req.workspace.id);
  if (!orig || orig.kind !== 'original') return res.status(404).json({ error: 'Original website not found in this workspace.' });
  if (orig.status === 'paused') return res.status(400).json({ error: 'The original website is paused. Resume it first.' });

  const active = db.prepare(`SELECT id FROM discoveries WHERE original_website_id=? AND status IN ('queued','running')`).get(orig.id);
  if (active) return res.status(409).json({ error: 'A discovery run for this website is already running.', discovery_id: active.id });

  const id = newId('dsc');
  const now = utcNow();
  db.prepare(`INSERT INTO discoveries (id, workspace_id, original_website_id, status, created_by, created_at, updated_at)
              VALUES (?,?,?, 'queued', ?, ?, ?)`)
    .run(id, req.workspace.id, orig.id, req.user.id, now, now);
  audit(req.workspace.id, req.user.id, 'discovery.created', { id, original_website_id: orig.id });
  discover.enqueueDiscovery(id);
  res.status(202).json({ discovery: { id, status: 'queued' } });
});

// List recent discovery runs
router.get('/workspaces/:workspaceId/discoveries', requireWorkspace(), (req, res) => {
  const rows = db.prepare(`SELECT * FROM discoveries WHERE workspace_id=? ORDER BY created_at DESC LIMIT 20`).all(req.workspace.id);
  res.json({ discoveries: rows.map(serializeDiscovery), search_available: Boolean(process.env.SERPER_API_KEY) });
});

// Poll one run
router.get('/workspaces/:workspaceId/discoveries/:id', requireWorkspace(), (req, res) => {
  const d = db.prepare('SELECT * FROM discoveries WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!d) return res.status(404).json({ error: 'Discovery run not found.' });
  res.json({ discovery: serializeDiscovery(d) });
});

module.exports = router;
