'use strict';
// Database entry point.
//
// SQLite stays the default and behaves exactly as before. PostgreSQL is selected
// only when DATABASE_URL is set, and reuses the same migrations through the
// dialect translator, so the two schemas cannot drift.
const config = require('../config');

let db;
let backend;

if (process.env.DATABASE_URL) {
  const pg = require('./pg-backend');
  const { applyMigrations, postMigrate } = require('./migrate');
  db = pg.open({ url: process.env.DATABASE_URL });
  backend = 'postgres';
  console.log(`[db] PostgreSQL backend: ${db.label}`);
  try {
    applyMigrations(db, { lock: true });
    postMigrate(db, config);
  } catch (e) {
    console.error('[db] PostgreSQL migration failed:', e.message);
    throw e;
  }
  db.MIGRATIONS = require('./migrations');
  db.metaGet = (k) => {
    const row = db.prepare('SELECT value FROM app_meta WHERE key=?').get(k);
    return row ? row.value : null;
  };
  db.metaSet = (k, v) => db.prepare(`INSERT INTO app_meta (key, value, updated_at) VALUES (?,?,?)
      ON CONFLICT (key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .run(k, v, new Date().toISOString());
} else {
  db = require('./sqlite-backend');
  backend = 'sqlite';
}

module.exports = db;
module.exports.backendKind = backend;
