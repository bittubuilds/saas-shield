'use strict';
// Actionable alerts on top of the changelog.
//
// - Every alert is evidence-backed: it points at a persisted change row, which
//   points at two persisted snapshots.
// - Deduplication happens twice: one alert per change (UNIQUE change_id) and
//   one delivery per (channel, recipient, alert).
// - Delivery failures are recorded and retried on a bounded ladder. Nothing is
//   retried forever, and nothing is ever reported as sent when it was skipped.
const db = require('./db/index');
const config = require('./config');
const email = require('./email');
const normalize = require('./normalize');
const { newId, utcNow } = require('./util');

const SEVERITY_RANK = { info: 0, normal: 1, high: 2, critical: 3 };
const CATEGORY_LABELS = {
  pricing: 'Pricing', signup: 'Signup flow', headings: 'Headings', copy: 'Page copy',
  sections: 'Page sections', links: 'Links', cta: 'Calls to action', images: 'Images',
  title: 'Page title', meta: 'Meta description', other: 'Other'
};

function severityForSignificance(significance) {
  if (significance >= 0.8) return 'critical';
  if (significance >= 0.5) return 'high';
  if (significance >= 0.25) return 'normal';
  return 'info';
}

function getSettings(wsId) {
  const row = db.prepare('SELECT * FROM notification_settings WHERE workspace_id=?').get(wsId);
  if (row) return row;
  const now = utcNow();
  db.prepare(`INSERT INTO notification_settings
    (workspace_id, immediate_email, digest_enabled, digest_day, digest_hour_utc, min_severity, include_empty_digest, updated_at)
    VALUES (?,1,1,?,?, 'high',0,?)`)
    .run(wsId, config.alerts.defaultDigestDay, config.alerts.defaultDigestHourUtc, now);
  return db.prepare('SELECT * FROM notification_settings WHERE workspace_id=?').get(wsId);
}

function updateSettings(wsId, patch) {
  const current = getSettings(wsId);
  const allowedDays = [0, 1, 2, 3, 4, 5, 6];
  const next = {
    immediate_email: patch.immediate_email === undefined ? current.immediate_email : (patch.immediate_email ? 1 : 0),
    digest_enabled: patch.digest_enabled === undefined ? current.digest_enabled : (patch.digest_enabled ? 1 : 0),
    digest_day: patch.digest_day === undefined ? current.digest_day : Number(patch.digest_day),
    digest_hour_utc: patch.digest_hour_utc === undefined ? current.digest_hour_utc : Number(patch.digest_hour_utc),
    min_severity: patch.min_severity === undefined ? current.min_severity : String(patch.min_severity),
    include_empty_digest: patch.include_empty_digest === undefined ? current.include_empty_digest : (patch.include_empty_digest ? 1 : 0)
  };
  if (!allowedDays.includes(next.digest_day)) return { ok: false, error: 'digest_day must be 0-6 (0 = Sunday)' };
  if (!Number.isInteger(next.digest_hour_utc) || next.digest_hour_utc < 0 || next.digest_hour_utc > 23) {
    return { ok: false, error: 'digest_hour_utc must be 0-23' };
  }
  if (!Object.keys(SEVERITY_RANK).includes(next.min_severity)) {
    return { ok: false, error: 'min_severity must be one of info, normal, high, critical' };
  }
  db.prepare(`UPDATE notification_settings SET immediate_email=?, digest_enabled=?, digest_day=?,
              digest_hour_utc=?, min_severity=?, include_empty_digest=?, updated_at=? WHERE workspace_id=?`)
    .run(next.immediate_email, next.digest_enabled, next.digest_day, next.digest_hour_utc,
      next.min_severity, next.include_empty_digest, utcNow(), wsId);
  return { ok: true, settings: getSettings(wsId) };
}

