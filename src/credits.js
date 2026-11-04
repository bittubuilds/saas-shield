'use strict';
// Scan-job credits.
//
// Every rule here exists so a user cannot pay twice or scan for free:
//   - credits belong to the USER, never to a workspace (a second workspace must
//     not mint credits, and an invited member spends their own balance)
//   - one credit buys one JOB: a manual comparison or a whole discovery run that
//     fans out across many competitors
//   - reserve happens before any crawling; consume on the first completed
//     comparison; refund when every comparison failed or the job was cancelled
//     before anything completed
//
// Every mutation is a single conditional statement so SQLite and PostgreSQL need
// no transaction helper, and a losing concurrent request simply changes 0 rows.

const db = require('./db/index');
const { newId, utcNow } = require('./util');

const GRANT = 3;
const TERMINAL_SCAN = ['completed', 'failed', 'cancelled'];

function wallet(userId) {
  let row = db.prepare('SELECT * FROM user_credits WHERE user_id=?').get(userId);
  if (!row) {
    try {
      db.prepare(`INSERT INTO user_credits (user_id, granted, backfill_version, updated_at)
                  VALUES (?,?,1,?)`).run(userId, GRANT, utcNow());
    } catch (e) { /* concurrent insert: re-read below */ }
    row = db.prepare('SELECT * FROM user_credits WHERE user_id=?').get(userId);
  }
  return row;
}

// One grant row per user, ever. The NOT EXISTS makes a repeated backfill a no-op
// instead of a second helping of credits.
function grantOnce(userId, reason = 'signup') {
  wallet(userId);
  const res = db.prepare(`
    INSERT INTO credit_ledger (id, user_id, job_id, entry_type, amount, reason, created_at)
    SELECT ?, ?, 'wallet', 'grant', ?, ?, ?
    WHERE NOT EXISTS (SELECT 1 FROM credit_ledger WHERE user_id=? AND job_id='wallet' AND entry_type='grant')`)
    .run(newId('crd'), userId, GRANT, reason, utcNow(), userId);
  return (res && res.changes) === 1;
}

// Lazy backfill: any user who has never received a grant gets exactly one, the
// first time their credits are touched. Existing accounts are therefore covered
// without a scheduled migration, and a second visit is a no-op.
function ensure(userId) {
  const row = db.prepare('SELECT user_id FROM user_credits WHERE user_id=?').get(userId);
  if (!row) {
    try {
      db.prepare(`INSERT INTO user_credits (user_id, granted, backfill_version, updated_at)
                  VALUES (?,?,1,?)`).run(userId, GRANT, utcNow());
    } catch (e) { /* another request created it */ }
  }
  return grantOnce(userId, 'backfill_v1');
}

function balance(userId) {
  ensure(userId);
  const row = db.prepare(`
    SELECT
      COALESCE((SELECT granted FROM user_credits WHERE user_id=?), 0) AS granted,
      (SELECT COUNT(*) FROM credit_ledger WHERE user_id=? AND entry_type='reserve') AS reserved,
      (SELECT COUNT(*) FROM credit_ledger WHERE user_id=? AND entry_type='consume') AS consumed,
      (SELECT COUNT(*) FROM credit_ledger WHERE user_id=? AND entry_type='refund') AS refunded`)
    .get(userId, userId, userId, userId);
  // reserve holds a credit, refund gives one back, consume merely labels a hold as
  // spent. Counting the consume again would charge the same job twice.
  const available = Math.max(0, row.granted - row.reserved + row.refunded);
  return { granted: row.granted, reserved: row.reserved, consumed: row.consumed, refunded: row.refunded, available };
}

// Atomic: the balance is recomputed inside the INSERT, so two concurrent calls
// cannot both slip under the same remaining credit.
function reserve(userId, jobId, reason = 'Job accepted') {
  const res = db.prepare(`
    INSERT INTO credit_ledger (id, user_id, job_id, entry_type, amount, reason, created_at)
    SELECT ?, ?, ?, 'reserve', -1, ?, ?
    WHERE (COALESCE((SELECT granted FROM user_credits WHERE user_id=?), 0)
         - (SELECT COUNT(*) FROM credit_ledger WHERE user_id=? AND entry_type='reserve')
         + (SELECT COUNT(*) FROM credit_ledger WHERE user_id=? AND entry_type='refund')) > 0`)
    .run(newId('crd'), userId, jobId, reason, utcNow(), userId, userId, userId);
  return (res && res.changes) === 1;
}

function release(userId, jobId, entryType, reason) {
  const res = db.prepare(`
    INSERT INTO credit_ledger (id, user_id, job_id, entry_type, amount, reason, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?
    WHERE NOT EXISTS (SELECT 1 FROM credit_ledger WHERE user_id=? AND job_id=? AND entry_type=?)`)
    .run(newId('crd'), userId, jobId, entryType, entryType === 'consume' ? -1 : 1, reason, utcNow(),
      userId, jobId, entryType);
  return (res && res.changes) === 1;
}

