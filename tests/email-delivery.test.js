'use strict';
// Email delivery tests: honest status reporting, provider error classification,
// the Resend test-sender restriction, the send audit trail, and webhook handling.
process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.DATABASE_FILE = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'shield-email-')) + '/test.db';
process.env.AUTH_RATE_LIMIT = '200';
process.env.AUTH_REQUIRE_EMAIL_VERIFICATION = 'true';
process.env.PUBLIC_BASE_URL = 'https://shield.test';
process.env.COOKIE_SECURE = 'false';
delete process.env.EMAIL_PROVIDER;         // set at runtime so each test controls it
delete process.env.EMAIL_DEV_SINK;

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');

const { server } = require('../src/server');
const db = require('../src/db');
const config = require('../src/config');
const email = require('../src/email');

const FAKE_KEY = 're_test_key_do_not_leak_123456';
const TEST_SENDER = 'SaaS Shield <onboarding@resend.dev>';
const REAL_SENDER = 'SaaS Shield <alerts@bittubuilds.com>';

// ---------------------------------------------------------------------------
// Fake provider: lets each test choose exactly how Resend behaves.
// ---------------------------------------------------------------------------
let providerMode = 'ok';
let providerSeq = 0;   // unique ids, like a real provider
let lastProviderRequest = null;
const provider = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    try { lastProviderRequest = JSON.parse(raw || '{}'); } catch { lastProviderRequest = null; }
    if (providerMode === 'ok') {
      res.writeHead(200, { 'content-type': 'application/json' });
      providerSeq += 1;
      return res.end(JSON.stringify({ id: `em_${providerSeq}` }));
    }
    if (providerMode === 'no_id') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ message: 'queued' }));
    }
    if (providerMode === 'test_sender_restricted') {
      res.writeHead(403, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        statusCode: 403,
        name: 'validation_error',
        message: 'You can only send testing emails to your own email address (owner@example.org). ' +
          'To send emails to other recipients, please verify a domain at resend.com/domains'
      }));
    }
    if (providerMode === 'unauthorized') {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ statusCode: 401, name: 'missing_api_key', message: 'Missing API key' }));
    }
    if (providerMode === 'rate_limited') {
      res.writeHead(429, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ statusCode: 429, name: 'rate_limit_exceeded', message: 'Too many requests' }));
    }
    res.writeHead(500, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ statusCode: 500, name: 'internal_server_error', message: 'Server error' }));
  });
});

let BASE = null;
async function ready() {
  if (BASE) return;
  if (!provider.listening) await new Promise((r) => provider.listen(0, '127.0.0.1', r));
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  BASE = `http://127.0.0.1:${server.address().port}/api`;
  config.email.provider = 'resend';
  config.email.resendApiKey = FAKE_KEY;
  config.email.from = TEST_SENDER;
  config.email.resendEndpoint = `http://127.0.0.1:${provider.address().port}/emails`;
  config.email.timeoutMs = 4000;
}

after(() => new Promise((resolve) => {
  provider.close(() => server.close(() => resolve()));
}));

function outbox() {
  return db.prepare('SELECT * FROM email_outbox ORDER BY created_at DESC, rowid DESC').all();
}
function lastOutbox() { return outbox()[0] || null; }

async function post(path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    redirect: 'manual'
  });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, data, headers: res.headers };
}

function assertNoSecretLeak(value, label) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assert.ok(!text.includes(FAKE_KEY), `${label} must not contain the API key`);
  assert.ok(!/re_[A-Za-z0-9_-]{12,}/.test(text), `${label} must not contain any API key`);
}

// ---------------------------------------------------------------------------
// A. provider accepts and returns an id
// ---------------------------------------------------------------------------
test('A: a provider id means accepted, and the attempt is recorded', async () => {
  await ready();
  providerMode = 'ok';
  const r = await email.sendMail({ to: 'user@example.net', subject: 'Hi', text: 'Body', context: 'unit' });
  assert.equal(r.status, 'sent');
  assert.match(r.messageId, /^em_\d+$/);
  assert.equal(r.retryable, false);
  assert.equal(lastProviderRequest.to[0], 'user@example.net');
  const row = lastOutbox();
  assert.equal(row.status, 'sent');
  assert.equal(row.provider_message_id, r.messageId);
  assert.equal(row.error_code, null);
});

