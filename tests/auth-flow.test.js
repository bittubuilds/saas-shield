'use strict';
// Authentication: email verification, token security, account enumeration,
// Google OIDC validation, and the migration path for accounts created before
// verification existed.
process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.DATABASE_FILE = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'shield-auth-')) + '/auth.db';
process.env.SHIELD_ALLOW_PRIVATE_IPS = 'true';
process.env.AUTH_RATE_LIMIT = '500';
process.env.COOKIE_SECURE = 'false';
process.env.AUTH_REQUIRE_EMAIL_VERIFICATION = 'true';   // the strict default
process.env.AUTH_DEV_EXPOSE_LINK = 'true';              // dev/test only
process.env.MONITOR_SCHEDULER_ENABLED = 'false';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { server } = require('../src/server');
const db = require('../src/db');
const verify = require('../src/verify');
const oauth = require('../src/oauth');
const config = require('../src/config');

after(() => {
  // Release the listener so the test process can exit.
  if (server && server.listening) server.close();
});

let BASE = null;
async function ready() {
  if (BASE) return;
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  BASE = `http://127.0.0.1:${server.address().port}/api`;
}

function client() {
  let cookie = null;
  return {
    async req(method, urlPath, body, opts = {}) {
      const headers = { 'content-type': 'application/json' };
      if (cookie) headers.cookie = cookie;
      const res = await fetch(BASE + urlPath, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual'
      });
      const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
      for (const c of setCookie) {
        if (!c) continue;
        if (/shield_session=;|shield_session=deleted/i.test(c)) cookie = null;
        else cookie = c.split(';')[0];
      }
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      return { status: res.status, data, headers: res.headers };
    },
    raw: (urlPath) => fetch(BASE + urlPath, { redirect: 'manual', headers: cookie ? { cookie } : {} }),
    hasCookie: () => Boolean(cookie)
  };
}

function extractLink(text) {
  const m = String(text || '').match(/https?:\/\/\S+token=[A-Za-z0-9_\-%]+/);
  return m ? m[0] : null;
}

// The dev link is absolute (publicBaseUrl). The client already prefixes /api, so
// strip that prefix from the parsed path before requesting.
function apiPath(link) {
  const u = new URL(link);
  return (u.pathname + u.search).replace(/^\/api/, '');
}

