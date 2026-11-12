'use strict';
// A scan that compared nothing must not look finished. In production this froze the
// progress screen at 0%: the payload said done, so nothing retried, and the user had
// no action that could move it forward.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATABASE_FILE = fs.mkdtempSync(path.join(os.tmpdir(), 'shield-empty-')) + '/test.db';
process.env.NODE_ENV = 'test';
delete process.env.SERPER_API_KEY;

const db = require('../src/db/index');
const initialScan = require('../src/initialscan');
const { newId, utcNow } = require('../src/util');

function seed({ pagesCompared, findings = 0, status = 'completed' }) {
  const now = utcNow();
  const uid = newId('usr'), ws = newId('wsp'), orig = newId('web'), comp = newId('web'), scan = newId('scn');
  db.prepare('INSERT INTO users (id,email,password_hash,name,created_at) VALUES (?,?,?,?,?)').run(uid, `${uid}@x.test`, 'x', 'x', now);
  db.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)').run(ws, 'W', now);
  for (const [id, kind, url, dom] of [[orig, 'original', 'https://mine.test/', 'mine.test'], [comp, 'comparison', 'https://other.test/', 'other.test']]) {
    db.prepare(`INSERT INTO websites (id,workspace_id,kind,submitted_url,normalized_domain,status,crawl_status,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?)`).run(id, ws, kind, url, dom, 'active', 'crawled', now, now);
  }
  db.prepare(`INSERT INTO scans (id,workspace_id,original_website_id,comparison_website_id,status,params,pages_compared,findings,created_by,created_at,finished_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(scan, ws, orig, comp, status, '{}', pagesCompared, findings, uid, now, now);
  return { uid, ws, orig };
}

test('a completed scan with zero pages compared is not done, and is flagged', () => {
  const { ws, orig } = seed({ pagesCompared: 0 });
  const out = initialScan.status(ws, orig);
  assert.equal(out.done, false, 'nothing was examined, so the screen must not look finished');
  assert.equal(out.empty_scan, true);
});

test('a real scan that found no copying still counts as done', () => {
  const { ws, orig } = seed({ pagesCompared: 4 });
  const out = initialScan.status(ws, orig);
  assert.equal(out.done, true, 'pages were compared, so the answer is a real answer');
  assert.equal(out.empty_scan, false);
});

test('an empty scan no longer blocks the next automatic step', () => {
  const { uid, ws, orig } = seed({ pagesCompared: 0 });
  const started = initialScan.start({ workspaceId: ws, siteId: orig, userId: uid });
  assert.notEqual(started.mode, 'already_scanned', 'the empty scan must not burn the workspace scan');
});
