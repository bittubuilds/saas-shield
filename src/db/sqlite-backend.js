'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('../config');

const dbFile = path.resolve(config.databaseFile);
fs.mkdirSync(path.dirname(dbFile), { recursive: true });

const db = new DatabaseSync(dbFile);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;');

// ---------------------------------------------------------------------------
// Versioned migrations. Each entry runs once, in order, recorded in
// schema_migrations. Add new entries to the end; never edit applied ones.
// ---------------------------------------------------------------------------
const MIGRATIONS = require('./migrations');;

function nowIso() {
  return new Date().toISOString();
}

function migrate() {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version)
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?,?,?)')
        .run(m.version, m.name, nowIso());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}
migrate();

// ---------------------------------------------------------------------------
// Data migrations that depend on configuration, applied once and recorded.
// ---------------------------------------------------------------------------
function metaGet(key) {
  const row = db.prepare('SELECT value FROM app_meta WHERE key=?').get(key);
  return row ? row.value : null;
}
function metaSet(key, value) {
  db.prepare(`INSERT INTO app_meta (key, value, updated_at) VALUES (?,?,?)
              ON CONFLICT (key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .run(key, String(value), nowIso());
}

function postMigrate() {
  // Accounts that existed before email verification was introduced are marked
  // confirmed with source='migration' so real users are not locked out, and so
  // the decision stays auditable (it is not the same as a verified signup).
  if (config.auth.grandfatherExistingUsers && metaGet('auth.grandfather_v2') === null) {
    const result = db.prepare(`UPDATE users
        SET email_verified_at = COALESCE(email_verified_at, created_at),
            email_verified_source = COALESCE(email_verified_source, 'migration')
        WHERE email_verified_at IS NULL`).run();
    metaSet('auth.grandfather_v2', nowIso());
    if (result.changes > 0) {
      console.log(`[db] grandfathered ${result.changes} pre-existing account(s) as email-confirmed (source=migration)`);
    }
  }

  // Give every workspace explicit notification defaults.
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
postMigrate();

// Exposed so tests can build a database at an older schema version and verify
// the upgrade path for existing accounts.
db.MIGRATIONS = MIGRATIONS;

module.exports = db;
module.exports.metaGet = metaGet;
module.exports.metaSet = metaSet;