test('A2: a 200 response without an email id is a failure, not a send', async () => {
  await ready();
  providerMode = 'no_id';
  const r = await email.sendMail({ to: 'user@example.net', subject: 'Hi', text: 'Body' });
  assert.equal(r.status, 'failed');
  assert.equal(r.errorCode, 'missing_message_id');
  assert.equal(r.retryable, true);
  assert.equal(lastOutbox().status, 'failed');
});

// ---------------------------------------------------------------------------
// B. provider rejections
// ---------------------------------------------------------------------------
test('B: the Resend test-sender restriction is reported as a hard failure', async () => {
  await ready();
  providerMode = 'test_sender_restricted';
  const r = await email.sendMail({ to: 'someone@example.net', subject: 'Hi', text: 'Body' });
  assert.equal(r.status, 'failed');
  assert.equal(r.errorCode, 'test_sender_restricted');
  assert.equal(r.retryable, false, 'a domain must be verified; retrying cannot help');
  assertNoSecretLeak(r, 'send result');
  const row = lastOutbox();
  assert.equal(row.error_code, 'test_sender_restricted');
  assert.ok(row.error_message && row.error_message.length <= 240);
});

test('B2: auth errors, rate limits and 5xx are classified for the retry ladder', async () => {
  await ready();
  const cases = [['unauthorized', 'auth_error', false], ['rate_limited', 'rate_limited', true], ['server_error', 'provider_error', true]];
  for (const [mode, code, retryable] of cases) {
    providerMode = mode;
    const r = await email.sendMail({ to: 'user@example.net', subject: 's', text: 'b' });
    assert.equal(r.status, 'failed', mode);
    assert.equal(r.errorCode, code, mode);
    assert.equal(r.retryable, retryable, mode);
  }
});

test('B3: an unreachable provider is a retryable network failure', async () => {
  await ready();
  const saved = config.email.resendEndpoint;
  config.email.resendEndpoint = 'http://127.0.0.1:1/emails';
  try {
    const r = await email.sendMail({ to: 'user@example.net', subject: 's', text: 'b' });
    assert.equal(r.status, 'failed');
    assert.equal(r.errorCode, 'network');
    assert.equal(r.retryable, true);
  } finally {
    config.email.resendEndpoint = saved;
  }
});

// ---------------------------------------------------------------------------
// C. missing configuration
// ---------------------------------------------------------------------------
test('C: a missing API key is skipped with an explicit diagnostic, not a success', async () => {
  await ready();
  const savedKey = config.email.resendApiKey;
  config.email.resendApiKey = '';
  try {
    assert.equal(email.providerName(), null);
    const r = await email.sendMail({ to: 'user@example.net', subject: 's', text: 'b' });
    assert.equal(r.status, 'skipped');
    assert.equal(r.errorCode, 'not_configured');
    assert.equal(email.describeConfig().configured, false);
    assert.deepEqual(email.describeConfig().missing, ['RESEND_API_KEY']);
  } finally {
    config.email.resendApiKey = savedKey;
  }
});

test('C2: an invalid recipient is skipped before any provider call', async () => {
  await ready();
  providerMode = 'ok';
  lastProviderRequest = null;
  const r = await email.sendMail({ to: 'not-an-email', subject: 's', text: 'b' });
  assert.equal(r.status, 'skipped');
  assert.equal(r.errorCode, 'invalid_recipient');
  assert.equal(lastProviderRequest, null, 'no provider request for an invalid address');
});