// Workspace owners and admins with a confirmed address are the only recipients.
function recipientsForWorkspace(wsId) {
  return db.prepare(`
    SELECT u.id, u.email FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.workspace_id = ? AND m.role IN ('owner','admin')
      AND u.email_verified_at IS NOT NULL
    ORDER BY m.role = 'owner' DESC, u.created_at`).all(wsId);
}

function changeLink(changeId) {
  return `${config.publicBaseUrl}/app#/changes/${changeId}`;
}

/**
 * Create the alert row for a change and queue immediate email deliveries when
 * the workspace asks for them. Returns the alert, or null when it already
 * existed (dedupe) or when the change is below the notification threshold.
 */
function raiseAlertForChange({ change, page, website, now = new Date() }) {
  if (!change) return null;
  const settings = getSettings(change.workspace_id);
  const severity = severityForSignificance(change.significance);
  const siteLabel = website && (website.label || website.submitted_url) || change.page_url;
  const categoryLabel = CATEGORY_LABELS[change.category] || change.category;

  const title = `${siteLabel}: ${categoryLabel.toLowerCase()} change${page && page.role ? ` on ${page.role} page` : ''}`;
  const body = change.summary;

  const alertId = newId('alr');
  const inserted = db.prepare(`INSERT INTO alerts
      (id, workspace_id, change_id, website_id, severity, title, body, status, dedupe_key, created_at)
      VALUES (?,?,?,?,?,?,?, 'unread', ?, ?)
      ON CONFLICT (change_id) DO NOTHING`)
    .run(alertId, change.workspace_id, change.id, change.website_id, severity,
      title.slice(0, 300), String(body).slice(0, 1000), `change:${change.id}`, now.toISOString());

  if (!inserted.changes) return null;   // duplicate alert for the same change

  // Queue immediate email only when enabled and the severity clears the bar.
  // 'info' changes stay in the changelog and wait for the digest.
  if (settings.immediate_email && SEVERITY_RANK[severity] >= SEVERITY_RANK[settings.min_severity]) {
    for (const recipient of recipientsForWorkspace(change.workspace_id)) {
      queueDelivery({
        workspaceId: change.workspace_id,
        alertId,
        recipient: recipient.email,
        now
      });
    }
  }

  return db.prepare('SELECT * FROM alerts WHERE id=?').get(alertId);
}

function queueDelivery({ workspaceId, alertId = null, digestId = null, recipient, now = new Date() }) {
  const id = newId('dlv');
  const res = db.prepare(`INSERT INTO alert_deliveries
      (id, workspace_id, alert_id, digest_id, channel, recipient, status, attempts, next_attempt_at,
       last_error, provider, provider_message_id, created_at, updated_at, sent_at)
      VALUES (?,?,?,?, 'email', ?, 'pending', 0, NULL, NULL, NULL, NULL, ?, ?, NULL)
      ON CONFLICT DO NOTHING`)
    .run(id, workspaceId, alertId, digestId, String(recipient).toLowerCase(), now.toISOString(), now.toISOString());
  return res.changes ? id : null;
}

function buildAlertEmail({ alert, change, workspace }) {
  const siteLine = change.page_url;
  const lines = [
    `${alert.title}`,
    '',
    change.summary,
    '',
    `Page: ${siteLine}`,
    `Detected: ${change.detected_at.replace('T', ' ').replace('Z', ' UTC')}`,
    `Confidence: ${change.confidence} · Significance: ${change.significance_label}`,
    '',
    `Open the changelog entry: ${changeLink(change.id)}`
  ];
  if (change.previous_value) {
    lines.push('', 'Before:', normalize.clip(change.previous_value, 700));
  }
  if (change.current_value) {
    lines.push('', 'After:', normalize.clip(change.current_value, 700));
  }
  lines.push('', 'This alert describes an observed difference between two saved snapshots of a public page. It is not a legal conclusion.');
  const text = lines.join('\n');
  return {
    to: null,
    subject: `[${workspace ? workspace.name : 'SaaS Shield'}] ${alert.title}`.slice(0, 200),
    text,
    html: email.textToHtml(text)
  };
}

