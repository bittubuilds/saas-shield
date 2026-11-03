'use strict';
const express = require('express');
const db = require('../db/index');
const config = require('../config');
const email = require('../email');
const alerts = require('../alerts');
const { requireAuth, requireWorkspace, requireAdminRole, audit, rateLimit } = require('../auth');

const router = express.Router();
router.use(requireAuth);

const testLimiter = rateLimit({ limit: 4, windowMs: 10 * 60 * 1000, bucket: 'notify-test' });

router.get('/workspaces/:workspaceId/alerts', requireWorkspace(), (req, res) => {
  const { status, severity, limit, offset } = req.query;
  const result = alerts.listAlerts(req.workspace.id, { status, severity, limit, offset });
  const counts = db.prepare(`SELECT status, COUNT(*) c FROM alerts WHERE workspace_id=? GROUP BY status`)
    .all(req.workspace.id);
  res.json({
    ...result,
    counts: Object.fromEntries(counts.map((r) => [r.status, r.c]))
  });
});

router.patch('/workspaces/:workspaceId/alerts/:alertId', requireWorkspace(), (req, res) => {
  const { status } = req.body || {};
  const result = alerts.setAlertStatus(req.workspace.id, req.params.alertId, status);
  if (!result.ok) {
    return res.status(result.error === 'not_found' ? 404 : 400)
      .json({ error: result.error === 'not_found' ? 'Alert not found.' : 'status must be unread, read or dismissed.' });
  }
  audit(req.workspace.id, req.user.id, 'alert.updated', { alertId: req.params.alertId, status });
  res.json({ ok: true, status });
});

// Bulk "mark all read" for the alert list header.
router.post('/workspaces/:workspaceId/alerts/read-all', requireWorkspace(), (req, res) => {
  const res1 = db.prepare(`UPDATE alerts SET status='read', read_at=? WHERE workspace_id=? AND status='unread'`)
    .run(new Date().toISOString(), req.workspace.id);
  res.json({ ok: true, updated: res1.changes });
});

// ---------------------------------------------------------------------------
// Notification preferences
// ---------------------------------------------------------------------------
function serializeSettings(row) {
  return {
    immediate_email: Boolean(row.immediate_email),
    digest_enabled: Boolean(row.digest_enabled),
    digest_day: row.digest_day,
    digest_hour_utc: row.digest_hour_utc,
    min_severity: row.min_severity,
    include_empty_digest: Boolean(row.include_empty_digest),
    updated_at: row.updated_at
  };
}

router.get('/workspaces/:workspaceId/notifications', requireWorkspace(), (req, res) => {
  const settings = alerts.getSettings(req.workspace.id);
  const recipients = alerts.recipientsForWorkspace(req.workspace.id);
  const nextPeriod = alerts.digestPeriod(settings, new Date());
  const lastDigest = db.prepare('SELECT * FROM digests WHERE workspace_id=? ORDER BY period_key DESC LIMIT 1')
    .get(req.workspace.id);
  res.json({
    settings: serializeSettings(settings),
    email: email.describeConfig(),
    recipients: recipients.map((r) => ({ email: r.email })),
    next_digest: {
      period_key: nextPeriod.periodKey,
      period_start: nextPeriod.start.toISOString(),
      period_end: nextPeriod.end.toISOString()
    },
    last_digest: lastDigest ? {
      period_key: lastDigest.period_key,
      status: lastDigest.status,
      change_count: lastDigest.change_count,
      reason: lastDigest.reason
    } : null,
    delivery_stats: alerts.deliveryStats(req.workspace.id),
    recent_deliveries: alerts.recentDeliveries(req.workspace.id, 15)
  });
});

router.patch('/workspaces/:workspaceId/notifications', requireWorkspace(), requireAdminRole, (req, res) => {
  const patch = req.body || {};
  const result = alerts.updateSettings(req.workspace.id, patch);
  if (!result.ok) return res.status(400).json({ error: result.error });
  audit(req.workspace.id, req.user.id, 'notifications.updated', { settings: serializeSettings(result.settings) });
  res.json({ ok: true, settings: serializeSettings(result.settings) });
});

// Send a real test email to the current user and report exactly what happened.
router.post('/workspaces/:workspaceId/notifications/test', requireWorkspace(), testLimiter, async (req, res) => {
  const result = await email.sendMail({
    to: req.user.email,
    subject: '[SaaS Shield] Test notification',
    text: [
      'This is a test notification from SaaS Shield.',
      '',
      'If you received this, alert delivery is configured correctly for this deployment.',
      '',
      `Workspace: ${req.workspace.name}`,
      `Sent at: ${new Date().toISOString()}`
    ].join('\n')
  });
  audit(req.workspace.id, req.user.id, 'notifications.test', { status: result.status });
  if (result.status === 'sent') {
    return res.json({ ok: true, status: 'sent', provider: result.provider, note: 'Test email accepted by the provider.' });
  }
  const status = result.status === 'skipped' ? 400 : 502;
  return res.status(status).json({
    ok: false,
    status: result.status,
    provider: result.provider || null,
    error: result.error || 'Email could not be sent.',
    remediation: result.status === 'skipped'
      ? { missing: email.describeConfig().missing, docs: 'README: Email provider configuration' }
      : undefined
  });
});

// Run pending deliveries now (useful after fixing an email provider).
router.post('/workspaces/:workspaceId/notifications/flush', requireWorkspace(), requireAdminRole, testLimiter, async (req, res) => {
  const result = await alerts.processDeliveries({ limit: 25 });
  audit(req.workspace.id, req.user.id, 'notifications.flush', { sent: result.sent, failed: result.failed, skipped: result.skipped });
  res.json({ ok: true, result });
});

module.exports = router;
