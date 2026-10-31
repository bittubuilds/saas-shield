'use strict';
// Durable-ish scheduling.
//
// Reality check, documented rather than hidden: this app has no job queue. Two
// mechanisms are provided and neither overclaims:
//
//   1. In-process interval tick (default every 300s). Runs only while the Node
//      process is alive. On hosts that sleep idle services (e.g. a free tier)
//      the tick stops while the instance is asleep.
//   2. POST /api/internal/cron with the CRON_SECRET header. Intended for an
//      external scheduler (cron-job.org, GitHub Actions, Render Cron Job,
//      Kubernetes CronJob) so checks keep happening even after a restart/sleep.
//
// Both call the same runTick(), and both are guarded by a database lease
// (job_locks) so two instances, or an overlapping tick, cannot double-run checks
// or double-send a digest.
const db = require('./db');
const config = require('./config');
const monitor = require('./monitor');
const alerts = require('./alerts');
const { newId, utcNow } = require('./util');

const INSTANCE_ID = newId('inst');
let timer = null;
let running = false;
let lastRun = null;

function acquireLock(name, ttlSeconds) {
  const now = new Date();
  const expires = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
  const res = db.prepare(`INSERT INTO job_locks (name, holder, acquired_at, expires_at)
      VALUES (?,?,?,?)
      ON CONFLICT(name) DO UPDATE SET holder=excluded.holder, acquired_at=excluded.acquired_at, expires_at=excluded.expires_at
      WHERE job_locks.expires_at < ?`)
    .run(name, INSTANCE_ID, now.toISOString(), expires, now.toISOString());
  return res.changes > 0;
}

function releaseLock(name) {
  db.prepare('DELETE FROM job_locks WHERE name=? AND holder=?').run(name, INSTANCE_ID);
}

function lockStatus(name) {
  return db.prepare('SELECT * FROM job_locks WHERE name=?').get(name) || null;
}

/**
 * One scheduler tick: due page checks, then digests, then queued deliveries.
 * Safe to call concurrently: a lease makes the second caller a no-op.
 */
async function runTick(opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const source = opts.source || 'internal';
  if (running) {
    return { skipped: true, reason: 'already_running', source };
  }
  if (!acquireLock('scheduler-tick', config.scheduler.lockTtlSeconds)) {
    return { skipped: true, reason: 'locked_by_other_instance', source, lock: lockStatus('scheduler-tick') };
  }

  running = true;
  const startedAt = Date.now();
  try {
    let monitorResult = null;
    let monitorError = null;
    try {
      monitorResult = await monitor.runDueChecks({ now, limit: opts.limit });
    } catch (e) {
      monitorError = e.message;
      console.error('[scheduler] monitor tick failed:', e.message);
    }

    let digestResult = null;
    try {
      digestResult = await alerts.runDueDigests({ now });
    } catch (e) {
      console.error('[scheduler] digest run failed:', e.message);
    }

    let deliveryResult = null;
    try {
      deliveryResult = await alerts.processDeliveries({ now });
    } catch (e) {
      console.error('[scheduler] delivery run failed:', e.message);
    }

    lastRun = {
      at: now.toISOString(),
      source,
      durationMs: Date.now() - startedAt,
      monitor: monitorResult,
      monitorError,
      digests: digestResult,
      deliveries: deliveryResult
    };
    return lastRun;
  } finally {
    running = false;
    releaseLock('scheduler-tick');
  }
}

function start() {
  if (timer || !config.scheduler.enabled) return { started: false, reason: 'disabled' };
  const intervalMs = Math.max(30, config.scheduler.intervalSeconds) * 1000;
  timer = setInterval(() => {
    // Errors are logged inside runTick; swallow here so the interval survives.
    runTick({ source: 'internal' }).catch((e) => console.error('[scheduler] tick error:', e.message));
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[scheduler] internal tick every ${intervalMs / 1000}s (external cron recommended for sleep-prone hosts)`);
  return { started: true, intervalMs };
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function status() {
  const nextDue = db.prepare(`SELECT COUNT(*) c FROM monitored_pages p JOIN websites w ON w.id=p.website_id
      WHERE p.enabled=1 AND w.monitor_enabled=1 AND w.status='active'
        AND (p.next_check_at IS NULL OR p.next_check_at <= ?)`).get(new Date().toISOString()).c;
  return {
    enabled: config.scheduler.enabled,
    interval_seconds: config.scheduler.intervalSeconds,
    internal_timer_active: Boolean(timer),
    external_cron_configured: Boolean(config.scheduler.cronSecret),
    due_checks_now: nextDue,
    last_run: lastRun,
    lock: lockStatus('scheduler-tick')
  };
}

module.exports = { runTick, start, stop, status, acquireLock, releaseLock, INSTANCE_ID };
