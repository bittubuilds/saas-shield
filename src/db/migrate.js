'use strict';
// Migration runner for backends that do not migrate themselves.
//
// SQLite applies its migrations at module load (unchanged, the default path).
// PostgreSQL uses this runner with the exact same statements from
// ./migrations.js, so a table cannot exist in one backend and not the other.
// The dialect translator is what makes the shared DDL valid PostgreSQL.
const MIGRATIONS = require('./migrations');

function nowIso() { return new Date().toISOString(); }

// Advisory lock key for migrations. Any process that wants to migrate takes this
// lock inside the same transaction that applies the DDL, so two instances starting
// together cannot interleave. It is released by COMMIT/ROLLBACK automatically.
const MIGRATION_LOCK_NAMESPACE = 21842;
const MIGRATION_LOCK_KEY = 7;

function bootstrap(db) {
  const ddl = `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`;
  // CREATE TABLE IF NOT EXISTS still races in PostgreSQL: two sessions can both
  // pass the existence check and one then fails on pg_type's unique index. That
  // failure means the other process won and the table now exists, so retry once.
  for (let attempt = 0; ; attempt += 1) {
    try { db.exec(ddl); return; } catch (e) {
      if (attempt >= 1 || !/duplicate key|already exists/i.test(e.message)) throw e;
    }
  }
}

function applyMigrations(db, { log = console.log, lock = false } = {}) {
  bootstrap(db);
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => Number(r.version)));
  let count = 0;
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.exec('BEGIN');
    try {
      // Whoever gets here first wins; the loser waits, then sees the row and skips.
      if (lock) db.prepare('SELECT pg_advisory_xact_lock(?, ?)').get(MIGRATION_LOCK_NAMESPACE, MIGRATION_LOCK_KEY);
      const done = db.prepare('SELECT 1 AS e FROM schema_migrations WHERE version=?').get(m.version);
      if (done) { db.exec('COMMIT'); continue; }
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?,?,?)')
        .run(m.version, m.name, nowIso());
      db.exec('COMMIT');
      count += 1;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw new Error(`migration ${m.version} (${m.name}) failed: ${e.message}`);
    }
  }
  if (count) log(`[db] applied ${count} migration(s)`);
  return count;
}

// Data migrations that depend on configuration, guarded by a meta flag so they
// run once. Mirrors the SQLite path.
function postMigrate(db, config, { log = console.log } = {}) {
  const metaGet = (k) => {
    const row = db.prepare('SELECT value FROM app_meta WHERE key=?').get(k);
    return row ? row.value : null;
  };
  const metaSet = (k, v) => {
    db.prepare(`INSERT INTO app_meta (key, value, updated_at) VALUES (?,?,?)
                ON CONFLICT (key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
      .run(k, v, nowIso());
  };

  if (config.auth.grandfatherExistingUsers && metaGet('auth.grandfather_v2') === null) {
    const result = db.prepare(`UPDATE users
        SET email_verified_at = COALESCE(email_verified_at, created_at),
            email_verified_source = COALESCE(email_verified_source, 'migration')
        WHERE email_verified_at IS NULL`).run();
    metaSet('auth.grandfather_v2', nowIso());
    if (result.changes > 0) log(`[db] grandfathered ${result.changes} pre-existing account(s) as email-confirmed`);
  }

  const missing = db.prepare(`SELECT w.id FROM workspaces w
      LEFT JOIN notification_settings n ON n.workspace_id = w.id
      WHERE n.workspace_id IS NULL`).all();
  for (const row of missing) {
    db.prepare(`INSERT INTO notification_settings
      (workspace_id, immediate_email, digest_enabled, digest_day, digest_hour_utc, min_severity, include_empty_digest, updated_at)
      VALUES (?,1,1,?,?, 'high',0,?)`)
      .run(row.id, config.alerts.defaultDigestDay, config.alerts.defaultDigestHourUtc, nowIso());
  }
}

module.exports = { applyMigrations, postMigrate, MIGRATIONS };
