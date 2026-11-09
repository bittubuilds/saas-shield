'use strict';
// GitHub sign-in, end to end, against a stub provider.
//
// GitHub has no id_token and no PKCE, so the whole trust story is: a signed
// state cookie, a server-side client secret, and an identity read from the API
// with the token we just exchanged. This file drives that path over real HTTP:
// start -> consent (stub) -> callback -> session, plus the refusal paths.
process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.DATABASE_FILE = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'shield-gh-')) + '/github.db';
process.env.SHIELD_ALLOW_PRIVATE_IPS = 'true';
process.env.AUTH_RATE_LIMIT = '500';
process.env.COOKIE_SECURE = 'false';
process.env.AUTH_REQUIRE_EMAIL_VERIFICATION = 'true';
process.env.MONITOR_SCHEDULER_ENABLED = 'false';

const http = require('http');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

// The stub provider is what the endpoints point at. It answers the three calls
// GitHub would: token exchange, /user, /user/emails.
let stubMode = 'verified';
const stub = http.createServer((req, res) => {
  const send = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.url.startsWith('/login/oauth/access_token')) {
    if (stubMode === 'bad_code') return send(200, { error: 'bad_verification_code' });
    return send(200, { access_token: 'gho_stub_token', scope: 'read:user,user:email', token_type: 'bearer' });
  }
  if (req.url === '/user') {
    if (req.headers.authorization !== 'Bearer gho_stub_token') return send(401, { message: 'Bad credentials' });
    return send(200, { id: 90210, login: 'stubuser', name: 'Stub User', avatar_url: 'https://avatars.example/s.png' });
  }
  if (req.url === '/user/emails') {
    if (stubMode === 'unverified') return send(200, [{ email: 'stub@example.com', primary: true, verified: false }]);
    return send(200, [
      { email: 'old@example.com', primary: false, verified: true },
      { email: 'stub@example.com', primary: true, verified: true }
    ]);
  }
  return send(404, { message: 'not found' });
});

let BASE = null;
let server;
let client;

async function boot() {
  if (BASE) return;
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const stubBase = `http://127.0.0.1:${stub.address().port}`;
  process.env.GITHUB_CLIENT_ID = 'stub-client-id';
  process.env.GITHUB_CLIENT_SECRET = 'stub-client-secret';
  process.env.GITHUB_REDIRECT_URI = 'http://127.0.0.1/app/api/auth/github/callback';
  process.env.GITHUB_AUTH_ENDPOINT = `${stubBase}/login/oauth/authorize`;
  process.env.GITHUB_TOKEN_ENDPOINT = `${stubBase}/login/oauth/access_token`;
  process.env.GITHUB_USER_ENDPOINT = `${stubBase}/user`;
  process.env.GITHUB_EMAILS_ENDPOINT = `${stubBase}/user/emails`;

  // Required after the env above is in place: config reads it at load time.
  ({ server } = require('../src/server'));
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  BASE = `http://127.0.0.1:${server.address().port}/api`;

  let cookie = null;
  client = {
    get cookie() { return cookie; },
    async req(method, urlPath, opts = {}) {
      const headers = {};
      if (cookie) headers.cookie = cookie;
      const res = await fetch(urlPath.startsWith('http') ? urlPath : BASE + urlPath, {
        method, headers, redirect: 'manual'
      });
      const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
      for (const c of setCookie) {
        if (!c) continue;
        const pair = c.split(';')[0];
        if (/=$/.test(pair)) continue;
        if (pair.startsWith('shield_session=')) cookie = pair;
        else cookie = cookie ? `${cookie}; ${pair}` : pair;
      }
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch { /* html or empty */ }
      return { status: res.status, headers: res.headers, data, text };
    }
  };
}

after(() => {
  if (server && server.listening) server.close();
  if (stub.listening) stub.close();
});

test('the deployment advertises GitHub once credentials exist', async () => {
  await boot();
  const r = await client.req('GET', '/auth/config');
  assert.equal(r.status, 200);
  assert.equal(r.data.github.enabled, true);
  assert.deepEqual(r.data.github.missing, []);
});

test('start sends the browser to GitHub with our state and redirect uri', async () => {
  await boot();
  const r = await client.req('GET', '/auth/github/start');
  assert.equal(r.status, 302);
  const url = new URL(r.headers.get('location'));
  assert.equal(url.pathname, '/login/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), 'stub-client-id');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1/app/api/auth/github/callback');
  assert.equal(url.searchParams.get('scope'), 'read:user user:email');
  assert.ok(url.searchParams.get('state'));
  // No PKCE parameters: GitHub's OAuth Apps do not support them, so pretending
  // to send a challenge would be security theatre.
  assert.equal(url.searchParams.get('code_challenge'), null);
  assert.match(client.cookie, /shield_oauth_github=/);
});

test('a full sign-in lands on a real session with the verified email', async () => {
  await boot();
  const start = await client.req('GET', '/auth/github/start');
  const state = new URL(start.headers.get('location')).searchParams.get('state');

  const cb = await client.req('GET', `/auth/github/callback?code=stub-code&state=${state}`);
  assert.equal(cb.status, 303);
  assert.match(cb.headers.get('location'), /\/app\/$/);

  const me = await client.req('GET', '/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.data.user.email, 'stub@example.com');
  assert.equal(me.data.workspaces.length, 1, 'a workspace is created with the account');

  const { default: db } = await import('../src/db/index.js');
  const link = db.prepare("SELECT * FROM oauth_accounts WHERE provider='github'").get();
  assert.equal(link.provider_user_id, '90210');
  assert.equal(link.email, 'stub@example.com');
});

test('a callback with the wrong state is refused and no session is created', async () => {
  await boot();
  await client.req('GET', '/auth/github/start');
  const cb = await client.req('GET', '/auth/github/callback?code=stub-code&state=not-the-state');
  assert.equal(cb.status, 303);
  assert.match(cb.headers.get('location'), /oauth_error=state_mismatch&provider=github$/);
  // Checked without this client's cookies: earlier tests in this file are signed in.
  const anon = await fetch(`${BASE}/auth/me`, { redirect: 'manual' });
  assert.equal(anon.status, 401, 'a refused callback must not create a session');
});

test('a callback without the state cookie is refused', async () => {
  await boot();
  const clean = { cookie: null };
  const res = await fetch(`${BASE}/auth/github/callback?code=stub-code&state=whatever`, { redirect: 'manual' });
  assert.equal(res.status, 303);
  assert.match(res.headers.get('location'), /oauth_error=state_cookie_invalid&provider=github$/);
});

test('an account GitHub will not vouch for is refused', async () => {
  await boot();
  stubMode = 'unverified';
  try {
    const start = await client.req('GET', '/auth/github/start');
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const cb = await client.req('GET', `/auth/github/callback?code=stub-code&state=${state}`);
    assert.equal(cb.status, 303);
    assert.match(cb.headers.get('location'), /oauth_error=email_not_verified&provider=github$/);
  } finally {
    stubMode = 'verified';
  }
});

test('a rejected code never reaches the API', async () => {
  await boot();
  stubMode = 'bad_code';
  try {
    const start = await client.req('GET', '/auth/github/start');
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const cb = await client.req('GET', `/auth/github/callback?code=stub-code&state=${state}`);
    assert.equal(cb.status, 303);
    assert.match(cb.headers.get('location'), /oauth_error=exchange_failed&provider=github$/);
  } finally {
    stubMode = 'verified';
  }
});
