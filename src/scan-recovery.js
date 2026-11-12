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

// Same failure mode for auto-discovery: Render (and any host) can stop the process
// mid-run, leaving the row at 'running'. Nothing would ever pick it up again, and
// the progress screen would wait on a job that no longer exists.
const DISCOVERY_INTERRUPTED = 'The automatic discovery was interrupted before it finished (the server stopped mid-run). Run it again.';

function recoverStaleDiscoveries({ olderThanMs, now = new Date() } = {}) {
  const window_ = Number.isFinite(olderThanMs) ? olderThanMs : config.scan.staleAfterMs;
  const cutoff = new Date(now.getTime() - window_).toISOString();
  const res = db.prepare(`
    UPDATE discoveries
       SET status='failed', finished_at=?, updated_at=?, error=?
     WHERE status IN ('queued','running')
       AND COALESCE(started_at, created_at) < ?`).run(now.toISOString(), now.toISOString(), DISCOVERY_INTERRUPTED, cutoff);
  const recovered = (res && res.changes) || 0;
  if (recovered) console.warn(`[recovery] marked ${recovered} orphaned discovery job(s) as failed (cutoff ${cutoff})`);
  return { recovered, cutoff };
}

// Scans and discoveries run from an in-memory queue (setImmediate), so a restart
// loses the job while the database row still says 'queued'. Waiting out the stale
// window left the screen on "queued" for fifteen minutes after every deploy. A row
// that was never started is safe to hand back to the queue: nothing ran, so nothing
// can run twice. Rows already 'running' are NOT resumed (a crawl half-done is not
// restartable); the stale window still fails those with a readable reason.
function resumeQueuedWork({ scanner, discover } = {}) {
  const out = { scans: 0, discoveries: 0 };
  try {
    const sc = scanner || require('./scanner');
    const rows = db.prepare(`SELECT id FROM scans WHERE status='queued' AND started_at IS NULL ORDER BY created_at ASC LIMIT 20`).all();
    for (const r of rows) {
      if (sc.isRunning && sc.isRunning(r.id)) continue;
      sc.enqueueScan(r.id);
      out.scans++;
    }
  } catch (e) { console.error('[recovery] could not resume queued scans:', e.message); }
  try {
    const dc = discover || require('./discover');
    const rows = db.prepare(`SELECT id FROM discoveries WHERE status='queued' AND started_at IS NULL ORDER BY created_at ASC LIMIT 20`).all();
    for (const r of rows) {
      dc.enqueueDiscovery(r.id);
      out.discoveries++;
    }
  } catch (e) { console.error('[recovery] could not resume queued discoveries:', e.message); }
  if (out.scans || out.discoveries) console.warn(`[recovery] resumed ${out.scans} queued scan(s) and ${out.discoveries} queued discovery job(s) after a restart`);
  return out;
}

module.exports = { recoverStaleScans, recoverStaleDiscoveries, resumeQueuedWork, INTERRUPTED, DISCOVERY_INTERRUPTED };
