'use strict';
const express = require('express');
const db = require('../db/index');
const { newId, utcNow } = require('../util');
const { requireAuth, requireWorkspace, requireAdminRole, audit } = require('../auth');

const router = express.Router();
router.use(requireAuth);

// Dashboard: real database-backed metrics only.
router.get('/workspaces/:workspaceId/dashboard', requireWorkspace(), (req, res) => {
  const ws = req.workspace.id;
  // A removed site is archived, not deleted, so it must not keep counting here.
  const monitored = db.prepare("SELECT COUNT(*) c FROM websites WHERE workspace_id=? AND status != 'paused' AND archived_at IS NULL").get(ws).c;
  const lastScan = db.prepare("SELECT MAX(finished_at) m FROM scans WHERE workspace_id=? AND status='completed'").get(ws).m;
  const scansCompleted = db.prepare("SELECT COUNT(*) c FROM scans WHERE workspace_id=? AND status='completed'").get(ws).c;
  const scansFailed = db.prepare("SELECT COUNT(*) c FROM scans WHERE workspace_id=? AND status IN ('failed','cancelled')").get(ws).c;
  const needsReview = db.prepare(`SELECT COUNT(*) c FROM results WHERE workspace_id=? AND status IN ('new','in_review')`).get(ws).c;
  const confirmed = db.prepare(`SELECT COUNT(*) c FROM results WHERE workspace_id=? AND status='confirmed'`).get(ws).c;
  const totalFindings = db.prepare('SELECT COUNT(*) c FROM results WHERE workspace_id=?').get(ws).c;

  const recentScans = db.prepare(`
    SELECT s.id, s.status, s.created_at, s.finished_at, s.findings, s.error,
           wo.submitted_url AS original_url, wc.submitted_url AS comparison_url
    FROM scans s JOIN websites wo ON wo.id=s.original_website_id JOIN websites wc ON wc.id=s.comparison_website_id
    WHERE s.workspace_id=? ORDER BY s.created_at DESC LIMIT 6`).all(ws);

  const recentResults = db.prepare(`
    SELECT id, original_url, comparison_url, match_type, jaccard_score, status, last_observed_at
    FROM results WHERE workspace_id=? ORDER BY last_observed_at DESC LIMIT 6`).all(ws);

  const failingSites = db.prepare(`SELECT id, submitted_url, crawl_error FROM websites WHERE workspace_id=? AND crawl_status='failed' LIMIT 5`).all(ws);

  // Monitoring + changelog counters (real rows only).
  const monitoredSites = db.prepare(`SELECT COUNT(*) c FROM websites WHERE workspace_id=? AND monitor_enabled=1`).get(ws).c;
  const monitoredPages = db.prepare('SELECT COUNT(*) c FROM monitored_pages WHERE workspace_id=? AND enabled=1').get(ws).c;
  const changes7d = db.prepare('SELECT COUNT(*) c FROM changes WHERE workspace_id=? AND detected_at >= ?')
    .get(ws, new Date(Date.now() - 7 * 86400000).toISOString()).c;
  const changesOpen = db.prepare("SELECT COUNT(*) c FROM changes WHERE workspace_id=? AND status='open'").get(ws).c;
  const unreadAlerts = db.prepare("SELECT COUNT(*) c FROM alerts WHERE workspace_id=? AND status='unread'").get(ws).c;
  const failingPages = db.prepare("SELECT COUNT(*) c FROM monitored_pages WHERE workspace_id=? AND last_status='failed'").get(ws).c;
  const nextCheck = db.prepare(`SELECT MIN(p.next_check_at) m FROM monitored_pages p JOIN websites w ON w.id=p.website_id
      WHERE p.workspace_id=? AND p.enabled=1 AND w.monitor_enabled=1`).get(ws).m;

  const recentChanges = db.prepare(`
    SELECT c.id, c.category, c.summary, c.detected_at, c.significance_label, c.page_url, c.status,
           w.submitted_url AS website_url
    FROM changes c JOIN websites w ON w.id=c.website_id
    WHERE c.workspace_id=? ORDER BY c.detected_at DESC LIMIT 6`).all(ws);

  res.json({
    monitored_websites: monitored,
    last_successful_scan: lastScan,
    scans_completed: scansCompleted,
    scans_failed: scansFailed,
    findings_needing_review: needsReview,
    findings_confirmed: confirmed,
    findings_total: totalFindings,
    recent_scans: recentScans,
    recent_results: recentResults,
    failing_websites: failingSites,
    monitored_websites_count: monitoredSites,
    monitored_pages: monitoredPages,
    changes_last_7_days: changes7d,
    changes_open: changesOpen,
    alerts_unread: unreadAlerts,
    failing_monitored_pages: failingPages,
    next_check_at: nextCheck,
    recent_changes: recentChanges
  });
});

