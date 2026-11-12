'use strict';
// A process that stops mid-discovery (a Render sleep, a crash, a deploy) must not
// leave the row at 'running' forever: nothing would ever pick it up again.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATABASE_FILE = fs.mkdtempSync(path.join(os.tmpdir(), 'shield-rec-')) + '/test.db';
process.env.NODE_ENV = 'test';

const db = require('../src/db/index');
const { recoverStaleDiscoveries, recoverStaleScans, DISCOVERY_INTERRUPTED } = require('../src/scan-recovery');
const { newId, utcNow } = require('../src/util');

function seedDiscovery(ageMs, status) {
  const ws = newId('wsp');
  const uid = newId('usr');
  const site = newId('web');
  const dsc = newId('dsc');
  const when = new Date(Date.now() - ageMs).toISOString();
  db.prepare('INSERT INTO users (id,email,password_hash,name,created_at) VALUES (?,?,?,?,?)').run(uid, `${uid}@x.test`, 'x', 'x', utcNow());
  db.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)').run(ws, 'W', utcNow());
  db.prepare(`INSERT INTO websites (id,workspace_id,kind,submitted_url,normalized_domain,status,crawl_status,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?,?)`).run(site, ws, 'original', 'https://a.test/', 'a.test', 'active', 'crawled', utcNow(), utcNow());
  db.prepare(`INSERT INTO discoveries (id, workspace_id, original_website_id, status, created_by, created_at, updated_at, started_at)
              VALUES (?,?,?,?,?,?,?,?)`).run(dsc, ws, site, status, uid, when, when, when);
  return dsc;
}

test('an interrupted discovery is closed, not left running', () => {
  const stale = seedDiscovery(60 * 60 * 1000, 'running');
  const result = recoverStaleDiscoveries({ olderThanMs: 10 * 60 * 1000 });
  assert.ok(result.recovered >= 1);
  const row = db.prepare('SELECT status, error FROM discoveries WHERE id=?').get(stale);
  assert.equal(row.status, 'failed');
  assert.equal(row.error, DISCOVERY_INTERRUPTED);
});

test('a discovery that just started is left alone', () => {
  const fresh = seedDiscovery(1000, 'running');
  recoverStaleDiscoveries({ olderThanMs: 10 * 60 * 1000 });
  assert.equal(db.prepare('SELECT status FROM discoveries WHERE id=?').get(fresh).status, 'running');
});

test('scan recovery still works alongside it', () => {
  const r = recoverStaleScans({ olderThanMs: 10 * 60 * 1000 });
  assert.equal(typeof r.recovered, 'number');
});

// A restart loses the in-memory queue while rows still say 'queued'. Resuming must
// hand back only never-started rows, so nothing can run twice.
test('queued rows that never started are handed back to the queue after a restart', () => {
  const { resumeQueuedWork } = require('../src/scan-recovery');
  const queuedScan = newId('scn'), startedScan = newId('scn');
  const ws = newId('wsp'), uid = newId('usr'), a = newId('web'), b = newId('web'), now = utcNow();
  db.prepare('INSERT INTO users (id,email,password_hash,name,created_at) VALUES (?,?,?,?,?)').run(uid, `${uid}@x.test`, 'x', 'x', now);
  db.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)').run(ws, 'W', now);
  for (const [id, kind, dom] of [[a, 'original', 'a.test'], [b, 'comparison', 'b.test']]) {
    db.prepare(`INSERT INTO websites (id,workspace_id,kind,submitted_url,normalized_domain,status,crawl_status,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?)`).run(id, ws, kind, `https://${dom}/`, dom, 'active', 'crawled', now, now);
  }
  db.prepare(`INSERT INTO scans (id,workspace_id,original_website_id,comparison_website_id,status,params,created_by,created_at)
              VALUES (?,?,?,?,?,?,?,?)`).run(queuedScan, ws, a, b, 'queued', '{}', uid, now);
  db.prepare(`INSERT INTO scans (id,workspace_id,original_website_id,comparison_website_id,status,params,created_by,created_at,started_at)
              VALUES (?,?,?,?,?,?,?,?,?)`).run(startedScan, ws, a, b, 'queued', '{}', uid, now, now);

  const enqueued = [];
  const out = resumeQueuedWork({
    scanner: { isRunning: () => false, enqueueScan: (id) => enqueued.push(id) },
    discover: { enqueueDiscovery: () => {} }
  });
  assert.ok(enqueued.includes(queuedScan), 'a never-started scan is resumed');
  assert.ok(!enqueued.includes(startedScan), 'a scan that had already started is not re-run');
  assert.ok(out.scans >= 1);
});
