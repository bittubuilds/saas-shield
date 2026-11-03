'use strict';
// The diagnostic endpoint is temporary, so these tests pin its contract:
// it is invisible without a strong configured secret, it authenticates in
// constant time, and it never leaks anything but the allowed facts.

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NODE_ENV = 'test';
process.env.DB_DIAGNOSTIC_SECRET = SECRET;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shield-diag-'));
process.env.DATABASE_FILE = path.join(tmpDir, 'diagnostic.db');
process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:47999';
delete process.env.DATABASE_URL;

const { server } = require('../src/server');
const diag = require('../src/routes/db-diagnostic-routes');

let base;
before(async () => {
  await new Promise((resolve) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

const get = (headers = {}) => fetch(`${base}/api/internal/db-diagnostic`, { headers });

const ALLOWED_TOP = ['backend', 'checked_at', 'connectivity', 'sqlite', 'storage'];
const ALLOWED_SQLITE = ['file_exists', 'file_size_bytes', 'integrity_check', 'integrity_issues', 'readable'];

test('a correct secret returns the database facts', async () => {
  const res = await get({ 'x-db-diagnostic-secret': SECRET });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.backend, 'sqlite');
  assert.equal(body.connectivity, 'connected');
  assert.equal(body.sqlite.file_exists, true);
  assert.ok(body.sqlite.file_size_bytes > 0, 'a real database has a size');
  assert.equal(body.sqlite.readable, true);
  assert.equal(body.sqlite.integrity_check, 'ok');
  assert.equal(body.sqlite.integrity_issues, 0);
  assert.ok(['persistent', 'ephemeral', 'unknown'].includes(body.storage.persistence));
  assert.ok(typeof body.storage.reason === 'string');
});

test('authorization is optional in form but strict in effect', async () => {
  const bearer = await get({ authorization: `Bearer ${SECRET}` });
  assert.equal(bearer.status, 200, 'Bearer is accepted too');
});

test('a missing, wrong or empty secret is indistinguishable from a missing route', async () => {
  const none = await get();
  const wrong = await get({ 'x-db-diagnostic-secret': 'nope' });
  const empty = await get({ 'x-db-diagnostic-secret': '' });
  const prefix = await get({ 'x-db-diagnostic-secret': SECRET.slice(0, 31) });
  // A caller must not be able to tell "denied" from "no such route". The app's
  // own API 404 shape is { error: 'Not found.' }, and every denied variant here
  // returns exactly that, so the endpoint is invisible unless you hold the
  // secret. (Unmatched /api paths answer 401 when unauthenticated because each
  // router mounts requireAuth first, so the 404 body is the stable comparison.)
  for (const res of [none, wrong, empty, prefix]) {
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('x-db-diagnostic-secret'), null, 'no echoed secret');
    assert.deepEqual(await res.json(), { error: 'Not found.' });
  }
});

test('a secret shorter than 32 characters is treated as not configured', () => {
  assert.equal(diag.strongSecret('short'), false);
  assert.equal(diag.strongSecret('a'.repeat(31)), false);
  assert.equal(diag.strongSecret('a'.repeat(32)), true);
  assert.equal(diag.strongSecret(undefined), false);
});

test('the response contains only the allowed fields, and no sensitive values', async () => {
  const res = await get({ 'x-db-diagnostic-secret': SECRET });
  const raw = await res.text();
  const body = JSON.parse(raw);
  assert.deepEqual(Object.keys(body).sort(), ALLOWED_TOP);
  assert.deepEqual(Object.keys(body.sqlite).sort(), ALLOWED_SQLITE);
  assert.deepEqual(Object.keys(body.storage).sort(), ['persistence', 'reason']);

  // Nothing that could identify a user, a credential or a location.
  assert.ok(!/password|token|secret|authorization|cookie/i.test(raw), 'no credential vocabulary');
  assert.ok(!/postgres(ql)?:\/\//i.test(raw), 'no connection string');
  assert.ok(!raw.includes(tmpDir), 'no filesystem path');
  assert.ok(!/@[a-z0-9-]+\.[a-z]{2,}/i.test(raw), 'no email address');
  assert.ok(!/SELECT |INSERT |CREATE TABLE/i.test(raw), 'no SQL echoed back');
});

test('database errors are reported as facts, never as stack traces', () => {
  const missing = diag.sqliteFacts(path.join(tmpDir, 'does-not-exist.db'));
  assert.deepEqual(missing, {
    file_exists: false, file_size_bytes: null, readable: false, integrity_check: 'unknown', integrity_issues: null
  });

  const corrupt = path.join(tmpDir, 'corrupt.db');
  fs.writeFileSync(corrupt, Buffer.from('this is not a sqlite database at all, just bytes'));
  const facts = diag.sqliteFacts(corrupt);
  assert.equal(facts.file_exists, true);
  assert.equal(facts.readable, false, 'an unparseable file is not readable');
  assert.ok(['failed', 'error'].includes(facts.integrity_check));
  assert.ok(!JSON.stringify(facts).includes('sqlite database'), 'file contents never echoed');

  // A directory where a file is expected must not throw either.
  const asDir = diag.sqliteFacts(tmpDir);
  assert.equal(asDir.file_exists, false);
  assert.equal(asDir.readable, false);
});

test('a PostgreSQL backend reports connection status only', () => {
  const report = diag.buildReport({
    backend: 'postgres',
    databaseFile: '/nonexistent/ignored.db',
    dbHandle: { prepare: () => ({ get: () => ({ ok: 1 }) }) }
  });
  assert.equal(report.backend, 'postgres');
  assert.equal(report.connectivity, 'connected');
  assert.equal(report.sqlite, null, 'no SQLite fields for a remote database');
  assert.equal(report.storage.persistence, 'unknown');
  const raw = JSON.stringify(report);
  assert.ok(!/postgres(ql)?:\/\//i.test(raw));
  assert.ok(!/password|user:/i.test(raw));

  const broken = diag.buildReport({
    backend: 'postgres',
    dbHandle: { prepare: () => ({ get: () => { throw new Error('connect ECONNREFUSED 10.0.0.1:5432'); } }) }
  });
  assert.equal(broken.connectivity, 'error');
  assert.ok(!JSON.stringify(broken).includes('ECONNREFUSED'), 'connection error text is not exposed');
});

test('the endpoint is read-only: no writes, no backups, no leftover files', async () => {
  const before = fs.readdirSync(tmpDir).sort();
  const sizeBefore = fs.statSync(process.env.DATABASE_FILE).size;
  await get({ 'x-db-diagnostic-secret': SECRET });
  const afterFiles = fs.readdirSync(tmpDir).sort();
  assert.deepEqual(afterFiles.filter((f) => !/-(wal|shm)$/.test(f)), before.filter((f) => !/-(wal|shm)$/.test(f)));
  assert.equal(fs.statSync(process.env.DATABASE_FILE).size, sizeBefore, 'database file unchanged');
});