// ---------------------------------------------------------------------------
// Public configuration
// ---------------------------------------------------------------------------
test('auth config reports verification mode and Google availability honestly', async () => {
  await ready();
  const c = client();
  const r = await c.req('GET', '/auth/config');
  assert.equal(r.status, 200);
  assert.equal(r.data.email_verification_required, true);
  assert.equal(typeof r.data.verification_ttl_hours, 'number');
  // No provider configured in this environment: must say so rather than imply delivery.
  assert.equal(r.data.email.configured, false);
  assert.equal(r.data.email.provider, null);
  assert.ok(r.data.email.missing.length > 0);
  assert.equal(r.data.google.enabled, false);
  assert.deepEqual(r.data.google.missing, ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
});

// ---------------------------------------------------------------------------
// Signup + verification
// ---------------------------------------------------------------------------
let tokensForUser5 = null;

test('signup does not create a session and never marks the account verified', async () => {
  await ready();
  const c = client();
  const r = await c.req('POST', '/auth/signup', {
    email: 'verify@example.com', password: 'correcthorse1', workspace_name: 'Verified Co'
  });
  assert.equal(r.status, 201);
  assert.equal(c.hasCookie(), false, 'no session may be issued before verification');
  assert.equal(r.data.verification.required, true);
  assert.equal(r.data.verification.delivery, 'skipped', 'no provider configured -> skipped, never "sent"');
  assert.match(r.data.verification.note, /no email provider/i);
  assert.ok(r.data.verification.dev_link, 'dev link is exposed in test mode');

  const user = db.prepare('SELECT * FROM users WHERE email=?').get('verify@example.com');
  assert.ok(user);
  assert.equal(user.email_verified_at, null, 'registration must not verify the account');

  const me = await c.req('GET', '/auth/me');
  assert.equal(me.status, 401, 'unauthenticated until the address is confirmed');

  const signin = await c.req('POST', '/auth/signin', { email: 'verify@example.com', password: 'correcthorse1' });
  assert.equal(signin.status, 403);
  assert.equal(signin.data.code, 'email_unverified');
});

test('only a hash of the verification token is stored', async () => {
  const row = db.prepare(`SELECT * FROM email_verification_tokens ORDER BY created_at DESC LIMIT 1`).get();
  assert.ok(row);
  assert.match(row.id, /^[0-9a-f]{64}$/, 'token id is a sha256 digest, not the token');
  assert.match(row.code_hash, /^[0-9a-f]{64}$/);
  const raw = db.prepare("SELECT * FROM email_verification_tokens WHERE id NOT LIKE '%token%' LIMIT 1").get();
  assert.ok(!JSON.stringify(raw).includes('correcthorse1'), 'passwords never appear in token rows');
});

test('a valid magic link verifies the account and starts a session', async () => {
  await ready();
  const c = client();
  const signup = await c.req('POST', '/auth/signup', {
    email: 'link@example.com', password: 'correcthorse1', workspace_name: 'Link Co'
  });
  const link = signup.data.verification.dev_link;
  assert.ok(link);

  // The link is on the API origin; follow it with the same client (cookie jar).
  const r = await c.req('GET', apiPath(link));
  assert.equal(r.status, 303);
  assert.match(r.headers.get('location'), /verified=1/);
  assert.equal(c.hasCookie(), true, 'verification starts a session');

  const me = await c.req('GET', '/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.data.user.email_verified, true);
  assert.equal(me.data.user.email_verified_source, 'email_link');
  assert.equal(me.data.workspaces.length, 1);
});

test('a magic link cannot be reused', async () => {
  await ready();
  const c = client();
  const signup = await c.req('POST', '/auth/signup', {
    email: 'reuse@example.com', password: 'correcthorse1'
  });
  const path = apiPath(signup.data.verification.dev_link);

  const first = await c.req('GET', path);
  assert.equal(first.status, 303);
  assert.match(first.headers.get('location'), /verified=1/);

  const second = await c.req('GET', path);
  assert.equal(second.status, 303);
  assert.match(second.headers.get('location'), /verify-failed\?reason=used/);
});

test('tampered, expired and superseded tokens are rejected', async () => {
  await ready();
  const c = client();

  const signup = await c.req('POST', '/auth/signup', { email: 'tokens@example.com', password: 'correcthorse1' });
  const rawLink = new URL(signup.data.verification.dev_link);

  // Tampered: keep the shape, change the value.
  const tampered = rawLink.searchParams.get('token').slice(0, -4) + 'AAAA';
  const t = await c.req('GET', `/auth/verify?token=${encodeURIComponent(tampered)}`);
  assert.match(t.headers.get('location'), /reason=invalid/);

  // Unknown token.
  const junk = await c.req('GET', '/auth/verify?token=not-a-real-token-value-at-all');
  assert.match(junk.headers.get('location'), /reason=invalid/);

  // Expired: move the stored token's expiry into the past.
  const token = rawLink.searchParams.get('token');
  const id = crypto.createHash('sha256').update(token).digest('hex');
  db.prepare('UPDATE email_verification_tokens SET expires_at=? WHERE id=?')
    .run(new Date(Date.now() - 60000).toISOString(), id);
  const expired = await c.req('GET', `/auth/verify?token=${encodeURIComponent(token)}`);
  assert.match(expired.headers.get('location'), /reason=expired/);

  // Verify the account is still unverified after all of that.
  const user = db.prepare('SELECT email_verified_at FROM users WHERE email=?').get('tokens@example.com');
  assert.equal(user.email_verified_at, null);

  // Superseded: issuing a new token invalidates the previous unused one.
  const userRow = db.prepare('SELECT id FROM users WHERE email=?').get('tokens@example.com');
  const first = verify.issueVerification({ userId: userRow.id, email: 'tokens@example.com' });
  const second = verify.issueVerification({ userId: userRow.id, email: 'tokens@example.com' });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  const oldTokenResult = verify.consumeByToken(first.token);
  assert.equal(oldTokenResult.ok, false);
  assert.equal(oldTokenResult.error, 'invalidated');
  const newTokenResult = verify.consumeByToken(second.token);
  assert.equal(newTokenResult.ok, true);
  assert.equal(newTokenResult.userId, userRow.id);
});

test('the 6-digit code path verifies once, and locks out after too many wrong tries', async () => {
  await ready();
  const c = client();

  const signup = await c.req('POST', '/auth/signup', { email: 'code@example.com', password: 'correcthorse1' });
  const code = signup.data.verification.dev_code;
  assert.match(code, /^\d{6}$/);

  const wrong = await c.req('POST', '/auth/verify', { email: 'code@example.com', code: '000000' === code ? '111111' : '000000' });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.data.code, 'incorrect_code');
  assert.ok(wrong.data.attempts_left < verify.MAX_CODE_ATTEMPTS);

  const ok = await c.req('POST', '/auth/verify', { email: 'code@example.com', code });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.email_verified, true);
  assert.equal(c.hasCookie(), true);

  // Lockout: a fresh account, wrong code attempted until the token is burned.
  await c.req('POST', '/auth/signup', { email: 'lockout@example.com', password: 'correcthorse1' });
  const codes = [];
  for (let i = 0; i < verify.MAX_CODE_ATTEMPTS + 2; i++) {
    const r = await c.req('POST', '/auth/verify', { email: 'lockout@example.com', code: '999999' });
    assert.equal(r.status, 400, 'every wrong code is rejected');
    codes.push(r.data.code);
  }
  // Exactly MAX_CODE_ATTEMPTS - 1 wrong guesses report the remaining budget, the
  // attempt that exhausts it reports the lockout, and later attempts find a dead
  // token rather than a fresh budget.
  assert.equal(codes.filter((c) => c === 'incorrect_code').length, verify.MAX_CODE_ATTEMPTS - 1,
    `unexpected sequence: ${codes.join(',')}`);
  assert.equal(codes[verify.MAX_CODE_ATTEMPTS - 1], 'too_many_attempts');
  assert.equal(codes[codes.length - 1], 'invalid');
  const locked = db.prepare(`SELECT invalidated_reason, attempts FROM email_verification_tokens
      WHERE user_id=(SELECT id FROM users WHERE email=?)`).get('lockout@example.com');
  assert.equal(locked.invalidated_reason, 'too_many_attempts');
});

