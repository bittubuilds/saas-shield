'use strict';
// TEMPORARY database diagnostic endpoint (delete this file to remove it).
//
//   GET /api/internal/db-diagnostic
//   header: x-db-diagnostic-secret: <DB_DIAGNOSTIC_SECRET>   (or Authorization: Bearer ...)
//
// Render's free plan hides the shell and logs, so this is the supported way to
// answer "is the database there, is it intact, and does its storage survive a
// restart". It exists only while DB_DIAGNOSTIC_SECRET is set, and it never reads
// or returns database contents, credentials, tokens or the database path.
//
// Removal: delete this file and the two lines in src/server.js that mount it
// (see docs/DB-DIAGNOSTIC.md).

const fs = require('fs');
const path = require('path');
const express = require('express');
const config = require('../config');
const crypto = require('crypto');
const db = require('../db');

const router = express.Router();

// Hash both sides first, so the comparison is constant-time even when the
// supplied value has a different length than the secret.
function constantTimeEquals(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// A short secret is treated as no secret at all: a 4-character value must not
// enable a production diagnostic surface.
const MIN_SECRET_LENGTH = 32;

function strongSecret(value) {
  return typeof value === 'string' && value.length >= MIN_SECRET_LENGTH;
}

function configuredSecret() {
  const secret = config.dbDiagnosticSecret;
  return strongSecret(secret) ? secret : null;
}

// File-level facts only: existence, size, readability and PRAGMA integrity_check
// through a read-only handle. Nothing is written and no rows are returned.
function sqliteFacts(file) {
  const facts = { file_exists: false, file_size_bytes: null, readable: false, integrity_check: 'unknown', integrity_issues: null };
  try {
    const stat = fs.statSync(file);
    facts.file_exists = stat.isFile();
    if (facts.file_exists) facts.file_size_bytes = stat.size;
  } catch {
    return facts;
  }
  if (!facts.file_exists) return facts;

  let handle = null;
  try {
    handle = new (require('node:sqlite').DatabaseSync)(file, { readOnly: true });
    const rows = handle.prepare('PRAGMA integrity_check').all();
    const values = rows.map((r) => String(Object.values(r)[0]));
    const ok = values.length === 1 && /^ok$/i.test(values[0]);
    facts.readable = true;
    facts.integrity_check = ok ? 'ok' : 'failed';
    facts.integrity_issues = ok ? 0 : values.length;
  } catch {
    // Locked, corrupt or not a database: report the fact, never the error text.
    facts.readable = false;
    facts.integrity_check = 'error';
  } finally {
    try { if (handle) handle.close(); } catch { /* already closed */ }
  }
  return facts;
}

// Is the directory holding the database a mount of its own (survives a restart)
// or part of the container's writable layer (lost on redeploy)? Heuristic, and it
// says "unknown" rather than guessing when the mount table is unreadable.
const EPHEMERAL_FS = new Set(['tmpfs', 'ramfs', 'overlay', 'devtmpfs', 'aufs']);

function storageKind(targetPath) {
  if (process.platform !== 'linux') return { persistence: 'unknown', reason: 'mount table not available on this platform' };
  let mounts;
  let real;
  try {
    real = fs.realpathSync(path.dirname(targetPath));
    mounts = fs.readFileSync('/proc/self/mounts', 'utf8').trim().split('\n');
  } catch {
    return { persistence: 'unknown', reason: 'mount table unreadable' };
  }
  let best = null;
  for (const line of mounts) {
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    const mountpoint = parts[1].replace(/\\040/g, ' ');
    const under = mountpoint === '/' ? real.startsWith('/') : (real === mountpoint || real.startsWith(`${mountpoint}/`));
    if (!under) continue;
    if (!best || mountpoint.length > best.mountpoint.length) best = { fstype: parts[2], mountpoint };
  }
  if (!best) return { persistence: 'unknown', reason: 'no matching mount point' };
  if (EPHEMERAL_FS.has(best.fstype) || best.mountpoint === '/') {
    return { persistence: 'ephemeral', reason: `${best.fstype} filesystem at ${best.mountpoint === '/' ? 'container root' : best.mountpoint}` };
  }
  return { persistence: 'persistent', reason: `${best.fstype} mount at ${best.mountpoint === '/' ? 'root' : 'a dedicated mount'}` };
}

// Connectivity is proven with one trivial read. No writes, no DDL, no schema work.
function connectivity() {
  try {
    db.prepare('SELECT 1 AS ok').get();
    return 'connected';
  } catch {
    return 'error';
  }
}

function buildReport({ backend, databaseFile, dbHandle }) {
  const report = {
    checked_at: new Date().toISOString(),
    backend,
    connectivity: 'unknown',
    sqlite: null,
    storage: { persistence: 'unknown', reason: 'not applicable' }
  };
  try {
    report.connectivity = (dbHandle || db).prepare('SELECT 1 AS ok').get() ? 'connected' : 'error';
  } catch {
    report.connectivity = 'error';
  }
  if (backend === 'sqlite') {
    report.sqlite = sqliteFacts(databaseFile);
    report.storage = storageKind(databaseFile);
  } else {
    // Remote managed database: nothing local to inspect and nothing to expose.
    report.storage = { persistence: 'unknown', reason: 'database is hosted elsewhere, not on this filesystem' };
  }
  return report;
}

function denied(res) {
  // Identical response whether the secret is unset, too weak, missing or wrong:
  // a caller cannot tell the endpoint exists.
  return res.status(404).json({ error: 'Not found.' });
}

router.get('/db-diagnostic', (req, res) => {
  const expected = configuredSecret();
  if (!expected) return denied(res);
  const header = req.get('x-db-diagnostic-secret');
  const auth = req.get('authorization') || '';
  const provided = header || (/^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, '') : '');
  if (!provided || !constantTimeEquals(provided, expected)) return denied(res);

  try {
    const backend = db.backendKind === 'postgres' ? 'postgres' : 'sqlite';
    res.set('cache-control', 'no-store');
    res.json(buildReport({ backend, databaseFile: config.databaseFile }));
  } catch {
    res.status(500).json({ error: 'Diagnostic failed.' });
  }
});

module.exports = { router, buildReport, sqliteFacts, storageKind, strongSecret, MIN_SECRET_LENGTH };
