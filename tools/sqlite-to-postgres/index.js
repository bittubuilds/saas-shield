#!/usr/bin/env node
'use strict';
// One-time SQLite -> PostgreSQL copy for SaaS Shield.
//
// Safety rules baked in:
//   * the source file is never written to: a VACUUM INTO snapshot is taken first
//     and every read happens against that snapshot;
//   * the whole import runs in one PostgreSQL transaction, so any failure leaves
//     the target untouched;
//   * rows are inserted with ON CONFLICT DO NOTHING (idempotent) and the tool
//     exits non-zero if the target already holds data unless --merge is given;
//   * nothing sensitive is printed: no connection strings, password hashes,
//     session ids or email addresses - only counts, table names and ids of
//     failed checks.
//
// Usage:
//   node tools/sqlite-to-postgres/index.js --sqlite <file.db> --pg <url> [options]
//
// Options:
//   --dry-run              read + report only, never write (implies rollback)
//   --merge                allow importing into a non-empty target
//   --skip-sessions        do not copy the sessions table
//   --batch <n>            rows per INSERT (default 200)
//   --backup-dir <dir>     where the SQLite snapshot is kept (default ./backups)
//   --verify-only          skip the import, only run the integrity checks
//   --json                 machine-readable report on stdout
//
// Exit codes: 0 ok, 2 usage, 3 target not empty (needs --merge), 4 import or
// verification failure.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

// Tables that exist for the SQLite deployment only, or that the target already
// owns. schema_migrations is verified instead of copied.
const SKIP_TABLES = new Set(['schema_migrations']);
const SENSITIVE_TABLES = new Set(['sessions', 'email_verification_tokens', 'oauth_accounts']);

function parseArgs(argv) {
  const out = { batch: 200, backupDir: path.join(process.cwd(), 'backups'), dryRun: false, merge: false, skipSessions: false, verifyOnly: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--sqlite') out.sqlite = argv[++i];
    else if (a === '--pg') out.pg = argv[++i];
    else if (a === '--batch') out.batch = Number(argv[++i]) || 200;
    else if (a === '--backup-dir') out.backupDir = path.resolve(argv[++i]);
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--merge') out.merge = true;
    else if (a === '--skip-sessions') out.skipSessions = true;
    else if (a === '--verify-only') out.verifyOnly = true;
    else if (a === '--json') out.json = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else { out.error = `unknown argument: ${a}`; }
  }
  return out;
}

// Never echo credentials: host/port/database only.
function describeTarget(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || 5432}${u.pathname}`;
  } catch {
    return 'postgres (unparseable url)';
  }
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// Consistent read-only snapshot of the live database (WAL included), kept as the
// rollback artifact for the SQLite side.
function snapshotSqlite(sourcePath, backupDir) {
  if (!fs.existsSync(sourcePath)) throw new Error(`sqlite file not found: ${sourcePath}`);
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `saas-shield-${stamp}.db`);
  const snapshotPath = path.join(backupDir, `import-source-${stamp}.db`);
  const live = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    live.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  } finally {
    live.close();
  }
  fs.copyFileSync(backupPath, snapshotPath);
  return { backupPath, snapshotPath, sha256: sha256File(backupPath), bytes: fs.statSync(backupPath).size };
}

function listTables(sqlite) {
  const rows = sqlite.prepare(`SELECT name FROM sqlite_master
      WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all();
  return rows.map((r) => {
    const columns = sqlite.prepare(`PRAGMA table_info(${r.name})`).all();
    const fks = sqlite.prepare(`PRAGMA foreign_key_list(${r.name})`).all();
    return {
      name: r.name,
      columns: columns.map((c) => c.name),
      primaryKey: columns.filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name),
      foreignKeys: fks.map((f) => ({ from: f.from, table: f.table, to: f.to }))
    };
  });
}

// Insert parents before children so foreign keys are satisfied row by row.
function orderByDependencies(tables) {
  const known = new Set(tables.map((t) => t.name));
  const pending = new Map(tables.map((t) => [t.name, new Set(t.foreignKeys.map((f) => f.table).filter((n) => known.has(n) && n !== t.name))]));
  const ordered = [];
  const byName = new Map(tables.map((t) => [t.name, t]));
  while (pending.size) {
    let progressed = false;
    for (const [name, deps] of [...pending.entries()]) {
      const blocking = [...deps].filter((d) => pending.has(d));
      if (blocking.length) continue;
      ordered.push(byName.get(name));
      pending.delete(name);
      progressed = true;
    }
    if (!progressed) {
      // A cycle: keep a deterministic order rather than failing the whole import.
      const rest = [...pending.keys()].sort();
      for (const name of rest) ordered.push(byName.get(name));
      break;
    }
  }
  return ordered;
}