test('verification resends are rate limited', async () => {
  await ready();
  const c = client();
  await c.req('POST', '/auth/signup', { email: 'resend@example.com', password: 'correcthorse1' });

  const statuses = [];
  for (let i = 0; i < config.auth.verificationResendMax + 2; i++) {
    const r = await c.req('POST', '/auth/verify/resend', { email: 'resend@example.com' });
    statuses.push(r.status);
  }
  assert.equal(statuses[0], 200, `first resend should be allowed, got ${statuses.join(',')}`);
  assert.ok(statuses.includes(429), `expected a 429 once the budget is spent, got ${statuses.join(',')}`);
  const events = db.prepare("SELECT COUNT(*) c FROM auth_events WHERE action='verify_resend' AND lower(email)=?").get('resend@example.com').c;
  assert.ok(events >= config.auth.verificationResendMax, 'resend attempts are audited');
});

test('signup and resend never reveal whether an address already has an account', async () => {
  await ready();
  const c = client();
  const first = await c.req('POST', '/auth/signup', { email: 'enum@example.com', password: 'correcthorse1' });
  assert.equal(first.status, 201);

  const again = await c.req('POST', '/auth/signup', { email: 'enum@example.com', password: 'correcthorse1' });
  assert.equal(again.status, 201);
  assert.equal(again.data.workspace, undefined);
  assert.equal(again.data.user, undefined);
  assert.equal(again.data.message, first.data.message, 'identical message for existing and new accounts');

  const known = await c.req('POST', '/auth/verify/resend', { email: 'enum@example.com' });
  const unknown = await c.req('POST', '/auth/verify/resend', { email: 'nobody@example.com' });
  assert.equal(known.status, unknown.status);
  assert.equal(known.data.message, unknown.data.message);

  const accounts = db.prepare('SELECT COUNT(*) c FROM users WHERE email=?').get('enum@example.com').c;
  assert.equal(accounts, 1, 'a second signup must not create a second account');
});

