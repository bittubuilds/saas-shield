#!/usr/bin/env node
'use strict';
// Restore a verified backup.
//
// Two modes, because SQLite and PostgreSQL restore differently:
//   default  logical restore through the app's database connection (PostgreSQL, or
//            a SQLite snapshot that is not a raw .db file). Refuses to touch a
//            populated database without --force.
//   --swap   SQLite file swap. Must run with the server stopped.
//
// The swap is deliberately careful: a raw copy over a live WAL database is not a
// restore. Copying the .db file alone leaves the previous -wal/-shm sidecars
// behind, and the next open replays that WAL on top of the restored file, which
// can resurrect deleted rows or mix two states. Those sidecars are moved aside
// together with the old file, and the restored file is opened and counted before
// this command reports success.
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
const force = args.includes('--force');
const swap = args.includes('--swap');

if (!target) {
  console.error('usage: node tools/db-restore.js <backup-path> [--force] [--swap]');
  process.exit(2);
}

const full = path.resolve(target);
if (!fs.existsSync(full)) {
  console.error(JSON.stringify({ ok: false, error: `backup not found: ${full}` }));
  process.exit(1);
}

// Opens the snapshot on its own (never the live database) and reports its shape.
function inspect(file) {
  const { DatabaseSync } = require('node:sqlite');
  const handle = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = handle.prepare('PRAGMA integrity_check').get();
    const tables = handle.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table'").get();
    const mig = handle.prepare('SELECT COALESCE(MAX(version), 0) v FROM schema_migrations').get();
    return {
      ok: Object.values(integrity)[0] === 'ok',
      tables: Number(tables.c),
      migration: Number(mig.v)
    };
  } finally {
    handle.close();
  }
}

if (swap) {
  const config = require('../src/config');
  const dest = path.resolve(config.databaseFile);
  const check = inspect(full);
  if (!check.ok) {
    console.error(JSON.stringify({ ok: false, stage: 'verify', check }, null, 2));
    process.exit(1);
  }

  const stamp = Date.now();
  const movedAside = [];
  // Park the live file and its sidecars together, so a bad restore is reversible
  // and no stale WAL can be replayed onto the restored file.
  for (const suffix of ['', '-wal', '-shm']) {
    const from = `${dest}${suffix}`;
    if (!fs.existsSync(from)) continue;
    const to = `${dest}.replaced-${stamp}${suffix}`;
    fs.renameSync(from, to);
    movedAside.push(to);
  }

  fs.copyFileSync(full, dest);
  for (const suffix of ['-wal', '-shm']) {
    try { fs.unlinkSync(`${dest}${suffix}`); } catch { /* nothing left behind */ }
  }

  const after = inspect(dest);
  const result = {
    ok: after.ok && after.tables >= 20,
    stage: 'swap',
    restored_from: full,
    moved_aside: movedAside,
    restored: after
  };
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

// Logical path needs the live database connection, so it is required only here.
const backup = require('../src/db/backup');
const check = backup.verifyBackup(full);
if (!check.ok) {
  console.error(JSON.stringify({ ok: false, stage: 'verify', check }, null, 2));
  process.exit(1);
}

const result = backup.restoreBackup(full, { force });
console.log(JSON.stringify({ verify: check, restore: result }, null, 2));
process.exit(result.ok ? 0 : 1);
