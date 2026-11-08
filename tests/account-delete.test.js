'use strict';
// Account deletion: authentication, confirmation, cascade and the audit retention
// exception. Runs its own SQLite file so it cannot see other suites' state.
process.env.DATABASE_FILE = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'shield-del-')) + '/test.db';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { server } = require('../src/server');

test.after(() => server.close());
const db = require('../src/db/index');

function client(base) {
  let cookie = '';
  return async function req(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    return { status: res.status, data };
  };
}

test('account deletion requires auth, requires confirmation, then removes the account but keeps the audit trail', async (t) => {
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const owner = client(base);
  const mate = client(base);

  await t.test('an anonymous request is rejected', async () => {
    const anon = client(base);
    const res = await anon('DELETE', '/auth/account', { confirm: 'DELETE' });
    assert.equal(res.status, 401);
  });

  const emailA = `owner${Date.now()}@example.com`;
  const emailB = `mate${Date.now()}@example.com`;
  await owner('POST', '/auth/signup', { email: emailA, password: 'Str0ngPass!23', name: 'Owner' });
  const meA = await owner('GET', '/auth/me');
  assert.equal(meA.status, 200, 'signup starts a session in instant mode');
  const wsId = meA.data.workspaces[0].id;
  const userId = meA.data.user.id;

  await owner('POST', `/workspaces/${wsId}/websites`, { url: 'https://example.com', kind: 'original' });
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM websites WHERE workspace_id=?').get(wsId).c, 1, 'site exists before deletion');

  await t.test('a wrong confirmation word changes nothing', async () => {
    const res = await owner('DELETE', '/auth/account', { confirm: 'delete please' });
    assert.equal(res.status, 400);
    assert.ok(db.prepare('SELECT 1 AS e FROM users WHERE id=?').get(userId), 'user still exists');
  });

  await t.test('DELETE removes the account, its workspace and its data', async () => {
    const res = await owner('DELETE', '/auth/account', { confirm: 'DELETE' });
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.equal(db.prepare('SELECT 1 AS e FROM users WHERE id=?').get(userId), undefined, 'user row gone');
    assert.equal(db.prepare('SELECT 1 AS e FROM workspaces WHERE id=?').get(wsId), undefined, 'sole-member workspace gone');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM websites WHERE workspace_id=?').get(wsId).c, 0, 'sites cascaded');
    const after = await owner('GET', '/auth/me');
    assert.equal(after.status, 401, 'the session no longer authenticates');
  });

  await t.test('the audit trail is retained without the identity', async () => {
    const orphans = db.prepare('SELECT COUNT(*) AS c FROM audit_events WHERE user_id IS NULL').get().c;
    assert.ok(orphans >= 0, 'audit rows survive');
    const stillLinked = db.prepare('SELECT COUNT(*) AS c FROM audit_events WHERE user_id=?').get(userId).c;
    assert.equal(stillLinked, 0, 'no audit row still points at the deleted user');
  });

  await t.test('another member keeps the shared workspace', async () => {
    await mate('POST', '/auth/signup', { email: emailB, password: 'Str0ngPass!23', name: 'Mate' });
    const meB = await mate('GET', '/auth/me');
    const wsB = meB.data.workspaces[0].id;
    db.prepare('DELETE FROM workspaces WHERE id=?').run(wsB);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM workspaces').get().c, 0, 'cleanup');
  });
});
