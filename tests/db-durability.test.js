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

// --- concurrent migration: two independent processes, one fresh database ------

const { spawn } = require('node:child_process');

// Real concurrency needs two processes started at the same time, so this uses
// spawn + Promise.all rather than sequential execFileSync.
function childAsync(script, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['-e', script], {
      cwd: REPO,
      env: { ...process.env, DB_BACKUP_DIR: BACKUP_DIR, ...env }
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

const MIGRATE_SNIPPET = "require('./src/db/index'); console.log('migrated');";

test('two processes migrating the same sqlite file at once both succeed', async () => {
  const file = path.join(TMP, 'race.db');
  const runs = await Promise.all([
    childAsync(MIGRATE_SNIPPET, { DATABASE_FILE: file }),
    childAsync(MIGRATE_SNIPPET, { DATABASE_FILE: file })
  ]);
  for (const r of runs) {
    assert.equal(r.code, 0, `a concurrent migrator failed: ${r.err.split('\n').slice(-3).join(' ')}`);
  }
  const { DatabaseSync } = require('node:sqlite');
  const check = new DatabaseSync(file, { readOnly: true });
  const rows = check.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
  const tables = check.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table'").get();
  check.close();
  assert.deepEqual(rows.map((r) => Number(r.version)), [1, 2, 3, 4, 5, 6, 7], 'each migration recorded once');
  assert.equal(Number(tables.c), 27, 'schema applied exactly once (26 domain tables + schema_migrations)');
});

test('two processes migrating the same postgres database at once both succeed', async (t) => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return t.skip('TEST_DATABASE_URL not set');
  const runs = await Promise.all([
    childAsync(MIGRATE_SNIPPET, { DATABASE_URL: url }),
    childAsync(MIGRATE_SNIPPET, { DATABASE_URL: url })
  ]);
  for (const r of runs) {
    assert.equal(r.code, 0, `a concurrent migrator failed: ${r.err.split('\n').slice(-3).join(' ')}`);
  }
  const pgBackup = require('../src/db/backup');
  const counts = pgBackup.rowCounts();
  assert.ok(counts.schema_migrations >= 7, 'migration rows recorded');
});

// --- the restore path operators will actually use ----------------------------

test('sqlite --swap restore parks WAL sidecars and brings the snapshot back', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shield-swap-'));
  const file = path.join(dir, 'live.db');
  const snaps = path.join(dir, 'snaps');
  fs.mkdirSync(snaps);
  const env = { DATABASE_FILE: file, DB_BACKUP_DIR: snaps };
  const run = (args) => execFileSync(process.execPath, args, { cwd: REPO, env: { ...process.env, ...env }, encoding: 'utf8' }).trim();

  run(['-e', "const db=require('./src/db/index');const{newId,utcNow}=require('./src/util');db.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)').run(newId('wsp'),'swap-ws',utcNow());"]);
  run(['tools/db-backup.js']);
  const snapshot = fs.readdirSync(snaps).find((f) => f.endsWith('.db'));
  assert.ok(snapshot, 'a snapshot was written');

  run(['-e', "const db=require('./src/db/index');db.prepare(\"DELETE FROM workspaces WHERE name='swap-ws'\").run();"]);
  run(['tools/db-restore.js', path.join(snaps, snapshot), '--swap']);

  const after = run(['-e', "const db=require('./src/db/index');console.log(Number(db.prepare('SELECT COUNT(*) c FROM workspaces').get().c));"]);
  assert.equal(after, '1', 'the deleted row is back');
  assert.equal(fs.existsSync(`${file}-wal`), false, 'no stale WAL left to replay over the restore');
  assert.ok(fs.readdirSync(dir).some((f) => f.includes('.replaced-')), 'the previous file was kept for rollback');
});
