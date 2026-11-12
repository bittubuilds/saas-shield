'use strict';
// A failed discovery must not freeze the screen for ten minutes: the usual reasons
// (browser missing, page unreadable, key not yet live) are often fixed moments later.
process.env.DATABASE_FILE = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'shield-retry-')) + '/test.db';
process.env.NODE_ENV = 'test';
process.env.SERPER_API_KEY = 'test-key';   // makes discovery "available" without a network call

const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db/index');
const initialScan = require('../src/initialscan');
const { newId, utcNow } = require('../src/util');

function seed({ ageSeconds, status }) {
  const now = utcNow();
  const uid = newId('usr'), ws = newId('wsp'), site = newId('web'), dsc = newId('dsc');
  const created = new Date(Date.now() - ageSeconds * 1000).toISOString();
  db.prepare('INSERT INTO users (id,email,password_hash,name,created_at) VALUES (?,?,?,?,?)').run(uid, `${uid}@x.test`, 'x', 'x', now);
  db.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)').run(ws, 'W', now);
  db.prepare(`INSERT INTO websites (id,workspace_id,kind,submitted_url,normalized_domain,status,crawl_status,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?,?)`).run(site, ws, 'original', 'https://mine.test/', 'mine.test', 'active', 'crawled', now, now);
  db.prepare(`INSERT INTO discoveries (id, workspace_id, original_website_id, status, created_by, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?)`).run(dsc, ws, site, status, uid, created, created);
  return { uid, ws, site, dsc };
}

test('a failed run from a minute ago is retried instead of reused', () => {
  const { uid, ws, site, dsc } = seed({ ageSeconds: 90, status: 'failed' });
  const started = initialScan.start({ workspaceId: ws, siteId: site, userId: uid });
  assert.equal(started.mode, 'discovery');
  assert.notEqual(started.discovery_id, dsc, 'a new attempt runs, the failed row stays as history');
});

test('a failed run from a moment ago is reused, so a reload cannot spam searches', () => {
  const { uid, ws, site, dsc } = seed({ ageSeconds: 5, status: 'failed' });
  const started = initialScan.start({ workspaceId: ws, siteId: site, userId: uid });
  assert.equal(started.discovery_id, dsc);
});

test('a live run is always reused', () => {
  const { uid, ws, site, dsc } = seed({ ageSeconds: 600, status: 'running' });
  const started = initialScan.start({ workspaceId: ws, siteId: site, userId: uid });
  assert.equal(started.discovery_id, dsc);
});
