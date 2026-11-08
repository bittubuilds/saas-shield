'use strict';
// Database entry point.
//
// SQLite stays the default and behaves exactly as before. PostgreSQL is selected
// only when DATABASE_URL is set, and reuses the same migrations through the
// dialect translator, so the two schemas cannot drift.
const config = require('../config');

let db;
let backend;

// A transient error while Render starts must not kill the deploy: the free plan
// wakes slowly and Neon can refuse the first connection. Attempts are bounded, so
// a genuinely broken configuration still fails loudly.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function openPostgres(pg, applyMigrations, postMigrate) {
  const attempts = Math.max(1, Number(process.env.DB_BOOTSTRAP_ATTEMPTS || 3));
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let candidate = null;
    try {
      candidate = pg.open({ url: process.env.DATABASE_URL });
      applyMigrations(candidate, { lock: true });
      postMigrate(candidate, config);
      return candidate;
    } catch (e) {
      lastError = e;
      try { if (candidate) candidate.close(); } catch { /* already closed */ }
      if (attempt >= attempts) break;
      const wait = Math.min(8000, 1000 * (2 ** (attempt - 1)));
      console.error(`[db] PostgreSQL bootstrap attempt ${attempt}/${attempts} failed: ${e.message} - retrying in ${wait}ms`);
      sleepSync(wait);
    }
  }
  console.error('[db] PostgreSQL bootstrap failed after retries:', lastError && lastError.message);
  throw lastError;
}

if (process.env.DATABASE_URL) {
  const pg = require('./pg-backend');
  const { applyMigrations, postMigrate } = require('./migrate');
  db = openPostgres(pg, applyMigrations, postMigrate);
  backend = 'postgres';
  console.log(`[db] PostgreSQL backend: ${db.label}`);
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
