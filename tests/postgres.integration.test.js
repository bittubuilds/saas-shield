'use strict';
// PostgreSQL integration: skipped unless DATABASE_URL points at a real server.
//
// Run with:
//   DATABASE_URL=postgres://user:pass@host:5432/dbname node --test tests/postgres.integration.test.js
//
// This is not a mock. It boots the real server module against the configured
// database and drives the HTTP API, and it compares the PostgreSQL schema with
// the SQLite schema table by table and column by column.
process.env.PORT = '0';
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_FILE;              // PostgreSQL must be the only backend
process.env.SHIELD_ALLOW_PRIVATE_IPS = 'true';
process.env.AUTH_RATE_LIMIT = '100';
process.env.COOKIE_SECURE = 'false';
process.env.AUTH_REQUIRE_EMAIL_VERIFICATION = 'false';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const enabled = Boolean(process.env.DATABASE_URL);
const opts = { skip: enabled ? false : 'set DATABASE_URL to run PostgreSQL integration tests' };

if (enabled) {
  const { server } = require('../src/server');
  const db = require('../src/db/index');
  const migrations = require('../src/db/migrations');
const { applyMigrations } = require('../src/db/migrate');

  let BASE = null;
  async function ready() {
    if (BASE) return;
    if (!server.listening) await new Promise((r) => server.once('listening', r));
    BASE = `http://127.0.0.1:${server.address().port}/api`;
  }

  function client() {
    let cookie = null;
    return async (path, o = {}) => {
      const res = await fetch(BASE + path, {
        method: o.method || 'GET',
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        body: o.body ? JSON.stringify(o.body) : undefined,
        redirect: 'manual'
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      let data = {};
      try { data = await res.json(); } catch { /* empty */ }
      return { status: res.status, data };
    };
  }

  after(() => Promise.resolve(server.close()));

  test('the backend is PostgreSQL and every migration ran', opts, async () => {
    assert.equal(db.backendKind, 'postgres');
    const applied = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => Number(r.version));
    // Every migration the code defines must be applied on this database, in order.
    // A hardcoded list silently went stale as new migrations landed; the source of
    // truth is the migration module itself.
    const defined = migrations.map((m) => Number(m.version)).sort((a, b) => a - b);
    assert.deepEqual(applied, defined, `applied ${applied.join(',')} vs defined ${defined.join(',')}`);
    // Idempotent: re-running the runner writes nothing.
    assert.equal(applyMigrations(db, { log: () => {} }), 0);
  });

  test('PostgreSQL schema matches the SQLite schema', opts, () => {
    const pgTables = db.prepare("SELECT tablename FROM pg_tables WHERE schemaname='public'").all().map((r) => r.tablename);
    const sqlite = require('../src/db/sqlite-backend');
    const sqliteTables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
    const missing = sqliteTables.filter((t) => !pgTables.includes(t));
    assert.deepEqual(missing, [], 'every SQLite table must exist in PostgreSQL');

    const pgCols = {};
    for (const row of db.prepare("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public'").all()) {
      (pgCols[row.table_name] = pgCols[row.table_name] || []).push(row.column_name);
    }
    for (const t of sqliteTables) {
      const cols = sqlite.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
      const absent = cols.filter((c) => !(pgCols[t] || []).includes(c));
      assert.deepEqual(absent, [], `columns missing on ${t}`);
    }
  });

  test('signup, login and session persistence work on PostgreSQL', opts, async () => {
    await ready();
    const c = client();
    const email = `pg${Date.now()}@example.com`;
    const signup = await c('/auth/signup', { method: 'POST', body: { email, password: 'PgpAss#1234', workspace_name: 'PG Co' } });
    assert.equal(signup.status, 201);
    const me = await c('/auth/me');
    assert.equal(me.data.user.email, email);
    assert.equal(me.data.workspaces.length, 1);

    // The session survives a fresh request cycle (server-side session row in PG).
    const again = await c('/auth/me');
    assert.equal(again.data.user.email, email);
    const sessions = db.prepare('SELECT COUNT(*) c FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.email=?').get(email).c;
    assert.ok(sessions >= 1);

    const login = await client()('/auth/signin', { method: 'POST', body: { email, password: 'PgpAss#1234' } });
    assert.equal(login.status, 200);
  });

  test('workspace isolation and website registration hold on PostgreSQL', opts, async () => {
    await ready();
    const a = client(); const b = client();
    const mk = (c, email) => c('/auth/signup', { method: 'POST', body: { email, password: 'PgpAss#1234', workspace_name: 'W' } });
    await mk(a, `pga${Date.now()}@example.com`);
    await mk(b, `pgb${Date.now()}@example.com`);

    const wsA = (await a('/auth/me')).data.workspaces[0].id;
    const wsB = (await b('/auth/me')).data.workspaces[0].id;
    assert.notEqual(wsA, wsB);

    const site = await a(`/workspaces/${wsA}/websites`, { method: 'POST', body: { url: 'https://example.org/', kind: 'original' } });
    assert.equal(site.status, 201);
    assert.equal((await a(`/workspaces/${wsA}/websites`)).data.websites.length, 1);
    // Cross-workspace reads must not leak.
    const crossWorkspace = await b(`/workspaces/${wsA}/websites`);
    assert.ok([403, 404].includes(crossWorkspace.status), 'other workspace must be closed');
    assert.equal((await b(`/workspaces/${wsB}/websites`)).data.websites.length, 0);
  });

  test('concurrent writes keep the database consistent', opts, async () => {
    await ready();
    const c = client();
    await c('/auth/signup', { method: 'POST', body: { email: `pgc${Date.now()}@example.com`, password: 'PgpAss#1234', workspace_name: 'C' } });
    const ws = (await c('/auth/me')).data.workspaces[0].id;

    const urls = Array.from({ length: 8 }, (_, i) => `https://concurrent-${i}-${Date.now()}.example/`);
    const results = await Promise.all(urls.map((url) => c(`/workspaces/${ws}/websites`, { method: 'POST', body: { url, kind: 'comparison' } })));
    assert.ok(results.every((r) => r.status === 201), 'every concurrent insert succeeded');
    const count = db.prepare('SELECT COUNT(*) c FROM websites WHERE workspace_id=?').get(ws).c;
    assert.equal(count, urls.length, 'no writes were lost');
  });
}
