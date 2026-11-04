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
  const res = db.prepare(`
    UPDATE scans
       SET status='failed', finished_at=?, error=?
     WHERE status IN ('queued','running')
       AND COALESCE(started_at, created_at) < ?`).run(now.toISOString(), INTERRUPTED, cutoff);
  const recovered = (res && res.changes) || 0;
  if (recovered) console.warn(`[recovery] marked ${recovered} orphaned scan(s) as failed (cutoff ${cutoff})`);
  return { recovered, cutoff };
}

module.exports = { recoverStaleScans, INTERRUPTED };
