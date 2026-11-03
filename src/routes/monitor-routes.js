'use strict';
const express = require('express');
const db = require('../db/index');
const config = require('../config');
const { requireAuth, requireWorkspace, requireAdminRole, audit, rateLimit } = require('../auth');
const monitor = require('../monitor');

const router = express.Router();
router.use(requireAuth);

const checkLimiter = rateLimit({ limit: 12, windowMs: 5 * 60 * 1000, bucket: 'monitor-check' });

function serializePage(p) {
  return {
    id: p.id,
    website_id: p.website_id,
    url: p.url,
    role: p.role,
    label: p.label,
    enabled: Boolean(p.enabled),
    last_checked_at: p.last_checked_at,
    next_check_at: p.next_check_at,
    last_status: p.last_status,
    last_error: p.last_error,
    last_change_at: p.last_change_at,
    has_baseline: Boolean(p.baseline_snapshot_id),
    created_at: p.created_at
  };
}

// Monitoring overview: which sites are watched, how often, and what is due.
router.get('/workspaces/:workspaceId/monitoring', requireWorkspace(), (req, res) => {
  res.json(monitor.monitoringOverview(req.workspace.id));
});

// Turn monitoring on/off for a website (and pick its frequency).
router.post('/workspaces/:workspaceId/websites/:id/monitor', requireWorkspace(), requireAdminRole, async (req, res, next) => {
  try {
    const { enabled, frequency_hours, roles } = req.body || {};
    const websiteId = req.params.id;
    if (enabled === false) {
      const off = monitor.setMonitoringEnabled({ workspaceId: req.workspace.id, websiteId, enabled: false });
      if (!off.ok) return res.status(off.error === 'website_not_found' ? 404 : 400).json({ error: off.error });
      audit(req.workspace.id, req.user.id, 'monitor.disabled', { websiteId });
      return res.json({ ok: true, enabled: false });
    }

    const result = await monitor.enableMonitoring({
      workspaceId: req.workspace.id,
      websiteId,
      frequencyHours: frequency_hours,
      roles: Array.isArray(roles) ? roles : undefined
    });
    if (!result.ok) {
      const status = result.error === 'website_not_found' ? 404 : 400;
      return res.status(status).json({ error: result.error, allowed: result.allowed });
    }
    if (frequency_hours !== undefined) {
      monitor.setMonitoringEnabled({ workspaceId: req.workspace.id, websiteId, enabled: true, frequencyHours: frequency_hours });
    }
    res.json({
      ok: true,
      enabled: true,
      frequency_hours: result.frequencyHours,
      discovered: result.discovered,
      pages: result.pages.map(serializePage),
      homepage_fetch_error: result.homepageFetchError || null,
      sitemap: result.sitemap || null,
      note: result.note
    });
  } catch (e) {
    next(e);
  }
});

// Monitored pages for one website (or the whole workspace).
router.get('/workspaces/:workspaceId/pages', requireWorkspace(), (req, res) => {
  const websiteId = req.query.website_id || null;
  if (websiteId) {
    const site = db.prepare('SELECT id FROM websites WHERE id=? AND workspace_id=?').get(websiteId, req.workspace.id);
    if (!site) return res.status(404).json({ error: 'Website not found.' });
  }
  res.json({
    pages: monitor.listMonitoredPages(req.workspace.id, websiteId).map((p) => ({
      ...serializePage(p),
      website_url: p.website_url,
      website_kind: p.website_kind,
      website_label: p.website_label
    })),
    roles: monitor.PAGE_ROLES,
    frequencies: config.monitor.frequencies
  });
});

// Add a page to watch.
router.post('/workspaces/:workspaceId/websites/:id/pages', requireWorkspace(), requireAdminRole, (req, res) => {
  const { url, role, label } = req.body || {};
  if (!url) return res.status(400).json({ error: 'A page URL is required.' });
  if (role !== undefined && !monitor.PAGE_ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of ${monitor.PAGE_ROLES.join(', ')}` });
  }
  const result = monitor.addMonitoredPage({
    workspaceId: req.workspace.id,
    websiteId: req.params.id,
    url,
    role,
    label
  });
  if (!result.ok) {
    const messages = {
      website_not_found: 'Website not found in this workspace.',
      invalid_url: 'That page URL is not valid.',
      different_host: 'The page must be on the same host as the website it belongs to.',
      page_limit: `A website can have at most ${config.monitor.maxPagesPerWebsite} monitored pages.`,
      duplicate: 'That page is already monitored.'
    };
    return res.status(result.error === 'website_not_found' ? 404 : 400)
      .json({ error: messages[result.error] || 'Could not add the page.' });
  }
  audit(req.workspace.id, req.user.id, 'monitor.page_added', { pageId: result.page.id, url: result.page.url });
  res.status(201).json({ page: serializePage(result.page) });
});

// Update a page (enable/disable, role, label).
router.patch('/workspaces/:workspaceId/pages/:pageId', requireWorkspace(), requireAdminRole, (req, res) => {
  const page = db.prepare('SELECT * FROM monitored_pages WHERE id=? AND workspace_id=?')
    .get(req.params.pageId, req.workspace.id);
  if (!page) return res.status(404).json({ error: 'Monitored page not found.' });

  const { enabled, role, label } = req.body || {};
  if (role !== undefined && !monitor.PAGE_ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of ${monitor.PAGE_ROLES.join(', ')}` });
  }
  const nextEnabled = enabled === undefined ? page.enabled : (enabled ? 1 : 0);
  const nextRole = role === undefined ? page.role : role;
  const nextLabel = label === undefined ? page.label : (label ? String(label).slice(0, 120) : null);
  const nextCheck = enabled ? new Date().toISOString() : page.next_check_at;

  db.prepare('UPDATE monitored_pages SET enabled=?, role=?, label=?, next_check_at=?, updated_at=? WHERE id=?')
    .run(nextEnabled, nextRole, nextLabel, nextCheck, new Date().toISOString(), page.id);
  audit(req.workspace.id, req.user.id, 'monitor.page_updated', { pageId: page.id, enabled: Boolean(nextEnabled) });
  res.json({ page: serializePage(db.prepare('SELECT * FROM monitored_pages WHERE id=?').get(page.id)) });
});

