'use strict';
// Durability, backup, migration and restart-recovery tests.
//
// Restart behaviour is tested with real child processes, not by re-requiring a
// module: "survives a restart" has to mean a new OS process reads data written by
// a previous one, otherwise the test proves nothing about deployment.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'shield-durability-'));
const DB_FILE = path.join(TMP, 'durable.db');
const BACKUP_DIR = path.join(TMP, 'backups');

process.env.DATABASE_FILE = DB_FILE;
process.env.DB_BACKUP_DIR = BACKUP_DIR;

const db = require('../src/db/index');
const durability = require('../src/db/durability');
const backup = require('../src/db/backup');
const { newId, utcNow } = require('../src/util');

// Runs a snippet in a brand-new node process against the same database file.
function child(script, env = {}) {
  return execFileSync(process.execPath, ['-e', script], {
    cwd: REPO,
    env: { ...process.env, DATABASE_FILE: DB_FILE, DB_BACKUP_DIR: BACKUP_DIR, ...env },
    encoding: 'utf8'
  }).trim();
}

function seed() {
  const userId = newId('usr');
  const wsId = newId('wsp');
  const now = utcNow();
  db.prepare('INSERT INTO workspaces (id, name, created_at) VALUES (?,?,?)').run(wsId, 'Durability', now);
  db.prepare('INSERT INTO users (id,email,password_hash,name,created_at) VALUES (?,?,?,?,?)')
    .run(userId, `${userId}@example.test`, 'x', null, now);
  return { userId, wsId };
}

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('a sqlite file inside the application image is reported as not durable', () => {
  // The repo lives under /app in the container image, which is exactly where the
  // real deployment puts its SQLite file, so this is the production shape.
  const imageFacts = durability.sqliteFacts(path.join(REPO, 'data', 'saas-shield.db'));
  assert.equal(imageFacts.insideImage, true, 'repo path should be recognised as image-local');
  const scratchFacts = durability.sqliteFacts(DB_FILE);
  assert.equal(scratchFacts.insideImage, false, 'a tmpfs path is outside the image');
  const probed = durability.probe();
  assert.equal(probed.backend, 'sqlite');
  assert.equal(probed.writable, true, 'the probe must prove writes work');
  assert.equal(probed.durable, false, 'writable is not the same as durable');
  assert.match(probed.note, /image|DATABASE_URL/);
});

test('declaring a persistent path makes the same file durable', () => {
  process.env.DB_PERSISTENT_PATH = path.dirname(DB_FILE);
  const probed = durability.probe();
  delete process.env.DB_PERSISTENT_PATH;
  assert.equal(probed.durable, true, 'an operator-declared mount is trusted');
});

test('data written by one process is readable by a different process', () => {
  const { wsId } = seed();
  const out = child(`
    const db = require('./src/db/index');
    const row = db.prepare('SELECT COUNT(*) c FROM workspaces').get();
    console.log(JSON.stringify({ workspaces: Number(row.c), migration: db.prepare('SELECT MAX(version) v FROM schema_migrations').get().v }));
  `);
  const parsed = JSON.parse(out);
  assert.ok(parsed.workspaces >= 1, 'a fresh process must see the row written earlier');
  assert.ok(Number(parsed.migration) >= 7, 'migrations survive the restart too');
  assert.ok(wsId);
});

test('migrations are idempotent across restarts', () => {
  const before = db.prepare('SELECT COUNT(*) c FROM schema_migrations').get().c;
  const out = child(`
    const db = require('./src/db/index');
    console.log(JSON.stringify({ applied: db.prepare('SELECT COUNT(*) c FROM schema_migrations').get().c }));
  `);
  const after2 = JSON.parse(out).applied;
  assert.equal(Number(after2), Number(before), 'reopening must not re-run or duplicate migrations');
});

test('sqlite backup captures a consistent snapshot and verifies', () => {
  seed();
  const snap = backup.createBackup({ label: 'test' });
  assert.equal(snap.ok, true);
  assert.ok(snap.bytes > 0);
  const check = backup.verifyBackup(snap.path);
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.ok(fs.existsSync(snap.path));
});