function activeJob(userId) {
  return db.prepare(`SELECT * FROM scan_jobs WHERE user_id=? AND status IN ('queued','running')
                     ORDER BY created_at DESC LIMIT 1`).get(userId);
}

function jobForRequest(userId, requestKey) {
  return db.prepare(`SELECT * FROM scan_jobs WHERE user_id=? AND request_key=? AND status IN ('queued','running')
                     ORDER BY created_at DESC LIMIT 1`).get(userId, requestKey);
}

// Outcome shapes returned to routes, so each caller can answer precisely:
//   { ok:true, jobId, replay:false }
//   { ok:true, jobId, replay:true }        identical request already running
//   { ok:false, conflict:true, jobId }     a DIFFERENT job is running
//   { ok:false, noCredits:true, balance }  balance is zero
function openJob({ userId, workspaceId, kind, requestKey }) {
  ensure(userId);
  const sameRequest = jobForRequest(userId, requestKey);
  if (sameRequest) return { ok: true, jobId: sameRequest.id, replay: true, job: sameRequest };

  const active = activeJob(userId);
  if (active) return { ok: false, conflict: true, jobId: active.id, job: active };

  const jobId = newId('job');
  if (!reserve(userId, jobId)) return { ok: false, noCredits: true, balance: balance(userId) };

  try {
    db.prepare(`INSERT INTO scan_jobs (id, user_id, workspace_id, kind, request_key, credit_state, status, created_at)
                VALUES (?,?,?,?,?, 'reserved', 'queued', ?)`)
      .run(jobId, userId, workspaceId, kind, requestKey, utcNow());
  } catch (e) {
    // Lost a race on the one-active-job index: give the reserved credit straight back.
    release(userId, jobId, 'refund', 'Job could not start');
    const winner = activeJob(userId);
    if (winner) return { ok: false, conflict: true, jobId: winner.id, job: winner };
    throw e;
  }
  return { ok: true, jobId, replay: false };
}

function attachScan(jobId, scanId) {
  if (!jobId) return;
  db.prepare('UPDATE scans SET job_id=? WHERE id=?').run(jobId, scanId);
  db.prepare(`UPDATE scan_jobs SET status='running' WHERE id=? AND status='queued'`).run(jobId);
}

function jobScans(jobId) {
  return db.prepare('SELECT id, status FROM scans WHERE job_id=?').all(jobId);
}

// Decide the job's fate from what its scans actually did.
function settleJob(jobId) {
  const job = db.prepare('SELECT * FROM scan_jobs WHERE id=?').get(jobId);
  if (!job) return { settled: false, reason: 'missing' };
  if (job.credit_state !== 'reserved') return { settled: false, reason: 'already_' + job.credit_state };

  const scans = jobScans(jobId);
  const completed = scans.filter((s) => s.status === 'completed').length;
  const finished = scans.filter((s) => TERMINAL_SCAN.includes(s.status)).length;

  if (completed === 0 && (scans.length === 0 || finished < scans.length)) {
    return { settled: false, reason: 'still_running' };
  }

  const state = completed > 0 ? 'consumed' : 'refunded';
  const status = completed > 0 ? 'completed' : 'failed';
  const moved = db.prepare(`UPDATE scan_jobs SET credit_state=?, status=?, finished_at=?
                            WHERE id=? AND credit_state='reserved'`)
    .run(state, status, utcNow(), jobId);
  if ((moved && moved.changes) !== 1) return { settled: false, reason: 'raced' };

  if (state === 'consumed') {
    release(job.user_id, jobId, 'consume', `${completed} comparison(s) completed`);
  } else {
    release(job.user_id, jobId, 'refund', scans.length === 0
      ? 'No comparison could be started'
      : 'No comparison completed');
  }
  return { settled: true, state, completed, scans: scans.length };
}

function settleJobsForScans(scanIds) {
  const out = [];
  for (const id of scanIds) {
    const row = db.prepare('SELECT job_id FROM scans WHERE id=?').get(id);
    if (row && row.job_id) out.push(settleJob(row.job_id));
  }
  return out;
}

function listJobs(userId, limit = 20) {
  return db.prepare(`SELECT id, workspace_id, kind, credit_state, status, created_at, finished_at
                     FROM scan_jobs WHERE user_id=? ORDER BY created_at DESC LIMIT ?`).all(userId, limit);
}

function ledgerFor(userId, limit = 50) {
  return db.prepare(`SELECT id, job_id, entry_type, amount, reason, created_at
                     FROM credit_ledger WHERE user_id=? ORDER BY created_at DESC LIMIT ?`).all(userId, limit);
}

module.exports = {
  GRANT, ensure, wallet, grantOnce, balance, reserve, release, openJob, attachScan,
  settleJob, settleJobsForScans, activeJob, jobForRequest, listJobs, ledgerFor, jobScans
};
