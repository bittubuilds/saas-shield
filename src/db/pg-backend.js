'use strict';
// PostgreSQL backend with the same synchronous shape as the SQLite backend.
//
// Public surface (identical to node:sqlite usage in this codebase):
//   db.prepare(sql).run(...params) -> { changes }
//   db.prepare(sql).get(...params) -> row | undefined
//   db.prepare(sql).all(...params) -> row[]
//   db.exec(sql)                   -> void (multi-statement DDL/DML, BEGIN/COMMIT)
//   db.close()                     -> graceful shutdown of the pool
//
// The connection string is never logged, returned to clients, or included in
// error messages; only the database name is reported.
const path = require('path');
const { Worker } = require('worker_threads');

const BUFFER_BYTES = 16 * 1024 * 1024;   // 16 MB of shared result space

function databaseLabel(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || 5432}${u.pathname}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

function open({ url } = {}) {
  const connectionString = url || process.env.DATABASE_URL;
  if (!connectionString) throw new Error('open() needs a DATABASE_URL');

  const sab = new SharedArrayBuffer(16 + BUFFER_BYTES);
  const ctrl = new Int32Array(sab, 0, 4);
  const bytes = new Uint8Array(sab, 16);
  const decoder = new TextDecoder();
  const timeoutMs = Number(process.env.PG_QUERY_TIMEOUT_MS || 30_000);

  const worker = new Worker(path.join(__dirname, 'pg-worker.js'), {
    workerData: { sab, connectionString, poolMax: process.env.PG_POOL_MAX || 10 }
  });
  // Do not keep the process alive: the main thread blocks while a query runs, so
  // the worker never needs to hold the event loop open.
  if (typeof worker.unref === 'function') worker.unref();

  let fatal = null;
  worker.on('error', (e) => { fatal = e; Atomics.store(ctrl, 0, 2); Atomics.notify(ctrl, 0); });
  worker.on('exit', (code) => {
    if (code !== 0) { fatal = new Error(`pg worker exited with code ${code}`); }
    Atomics.store(ctrl, 0, 2);
    Atomics.notify(ctrl, 0);
  });

  function call(sqlText, params, mode) {
    if (fatal) throw fatal;
    Atomics.store(ctrl, 0, 0);
    Atomics.store(ctrl, 1, 0);
    worker.postMessage({ sab, sql: sqlText, params, mode });
    const waited = Atomics.wait(ctrl, 0, 0, timeoutMs);
    if (waited === 'timed-out') {
      throw new Error(`database query timed out after ${timeoutMs}ms`);
    }
    const len = Atomics.load(ctrl, 1);
    const payload = decoder.decode(bytes.subarray(0, len));
    let parsed;
    try { parsed = JSON.parse(payload); } catch { throw new Error('database returned an unreadable response'); }
    if (!parsed.ok) {
      const err = new Error(parsed.error || 'database error');
      if (parsed.code) err.code = parsed.code;
      throw err;
    }
    return parsed;
  }

  function paramsFrom(args) {
    if (args.length === 1 && Array.isArray(args[0])) return args[0];
    return args;
  }

  const db = {
    backend: 'postgres',
    label: databaseLabel(connectionString),
    prepare(sqlText) {
      return {
        run: (...args) => {
          const res = call(sqlText, paramsFrom(args), 'run');
          return { changes: res.rowCount, lastInsertRowid: null };
        },
        get: (...args) => {
          const res = call(sqlText, paramsFrom(args), 'get');
          return res.rows[0];
        },
        all: (...args) => call(sqlText, paramsFrom(args), 'all').rows
      };
    },
    exec(sqlText) {
      if (/^\s*pragma\b/i.test(sqlText)) return;   // SQLite-only tuning
      call(sqlText, [], 'exec');
    },
    close() {
      return new Promise((resolve) => {
        worker.once('exit', () => resolve());
        worker.terminate().then(() => resolve()).catch(() => resolve());
      });
    }
  };
  return db;
}

module.exports = { open, databaseLabel };
