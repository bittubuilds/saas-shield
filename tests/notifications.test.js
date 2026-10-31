'use strict';
// Alerts, deliveries, weekly digests and the scheduler lease.
//
// The external provider is replaced with the built-in dev sink (a local file) so
// every assertion about "sent" can be verified by reading what was actually
// delivered. The "no provider" path is tested by clearing that setting.
process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.DATABASE_FILE = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'shield-notif-')) + '/notif.db';
process.env.AUTH_RATE_LIMIT = '500';
process.env.ENABLE_INTERNAL_SCHEDULER = 'false';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const db = require('../src/db');
const config = require('../src/config');
const alerts = require('../src/alerts');
const email = require('../src/email');
const scheduler = require('../src/scheduler');
const { newId, utcNow } = require('../src/util');

const SINK = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shield-sink-')), 'mail.jsonl');
const WS = 'wsp_notif';
const SITE = 'web_notif';
const PAGE = 'mpg_notif';
const USER = 'usr_notif';

function seed() {
  const now = utcNow();
  db.prepare('INSERT INTO users (id,email,password_hash,name,created_at,email_verified_at,email_verified_source) VALUES (?,?,?,?,?,?,?)')
    .run(USER, 'owner@example.com', 'x', null, now, now, 'email_link');
  db.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)').run(WS, 'Notif Co', now);
  db.prepare('INSERT INTO memberships (workspace_id,user_id,role,created_at) VALUES (?,?,?,?)').run(WS, USER, 'owner', now);
  db.prepare(`INSERT INTO notification_settings
    (workspace_id, immediate_email, digest_enabled, digest_day, digest_hour_utc, min_severity, include_empty_digest, updated_at)
    VALUES (?,1,1,1,8,'high',0,?)`).run(WS, now);
  db.prepare(`INSERT INTO websites (id, workspace_id, kind, submitted_url, normalized_domain, status, crawl_status,
      monitor_enabled, frequency_hours, baseline_status, label, created_at, updated_at)
    VALUES (?,?,?,?,?, 'active','crawled',1,6,'created','Rival CRM',?,?)`)
    .run(SITE, WS, 'comparison', 'https://rival.example/', 'rival.example', now, now);
  db.prepare(`INSERT INTO monitored_pages (id, workspace_id, website_id, url, normalized_url, role, label, enabled,
      last_status, created_at, updated_at)
    VALUES (?,?,?,?,?,?,'Pricing',1,'ok',?,?)`)
    .run(PAGE, WS, SITE, 'https://rival.example/pricing', 'https://rival.example/pricing', 'pricing', now, now);
}

function insertSnapshot(id, fetchedAt) {
  db.prepare(`INSERT INTO snapshots (id, workspace_id, website_id, monitored_page_id, requested_url, final_url,
      http_status, fetched_at, title, meta_description, headings, links, images, ctas, forms, pricing, structure,
      text_normalized, text_raw, content_hash, byte_length, redirect_chain, capture_status, is_baseline, created_at)
    VALUES (?,?,?,?,?,?,200,?, 'Pricing', '', '[]','[]','[]','[]','[]','[]','{}', ?, ?, ?, 100, '[]','ok',0,?)`)
    .run(id, WS, SITE, PAGE, 'https://rival.example/pricing', 'https://rival.example/pricing', fetchedAt,
      'text', 'text', 'hash' + id, fetchedAt);
}

