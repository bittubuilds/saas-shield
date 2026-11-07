'use strict';
// PostgreSQL worker.
//
// The application was written against a synchronous SQLite driver, so every call
// site expects a result immediately. Rather than convert ~390 call sites to async,
// the async `pg` driver lives in this worker and the main thread blocks on a
// shared buffer until the answer arrives. That keeps the existing concurrency
// profile (queries serialize per process, exactly like node:sqlite) while using a
// maintained driver with a real connection pool.
//
// Transactions: BEGIN pins one pooled client until COMMIT/ROLLBACK, so the
// app's db.exec('BEGIN') ... COMMIT sequences keep their semantics.
const { parentPort, workerData } = require('worker_threads');
const { Pool, types } = require('pg');
const { translate } = require('./dialect');

// Keep the numeric behaviour the SQLite driver had: counts and sums are numbers,
// not strings. (pg returns int8/numeric as strings to protect precision.)
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

const pool = new Pool({
  connectionString: workerData.connectionString,
  max: Number(workerData.poolMax || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000
});
pool.on('error', (e) => console.error('[pg] idle client error:', e.message));

let txClient = null;

function encode(value) {
  const json = JSON.stringify(value, (k, v) => {
    if (typeof v === 'bigint') return Number(v);
    return v;
  });
  return Buffer.from(json, 'utf8');
}

function reply(sab, payload) {
  const ctrl = new Int32Array(sab, 0, 4);
  const bytes = new Uint8Array(sab, 16);
  const buf = encode(payload);
  if (buf.length > bytes.length) {
    // Never truncate silently: report it so the caller sees a real error.
    const fallback = Buffer.from(JSON.stringify({
      ok: false,
      error: `result too large for the shared buffer (${buf.length} bytes)`
    }), 'utf8');
    bytes.set(fallback.subarray(0, bytes.length));
    Atomics.store(ctrl, 1, Math.min(fallback.length, bytes.length));
  } else {
    bytes.set(buf);
    Atomics.store(ctrl, 1, buf.length);
  }
  Atomics.store(ctrl, 0, payload.ok === false ? 2 : 1);
  Atomics.notify(ctrl, 0);
}

async function runQuery({ sql, params, mode }) {
  const client = txClient || pool;
  const res = await client.query(sql, params);
  const rows = res.rows || [];
  if (mode === 'run') return { ok: true, rows: [], rowCount: res.rowCount || 0 };
  if (mode === 'get') return { ok: true, rows: rows.slice(0, 1), rowCount: res.rowCount || 0 };
  return { ok: true, rows, rowCount: res.rowCount || 0 };
}

parentPort.on('message', async (msg) => {
  const { sab, sql, params, mode } = msg;
  const head = String(sql || '').trim().split(/\s+/)[0].toUpperCase();
  try {
    if (/^PRAGMA\b/i.test(String(sql).trim())) {
      return reply(sab, { ok: true, rows: [], rowCount: 0 });
    }
    if (head === 'BEGIN' || head === 'START') {
      if (!txClient) txClient = await pool.connect();
      await txClient.query('BEGIN');
      return reply(sab, { ok: true, rows: [], rowCount: 0 });
    }
    // Only a transaction-ending statement ends the pinned client. Matching on the
    // first word alone broke savepoints: 'ROLLBACK TO SAVEPOINT x' starts with
    // ROLLBACK, so it released the transaction and every later statement ran
    // autocommit outside it. A restore that relied on savepoints then committed a
    // partial load. Match the whole statement instead.
    const statement = String(sql || '').trim().replace(/;+$/, '');
    const endsTransaction = /^(COMMIT|ROLLBACK|END)(\s+(TRANSACTION|WORK))?$/i.test(statement);
    if (endsTransaction) {
      if (!txClient) return reply(sab, { ok: true, rows: [], rowCount: 0 });
      const client = txClient;
      try { await client.query(statement.split(/\s+/)[0].toUpperCase()); } finally { txClient = null; client.release(); }
      return reply(sab, { ok: true, rows: [], rowCount: 0 });
    }
    const t = translate(sql, params);
    if (t.sql === null) return reply(sab, { ok: true, rows: [], rowCount: 0 });
    return reply(sab, await runQuery({ sql: t.sql, params: t.params, mode }));
  } catch (e) {
    return reply(sab, { ok: false, error: e.message, code: e.code || null, detail: e.detail || null });
  }
});

async function shutdown() {
  try { if (txClient) { txClient.release(); txClient = null; } } catch { /* ignore */ }
  try { await pool.end(); } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
