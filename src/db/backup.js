'use strict';
// Portable backup and restore for both backends.
//
// SQLite: a consistent snapshot via `VACUUM INTO`, which is WAL-safe and cannot
// capture a half-written page the way a plain file copy can.
// PostgreSQL: a logical JSONL export, one file per table. `pg_dump` is not
// guaranteed to exist in a runtime container, and a logical export restores into
// any provider, so it is the portable choice rather than a convenience one.
//
// Restore is deliberately additive and explicit: it refuses to run against a
// database that already holds rows unless --force is passed, because silently
// merging two histories is how evidence gets corrupted.

const fs = require('fs');
const path = require('path');
const db = require('./index');
const config = require('../config');

const BACKUP_DIR = path.resolve(process.env.DB_BACKUP_DIR || path.join(path.dirname(path.resolve(config.databaseFile)), 'backups'));

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function ensureDir(dir = BACKUP_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sqliteTables() {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map((r) => r.name);
}

function pgTables() {
  return db.prepare(`SELECT table_name AS name FROM information_schema.tables
                     WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`)
    .all().map((r) => r.name);
}

function tables() {
  return db.backendKind === 'postgres' ? pgTables() : sqliteTables();
}

function createBackup({ dir = BACKUP_DIR, label = 'auto' } = {}) {
  ensureDir(dir);
  const name = `${db.backendKind}-${label}-${stamp()}`;
  const target = path.join(dir, name);

  if (db.backendKind !== 'postgres') {
    const file = `${target}.db`;
    // VACUUM INTO writes a complete, consistent database file without locking out
    // readers for the whole copy.
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    const bytes = fs.statSync(file).size;
    const manifest = { backend: 'sqlite', file: path.basename(file), bytes, tables: tables().length, created_at: new Date().toISOString() };
    fs.writeFileSync(`${target}.json`, JSON.stringify(manifest, null, 2));
    return { ok: true, ...manifest, path: file, manifest: `${target}.json` };
  }

  // logical export: one JSONL file per table + a manifest with row counts
  fs.mkdirSync(target, { recursive: true });
  const manifest = { backend: 'postgres', created_at: new Date().toISOString(), tables: {} };
  for (const t of tables()) {
    const rows = db.prepare(`SELECT * FROM "${t}"`).all();
    const body = rows.map((r) => JSON.stringify(r)).join('\n');
    fs.writeFileSync(path.join(target, `${t}.jsonl`), body ? body + '\n' : '');
    manifest.tables[t] = rows.length;
  }
  fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { ok: true, backend: 'postgres', path: target, tables: Object.keys(manifest.tables).length, rows: Object.values(manifest.tables).reduce((a, b) => a + b, 0), manifest };
}

// A snapshot is either a SQLite .db plus its .json manifest, or - on PostgreSQL -
// a directory of one .jsonl per table with manifest.json inside. Both shapes have
// to be listed, or retention cannot see (and cannot prune) the Postgres ones.
function snapshotKind(full, name) {
  const st = fs.statSync(full);
  if (st.isDirectory()) {
    return fs.existsSync(path.join(full, 'manifest.json')) ? 'postgres' : null;
  }
  return name.endsWith('.json') || name.endsWith('.db') ? 'file' : null;
}

function dirBytes(full) {
  let total = 0;
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    const child = path.join(full, entry.name);
    total += entry.isDirectory() ? dirBytes(child) : fs.statSync(child).size;
  }
  return total;
}

function listBackups({ dir = BACKUP_DIR } = {}) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map((n) => {
      const full = path.join(dir, n);
      const kind = snapshotKind(full, n);
      if (!kind) return null;
      const st = fs.statSync(full);
      return {
        name: n,
        kind,
        bytes: st.isDirectory() ? dirBytes(full) : st.size,
        modified: st.mtime.toISOString(),
        path: full
      };
    })
    .filter(Boolean)
    .sort((a, b) => (a.modified < b.modified ? 1 : -1));
}