// ---------------------------------------------------------------------------
// Delivery processing (bounded retries)
// ---------------------------------------------------------------------------
function nextRetryAt(attempts, now) {
  const ladder = config.alerts.retryDelaysMinutes;
  if (attempts > ladder.length) return null;    // exhausted
  const minutes = ladder[Math.min(attempts - 1, ladder.length - 1)];
  return new Date(now.getTime() + minutes * 60 * 1000).toISOString();
}

async function processDeliveries({ limit = 25, now = new Date() } = {}) {
  const rows = db.prepare(`SELECT d.*, a.title AS alert_title, a.severity, a.change_id
      FROM alert_deliveries d LEFT JOIN alerts a ON a.id = d.alert_id
      WHERE d.status IN ('pending','failed')
        AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ?)
        AND d.attempts < ?
      ORDER BY d.created_at ASC LIMIT ?`)
    .all(now.toISOString(), config.alerts.retryDelaysMinutes.length + 1, limit);

  const summary = { processed: 0, sent: 0, failed: 0, skipped: 0, results: [] };

  for (const delivery of rows) {
    summary.processed++;
    let message;

    if (delivery.alert_id) {
      const alert = db.prepare('SELECT * FROM alerts WHERE id=?').get(delivery.alert_id);
      const change = alert ? db.prepare('SELECT * FROM changes WHERE id=?').get(alert.change_id) : null;
      if (!alert || !change) {
        db.prepare(`UPDATE alert_deliveries SET status='skipped', last_error=?, updated_at=? WHERE id=?`)
          .run('alert or change no longer exists', now.toISOString(), delivery.id);
        summary.skipped++;
        continue;
      }
      if (alert.status === 'dismissed') {
        db.prepare(`UPDATE alert_deliveries SET status='skipped', last_error=?, updated_at=? WHERE id=?`)
          .run('alert dismissed by a user', now.toISOString(), delivery.id);
        summary.skipped++;
        continue;
      }
      const workspace = db.prepare('SELECT * FROM workspaces WHERE id=?').get(delivery.workspace_id);
      message = buildAlertEmail({ alert, change, workspace });
    } else if (delivery.digest_id) {
      const digestRow = db.prepare('SELECT * FROM digests WHERE id=?').get(delivery.digest_id);
      if (!digestRow) {
        db.prepare(`UPDATE alert_deliveries SET status='skipped', last_error=?, updated_at=? WHERE id=?`)
          .run('digest no longer exists', now.toISOString(), delivery.id);
        summary.skipped++;
        continue;
      }
      message = buildDigestEmail(digestRow);
    } else {
      db.prepare(`UPDATE alert_deliveries SET status='skipped', last_error=?, updated_at=? WHERE id=?`)
        .run('delivery has no alert or digest', now.toISOString(), delivery.id);
      summary.skipped++;
      continue;
    }

    message.to = delivery.recipient;
    const result = await email.sendMail(message);
    const attempts = delivery.attempts + 1;

    if (result.status === 'sent') {
      db.prepare(`UPDATE alert_deliveries SET status='sent', attempts=?, provider=?, provider_message_id=?,
                  last_error=NULL, next_attempt_at=NULL, sent_at=?, updated_at=? WHERE id=?`)
        .run(attempts, result.provider, result.messageId || null, now.toISOString(), now.toISOString(), delivery.id);
      summary.sent++;
      summary.results.push({ id: delivery.id, status: 'sent', to: delivery.recipient, provider: result.provider });
    } else if (result.status === 'skipped') {
      // No provider configured: record the reason, do not pretend delivery, and
      // do not burn the retry ladder forever.
      db.prepare(`UPDATE alert_deliveries SET status='skipped', attempts=?, last_error=?, provider=NULL,
                  next_attempt_at=NULL, updated_at=? WHERE id=?`)
        .run(attempts, result.error || 'skipped', now.toISOString(), delivery.id);
      summary.skipped++;
      summary.results.push({ id: delivery.id, status: 'skipped', to: delivery.recipient, error: result.error });
    } else {
      const retryAt = nextRetryAt(attempts, now);
      const finalStatus = retryAt ? 'failed' : 'failed';
      db.prepare(`UPDATE alert_deliveries SET status=?, attempts=?, last_error=?, provider=?,
                  next_attempt_at=?, updated_at=? WHERE id=?`)
        .run(finalStatus, attempts, result.error || 'send failed', result.provider || null, retryAt, now.toISOString(), delivery.id);
      summary.failed++;
      summary.results.push({ id: delivery.id, status: 'failed', to: delivery.recipient, error: result.error, retryAt });
    }
    refreshDigestStatus(delivery.digest_id, now);
  }

  return summary;
}