function insertChange({ id = newId('chg'), category = 'pricing', significance = 0.95, summary = 'Pro plan price changed: USD 29 / month → USD 39 / month', status = 'open', detectedAt = utcNow() } = {}) {
  insertSnapshot('snap_a_' + id, detectedAt);
  insertSnapshot('snap_b_' + id, detectedAt);
  db.prepare(`INSERT INTO changes (id, workspace_id, website_id, monitored_page_id, page_role, page_url,
      previous_snapshot_id, current_snapshot_id, detected_at, category, summary, significance, confidence,
      significance_label, previous_value, current_value, evidence, dedupe_key, status, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, WS, SITE, PAGE, 'pricing', 'https://rival.example/pricing',
      'snap_a_' + id, 'snap_b_' + id, detectedAt, category, summary, significance, 'high',
      significance >= 0.8 ? 'critical' : 'high', 'USD 29 / month', 'USD 39 / month',
      JSON.stringify({ kind: 'pricing', changed: [{ previous: { name: 'Pro', amount: 29 }, current: { name: 'Pro', amount: 39 } }] }),
      'dedupe_' + id, status, detectedAt);
  return db.prepare('SELECT * FROM changes WHERE id=?').get(id);
}

function readSink() {
  if (!fs.existsSync(SINK)) return [];
  return fs.readFileSync(SINK, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

before(() => {
  seed();
});

// ---------------------------------------------------------------------------
// Missing provider: report honestly, never claim delivery
// ---------------------------------------------------------------------------
test('with no email provider every send is recorded as skipped with a reason', async () => {
  assert.equal(email.describeConfig().configured, false);
  const change = insertChange();
  const alert = alerts.raiseAlertForChange({
    change,
    page: db.prepare('SELECT * FROM monitored_pages WHERE id=?').get(PAGE),
    website: db.prepare('SELECT * FROM websites WHERE id=?').get(SITE)
  });
  assert.ok(alert);

  const queued = db.prepare('SELECT * FROM alert_deliveries WHERE alert_id=?').all(alert.id);
  assert.equal(queued.length, 1, 'the owner is queued because the change is critical');
  assert.equal(queued[0].status, 'pending');

  const result = await alerts.processDeliveries({});
  assert.ok(result.processed >= 1);
  assert.ok(result.skipped >= 1);
  assert.equal(result.sent, 0, 'nothing may be reported as sent without a provider');

  const row = db.prepare('SELECT * FROM alert_deliveries WHERE alert_id=?').get(alert.id);
  assert.equal(row.status, 'skipped');
  assert.match(row.last_error, /no email provider configured/i);
  assert.equal(row.next_attempt_at, null, 'a configuration problem is not retried forever');
  assert.equal(row.sent_at, null);
});

// ---------------------------------------------------------------------------
// With a provider (dev sink): real delivery, real content
// ---------------------------------------------------------------------------
test('a configured provider receives the alert email and it is marked sent', async () => {
  config.email.devSinkFile = SINK;
  assert.equal(email.describeConfig().provider, 'dev-sink');

  const change = insertChange({ category: 'signup', significance: 0.8, summary: 'Signup/contact form changed: added field "work_email"' });
  const alert = alerts.raiseAlertForChange({
    change,
    page: db.prepare('SELECT * FROM monitored_pages WHERE id=?').get(PAGE),
    website: db.prepare('SELECT * FROM websites WHERE id=?').get(SITE)
  });
  assert.ok(alert);

  const result = await alerts.processDeliveries({});
  assert.equal(result.sent, 1, JSON.stringify(result.results));
  const row = db.prepare('SELECT * FROM alert_deliveries WHERE alert_id=?').get(alert.id);
  assert.equal(row.status, 'sent');
  assert.equal(row.provider, 'dev-sink');
  assert.ok(row.sent_at);

  const delivered = readSink().filter((m) => m.to === 'owner@example.com');
  const mail = delivered[delivered.length - 1];
  assert.match(mail.subject, /Rival CRM/i);
  assert.match(mail.text, /added field "work_email"/);
  assert.match(mail.text, /https?:\/\/\S+\/app#\/changes\//, 'the email links to the changelog entry');
  assert.match(mail.text, /not a legal conclusion/i);

  config.email.devSinkFile = '';
});

test('a recipient whose address is not confirmed never receives mail', () => {
  const now = utcNow();
  db.prepare('INSERT INTO users (id,email,password_hash,name,created_at,email_verified_at,email_verified_source) VALUES (?,?,?,?,?,NULL,NULL)')
    .run('usr_unconfirmed', 'unconfirmed@example.com', 'x', null, now);
  db.prepare('INSERT INTO memberships (workspace_id,user_id,role,created_at) VALUES (?,?,?,?)')
    .run(WS, 'usr_unconfirmed', 'admin', now);
  const recipients = alerts.recipientsForWorkspace(WS).map((r) => r.email);
  assert.deepEqual(recipients, ['owner@example.com']);
  db.prepare('DELETE FROM memberships WHERE user_id=?').run('usr_unconfirmed');
});

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------
test('the weekly digest lists competitors, changes and links to each changelog entry', async () => {
  config.email.devSinkFile = SINK;
  const settings = alerts.getSettings(WS);
  const period = alerts.digestPeriod(settings, new Date('2026-11-02T09:00:00Z'));   // after Monday 08:00 UTC
  assert.equal(period.periodKey, alerts.isoWeekKey(period.end));

  const digest = alerts.buildDigest(WS, period);
  assert.ok(digest.monitored.length >= 1, 'monitored competitors are listed');
  assert.equal(digest.monitored[0].label, 'Rival CRM');

  const text = alerts.digestText(digest);
  assert.match(text, /weekly digest/i);
  assert.match(text, /Rival CRM/);
  for (const change of digest.changes.slice(0, 3)) {
    assert.ok(text.includes(alerts.changeLink(change.id)), 'every change links to its changelog entry');
  }
  assert.match(text, /Pricing changes/);
  assert.match(text, /Dismissed changes are excluded/);

  await alerts.runDueDigests({ now: new Date('2026-11-02T09:00:00Z') });
  const digestRow = db.prepare('SELECT * FROM digests WHERE workspace_id=? AND period_key=?').get(WS, period.periodKey);
  assert.ok(digestRow, 'a digest row is recorded for the period');

  const deliveries = db.prepare('SELECT * FROM alert_deliveries WHERE digest_id=?').all(digestRow.id);
  assert.equal(deliveries.length, 1, 'exactly one delivery per confirmed recipient');

  await alerts.processDeliveries({ now: new Date('2026-11-02T09:00:05Z') });
  const refreshed = db.prepare('SELECT status FROM digests WHERE id=?').get(digestRow.id);
  assert.equal(refreshed.status, 'sent');
  config.email.devSinkFile = '';
});

test('the same digest period is never sent twice', async () => {
  config.email.devSinkFile = SINK;
  // Make the period specific to this test instead of relying on test order.
  await alerts.runDueDigests({ now: new Date('2026-11-02T09:00:00Z') });
  const settings = alerts.getSettings(WS);
  const period = alerts.digestPeriod(settings, new Date('2026-11-02T09:00:00Z'));
  const before = db.prepare('SELECT COUNT(*) c FROM digests WHERE workspace_id=? AND period_key=?').get(WS, period.periodKey).c;
  await alerts.runDueDigests({ now: new Date('2026-11-02T10:00:00Z') });
  const after = db.prepare('SELECT COUNT(*) c FROM digests WHERE workspace_id=? AND period_key=?').get(WS, period.periodKey).c;
  assert.equal(after, before, 're-running the digest for a completed period does nothing');
  config.email.devSinkFile = '';
});

test('an empty period is skipped unless the workspace asks for empty digests', async () => {
  const now = utcNow();
  db.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)').run('wsp_empty', 'Empty Co', now);
  db.prepare(`INSERT INTO notification_settings
    (workspace_id, immediate_email, digest_enabled, digest_day, digest_hour_utc, min_severity, include_empty_digest, updated_at)
    VALUES (?,1,1,1,8,'high',0,?)`).run('wsp_empty', now);
  db.prepare('INSERT INTO users (id,email,password_hash,name,created_at,email_verified_at,email_verified_source) VALUES (?,?,?,?,?,?,?)')
    .run('usr_empty', 'empty@example.com', 'x', null, now, now, 'email_link');
  db.prepare('INSERT INTO memberships (workspace_id,user_id,role,created_at) VALUES (?,?,?,?)')
    .run('wsp_empty', 'usr_empty', 'owner', now);

  config.email.devSinkFile = SINK;
  const run = await alerts.runDueDigests({ now: new Date('2026-11-02T09:00:00Z') });
  assert.ok(run.skipped >= 1);

  const row = db.prepare('SELECT * FROM digests WHERE workspace_id=?').get('wsp_empty');
  assert.equal(row.status, 'skipped');
  assert.match(row.reason, /no changes/);
  const deliveries = db.prepare('SELECT COUNT(*) c FROM alert_deliveries WHERE workspace_id=?').get('wsp_empty').c;
  assert.equal(deliveries, 0, 'an empty digest sends nothing');

  // Explicit opt-in produces a digest even with no changes.
  alerts.updateSettings('wsp_empty', { include_empty_digest: true });
  await alerts.runDueDigests({ now: new Date('2026-11-09T09:00:00Z') });
  const rows = db.prepare('SELECT * FROM digests WHERE workspace_id=? ORDER BY period_key').all('wsp_empty');
  assert.equal(rows.length, 2);
  assert.notEqual(rows[1].status, 'skipped');
  config.email.devSinkFile = '';
});

test('a dismissed change and its alert are not delivered', async () => {
  config.email.devSinkFile = SINK;
  const change = insertChange({ category: 'copy', significance: 0.6, summary: 'Page copy changed: 20 words removed, 18 added.' });
  const alert = alerts.raiseAlertForChange({
    change,
    page: db.prepare('SELECT * FROM monitored_pages WHERE id=?').get(PAGE),
    website: db.prepare('SELECT * FROM websites WHERE id=?').get(SITE)
  });
  alerts.setAlertStatus(WS, alert.id, 'dismissed');

  const result = await alerts.processDeliveries({});
  const delivery = db.prepare('SELECT * FROM alert_deliveries WHERE alert_id=?').get(alert.id);
  assert.equal(delivery.status, 'skipped');
  assert.match(delivery.last_error, /dismissed/);
  assert.ok(result.processed >= 1);

  const period = alerts.digestPeriod(alerts.getSettings(WS), new Date('2026-11-16T09:00:00Z'));
  const digest = alerts.buildDigest(WS, period);
  assert.ok(!digest.changes.some((c) => c.id === change.id));
  config.email.devSinkFile = '';
});

// ---------------------------------------------------------------------------
// Delivery failures: bounded retries, recorded errors
// ---------------------------------------------------------------------------
test('a transient delivery failure is retried on a bounded ladder with the error recorded', async () => {
  const change = insertChange({ significance: 0.95, summary: 'Pro plan price changed: USD 39 / month → USD 49 / month' });
  const alert = alerts.raiseAlertForChange({
    change,
    page: db.prepare('SELECT * FROM monitored_pages WHERE id=?').get(PAGE),
    website: db.prepare('SELECT * FROM websites WHERE id=?').get(SITE)
  });

  const saved = { ...config.email };
  config.email.provider = 'webhook';
  config.email.webhookUrl = 'http://127.0.0.1:9/nope';   // closed port: connection refused
  config.email.timeoutMs = 3000;

  await alerts.processDeliveries({});
  let row = db.prepare('SELECT * FROM alert_deliveries WHERE alert_id=?').get(alert.id);
  assert.equal(row.status, 'failed');
  assert.equal(row.attempts, 1);
  assert.ok(row.last_error, 'the delivery error is stored, not swallowed');
  assert.ok(row.next_attempt_at, 'a retry is scheduled');
  assert.ok(new Date(row.next_attempt_at) > new Date());

  // Exhaust the ladder: no further retry may be scheduled.
  const maxAttempts = config.alerts.retryDelaysMinutes.length + 1;
  db.prepare('UPDATE alert_deliveries SET attempts=?, next_attempt_at=NULL WHERE id=?').run(maxAttempts, row.id);
  await alerts.processDeliveries({});
  row = db.prepare('SELECT * FROM alert_deliveries WHERE alert_id=?').get(alert.id);
  assert.equal(row.next_attempt_at, null, 'retries stop at the end of the ladder');
  assert.equal(row.status, 'failed');

  Object.assign(config.email, saved);
  assert.equal(email.describeConfig().configured, false);
});

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------
test('the scheduler lease stops two instances from running the same tick', async () => {
  assert.equal(scheduler.acquireLock('scheduler-tick', 60), true);
  const second = await scheduler.runTick({ source: 'test' });
  assert.equal(second.skipped, true);
  assert.equal(second.reason, 'locked_by_other_instance');
  scheduler.releaseLock('scheduler-tick');

  const status = scheduler.status();
  assert.equal(status.enabled, false, 'the internal timer is disabled in tests');
  assert.equal(status.internal_timer_active, false);
});

test('the external cron endpoint requires a configured secret', async () => {
  const { server } = require('../src/server');
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/internal/cron`;

  const noSecretConfigured = await fetch(base, { method: 'POST' });
  assert.equal(noSecretConfigured.status, 503);
  const body = await noSecretConfigured.json();
  assert.equal(body.code, 'cron_not_configured');

  // With a secret configured, a wrong or missing one is rejected.
  const saved = config.scheduler.cronSecret;
  config.scheduler.cronSecret = 'super-secret-value';
  const wrong = await fetch(base, { method: 'POST', headers: { 'x-cron-secret': 'guess' } });
  assert.equal(wrong.status, 401);
  const missing = await fetch(base, { method: 'POST' });
  assert.equal(missing.status, 401);

  const ok = await fetch(base, { method: 'POST', headers: { 'x-cron-secret': 'super-secret-value' } });
  assert.equal(ok.status, 200);
  const result = await ok.json();
  assert.equal(result.ok, true);
  config.scheduler.cronSecret = saved;

  server.close();
});

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------
test('notification preferences are validated and persisted', () => {
  const bad = alerts.updateSettings(WS, { digest_day: 9 });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /digest_day/);

  const badHour = alerts.updateSettings(WS, { digest_hour_utc: 24 });
  assert.equal(badHour.ok, false);

  const badSeverity = alerts.updateSettings(WS, { min_severity: 'urgent' });
  assert.equal(badSeverity.ok, false);

  const ok = alerts.updateSettings(WS, { digest_day: 3, digest_hour_utc: 14, immediate_email: false, min_severity: 'normal' });
  assert.equal(ok.ok, true);
  const saved = alerts.getSettings(WS);
  assert.equal(saved.digest_day, 3);
  assert.equal(saved.digest_hour_utc, 14);
  assert.equal(saved.immediate_email, 0);
  assert.equal(saved.min_severity, 'normal');

  // immediate_email=false must stop new deliveries from being queued.
  const before = db.prepare('SELECT COUNT(*) c FROM alert_deliveries WHERE workspace_id=?').get(WS).c;
  const change = insertChange({ significance: 0.99, summary: 'Starter plan no longer shown: USD 19 / month' });
  alerts.raiseAlertForChange({
    change,
    page: db.prepare('SELECT * FROM monitored_pages WHERE id=?').get(PAGE),
    website: db.prepare('SELECT * FROM websites WHERE id=?').get(SITE)
  });
  const after = db.prepare('SELECT COUNT(*) c FROM alert_deliveries WHERE workspace_id=?').get(WS).c;
  assert.equal(after, before, 'immediate email is off, so nothing is queued (the changelog still records it)');
  assert.ok(db.prepare('SELECT id FROM alerts WHERE change_id=?').get(change.id), 'the in-app alert still exists');
});