// Prune old snapshots, newest kept. Used by the retention policy so backups
// cannot fill a small disk.
function pruneBackups({ dir = BACKUP_DIR, keep = 7 } = {}) {
  const all = listBackups({ dir })
    .filter((b) => b.kind === 'postgres' || b.name.endsWith('.db') || b.name.endsWith('manifest.json') || b.name.endsWith('.json'));
  const snapshots = new Map();
  for (const b of all) {
    // a directory snapshot is already keyed by its own name, no suffix to strip
    const key = b.kind === 'postgres' ? b.name : b.name.replace(/\.(db|json)$/, '');
    const cur = snapshots.get(key) || { key, files: [] };
    cur.files.push(b.path);
    snapshots.set(key, cur);
  }
  const keys = [...snapshots.keys()].sort((a, b) => (a < b ? 1 : -1));
  const removed = [];
  for (const k of keys.slice(keep)) {
    for (const f of snapshots.get(k).files) {
      try {
        // directory snapshots are removed whole; a file snapshot is one unlink
        if (fs.statSync(f).isDirectory()) fs.rmSync(f, { recursive: true, force: true });
        else fs.unlinkSync(f);
        removed.push(f);
      } catch { /* already gone */ }
    }
  }
  return { removed, kept: Math.min(keys.length, keep) };
}

// A logical restore has to insert parents before children. The manifest is
// alphabetical, and 'competitors' sorts before 'workspaces', so a naive replay
// trips foreign keys on any real dataset. Order by the live foreign-key graph.
function dependencyOrder(names) {
  const wanted = new Set(names);
  const parents = new Map(names.map((n) => [n, new Set()]));
  if (db.backendKind === 'postgres') {
    const edges = db.prepare(`
      SELECT tc.table_name AS child, ccu.table_name AS parent
        FROM information_schema.table_constraints tc
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name
         AND ccu.constraint_schema = tc.constraint_schema
       WHERE tc.constraint_type = 'FOREIGN KEY'`).all();
    for (const e of edges) {
      if (e.child === e.parent) continue;               // self reference: fine in place
      if (!wanted.has(e.child) || !wanted.has(e.parent)) continue;
      parents.get(e.child).add(e.parent);
    }
  }
  const order = [];
  const placed = new Set();
  let pending = [...names];
  while (pending.length) {
    const ready = pending.filter((n) => [...parents.get(n)].every((p2) => placed.has(p2)));
    if (!ready.length) {
      // cycle: emit the rest in manifest order rather than dropping tables
      for (const n of pending) { order.push(n); placed.add(n); }
      break;
    }
    for (const n of ready) { order.push(n); placed.add(n); }
    pending = pending.filter((n) => !placed.has(n));
  }
  return order;
}

function rowCounts() {
  const out = {};
  for (const t of tables()) {
    const row = db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get();
    out[t] = row ? Number(row.c) : 0;
  }
  return out;
}

