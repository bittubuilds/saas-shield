#!/usr/bin/env node
'use strict';
// Builds a synthetic SQLite database for exercising the importer (test/dev only).
// Values are derived from the live schema, so this keeps working as columns are
// added: required columns are filled from CHECK-constraint values where present.
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const file = process.argv[2] || path.join(process.cwd(), 'backups', 'fixture.db');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.rmSync(file, { force: true });
process.env.DATABASE_FILE = file;
process.env.NODE_ENV = 'test';
const db = require('../../src/db');

const now = '2026-11-01T09:00:00.000Z';
const later = '2026-11-02T09:00:00.000Z';

function enumValues(sql) {
  const map = new Map();
  const re = /CHECK\s*\(\s*(\w+)\s+IN\s*\(([^)]*)\)\)/gi;
  let m;
  while ((m = re.exec(sql))) {
    map.set(m[1], m[2].split(',').map((s) => s.trim().replace(/^'|'$/g, '')));
  }
  return map;
}

function makeId(table, n) {
  return `${table.slice(0, 3)}_${n}`;
}

function seed() {
  const tables = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type='table'
      AND name NOT LIKE 'sqlite_%' AND name NOT IN ('schema_migrations')`).all();
  const ids = new Map();          // table -> [ids]
  const rowsByTable = new Map();

  const order = ['users', 'workspaces', 'memberships', 'sessions', 'auth_events', 'audit_events',
    'websites', 'pages', 'monitored_pages', 'snapshots', 'scans', 'results', 'passages', 'evidence',
    'review_events', 'changes', 'alerts', 'alert_deliveries', 'email_outbox', 'notification_settings',
    'digests', 'job_locks', 'app_meta', 'oauth_accounts', 'email_verification_tokens', 'discoveries'];

  for (const name of order) {
    const meta = tables.find((t) => t.name === name);
    if (!meta) continue;
    const cols = db.prepare(`PRAGMA table_info(${name})`).all();
    const fks = db.prepare(`PRAGMA foreign_key_list(${name})`).all();
    const enums = enumValues(meta.sql || '');
    const count = (name === 'pages' || name === 'snapshots') ? 3 : 2;
    ids.set(name, []);
    rowsByTable.set(name, []);

    for (let n = 1; n <= count; n += 1) {
      const id = makeId(name, n);
      ids.get(name).push(id);
      const row = {};
      for (const c of cols) {
        const fk = fks.find((f) => f.from === c.name);
        if (c.pk && !fk) {
          row[c.name] = name === 'app_meta' ? `meta_${n}`
            : (cols.filter((x) => x.pk).length > 1 ? `${id}_${c.name}` : id);
          continue;
        }
        if (fk) {
          const parentIds = ids.get(fk.table) || [];
          row[c.name] = parentIds.length ? parentIds[(n - 1) % parentIds.length] : null;
          continue;
        }
        const colType = String(c.type || '').toUpperCase();
        const numeric = /INT|REAL|NUM|DEC|DOUBLE|FLOAT/.test(colType);
        if (enums.has(c.name)) {
          const allowed = enums.get(c.name);
          row[c.name] = numeric && /^-?\d+$/.test(allowed[0]) ? Number(allowed[0]) : allowed[0];
          continue;
        }
        if (numeric) { row[c.name] = 0; continue; }   // numeric columns never get text
        if (/created_at|updated_at|observed_at|detected_at|expires_at|_at$/.test(c.name)) { row[c.name] = c.name.startsWith('expires') ? later : now; continue; }
        if (/email/.test(c.name)) { row[c.name] = `user${n}@example.test`; continue; }
        if (/hash|token/.test(c.name)) { row[c.name] = `synthetic_${n}_${c.name}`; continue; }
        if (/url/.test(c.name)) { row[c.name] = `https://site${n}.example.test/`; continue; }
        if (/name|title|label|summary|detail|note|message|text|content|path|ip|owner|value|key/.test(c.name)) { row[c.name] = `x_${n}`; continue; }
        const type = String(c.type || '').toUpperCase();
        if (type.includes('INT') || type.includes('REAL') || type.includes('NUM')) { row[c.name] = 0; continue; }
        // A NOT NULL column must never receive an explicit NULL (that overrides its
        // DEFAULT): JSON-ish columns get '[]', everything else a short string.
        if (c.notnull) {
          row[c.name] = /heading|links|sections|text|body|json/i.test(c.name) ? '[]' : `x_${c.name}_${n}`;
        } else {
          row[c.name] = null;
        }
      }
      const keys = Object.keys(row).filter((k) => row[k] !== undefined);
      db.prepare(`INSERT INTO ${name} (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
        .run(...keys.map((k) => row[k]));
      rowsByTable.get(name).push(row);
    }
  }
  const summary = {};
  for (const { name } of tables) summary[name] = db.prepare(`SELECT count(*) c FROM ${name}`).get().c;
  return summary;
}

const summary = seed();
process.stdout.write(`${JSON.stringify(summary, null, 1)}\n`);