router.delete('/workspaces/:workspaceId/pages/:pageId', requireWorkspace(), requireAdminRole, (req, res) => {
  const page = db.prepare('SELECT * FROM monitored_pages WHERE id=? AND workspace_id=?')
    .get(req.params.pageId, req.workspace.id);
  if (!page) return res.status(404).json({ error: 'Monitored page not found.' });
  db.prepare('DELETE FROM monitored_pages WHERE id=?').run(page.id);
  audit(req.workspace.id, req.user.id, 'monitor.page_removed', { pageId: page.id, url: page.url });
  res.json({ ok: true });
});

// Check one page now (baseline or re-check).
router.post('/workspaces/:workspaceId/pages/:pageId/check', requireWorkspace(), checkLimiter, async (req, res, next) => {
  try {
    const page = db.prepare('SELECT * FROM monitored_pages WHERE id=? AND workspace_id=?')
      .get(req.params.pageId, req.workspace.id);
    if (!page) return res.status(404).json({ error: 'Monitored page not found.' });
    if (!page.enabled) return res.status(400).json({ error: 'This page is disabled. Enable it first.' });

    const result = await monitor.runPageCheck(page.id, { claim: false });
    audit(req.workspace.id, req.user.id, 'monitor.page_checked', {
      pageId: page.id, status: result.status, changes: (result.changes || []).length
    });
    res.json({ result });
  } catch (e) {
    next(e);
  }
});

// Run all due checks now (admin action; same code path as the scheduler).
router.post('/workspaces/:workspaceId/monitoring/run', requireWorkspace(), requireAdminRole, checkLimiter, async (req, res, next) => {
  try {
    const scheduler = require('../scheduler');
    const result = await scheduler.runTick({ source: 'manual' });
    audit(req.workspace.id, req.user.id, 'monitor.run_now', { checked: result.monitor && result.monitor.checked });
    res.json({ result });
  } catch (e) {
    next(e);
  }
});

// ---------------------------------------------------------------------------
// Changelog
// ---------------------------------------------------------------------------
router.get('/workspaces/:workspaceId/changes', requireWorkspace(), (req, res) => {
  const { website_id, category, status, page_role, since, limit, offset } = req.query;
  const result = monitor.listChanges(req.workspace.id, { website_id, category, status, page_role, since, limit, offset });
  res.json(result);
});

router.get('/workspaces/:workspaceId/changes/:changeId', requireWorkspace(), (req, res) => {
  const detail = monitor.getChange(req.workspace.id, req.params.changeId);
  if (!detail) return res.status(404).json({ error: 'Change not found.' });
  res.json(detail);
});

router.patch('/workspaces/:workspaceId/changes/:changeId', requireWorkspace(), (req, res) => {
  const { status } = req.body || {};
  const result = monitor.setChangeStatus(req.workspace.id, req.params.changeId, { status, userId: req.user.id });
  if (!result.ok) {
    return res.status(result.error === 'not_found' ? 404 : 400)
      .json({ error: result.error === 'not_found' ? 'Change not found.' : 'status must be open, acknowledged or dismissed.' });
  }
  audit(req.workspace.id, req.user.id, 'change.reviewed', { changeId: req.params.changeId, status });
  res.json({ ok: true, status });
});

// One snapshot (used by the compare view).
router.get('/workspaces/:workspaceId/snapshots/:snapshotId', requireWorkspace(), (req, res) => {
  const row = db.prepare('SELECT * FROM snapshots WHERE id=? AND workspace_id=?')
    .get(req.params.snapshotId, req.workspace.id);
  if (!row) return res.status(404).json({ error: 'Snapshot not found.' });
  const snapshot = monitor.hydrateSnapshot(row);
  res.json({
    snapshot: {
      id: snapshot.id,
      final_url: snapshot.final_url,
      fetched_at: snapshot.fetched_at,
      http_status: snapshot.http_status,
      title: snapshot.title,
      capture_status: snapshot.capture_status,
      content_hash: snapshot.content_hash,
      redirect_chain: snapshot.redirect_chain,
      pricing: snapshot.pricing,
      headings: snapshot.headings,
      forms: snapshot.forms,
      word_count: (snapshot.structure && snapshot.structure.wordCount) || 0
    },
    text: snapshot.text_raw
  });
});

module.exports = router;