function refreshDigestStatus(digestId, now = new Date()) {
  if (!digestId) return;
  const rows = db.prepare('SELECT status, COUNT(*) c FROM alert_deliveries WHERE digest_id=? GROUP BY status').all(digestId);
  if (rows.length === 0) return;
  const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.c]));
  let status = 'pending';
  if (byStatus.sent) status = 'sent';
  else if (byStatus.failed && !byStatus.pending) status = 'failed';
  else if (byStatus.skipped && !byStatus.pending && !byStatus.failed) status = 'skipped';
  db.prepare('UPDATE digests SET status=?, updated_at=? WHERE id=?').run(status, now.toISOString(), digestId);
}

// ---------------------------------------------------------------------------
// Weekly digest
// ---------------------------------------------------------------------------
function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// Most recent scheduled digest boundary at or before `now`.
function digestBoundary(settings, now) {
  const candidate = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    settings.digest_hour_utc, 0, 0, 0
  ));
  const diff = (candidate.getUTCDay() - settings.digest_day + 7) % 7;
  candidate.setUTCDate(candidate.getUTCDate() - diff);
  if (candidate.getTime() > now.getTime()) candidate.setUTCDate(candidate.getUTCDate() - 7);
  return candidate;
}

function digestPeriod(settings, now) {
  const end = digestBoundary(settings, now);
  const start = new Date(end.getTime() - 7 * 86400000);
  return { periodKey: isoWeekKey(end), start, end };
}

function collectDigestChanges(wsId, start, end) {
  return db.prepare(`SELECT c.*, w.submitted_url AS website_url, w.label AS website_label
      FROM changes c JOIN websites w ON w.id = c.website_id
      WHERE c.workspace_id = ? AND c.detected_at >= ? AND c.detected_at < ? AND c.status != 'dismissed'
      ORDER BY c.significance DESC, c.detected_at DESC`).all(wsId, start.toISOString(), end.toISOString());
}

function buildDigest(wsId, period) {
  const changes = collectDigestChanges(wsId, period.start, period.end);
  const monitored = db.prepare(`SELECT w.submitted_url, w.label,
      (SELECT COUNT(*) FROM monitored_pages p WHERE p.website_id=w.id AND p.last_status IN ('ok','unchanged','changed')) AS pages,
      (SELECT COUNT(*) FROM monitored_pages p WHERE p.website_id=w.id AND p.last_status='failed') AS failing
    FROM websites w WHERE w.workspace_id=? AND w.monitor_enabled=1`).all(wsId);

  const groups = {
    pricing: changes.filter((c) => c.category === 'pricing'),
    signup: changes.filter((c) => c.category === 'signup'),
    content: changes.filter((c) => ['copy', 'headings', 'sections', 'cta', 'links', 'images'].includes(c.category)),
    other: changes.filter((c) => ['title', 'meta', 'other'].includes(c.category))
  };

  return {
    periodKey: period.periodKey,
    periodStart: period.start.toISOString(),
    periodEnd: period.end.toISOString(),
    totalChanges: changes.length,
    changes,
    monitored,
    groups
  };
}