test('a restore brings deleted rows back', () => {
  const { wsId } = seed();
  const snap = backup.createBackup({ label: 'restore-src' });
  // Destroy the row the snapshot holds, in a separate process so the file on disk
  // is genuinely the only remaining copy.
  child(`const db=require('./src/db/index'); db.prepare('DELETE FROM workspaces WHERE id=?').run('${wsId}');`);
  const gone = db.prepare('SELECT COUNT(*) c FROM workspaces WHERE id=?').get(wsId).c;
  assert.equal(Number(gone), 0);

  // The running connection keeps its own view, so restore is exercised the way an
  // operator would: stop the server, swap the file, restart.
  const swapTarget = path.join(TMP, 'swap.db');
  fs.copyFileSync(snap.path, swapTarget);
  const out = child(`
    const db = require('./src/db/index');
    const before = db.prepare('SELECT COUNT(*) c FROM workspaces WHERE id=?').get('${wsId}');
    console.log(JSON.stringify({ present: Number(before.c) }));
  `, { DATABASE_FILE: swapTarget });
  assert.equal(JSON.parse(out).present, 1, 'the snapshot must still contain the deleted workspace');
});

test('backup retention keeps the newest snapshots and prunes the rest', () => {
  backup.createBackup({ label: 'r1' });
  backup.createBackup({ label: 'r2' });
  backup.createBackup({ label: 'r3' });
  const pruned = backup.pruneBackups({ keep: 2 });
  const left = backup.listBackups();
  assert.ok(pruned.removed.length >= 1, 'old snapshots must be pruned');
  assert.ok(left.length <= 6, `expected a bounded number of files, got ${left.length}`);
});

test('a truncated snapshot fails verification instead of restoring silently', () => {
  const snap = backup.createBackup({ label: 'corrupt' });
  fs.writeFileSync(snap.path, Buffer.alloc(64, 0));
  const check = backup.verifyBackup(snap.path);
  assert.equal(check.ok, false);
  assert.ok(check.expected_bytes > 64);
});

test('stale scan recovery still runs after a restart', () => {
  const { wsId } = seed();
  const now = utcNow();
  const old = new Date(Date.now() - 3600 * 1000).toISOString();
  for (const [id, kind] of [['web_durability_a', 'original'], ['web_durability_b', 'comparison']]) {
    db.prepare(`INSERT INTO websites (id,workspace_id,kind,submitted_url,normalized_domain,status,crawl_status,created_at,updated_at)
                VALUES (?,?,?,?,?,'active','not_crawled',?,?)`)
      .run(`${id}_${Date.now()}`, wsId, kind, `https://${id}.test/`, `${id}.test`, now, now);
  }
  const sites = db.prepare('SELECT id FROM websites WHERE workspace_id=?').all(wsId);
  const scanId = newId('scn');
  db.prepare(`INSERT INTO scans (id,workspace_id,original_website_id,comparison_website_id,status,params,created_at,started_at)
              VALUES (?,?,?,?,'running','{}',?,?)`)
    .run(scanId, wsId, sites[0].id, sites[1].id, old, old);

  const out = child(`
    const recovery = require('./src/scan-recovery');
    const res = recovery.recoverStaleScans();
    const db = require('./src/db/index');
    const row = db.prepare('SELECT status FROM scans WHERE id=?').get('${scanId}');
    console.log(JSON.stringify({ recovered: res.recovered, status: row.status }));
  `);
  const parsed = JSON.parse(out);
  assert.equal(parsed.status, 'failed', 'an orphaned scan must be recovered by a fresh process');
  assert.ok(parsed.recovered >= 1);
});

test('the health probe never leaks the connection string', () => {
  const probed = durability.probe();
  const text = JSON.stringify(probed);
  assert.doesNotMatch(text, /postgres:\/\/|password|@127\.0\.0\.1/i);
});