test('passwords are stored as a slow hash and wrong passwords are rejected', async () => {
  await ready();
  const c = client();
  await c.req('POST', '/auth/signup', { email: 'hash@example.com', password: 'correcthorse1' });
  const user = db.prepare('SELECT password_hash FROM users WHERE email=?').get('hash@example.com');
  assert.match(user.password_hash, /^scrypt\$/);
  assert.ok(!user.password_hash.includes('correcthorse1'));

  const userRow = db.prepare('SELECT id FROM users WHERE email=?').get('hash@example.com');
  const issued = verify.issueVerification({ userId: userRow.id, email: 'hash@example.com' });
  verify.consumeByToken(issued.token);

  const bad = await c.req('POST', '/auth/signin', { email: 'hash@example.com', password: 'wrongpassword' });
  assert.equal(bad.status, 401);
  assert.equal(bad.data.error, 'Invalid email or password.');

  const good = await c.req('POST', '/auth/signin', { email: 'hash@example.com', password: 'correcthorse1' });
  assert.equal(good.status, 200);
  assert.equal(good.data.user.email_verified, true);
});

// ---------------------------------------------------------------------------
// Google OIDC (unit level: no network, injected keys)
// ---------------------------------------------------------------------------
function makeKeypair(kid = 'test-kid') {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  return { privateKey, jwk };
}

function signJwt(payload, privateKey, header = { alg: 'RS256', kid: 'test-kid' }) {
  const h = Buffer.from(JSON.stringify(header)).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url');
  return `${h}.${p}.${sig}`;
}

const { privateKey, jwk } = makeKeypair();
const KEYS = [jwk];
const now = () => Math.floor(Date.now() / 1000);

function claims(overrides = {}) {
  return {
    iss: 'https://accounts.google.com',
    aud: 'test-client-id',
    sub: 'google-sub-1',
    email: 'googleuser@example.com',
    email_verified: true,
    name: 'Google User',
    nonce: 'nonce-1',
    iat: now() - 10,
    exp: now() + 600,
    ...overrides
  };
}

test('a correctly signed Google id_token is accepted', () => {
  const token = signJwt(claims(), privateKey);
  const r = oauth.verifyIdToken(token, { keys: KEYS, nonce: 'nonce-1', audience: 'test-client-id' });
  assert.equal(r.ok, true);
  assert.equal(r.claims.email, 'googleuser@example.com');
  assert.equal(r.claims.sub, 'google-sub-1');
});