// Verifies a backup is internally consistent: the manifest exists, every file it
// names is present, and row counts line up with the counts recorded at capture.
function verifyBackup(target) {
  const full = path.resolve(target);
  if (!fs.existsSync(full)) return { ok: false, error: 'backup path does not exist' };

  if (fs.statSync(full).isFile() && full.endsWith('.db')) {
    const manifestPath = full.replace(/\.db$/, '.json');
    if (!fs.existsSync(manifestPath)) return { ok: false, error: 'manifest missing next to snapshot' };
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const bytes = fs.statSync(full).size;
    return {
      ok: bytes > 0 && bytes === manifest.bytes,
      backend: 'sqlite',
      bytes,
      expected_bytes: manifest.bytes,
      tables: manifest.tables
    };
  }

  const manifestPath = path.join(full, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return { ok: false, error: 'manifest.json missing' };
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const problems = [];
  for (const [t, expected] of Object.entries(manifest.tables)) {
    const f = path.join(full, `${t}.jsonl`);
    if (!fs.existsSync(f)) { problems.push(`${t}: file missing`); continue; }
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length;
    if (lines !== expected) problems.push(`${t}: ${lines} rows, expected ${expected}`);
  }
  return { ok: problems.length === 0, backend: 'postgres', tables: Object.keys(manifest.tables).length, problems };
}

// Restore is additive by design. `force` clears existing rows first and is the
// only path that can destroy data, so it is never implied.
function restoreBackup(target, { force = false } = {}) {
  const full = path.resolve(target);
  const counts = rowCounts();
  // Migration bookkeeping alone does not count as "this database holds data":
  // a freshly migrated target still has schema_migrations and app_meta rows, and
  // making the operator type --force to restore into an empty database is exactly
  // the kind of friction a restore during an outage cannot afford.
  const BOOKKEEPING = new Set(['schema_migrations', 'app_meta']);
  const populated = Object.entries(counts).filter(([t, c]) => c > 0 && !BOOKKEEPING.has(t));
  if (populated.length && !force) {
    return { ok: false, error: 'target database already has data; pass --force to replace it', populated: populated.map(([t]) => t) };
  }

  if (fs.statSync(full).isFile() && full.endsWith('.db')) {
    // SQLite restore means swapping the file, which cannot be done from inside the
    // running connection. The CLI copies the snapshot into place and the operator
    // restarts; this function reports the plan and refuses to pretend otherwise.
    return { ok: false, error: 'sqlite restore is a file swap; use tools/db-restore.js --swap which stops the process first', plan: { copy: full, to: path.resolve(config.databaseFile) } };
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(full, 'manifest.json'), 'utf8'));
  const order = dependencyOrder(Object.keys(manifest.tables));
  const restored = {};
  const failures = [];
  const skipped = [];
  db.exec('BEGIN');
  try {
    if (force) {
      for (const t of [...order].reverse()) db.prepare(`DELETE FROM "${t}"`).run();
    }
    for (const t of order) {
      const file = path.join(full, `${t}.jsonl`);
      if (!fs.existsSync(file)) continue;
      const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      for (const row of rows) {
        const cols = Object.keys(row);
        if (!cols.length) continue;
        const sql = `INSERT INTO "${t}" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
        // A silently skipped row is a lost row. Collect the failure and roll the
        // whole restore back rather than reporting success over a partial load.
        // A per-row savepoint keeps one bad row from aborting the whole load on
        // PostgreSQL, and it is what lets a bookkeeping collision be skipped
        // instead of taking the restore down with it.
        db.exec('SAVEPOINT restore_row');
        try {
          db.prepare(sql).run(...cols.map((c) => row[c]));
          restored[t] = (restored[t] || 0) + 1;
          db.exec('RELEASE SAVEPOINT restore_row');
        } catch (rowError) {
          try { db.exec('ROLLBACK TO SAVEPOINT restore_row'); } catch { /* ignore */ }
          const message = String(rowError && rowError.message);
          // A freshly migrated target already holds migrations and app_meta rows.
          // Those are not user data, so an existing copy is simply kept.
          const duplicate = /duplicate key|UNIQUE constraint/i.test(message);
          if (duplicate && BOOKKEEPING.has(t)) {
            skipped.push({ table: t, reason: 'already present' });
          } else {
            failures.push({ table: t, error: message.slice(0, 200) });
          }
        }
      }
    }
    if (failures.length) {
      db.exec('ROLLBACK');
      return {
        ok: false,
        error: `${failures.length} row(s) could not be restored; nothing was committed`,
        failures: failures.slice(0, 5),
        restored_before_rollback: restored
      };
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    return { ok: false, error: e.message };
  }
  return { ok: true, backend: 'postgres', restored, skipped };
}

module.exports = { BACKUP_DIR, createBackup, listBackups, pruneBackups, verifyBackup, restoreBackup, rowCounts, tables };