// Settings: workspace profile
router.get('/workspaces/:workspaceId/settings', requireWorkspace(), (req, res) => {
  const members = db.prepare(`
    SELECT m.user_id, m.role, m.created_at, u.email
    FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.workspace_id=? ORDER BY m.created_at`).all(req.workspace.id);
  const alerts = require('../alerts');
  const email = require('../email');
  const notificationSettings = alerts.getSettings(req.workspace.id);
  res.json({
    workspace: { id: req.workspace.id, name: req.workspace.name, role: req.workspace.role },
    members,
    notifications: {
      immediate_email: Boolean(notificationSettings.immediate_email),
      digest_enabled: Boolean(notificationSettings.digest_enabled),
      digest_day: notificationSettings.digest_day,
      digest_hour_utc: notificationSettings.digest_hour_utc,
      min_severity: notificationSettings.min_severity,
      include_empty_digest: Boolean(notificationSettings.include_empty_digest)
    },
    email: email.describeConfig(),
    note: 'Notification preferences are stored server-side and applied by the scheduler. Email delivery depends on the configured provider.'
  });
});

router.patch('/workspaces/:workspaceId/settings', requireWorkspace(), requireAdminRole, (req, res) => {
  const { name, notifications } = req.body || {};
  if (name !== undefined) {
    const clean = String(name).trim().slice(0, 80);
    if (!clean) return res.status(400).json({ error: 'Workspace name cannot be empty.' });
    db.prepare('UPDATE workspaces SET name=? WHERE id=?').run(clean, req.workspace.id);
    audit(req.workspace.id, req.user.id, 'workspace.renamed', { name: clean });
  }
  res.json({ ok: true });
});

// Invite/add member by email (must already have an account) - admin only.
router.post('/workspaces/:workspaceId/members', requireWorkspace(), requireAdminRole, (req, res) => {
  const { email, role } = req.body || {};
  if (!['admin', 'member'].includes(role)) return res.status(400).json({ error: 'role must be "admin" or "member".' });
  const user = db.prepare('SELECT id FROM users WHERE email=?').get(String(email || '').trim().toLowerCase());
  if (!user) return res.status(404).json({ error: 'No SaaS Shield account exists for that email yet.' });
  const existing = db.prepare('SELECT user_id FROM memberships WHERE workspace_id=? AND user_id=?').get(req.workspace.id, user.id);
  if (existing) return res.status(409).json({ error: 'User is already a member.' });
  db.prepare('INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?,?,?,?)')
    .run(req.workspace.id, user.id, role, utcNow());
  audit(req.workspace.id, req.user.id, 'member.added', { member: user.id, role });
  res.status(201).json({ ok: true });
});

router.delete('/workspaces/:workspaceId/members/:userId', requireWorkspace(), requireAdminRole, (req, res) => {
  const m = db.prepare('SELECT * FROM memberships WHERE workspace_id=? AND user_id=?').get(req.workspace.id, req.params.userId);
  if (!m) return res.status(404).json({ error: 'Member not found.' });
  if (m.role === 'owner') return res.status(400).json({ error: 'The workspace owner cannot be removed.' });
  db.prepare('DELETE FROM memberships WHERE workspace_id=? AND user_id=?').run(req.workspace.id, req.params.userId);
  audit(req.workspace.id, req.user.id, 'member.removed', { member: req.params.userId });
  res.json({ ok: true });
});

module.exports = router;