// ---------------------------------------------------------------------------
// Test sender detection
// ---------------------------------------------------------------------------
test('the test sender is detected and explained, and clear senders are not flagged', async () => {
  await ready();
  assert.equal(email.isResendTestSender(TEST_SENDER), true);
  assert.equal(email.isResendTestSender(REAL_SENDER), false);
  const cfg = email.describeConfig();
  assert.equal(cfg.test_sender, true);
  assert.ok(cfg.notes.join(' ').includes('resend.com/domains'));

  providerMode = 'ok';
  const r = await email.sendMail({ to: 'user@example.net', subject: 's', text: 'b' });
  assert.equal(r.testSender, true);

  config.email.from = REAL_SENDER;
  try {
    const r2 = await email.sendMail({ to: 'user@example.net', subject: 's', text: 'b' });
    assert.equal(r2.testSender, false);
    assert.equal(email.describeConfig().test_sender, false);
  } finally {
    config.email.from = TEST_SENDER;
  }
});

// ---------------------------------------------------------------------------
// D/F. signup reports what actually happened
// ---------------------------------------------------------------------------
test('D: a rejected provider makes signup report failure with a safe explanation', async () => {
  await ready();
  providerMode = 'test_sender_restricted';
  const r = await post('/auth/signup', { email: 'blocked@example.net', password: 'longpassword1', workspace_name: 'Blocked Co' });
  assert.equal(r.status, 201, 'the account is created; the email is what failed');
  const v = r.data.verification;
  assert.equal(v.delivery, 'failed');
  assert.equal(v.accepted, false);
  assert.equal(v.delivery_error_code, 'test_sender_restricted');
  assert.equal(v.retryable, false);
  assert.match(v.note, /test address|verify a domain/i);
  assert.equal(v.message_id, null);
  assertNoSecretLeak(r.data, 'signup response');

  // The account exists but is not usable until confirmed.
  const user = db.prepare('SELECT * FROM users WHERE email=?').get('blocked@example.net');
  assert.ok(user);
  assert.equal(user.email_verified_at, null);
  assert.equal(r.headers.get('set-cookie'), null, 'no session before confirmation');
});

test('D2: an accepted send reports accepted with the provider message id', async () => {
  await ready();
  providerMode = 'ok';
  config.email.from = REAL_SENDER;
  try {
    const r = await post('/auth/signup', { email: 'accepted@example.net', password: 'longpassword1' });
    assert.equal(r.status, 201);
    const v = r.data.verification;
    assert.equal(v.delivery, 'sent');
    assert.equal(v.accepted, true);
    assert.match(v.message_id, /^em_\d+$/);
    assert.equal(v.message_id, lastOutbox().provider_message_id);
    assert.equal(v.note, null, 'no caveat for a real sender');
    assert.equal(v.test_sender, false);
  } finally {
    config.email.from = TEST_SENDER;
  }
});

test('D3: the verification link targets the public app URL and works exactly once', async () => {
  await ready();
  providerMode = 'ok';
  const r = await post('/auth/signup', { email: 'linkbase@example.net', password: 'longpassword1' });
  assert.equal(r.data.verification.delivery, 'sent');

  const token = db.prepare(`SELECT id FROM email_verification_tokens
      WHERE user_id=(SELECT id FROM users WHERE email=?)
      ORDER BY created_at DESC LIMIT 1`).get('linkbase@example.net');
  assert.ok(token, 'a token was stored');
  assert.match(token.id, /^[a-f0-9]{64}$/, 'only the sha256 of the token is stored');

  // Linking is built from PUBLIC_BASE_URL, so production links point at the app.
  const verify = require('../src/verify');
  const issued = verify.issueVerification({ userId: db.prepare('SELECT id FROM users WHERE email=?').get('linkbase@example.net').id, email: 'linkbase@example.net' });
  assert.ok(issued.link.startsWith('https://shield.test/'), issued.link);
  const first = verify.consumeByToken(issued.token);
  assert.equal(first.ok, true);
  const replay = verify.consumeByToken(issued.token);
  assert.equal(replay.ok, false);
  assert.equal(replay.error, 'used');
});

