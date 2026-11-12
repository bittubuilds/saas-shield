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
