#!/usr/bin/env node
'use strict';
// Copy an existing SQLite database into PostgreSQL.
//
// Used once, during the durability cutover, so the accounts, websites, scans,
// findings and credit records already held by a running instance are not thrown
// away. It is additive and idempotent: existing rows win, nothing is deleted, and
// re-running after a partial copy simply finishes the job.
//
// Usage: DATABASE_URL=postgres://... node tools/db-copy-sqlite-to-pg.js [path/to/file.db]
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const source = path.resolve(process.argv[2] || process.env.SQLITE_SOURCE || 'data/saas-shield.db');
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required: this tool copies INTO PostgreSQL.');
  process.exit(2);
}
if (!fs.existsSync(source)) {
  console.error(`source database not found: ${source}`);
  process.exit(2);
}

const src = new DatabaseSync(source, { readOnly: true });
const db = require('../src/db/index');

if (db.backendKind !== 'postgres') {
  console.error('refusing to run: DATABASE_URL did not select the PostgreSQL backend');
  process.exit(2);
}

// Parents before children, so foreign keys hold as rows arrive.
const ORDER = [
  'users', 'workspaces', 'memberships', 'sites', 'websites', 'pages', 'scans', 'results',
  'passages', 'evidence', 'review_events', 'audit_events', 'sessions', 'email_verification_tokens',
  'oauth_accounts', 'auth_events', 'discoveries', 'email_outbox', 'monitored_pages', 'snapshots',
  'changes', 'alerts', 'alert_deliveries', 'digests', 'notification_settings', 'app_meta', 'job_locks'
];

const tables = src.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
const present = new Set(tables);
const ordered = [...ORDER.filter((t) => present.has(t)), ...tables.filter((t) => !ORDER.includes(t) && t !== 'schema_migrations')];

const report = { source, copied: {}, skipped_tables: [], errors: [] };

db.exec('BEGIN');
try {
  for (const table of ordered) {
    const exists = db.prepare(`SELECT to_regclass(?) AS t`).get(`public.${table}`);
    if (!exists || !exists.t) { report.skipped_tables.push(`${table}: table missing in target`); continue; }
    const rows = src.prepare(`SELECT * FROM "${table}"`).all();
    let inserted = 0;
    for (const row of rows) {
      const cols = Object.keys(row);
      if (!cols.length) continue;
      const sql = `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(',')})
                   VALUES (${cols.map(() => '?').join(',')}) ON CONFLICT DO NOTHING`;
      try {
        const res = db.prepare(sql).run(...cols.map((c) => row[c]));
        if (res && res.changes) inserted += 1;
      } catch (e) {
        report.errors.push(`${table}: ${e.message}`);
      }
    }
    report.copied[table] = { rows_in_source: rows.length, inserted, already_present: rows.length - inserted };
  }
  db.exec('COMMIT');
} catch (e) {
  try { db.exec('ROLLBACK'); } catch { /* ignore */ }
  console.error(JSON.stringify({ ok: false, error: e.message, report }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: report.errors.length === 0, ...report }, null, 2));
process.exit(report.errors.length === 0 ? 0 : 1);
