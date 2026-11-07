'use strict';
// Database durability probe.
//
// The failure this exists to catch: on an ephemeral host (Render free plan, most
// serverless containers) the SQLite file lives inside the container image and is
// destroyed by the next deploy, restart, or scale event. The app keeps working and
// reports healthy while every account, scan and piece of evidence is gone.
//
// So "the process can query the database" is not the same question as "this data
// will still exist tomorrow". This module answers the second one and makes the
// answer visible at startup and on /api/health.

const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('./index');
const config = require('../config');

// Directories that are known to be rebuilt from the image on every deploy.
const EPHEMERAL_ROOTS = ['/app', '/usr/src/app', '/var/task', '/workspace', '/srv'];
// Temporary filesystems: writable, fast, and gone on restart. Treating them as
// durable would be the same false confidence this probe exists to remove.
const TEMP_ROOT = path.resolve(os.tmpdir());

function migrationVersion() {
  try {
    const row = db.prepare('SELECT MAX(version) v FROM schema_migrations').get();
    return row && row.v ? Number(row.v) : 0;
  } catch {
    return null;
  }
}

function tableCount() {
  try {
    const row = db.prepare('SELECT COUNT(*) c FROM schema_migrations').get();
    return row ? Number(row.c) : 0;
  } catch {
    return 0;
  }
}

function sqliteFacts(fileArg) {
  const file = path.resolve(fileArg || config.databaseFile);
  let bytes = null;
  try { bytes = fs.statSync(file).size; } catch { /* not created yet */ }
  const dir = path.dirname(file);
  const insideImage = EPHEMERAL_ROOTS.some((root) => (dir === root || dir.startsWith(root + path.sep)));
  const inTemp = dir === TEMP_ROOT || dir.startsWith(TEMP_ROOT + path.sep);
  const ephemeral = insideImage || inTemp;
  // A path is only treated as durable when an operator says so explicitly; guessing
  // "it looks like a mounted volume" would recreate exactly the false confidence
  // this probe exists to remove.
  const declaredPersistent = process.env.DB_PERSISTENT_PATH
    ? path.resolve(process.env.DB_PERSISTENT_PATH) === dir
    : false;
  return { file, dir, bytes, insideImage, inTemp, ephemeral, declaredPersistent };
}

function probe() {
  const backend = db.backendKind;
  let writable = false;
  let error = null;
  try {
    // A real write round-trip: a read-only or detached volume passes SELECT but
    // fails here, which is the failure mode that matters.
    db.prepare('INSERT INTO app_meta (key, value, updated_at) VALUES (?,?,?) ON CONFLICT (key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at')
      .run('durability_probe', new Date().toISOString(), new Date().toISOString());
    writable = true;
  } catch (e) {
    error = e.message;
  }

  const result = {
    backend,
    writable,
    migration: migrationVersion(),
    tables: tableCount(),
    error
  };

  if (backend === 'postgres') {
    // A managed PostgreSQL instance is the durable target; its own provider handles
    // the backing store. We report the label only, never the connection string.
    result.durable = writable;
    result.storage = 'managed-postgres';
    result.note = 'Durability is provided by the managed PostgreSQL service, not by this process.';
    return result;
  }

  const facts = sqliteFacts();
  Object.assign(result, facts);
  result.storage = 'sqlite-file';
  result.durable = writable && (!facts.ephemeral || facts.declaredPersistent);

  if (!result.durable) {
    result.note = facts.ephemeral
      ? 'SQLite file lives on throwaway storage (application image or temporary directory). On an ephemeral host it is destroyed on every deploy or restart. Set DATABASE_URL to a managed PostgreSQL instance, or mount a persistent disk and set DB_PERSISTENT_PATH to its directory.'
      : 'SQLite file is outside the image, but persistence could not be confirmed. Set DB_PERSISTENT_PATH to the mounted directory to declare it durable.';
  } else {
    result.note = 'SQLite file is on a path declared persistent.';
  }
  return result;
}

// Startup banner: one honest line, plus a loud warning when production is running
// on throwaway storage. It never blocks startup - breaking a running deployment
// would be worse than the warning - unless the operator opts into failing.
function announce(log = console) {
  const facts = probe();
  const where = facts.backend === 'postgres' ? facts.storage : facts.file;
  if (facts.durable) {
    log.log(`[db] storage: ${facts.backend} at ${where} (writable, migrations up to ${facts.migration})`);
    return facts;
  }
  log.warn(`[db] WARNING: storage is NOT durable - ${facts.backend} at ${where}`);
  log.warn(`[db] ${facts.note}`);
  if (process.env.DB_REQUIRE_DURABLE === 'true') {
    throw new Error('DB_REQUIRE_DURABLE=true and the configured database is not durable.');
  }
  return facts;
}

module.exports = { probe, announce, migrationVersion, sqliteFacts };