function digestText(digest) {
  const lines = [`SaaS Shield weekly digest — week ${digest.periodKey}`, ''];
  lines.push(`Competitors monitored: ${digest.monitored.length}`);
  for (const site of digest.monitored) {
    lines.push(`  • ${site.label || site.submitted_url} — ${site.pages} page(s) checked${site.failing ? `, ${site.failing} failing` : ''}`);
  }
  lines.push('', `Changes detected: ${digest.totalChanges}`);

  const section = (title, items) => {
    if (!items.length) return;
    lines.push('', title);
    for (const change of items) {
      lines.push(`  • [${change.significance_label}] ${change.summary}`);
      lines.push(`    ${change.page_url}`);
      lines.push(`    ${changeLink(change.id)}`);
    }
  };
  section('Pricing changes', digest.groups.pricing);
  section('Signup flow changes', digest.groups.signup);
  section('Content changes', digest.groups.content);
  section('Other changes', digest.groups.other);

  if (digest.totalChanges === 0) {
    lines.push('', 'No changes were detected in monitored pages this week.');
  }
  lines.push('', 'Every entry links to the two saved snapshots it was derived from. Dismissed changes are excluded.');
  return lines.join('\n');
}

function digestHtml(digest) {
  const text = digestText(digest);
  return email.textToHtml(text);
}

function buildDigestEmail(digestRow) {
  const ws = db.prepare('SELECT * FROM workspaces WHERE id=?').get(digestRow.workspace_id);
  const digest = buildDigest(digestRow.workspace_id, {
    periodKey: digestRow.period_key,
    start: new Date(digestRow.period_start),
    end: new Date(digestRow.period_end)
  });
  const text = digestText(digest);
  return {
    to: null,
    subject: `[${ws ? ws.name : 'SaaS Shield'}] Weekly competitor digest — ${digestRow.period_key} (${digest.totalChanges} change${digest.totalChanges === 1 ? '' : 's'})`.slice(0, 200),
    text,
    html: digestHtml(digest)
  };
}

/**
 * Create the digest for the most recent due period, once per workspace/period.
 * @returns {{created:number, skipped:number, sent:number, results:Array}}
 */
async function runDueDigests({ now = new Date() } = {}) {
  const workspaces = db.prepare('SELECT workspace_id FROM notification_settings WHERE digest_enabled=1').all();
  const outcome = { created: 0, skipped: 0, deliveries: 0, recipients: 0, results: [] };

  for (const { workspace_id: wsId } of workspaces) {
    const settings = getSettings(wsId);
    const period = digestPeriod(settings, now);
    const existing = db.prepare('SELECT * FROM digests WHERE workspace_id=? AND period_key=?')
      .get(wsId, period.periodKey);
    if (existing) continue;

    const digest = buildDigest(wsId, period);
    const shouldSend = digest.totalChanges > 0 || settings.include_empty_digest === 1;
    const digestId = newId('dgt');

    if (!shouldSend) {
      db.prepare(`INSERT INTO digests (id, workspace_id, period_key, period_start, period_end, change_count, status, reason, created_at, updated_at)
                  VALUES (?,?,?,?,?,0,'skipped',?,?,?)`)
        .run(digestId, wsId, period.periodKey, period.start.toISOString(), period.end.toISOString(),
          'no changes in period', now.toISOString(), now.toISOString());
      outcome.skipped++;
      outcome.results.push({ workspaceId: wsId, periodKey: period.periodKey, status: 'skipped', reason: 'no changes' });
      continue;
    }

    const recipients = recipientsForWorkspace(wsId);
    if (recipients.length === 0) {
      db.prepare(`INSERT INTO digests (id, workspace_id, period_key, period_start, period_end, change_count, status, reason, created_at, updated_at)
                  VALUES (?,?,?,?,?,?,'skipped',?,?,?)`)
        .run(digestId, wsId, period.periodKey, period.start.toISOString(), period.end.toISOString(),
          digest.totalChanges, 'no confirmed recipients', now.toISOString(), now.toISOString());
      outcome.skipped++;
      outcome.results.push({ workspaceId: wsId, periodKey: period.periodKey, status: 'skipped', reason: 'no confirmed recipients' });
      continue;
    }

    db.prepare(`INSERT INTO digests (id, workspace_id, period_key, period_start, period_end, change_count, status, reason, created_at, updated_at)
                VALUES (?,?,?,?,?,?, 'pending', NULL, ?, ?)`)
      .run(digestId, wsId, period.periodKey, period.start.toISOString(), period.end.toISOString(),
        digest.totalChanges, now.toISOString(), now.toISOString());

    for (const recipient of recipients) {
      queueDelivery({ workspaceId: wsId, digestId, recipient: recipient.email, now });
      outcome.recipients++;
    }
    outcome.created++;
    outcome.results.push({ workspaceId: wsId, periodKey: period.periodKey, status: 'queued', changes: digest.totalChanges, recipients: recipients.length });
  }

  return outcome;
}