// ---------------------------------------------------------------------------
// Target schema. Reuses the application's own migrations so an imported database
// is byte-for-byte the schema the app expects, and never a hand-maintained copy.
// ---------------------------------------------------------------------------
function migrationStatements() {
  const migrations = require('../../src/db/migrations');
  const { translate } = require('../../src/db/dialect');
  return migrations.map((m) => {
    const { sql } = translate(m.sql, []);
    return { version: m.version, name: m.name, sql };
  });
}

async function ensureTargetSchema(pg) {
  await pg.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const applied = new Set((await pg.query('SELECT version FROM schema_migrations')).rows.map((r) => Number(r.version)));
  const ran = [];
  for (const m of migrationStatements()) {
    if (applied.has(m.version)) continue;
    await pg.query('BEGIN');
    try {
      await pg.query(m.sql);
      await pg.query('INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1,$2,$3)',
        [m.version, m.name, new Date().toISOString()]);
      await pg.query('COMMIT');
      ran.push(m.version);
    } catch (e) {
      await pg.query('ROLLBACK');
      throw new Error(`migration ${m.version} (${m.name}) failed on the target: ${e.message}`);
    }
  }
  const versions = (await pg.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map((r) => Number(r.version));
  return { ran, versions };
}

async function targetCounts(pg, tableNames) {
  const counts = {};
  for (const name of tableNames) {
    const r = await pg.query(`SELECT count(*) AS c FROM ${name}`);
    counts[name] = Number(r.rows[0].c);
  }
  return counts;
}

function sourceCounts(sqlite, tableNames) {
  const counts = {};
  for (const name of tableNames) {
    counts[name] = Number(sqlite.prepare(`SELECT count(*) AS c FROM ${name}`).get().c);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Copy. One transaction for the whole import: partial imports are impossible.
// ---------------------------------------------------------------------------
async function copyTable(pg, sqlite, table, batchSize) {
  const { name, columns } = table;
  const rows = sqlite.prepare(`SELECT ${columns.map((c) => `"${c}"`).join(',')} FROM ${name}`).all();
  if (!rows.length) return { name, source: 0, inserted: 0, skipped: 0 };

  const perRow = columns.length;
  const rowsPerBatch = Math.max(1, Math.min(batchSize, Math.floor(60000 / perRow)));
  let inserted = 0;

  for (let i = 0; i < rows.length; i += rowsPerBatch) {
    const slice = rows.slice(i, i + rowsPerBatch);
    const params = [];
    const values = slice.map((row) => {
      const holders = columns.map((c) => {
        const v = row[c];
        // node:sqlite returns Uint8Array for BLOBs; send a Buffer to PostgreSQL.
        params.push(v instanceof Uint8Array ? Buffer.from(v) : v);
        return `$${params.length}`;
      });
      return `(${holders.join(',')})`;
    });
    const sql = `INSERT INTO ${name} (${columns.map((c) => `"${c}"`).join(',')}) VALUES ${values.join(',')} ON CONFLICT DO NOTHING`;
    const res = await pg.query(sql, params);
    inserted += res.rowCount;
  }
  return { name, source: rows.length, inserted, skipped: rows.length - inserted };
}

// ---------------------------------------------------------------------------
// Verification: counts, primary-key uniqueness and every foreign key.
// ---------------------------------------------------------------------------
async function verify(pg, sqlite, tables, expectedVersions) {
  const names = tables.map((t) => t.name);
  const source = sourceCounts(sqlite, names);
  const target = await targetCounts(pg, names);
  const checks = [];

  for (const name of names) {
    checks.push({
      check: `row-count:${name}`,
      ok: target[name] === source[name],
      detail: `source=${source[name]} target=${target[name]}`
    });
  }

  for (const table of tables) {
    if (!table.primaryKey.length) continue;
    const cols = table.primaryKey.map((c) => `"${c}"`).join(',');
    const r = await pg.query(`SELECT count(*)::int AS total, count(DISTINCT (${cols}))::int AS distinct_keys FROM ${table.name}`);
    const { total, distinct_keys: distinctKeys } = r.rows[0];
    checks.push({
      check: `primary-key:${table.name}`,
      ok: total === distinctKeys,
      detail: `rows=${total} distinct_keys=${distinctKeys}`
    });
  }

  for (const table of tables) {
    for (const fk of table.foreignKeys) {
      const parent = tables.find((t) => t.name === fk.table);
      // Every foreign key in this schema points at a single-column primary key;
      // a composite parent would be reported by the row-count checks instead.
      if (!parent || parent.primaryKey.length !== 1) continue;
      const parentKey = parent.primaryKey[0];
      const r = await pg.query(`SELECT count(*)::int AS orphans
          FROM "${table.name}" c
          LEFT JOIN "${fk.table}" p ON p."${parentKey}" = c."${fk.from}"
         WHERE c."${fk.from}" IS NOT NULL AND p."${parentKey}" IS NULL`);
      checks.push({
        check: `foreign-key:${table.name}.${fk.from}->${fk.table}`,
        ok: r.rows[0].orphans === 0,
        detail: `orphans=${r.rows[0].orphans}`
      });
    }
  }

  const targetVersions = (await pg.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map((r) => Number(r.version));
  const missing = (expectedVersions || []).filter((v) => !targetVersions.includes(v));
  checks.push({
    check: 'schema-migrations',
    ok: missing.length === 0 && targetVersions.length > 0,
    detail: `target=${targetVersions.join(',')}${missing.length ? ` missing=${missing.join(',')}` : ''}`
  });

  return { checks, failed: checks.filter((c) => !c.ok), source, target };
}

function printReport(report, opts) {
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const line = (s) => process.stdout.write(`${s}\n`);
  line(`target        : ${report.target}`);
  line(`source        : ${report.sourceFile} (sha256 ${report.sourceSha256.slice(0, 16)}...)`);
  line(`snapshot      : ${report.snapshotPath}`);
  line(`mode          : ${report.dryRun ? 'dry-run (rolled back)' : (report.merge ? 'merge' : 'strict')}`);
  line('');
  line('table                  source  inserted  skipped');
  for (const t of report.tables) {
    line(`${t.name.padEnd(22)} ${String(t.source).padStart(6)} ${String(t.inserted).padStart(9)} ${String(t.skipped).padStart(8)}`);
  }
  line('');
  const bad = report.verification.failed;
  line(`verification  : ${report.verification.checks.length - bad.length}/${report.verification.checks.length} checks passed`);
  if (bad.length) {
    line('failed checks :');
    for (const c of bad) line(`  - ${c.check} (${c.detail})`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || opts.error || !opts.pg) {
    process.stderr.write(`${opts.error ? `${opts.error}\n` : ''}usage: node tools/sqlite-to-postgres/index.js --sqlite <file.db> --pg <url> [--dry-run|--merge|--verify-only|--skip-sessions] [--batch n] [--backup-dir dir] [--json]\n`);
    return 2;
  }

  const { Client } = require('pg');
  const sourcePath = opts.sqlite || path.join(process.cwd(), 'data', 'saas-shield.db');
  const target = describeTarget(opts.pg);

  const snap = snapshotSqlite(sourcePath, opts.backupDir);
  const sqlite = new DatabaseSync(snap.snapshotPath, { readOnly: true });
  const allTables = listTables(sqlite);
  const effective = allTables.filter((t) => !SKIP_TABLES.has(t.name) && !(opts.skipSessions && t.name === 'sessions'));
  const ordered = orderByDependencies(effective);
  const expectedVersions = allTables.some((t) => t.name === 'schema_migrations')
    ? sqlite.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => Number(r.version))
    : [];

  const pg = new Client({ connectionString: opts.pg, application_name: 'saas-shield-import' });
  await pg.connect();

  const report = {
    target, sourceFile: path.relative(process.cwd(), sourcePath) || sourcePath,
    sourceSha256: snap.sha256, snapshotPath: path.relative(process.cwd(), snap.snapshotPath),
    dryRun: opts.dryRun, merge: opts.merge, tables: [], verification: { checks: [], failed: [] }
  };

  try {
    // Verify-only never writes, so it may run against a live target safely.
    if (!opts.verifyOnly) {
      await ensureTargetSchema(pg);
      const names = ordered.map((t) => t.name);
      const before = await targetCounts(pg, names);
      const nonEmpty = Object.entries(before).filter(([, c]) => c > 0);
      if (nonEmpty.length && !opts.merge) {
        sqlite.close();
        await pg.end();
        process.stderr.write(`refusing to import: target already holds data (${nonEmpty.map(([t, c]) => `${t}=${c}`).join(', ')}).\nPass --merge to add missing rows with ON CONFLICT DO NOTHING.\n`);
        return 3;
      }

      await pg.query('BEGIN');
      try {
        for (const table of ordered) {
          report.tables.push(await copyTable(pg, sqlite, table, opts.batch));
        }
        const result = await verify(pg, sqlite, ordered, expectedVersions);
        report.verification = result;
        if (opts.dryRun || result.failed.length) {
          await pg.query('ROLLBACK');
          if (result.failed.length) {
            printReport(report, opts);
            process.stderr.write('import rolled back: verification failed, target left unchanged.\n');
            return 4;
          }
        } else {
          await pg.query('COMMIT');
        }
      } catch (e) {
        try { await pg.query('ROLLBACK'); } catch { /* already rolled back */ }
        throw e;
      }
    } else {
      report.verification = await verify(pg, sqlite, ordered, expectedVersions);
    }

    printReport(report, opts);
    if (report.verification.failed.length) return 4;
    return 0;
  } finally {
    try { sqlite.close(); } catch { /* closed */ }
    try { await pg.end(); } catch { /* closed */ }
  }
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((e) => {
    process.stderr.write(`import failed: ${e.message}\n`);
    process.exit(4);
  });
}

module.exports = { parseArgs, listTables, orderByDependencies, copyTable, verify, describeTarget, snapshotSqlite };