test('invalid Google id_tokens are rejected for every check', () => {
  const opts = { keys: KEYS, nonce: 'nonce-1', audience: 'test-client-id' };
  const cases = [
    ['wrong audience', signJwt(claims({ aud: 'someone-else' }), privateKey), 'bad_audience'],
    ['wrong issuer', signJwt(claims({ iss: 'https://evil.example' }), privateKey), 'bad_issuer'],
    ['expired', signJwt(claims({ exp: now() - 30 }), privateKey), 'expired'],
    ['wrong nonce', signJwt(claims({ nonce: 'other' }), privateKey), 'bad_nonce'],
    ['unverified email', signJwt(claims({ email_verified: false }), privateKey), 'email_not_verified_by_provider'],
    ['missing subject', signJwt(claims({ sub: undefined }), privateKey), 'missing_claims'],
    ['unsigned alg', signJwt(claims(), privateKey, { alg: 'none', kid: 'test-kid' }), 'unexpected_alg'],
    ['unknown key id', signJwt(claims(), privateKey, { alg: 'RS256', kid: 'other-kid' }), 'unknown_signing_key']
  ];
  for (const [label, token, expected] of cases) {
    const r = oauth.verifyIdToken(token, opts);
    assert.equal(r.ok, false, `${label} must be rejected`);
    assert.equal(r.error, expected, `${label} -> ${r.error} (expected ${expected})`);
  }

  // Signature tampering: valid structure, altered payload.
  const good = signJwt(claims(), privateKey);
  const [h, , s] = good.split('.');
  const forgedPayload = Buffer.from(JSON.stringify(claims({ email: 'attacker@example.com' }))).toString('base64url');
  const forged = `${h}.${forgedPayload}.${s}`;
  const tampered = oauth.verifyIdToken(forged, opts);
  assert.equal(tampered.ok, false);
  assert.equal(tampered.error, 'bad_signature');
});

test('Google account resolution creates a verified account, links safely, and refuses unsafe linking', async () => {
  const created = oauth.resolveUser({
    sub: 'google-sub-new', email: 'newgoogle@example.com', emailVerified: true, name: 'New Google'
  });
  assert.equal(created.ok, true);
  assert.equal(created.created, true);
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(created.userId);
  assert.equal(user.email_verified_at !== null, true, 'Google confirmed the address, so it is verified');
  assert.equal(user.email_verified_source, 'google');
  assert.equal(user.password_hash, 'oauth-only$', 'no usable password is invented');
  const membership = db.prepare('SELECT role FROM memberships WHERE user_id=?').get(created.userId);
  assert.equal(membership.role, 'owner', 'a workspace is created for the new account');

  const second = oauth.resolveUser({ sub: 'google-sub-new', email: 'newgoogle@example.com', emailVerified: true });
  assert.equal(second.userId, created.userId);
  assert.equal(second.created, false, 'repeated sign-in reuses the same account');

  // Existing verified password account: linking is allowed.
  await ready();
  const c = client();
  const signup = await c.req('POST', '/auth/signup', { email: 'linkme@example.com', password: 'correcthorse1' });
  await c.req('GET', apiPath(signup.data.verification.dev_link));

  const linked = oauth.resolveUser({ sub: 'google-sub-link', email: 'linkme@example.com', emailVerified: true });
  assert.equal(linked.ok, true);
  assert.equal(linked.created, false);
  assert.equal(linked.userId, db.prepare('SELECT id FROM users WHERE email=?').get('linkme@example.com').id);

  // Existing UNVERIFIED password account: linking must be refused, because the
  // person who registered it never proved they control the mailbox.
  const nowIso = new Date().toISOString();
  db.prepare('INSERT INTO users (id,email,password_hash,name,created_at,email_verified_at,email_verified_source) VALUES (?,?,?,?,?,NULL,NULL)')
    .run('usr_unverified', 'unverified@example.com', 'scrypt$aa$bb', null, nowIso);
  const refused = oauth.resolveUser({ sub: 'google-sub-unverified', email: 'unverified@example.com', emailVerified: true });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'local_account_unverified');
  const stillUnlinked = db.prepare('SELECT COUNT(*) c FROM oauth_accounts WHERE user_id=?').get('usr_unverified').c;
  assert.equal(stillUnlinked, 0, 'no OAuth link may be created for an unverified local account');
});