// ---------------------------------------------------------------------------
// Test F: delivery webhooks (Svix signature)
// ---------------------------------------------------------------------------
const WEBHOOK_SECRET = 'whsec_' + Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');

function sign(bodyString, { secret = WEBHOOK_SECRET, id = 'msg_1', ts = Math.floor(Date.now() / 1000) } = {}) {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const sig = crypto.createHmac('sha256', key).update(`${id}.${ts}.${bodyString}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,${sig}` };
}

async function postWebhook(bodyString, headers) {
  const res = await fetch(BASE + '/webhooks/resend', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: bodyString
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data };
}

test('F: webhooks are closed without a secret and reject bad signatures', async () => {
  await ready();
  config.email.resendWebhookSecret = '';
  const body = JSON.stringify({ type: 'email.delivered', data: { email_id: 'em_nonexistent' } });
  assert.equal((await postWebhook(body, {})).status, 503);

  config.email.resendWebhookSecret = WEBHOOK_SECRET;
  const bad = await postWebhook(body, { 'svix-id': 'msg_1', 'svix-timestamp': String(Math.floor(Date.now() / 1000)), 'svix-signature': 'v1,AAAA' });
  assert.equal(bad.status, 401);

  const stale = await postWebhook(body, sign(body, { ts: Math.floor(Date.now() / 1000) - 3600 }));
  assert.equal(stale.status, 401, 'old timestamps are rejected to stop replays');

  const missing = await postWebhook(body, {});
  assert.equal(missing.status, 401);
});

test('F2: a signed delivery event marks the outbox row delivered', async () => {
  await ready();
  providerMode = 'ok';
  config.email.resendWebhookSecret = WEBHOOK_SECRET;
  const sent = await email.sendMail({ to: 'delivered@example.net', subject: 's', text: 'b' });
  assert.equal(sent.status, 'sent');
  assert.equal(lastOutbox().status, 'sent');

  const body = JSON.stringify({ type: 'email.delivered', created_at: new Date().toISOString(), data: { email_id: sent.messageId } });
  const r = await postWebhook(body, sign(body));
  assert.equal(r.status, 200);
  assert.equal(r.data.updated, true);

  const row = db.prepare('SELECT * FROM email_outbox WHERE provider_message_id=?').get(sent.messageId);
  assert.equal(row.status, 'delivered');
  assert.equal(row.last_event, 'email.delivered');
  assert.ok(row.delivered_at);
});

test('F3: bounce events are recorded, unknown events are acknowledged and ignored', async () => {
  await ready();
  providerMode = 'ok';
  config.email.resendWebhookSecret = WEBHOOK_SECRET;
  const sent = await email.sendMail({ to: 'bounce@example.net', subject: 's', text: 'b' });

  const bounce = JSON.stringify({ type: 'email.bounced', data: { email_id: sent.messageId } });
  assert.equal((await postWebhook(bounce, sign(bounce))).status, 200);
  assert.equal(db.prepare('SELECT status FROM email_outbox WHERE provider_message_id=?').get(sent.messageId).status, 'bounced');

  const other = JSON.stringify({ type: 'contact.created', data: { id: 'x' } });
  const r = await postWebhook(other, sign(other));
  assert.equal(r.status, 200);
  assert.equal(r.data.ignored, true);
});

test('F4: a forged payload cannot change a row without a valid signature', async () => {
  await ready();
  providerMode = 'ok';
  config.email.resendWebhookSecret = WEBHOOK_SECRET;
  const sent = await email.sendMail({ to: 'forge@example.net', subject: 's', text: 'b' });

  const forged = JSON.stringify({ type: 'email.delivered', data: { email_id: sent.messageId } });
  const wrongSecret = 'whsec_' + Buffer.from('ffffffffffffffffffffffffffffffff').toString('base64');
  const r = await postWebhook(forged, sign(forged, { secret: wrongSecret }));
  assert.equal(r.status, 401);
  assert.equal(db.prepare('SELECT status FROM email_outbox WHERE provider_message_id=?').get(sent.messageId).status, 'sent');
});
