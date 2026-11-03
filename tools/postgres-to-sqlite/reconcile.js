#!/usr/bin/env node
'use strict';
// Reconciliation for rolling a cutover back to SQLite.
//
// Removing DATABASE_URL does NOT undo anything: from the moment of cutover every
// account, workspace, website, scan and finding is written to PostgreSQL only.
// Pointing the app back at the old SQLite file therefore silently rolls the
// product back in time. This tool copies PostgreSQL rows that SQLite is missing
// (and newer versions of rows it has) back into the SQLite file first.
//
//   node tools/postgres-to-sqlite/reconcile.js \
//     --pg postgres://user:pass@host/db --sqlite ./data/saas-shield.db [--dry-run]
//
// Limits, stated plainly: it replays inserts and newer updates. Rows *deleted*
// in PostgreSQL are re-inserted into SQLite if SQLite still has them, so delete
// the SQLite file instead of reconciling it if deletions matter.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { Client } = require('pg');

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? def : args[i + 1];
};
const PG_URL = arg('pg');
const SQLITE = arg('sqlite');
const DRY = args.includes('--dry-run');
if (!PG_URL || !SQLITE) {
  console.error('usage: reconcile.js --pg <url> --sqlite <file> [--dry-run]');
  process.exit(2);
}
if (!fs.existsSync(SQLITE)) {
  console.error('sqlite file not found:', SQLITE);
  process.exit(2);
}
const redact = (s) => String(s).replace(/(postgres(?:ql)?:\/\/)[^@\s]+@/gi, '$1<credentials>@');

const sqlite = new DatabaseSync(SQLITE);
sqlite.exec('PRAGMA foreign_keys = ON;');

const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name").all()
  .map((r) => r.name);

function columns(name) {
  return sqlite.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name);
}
function primaryKey(name) {
  return sqlite.prepare(`PRAGMA table_info(${name})`).all().filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name);
}
// Parents before children, using the same signal as the importer.
function order() {
  const deps = new Map();
  for (const t of tables) {
    deps.set(t, sqlite.prepare(`PRAGMA foreign_key_list(${t})`).all().map((f) => f.table).filter((p) => tables.includes(p) && p !== t));
  }
  const done = [];
  const seen = new Set();
  while (done.length < tables.length) {
    const ready = tables.filter((t) => !seen.has(t) && deps.get(t).every((p) => seen.has(p) || !tables.includes(p)));
    if (!ready.length) { for (const t of tables) if (!seen.has(t)) done.push(t); break; }
    for (const t of ready) { done.push(t); seen.add(t); }
  }
  return done;
}

async function main() {
  const pg = new Client({ connectionString: PG_URL });
  await pg.connect();
  console.log(`reconcile ${redact(PG_URL)} -> ${path.basename(SQLITE)}${DRY ? ' (dry run)' : ''}`);
  const report = [];
  let inserts = 0;
  let updates = 0;

  for (const table of order()) {
    const cols = columns(table);
    const pk = primaryKey(table);
    if (!pk.length) continue;
    const { rows } = await pg.query(`SELECT ${cols.map((c) => `"${c}"`).join(',')} FROM "${table}"`);
    if (!rows.length) { report.push({ table, inserted: 0, updated: 0, missing: 0 }); continue; }

    const existing = new Map();
    for (const r of sqlite.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(',')} FROM ${table}`).all()) {
      existing.set(pk.map((k) => String(r[k])).join('\u0000'), r);
    }
    const toInsert = [];
    const toUpdate = [];
    for (const row of rows) {
      const key = pk.map((k) => String(row[k])).join('\u0000');
      const local = existing.get(key);
      if (!local) { toInsert.push(row); continue; }
      if (row.updated_at && local.updated_at && String(row.updated_at) > String(local.updated_at)) toUpdate.push(row);
    }
    report.push({ table, inserted: toInsert.length, updated: toUpdate.length, missing: 0 });

    if (DRY) continue;
    const stmtInsert = sqlite.prepare(`INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
    const setClause = cols.filter((c) => !pk.includes(c)).map((c) => `"${c}"=?`).join(',');
    const whereClause = pk.map((c) => `"${c}"=?`).join(' AND ');
    const stmtUpdate = setClause ? sqlite.prepare(`UPDATE ${table} SET ${setClause} WHERE ${whereClause}`) : null;

    sqlite.exec('BEGIN');
    try {
      for (const row of toInsert) { stmtInsert.run(...cols.map((c) => row[c] ?? null)); inserts += 1; }
      for (const row of toUpdate) {
        if (!stmtUpdate) continue;
        const setCols = cols.filter((c) => !pk.includes(c));
        stmtUpdate.run(...setCols.map((c) => row[c] ?? null), ...pk.map((c) => row[c]));
        updates += 1;
      }
      sqlite.exec('COMMIT');
    } catch (e) {
      try { sqlite.exec('ROLLBACK'); } catch { /* ignore */ }
      console.error(`  failed on ${table}: ${e.message}`);
      process.exit(1);
    }
  }

  for (const r of report) {
    if (r.inserted || r.updated) console.log(`  ${r.table.padEnd(24)} inserted=${String(r.inserted).padStart(3)} updated=${String(r.updated).padStart(3)}`);
  }
  const fk = sqlite.prepare('PRAGMA foreign_key_check').all();
  const integrity = Object.values(sqlite.prepare('PRAGMA integrity_check').get())[0];
  console.log(`\ntotals: inserted=${inserts} updated=${updates}${DRY ? ' (nothing written)' : ''}`);
  console.log(`sqlite integrity: ${integrity} | foreign-key problems: ${fk.length}`);
  await pg.end();
  sqlite.close();
  if (integrity !== 'ok' || fk.length) process.exit(4);
}

main().catch((e) => { console.error('reconcile error:', redact(e.message)); process.exit(1); });
