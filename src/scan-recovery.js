'use strict';
// Recovery for scans orphaned by a process that died mid-run.
//
// A crash leaves a scan row at 'running' (or 'queued' if the worker never picked
// it up) with no worker behind it. Because the free product allows exactly one
// scan per website, an orphan would silently consume that allowance forever.
//
// Rules kept deliberately narrow:
//   - only rows past the stale window are touched, so a live scan never is
//   - the row is marked failed with a readable reason; history and error stay
//   - no replacement job is created here, so recovery cannot double-queue work
//   - the update is a single statement, so two instances racing produce one result

const db = require('./db/index');
const config = require('./config');

const INTERRUPTED = 'The scan was interrupted before it finished (the server stopped mid-scan). Run the scan again.';

function recoverStaleScans({ olderThanMs, now = new Date() } = {}) {
  const window_ = Number.isFinite(olderThanMs) ? olderThanMs : config.scan.staleAfterMs;
  const cutoff = new Date(now.getTime() - window_).toISOString();
  // Capture the orphans (and their jobs) before the update, so the credit can be
  // settled for exactly the scans this pass killed.
  const orphans = db.prepare(`
    SELECT id, job_id FROM scans
     WHERE status IN ('queued','running')
       AND COALESCE(started_at, created_at) < ?`).all(cutoff);

  const res = db.prepare(`
    UPDATE scans
       SET status='failed', finished_at=?, error=?
     WHERE status IN ('queued','running')
       AND COALESCE(started_at, created_at) < ?`).run(now.toISOString(), INTERRUPTED, cutoff);
  const recovered = (res && res.changes) || 0;

  // An interrupted job bought nothing, so its credit goes back (settleJob refunds
  // when no comparison completed; it is idempotent).
  const jobIds = [...new Set(orphans.map((o) => o.job_id).filter(Boolean))];
  for (const jobId of jobIds) {
    try { require('./credits').settleJob(jobId); } catch (e) { console.error('[recovery] settle failed:', e.message); }
  }
  if (recovered) console.warn(`[recovery] marked ${recovered} orphaned scan(s) as failed (cutoff ${cutoff})`);
  return { recovered, cutoff };
}

module.exports = { recoverStaleScans, INTERRUPTED };