test('the OAuth state cookie is signed, expiring and tamper-proof', () => {
  const payload = { state: 'abc', nonce: 'def', cv: 'verifier', exp: Date.now() + 60000 };
  const cookie = oauth.signStateCookie(payload);
  const read = oauth.readStateCookie(cookie);
  assert.equal(read.state, 'abc');
  assert.equal(read.cv, 'verifier');

  const tampered = cookie.slice(0, -3) + 'AAA';
  assert.equal(oauth.readStateCookie(tampered), null, 'a modified cookie is rejected');
  assert.equal(oauth.readStateCookie('garbage'), null);

  const expired = oauth.signStateCookie({ ...payload, exp: Date.now() - 1000 });
  assert.equal(oauth.readStateCookie(expired), null, 'an expired cookie is rejected');

  const saved = { ...config.oauth.google };
  config.oauth.google.clientId = 'test-client-id';
  config.oauth.google.clientSecret = 'test-secret';
  config.oauth.google.redirectUri = 'http://localhost:3000/api/auth/google/callback';
  config.oauth.google.configured = true;
  const built = oauth.buildAuthorizeUrl();
  Object.assign(config.oauth.google, saved);
  assert.equal(built.ok, true);
  const url = new URL(built.url);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('state').length >= 20);
  assert.ok(url.searchParams.get('nonce').length >= 20);
  assert.equal(url.searchParams.get('scope'), 'openid email profile');
  assert.ok(!built.url.includes('test-secret'), 'client secret is never placed in a URL');
});

test('Google sign-in reports missing configuration instead of failing silently', async () => {
  await ready();
  const c = client();
  const r = await c.req('GET', '/auth/google/start');
  assert.equal(r.status, 503);
  assert.equal(r.data.code, 'google_not_configured');
  assert.deepEqual(r.data.missing, ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);

  const cb = await c.raw('/auth/google/callback?code=x&state=y');
  assert.equal(cb.status, 303);
  assert.match(cb.headers.get('location'), /oauth_error=not_configured/);
});

// ---------------------------------------------------------------------------
// Migration safety: accounts that existed before email verification
// ---------------------------------------------------------------------------
const legacySkip = process.env.DATABASE_URL
  ? 'builds a pre-verification SQLite file; PostgreSQL has no legacy-file upgrade path'
  : false;
test('accounts created before email verification keep working after the migration', { skip: legacySkip }, () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shield-legacy-')), 'legacy.db');
  const { DatabaseSync } = require('node:sqlite');

  // Build a database that is exactly at schema version 1 with a real user row.
  const legacy = new DatabaseSync(file);
  const dbSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'migrations.js'), 'utf8');
  assert.ok(dbSource.includes('initial-schema'));
  const migrations = db.MIGRATIONS;
  const first = migrations.find((m) => m.version === 1);
  assert.ok(first, 'migration 1 must exist');
  legacy.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  legacy.exec(first.sql);
  legacy.prepare('INSERT INTO schema_migrations (version,name,applied_at) VALUES (1,?,?)')
    .run('initial-schema', new Date().toISOString());
  legacy.prepare('INSERT INTO users (id,email,password_hash,name,created_at) VALUES (?,?,?,?,?)')
    .run('usr_legacy', 'legacy@example.com', 'scrypt$aa$bb', 'Legacy', new Date().toISOString());
  legacy.close();

  // Opening the app on that file must apply 2-5 and grandfather the account.
  const script = `process.env.DATABASE_FILE=${JSON.stringify(file)}; require(${JSON.stringify(path.join(__dirname, '..', 'src', 'db', 'index.js'))});`;
  execFileSync(process.execPath, ['-e', script], { stdio: 'pipe', cwd: path.join(__dirname, '..') });

  const upgraded = new DatabaseSync(file);
  const user = upgraded.prepare('SELECT * FROM users WHERE id=?').get('usr_legacy');
  assert.ok(user.email_verified_at, 'a pre-existing account must not be locked out');
  assert.equal(user.email_verified_source, 'migration');
  const versions = upgraded.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => r.version);
  assert.deepEqual(versions, [1, 2, 3, 4, 5, 6, 7], 'every migration ran, in order');
  upgraded.close();
});