// ---------------------------------------------------------------------------
// Queries for the UI
// ---------------------------------------------------------------------------
function listAlerts(wsId, filters = {}) {
  const limit = Math.min(Math.max(Number(filters.limit) || 25, 1), 100);
  const offset = Math.max(Number(filters.offset) || 0, 0);
  const where = ['a.workspace_id = ?'];
  const args = [wsId];
  if (filters.status) { where.push('a.status = ?'); args.push(filters.status); }
  if (filters.severity) { where.push('a.severity = ?'); args.push(filters.severity); }
  const whereSql = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) c FROM alerts a WHERE ${whereSql}`).get(...args).c;
  const rows = db.prepare(`SELECT a.*, c.category, c.page_url, c.summary, c.previous_value, c.current_value,
      c.confidence, c.significance, w.submitted_url AS website_url
    FROM alerts a
    LEFT JOIN changes c ON c.id = a.change_id
    LEFT JOIN websites w ON w.id = a.website_id
    WHERE ${whereSql} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
  return { alerts: rows, total, has_more: offset + rows.length < total, limit, offset };
}

function setAlertStatus(wsId, alertId, status, now = new Date()) {
  if (!['unread', 'read', 'dismissed'].includes(status)) return { ok: false, error: 'invalid_status' };
  const alert = db.prepare('SELECT * FROM alerts WHERE id=? AND workspace_id=?').get(alertId, wsId);
  if (!alert) return { ok: false, error: 'not_found' };
  db.prepare('UPDATE alerts SET status=?, read_at=? WHERE id=?')
    .run(status, status === 'read' ? now.toISOString() : alert.read_at, alertId);
  if (status === 'dismissed') {
    db.prepare(`UPDATE changes SET status='dismissed', reviewed_at=? WHERE id=?`).run(now.toISOString(), alert.change_id);
  }
  return { ok: true };
}

function deliveryStats(wsId) {
  return db.prepare(`SELECT status, COUNT(*) c FROM alert_deliveries WHERE workspace_id=? GROUP BY status`).all(wsId);
}

function recentDeliveries(wsId, limit = 20) {
  return db.prepare(`SELECT id, alert_id, digest_id, channel, recipient, status, attempts, last_error,
      provider, sent_at, created_at FROM alert_deliveries
      WHERE workspace_id=? ORDER BY created_at DESC LIMIT ?`).all(wsId, Math.min(limit, 100));
}

module.exports = {
  SEVERITY_RANK,
  severityForSignificance,
  getSettings,
  updateSettings,
  recipientsForWorkspace,
  raiseAlertForChange,
  queueDelivery,
  processDeliveries,
  runDueDigests,
  digestPeriod,
  digestText,
  buildDigest,
  listAlerts,
  setAlertStatus,
  deliveryStats,
  recentDeliveries,
  changeLink,
  isoWeekKey,
  refreshDigestStatus
};
