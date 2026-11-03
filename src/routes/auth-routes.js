'use strict';
const express = require('express');
const db = require('../db/index');
const config = require('../config');
const { newId, hashPassword, verifyPassword, utcNow } = require('../util');
const {
  createSession, destroySession, parseCookies, SESSION_COOKIE,
  requireAuth, rateLimit, persistentRateLimit, logAuthEvent,
  setSessionCookie, clearSessionCookie, audit
} = require('../auth');
const verify = require('../verify');
const email = require('../email');
const oauth = require('../oauth');

const router = express.Router();
const OAUTH_COOKIE = 'shield_oauth';

function validEmail(email) {
  return typeof email === 'string' && /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(email.trim());
}

const authLimiter = rateLimit({
  limit: config.authRateLimit,
  windowMs: config.authRateWindowMinutes * 60 * 1000,
  bucket: 'auth'
});

// Sign-in attempts are limited per email+IP in the database as well, so a
// restart cannot be used to reset a brute-force budget.
const signinLimiter = persistentRateLimit({
  action: 'signin_failed',
  limit: config.authRateLimit,
  windowMs: config.authRateWindowMinutes * 60 * 1000
});
const resendLimiter = persistentRateLimit({
  action: 'verify_resend',
  limit: config.auth.verificationResendMax,
  windowMs: config.auth.verificationResendWindowMinutes * 60 * 1000,
  by: 'email'
});

function primaryWorkspace(userId) {
  return db.prepare(`SELECT w.id, w.name, m.role FROM memberships m
    JOIN workspaces w ON w.id = m.workspace_id
    WHERE m.user_id = ? ORDER BY m.created_at LIMIT 1`).get(userId) || null;
}

function startSession(res, userId) {
  const { token, expires } = createSession(userId);
  setSessionCookie(res, token, expires);
  return expires;
}

function publicUser(userId) {
  const row = db.prepare('SELECT id, email, name, email_verified_at, email_verified_source, created_at FROM users WHERE id=?').get(userId);
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    email_verified: Boolean(row.email_verified_at),
    email_verified_source: row.email_verified_source || null
  };
}

// Delivery outcome is reported honestly to the caller (never "sent" unless it was).
function deliverVerification({ userId, emailAddress, workspaceName, ip }) {
  const issued = verify.issueVerification({ userId, email: emailAddress, ip, purpose: 'signup' });
  if (!issued.ok) return { ok: false, error: issued.error, retryAfterSeconds: issued.retryAfterSeconds };

  const message = email.verificationMessage({
    email: emailAddress,
    link: issued.link,
    code: issued.code,
    workspaceName,
    ttlHours: config.auth.verificationTtlHours
  });

  // sendMail is async; callers await the returned promise through sendVerificationEmail.
  return { ok: true, issued, message };
}

// User-safe explanation of a delivery outcome. No provider internals, no keys.
function deliveryNote(result) {
  const code = result.errorCode || '';
  if (result.status === 'sent') {
    if (result.testSender) {
      return 'Resend accepted the message, but this deployment sends from the test ' +
        'address (onboarding@resend.dev), which Resend only delivers to the address ' +
        'on its own account. Verify a domain at resend.com/domains and set EMAIL_FROM ' +
        'to an address on that domain to reach everyone else.';
    }
    return null;
  }
  if (result.status === 'skipped') {
    if (code === 'invalid_recipient') return 'That address cannot receive email.';
    return 'No email provider is configured on this deployment, so no message was sent. ' +
      'The server log shows which variable is missing.';
  }
  switch (code) {
    case 'test_sender_restricted':
      return 'The email provider refused delivery: this deployment sends from Resend\'s ' +
        'test address (onboarding@resend.dev), which can only email the address on the ' +
        'Resend account. Verify a domain at resend.com/domains and set EMAIL_FROM to an ' +
        'address on it.';
    case 'auth_error':
      return 'The email provider rejected the request. The server log records the reason.';
    case 'rate_limited':
      return 'The email provider is rate limiting right now. Try again in a minute.';
    case 'network':
      return 'The email provider could not be reached. Try again in a moment.';
    default:
      return 'The confirmation email could not be sent. Try again, or contact support if it keeps failing.';
  }
}

async function sendVerificationEmail(details) {
  // Instant mode needs no message, so do not call the provider at all. Otherwise
  // every signup burns a provider request and reports a pointless failure.
  if (!config.auth.requireEmailVerification) {
    return {
      required: false,
      delivery: 'not_needed',
      accepted: false,
      note: 'Email verification is disabled on this deployment, so no confirmation email was sent.'
    };
  }
  const { issued, message } = details;
  const result = await email.sendMail(message);
  const payload = {
    required: config.auth.requireEmailVerification,
    // 'sent' = the provider accepted it AND returned an id. Never "delivered".
    delivery: result.status,
    accepted: result.status === 'sent',
    delivery_error_code: result.errorCode || null,
    delivery_error: result.error || null,
    retryable: Boolean(result.retryable),
    test_sender: Boolean(result.testSender),
    message_id: result.messageId || null,
    expires_at: issued.expiresAt,
    note: deliveryNote(result)
  };
  if (config.auth.devExposeVerificationLink && !config.isProduction) {
    // Local/dev convenience only. Forced off in production by config.
    payload.dev_link = issued.link;
    payload.dev_code = issued.code;
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Public auth configuration (lets the UI hide unavailable options)
// ---------------------------------------------------------------------------
router.get('/config', (req, res) => {
  res.json({
    email_verification_required: config.auth.requireEmailVerification,
    auth_mode: config.auth.mode,                     // 'verified' | 'instant'
    auth_mode_source: config.auth.modeSource,        // 'derived' | 'AUTH_REQUIRE_EMAIL_VERIFICATION'
    email_reachable: config.auth.emailReachable,     // can this deploy email arbitrary users?
    auth_mode_note: config.auth.mode === 'instant'
      ? 'Email verification is off on this deployment: new accounts are active immediately because this deployment cannot deliver verification email to arbitrary users.'
      : undefined,
    verification_ttl_hours: config.auth.verificationTtlHours,
    email: email.describeConfig(),
    google: {
      enabled: oauth.isConfigured(),
      missing: oauth.isConfigured() ? [] : oauth.missingConfig()
    }
  });
});

// ---------------------------------------------------------------------------
// Sign up
// ---------------------------------------------------------------------------
router.post('/signup', authLimiter, express.json({ limit: '16kb' }), async (req, res) => {
  const { email: rawEmail, password, workspace_name } = req.body || {};
  const normEmail = validEmail(rawEmail) ? rawEmail.trim().toLowerCase() : null;
  if (!normEmail) return res.status(400).json({ error: 'A valid email address is required.' });
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  if (password.length > 200) return res.status(400).json({ error: 'Password is too long.' });

  const wsName = (typeof workspace_name === 'string' && workspace_name.trim().slice(0, 80)) || 'My workspace';
  const existing = db.prepare('SELECT * FROM users WHERE email=?').get(normEmail);

  // Response body is identical whether or not the address is already registered,
  // so this endpoint cannot be used to enumerate accounts.
  const generic = {
    ok: true,
    message: 'If this address can be registered, a confirmation email is on its way.'
  };

  if (existing) {
    if (!existing.email_verified_at) {
      // Resume an unfinished signup instead of leaking that the account exists.
      const details = deliverVerification({
        userId: existing.id, emailAddress: normEmail, workspaceName: existing.name, ip: req.ip
      });
      if (details.ok) {
        generic.verification = await sendVerificationEmail(details);
      }
      logAuthEvent({ email: normEmail, userId: existing.id, ip: req.ip, action: 'signup', outcome: 'existing_unverified' });
    } else {
      logAuthEvent({ email: normEmail, userId: existing.id, ip: req.ip, action: 'signup', outcome: 'existing_verified' });
    }
    return res.status(201).json(generic);
  }

  const userId = newId('usr');
  const wsId = newId('wsp');
  const now = utcNow();
  const passwordHash = await hashPassword(password);

  try {
    db.exec('BEGIN');
    // In instant mode the account is usable immediately, so record it as verified
    // with an auditable source. Otherwise switching verification on later would lock
    // out every account created while email was unavailable.
    const instantVerifiedAt = config.auth.requireEmailVerification ? null : now;
    const instantSource = config.auth.requireEmailVerification ? null : 'instant_mode';
    db.prepare('INSERT INTO users (id, email, password_hash, name, created_at, email_verified_at, email_verified_source) VALUES (?,?,?,?,?,?,?)')
      .run(userId, normEmail, passwordHash, null, now, instantVerifiedAt, instantSource);
    db.prepare('INSERT INTO workspaces (id, name, created_at) VALUES (?,?,?)').run(wsId, wsName, now);
    db.prepare('INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?,?,?,?)')
      .run(wsId, userId, 'owner', now);
    db.prepare(`INSERT INTO notification_settings
      (workspace_id, immediate_email, digest_enabled, digest_day, digest_hour_utc, min_severity, include_empty_digest, updated_at)
      VALUES (?,1,1,?,?, 'high',0,?)`)
      .run(wsId, config.alerts.defaultDigestDay, config.alerts.defaultDigestHourUtc, now);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    return res.status(500).json({ error: 'Could not create the account.' });
  }

  const details = deliverVerification({ userId, emailAddress: normEmail, workspaceName: wsName, ip: req.ip });
  const verification = details.ok
    ? await sendVerificationEmail(details)
    : { required: true, delivery: 'failed', delivery_error: details.error };

  logAuthEvent({ email: normEmail, userId, ip: req.ip, action: 'signup', outcome: 'created' });
  audit(wsId, userId, 'auth.signup', { verification_required: config.auth.requireEmailVerification });

  // No session is issued here by default: the account is not usable until the
  // address is confirmed. The account is never marked verified by registering.
  const body = { ...generic, verification };
  if (!config.auth.requireEmailVerification) {
    startSession(res, userId);
    body.user = publicUser(userId);
    body.workspace = primaryWorkspace(userId);
    verification.note = 'Email verification is disabled by configuration (AUTH_REQUIRE_EMAIL_VERIFICATION=false).';
  }
  res.status(201).json(body);
});

// ---------------------------------------------------------------------------
// Verify (magic link and code)
// ---------------------------------------------------------------------------
function verificationLanding(res, { ok, reason }) {
  const target = ok
    ? `${config.publicBaseUrl}/app#/dashboard?verified=1`
    : `${config.publicBaseUrl}/app#/verify-failed?reason=${encodeURIComponent(reason || 'invalid')}`;
  return res.redirect(303, target);
}

router.get('/verify', (req, res) => {
  const token = req.query.token;
  if (!token || typeof token !== 'string') return verificationLanding(res, { ok: false, reason: 'missing_token' });

  const result = verify.consumeByToken(token);
  if (!result.ok) {
    logAuthEvent({ ip: req.ip, action: 'verify', outcome: result.error });
    return verificationLanding(res, { ok: false, reason: result.error });
  }

  logAuthEvent({ userId: result.userId, ip: req.ip, action: 'verify', outcome: 'verified' });
  const user = db.prepare('SELECT id FROM users WHERE id=?').get(result.userId);
  if (user) startSession(res, result.userId);
  return verificationLanding(res, { ok: true });
});

router.post('/verify', authLimiter, express.json({ limit: '16kb' }), (req, res) => {
  const { token, email: rawEmail, code } = req.body || {};
  let result;
  if (token) {
    result = verify.consumeByToken(token);
  } else {
    if (!validEmail(rawEmail) || !code) return res.status(400).json({ error: 'Provide an email and the 6-digit code.' });
    result = verify.consumeByCode(rawEmail.trim().toLowerCase(), code);
  }

  if (!result.ok) {
    logAuthEvent({ email: rawEmail || null, ip: req.ip, action: 'verify', outcome: result.error });
    const messages = {
      invalid: 'This confirmation link is not valid.',
      expired: 'This confirmation link has expired. Request a new one.',
      used: 'This confirmation link has already been used.',
      invalidated: 'This confirmation link was replaced by a newer one. Use the most recent email.',
      too_many_attempts: 'Too many incorrect codes. Request a new confirmation email.',
      incorrect_code: 'That code is not correct.',
      missing_token: 'A confirmation token is required.'
    };
    return res.status(400).json({
      error: messages[result.error] || 'Verification failed.',
      code: result.error,
      attempts_left: result.attemptsLeft
    });
  }

  logAuthEvent({ userId: result.userId, ip: req.ip, action: 'verify', outcome: 'verified' });
  startSession(res, result.userId);
  res.json({ ok: true, user: publicUser(result.userId), workspace: primaryWorkspace(result.userId) });
});

router.post('/verify/resend', resendLimiter, express.json({ limit: '16kb' }), async (req, res) => {
  const rawEmail = req.body && req.body.email;
  const normEmail = validEmail(rawEmail) ? rawEmail.trim().toLowerCase() : null;
  if (!normEmail) return res.status(400).json({ error: 'A valid email address is required.' });

  const generic = { ok: true, message: 'If that address needs confirmation, a new email has been sent.' };
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(normEmail);
  logAuthEvent({ email: normEmail, userId: user ? user.id : null, ip: req.ip, action: 'verify_resend', outcome: 'requested' });

  if (!user || user.email_verified_at) return res.json(generic);

  const details = deliverVerification({ userId: user.id, emailAddress: normEmail, workspaceName: null, ip: req.ip });
  if (!details.ok) {
    if (details.error === 'rate_limited') {
      res.set('Retry-After', String(details.retryAfterSeconds));
      return res.status(429).json({ error: 'Too many confirmation emails requested. Try again later.' });
    }
    return res.status(500).json({ error: 'Could not create a confirmation email.' });
  }

  const payload = await sendVerificationEmail(details);
  res.json({ ...generic, verification: payload });
});

// ---------------------------------------------------------------------------
// Sign in / out
// ---------------------------------------------------------------------------
router.post('/signin', signinLimiter, express.json({ limit: '16kb' }), async (req, res) => {
  const { email: rawEmail, password } = req.body || {};
  if (!rawEmail || !password) return res.status(400).json({ error: 'Email and password are required.' });
  const normEmail = String(rawEmail).trim().toLowerCase();

  const user = db.prepare('SELECT * FROM users WHERE email=?').get(normEmail);
  const ok = user ? await verifyPassword(password, user.password_hash) : false;
  if (!ok) {
    logAuthEvent({ email: normEmail, userId: user ? user.id : null, ip: req.ip, action: 'signin_failed', outcome: 'bad_credentials' });
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  if (config.auth.requireEmailVerification && !user.email_verified_at) {
    logAuthEvent({ email: normEmail, userId: user.id, ip: req.ip, action: 'signin', outcome: 'unverified' });
    return res.status(403).json({
      error: 'Confirm your email address before signing in.',
      code: 'email_unverified',
      can_resend: true
    });
  }

  startSession(res, user.id);
  logAuthEvent({ email: normEmail, userId: user.id, ip: req.ip, action: 'signin', outcome: 'ok' });
  res.json({ user: publicUser(user.id), workspace: primaryWorkspace(user.id) });
});

router.post('/signout', (req, res) => {
  const cookies = parseCookies(req);
  destroySession(cookies[SESSION_COOKIE]);
  clearSessionCookie(res);
  res.json({ ok: true });
});

// Session identity. Mounted at /api/auth/me and /api/me: the SPA has always
// called /api/me, so both paths must work.
function meHandler(req, res) {
  const workspaces = db.prepare(`
    SELECT w.id, w.name, m.role FROM memberships m
    JOIN workspaces w ON w.id = m.workspace_id
    WHERE m.user_id = ? ORDER BY m.created_at
  `).all(req.user.id);
  res.json({ user: req.user, workspaces });
}
router.get('/me', requireAuth, meHandler);

// ---------------------------------------------------------------------------
// Google sign-in
// ---------------------------------------------------------------------------
router.get('/google/start', (req, res) => {
  const built = oauth.buildAuthorizeUrl();
  if (!built.ok) {
    return res.status(503).json({
      error: 'Google sign-in is not configured on this deployment.',
      code: 'google_not_configured',
      missing: built.missing
    });
  }
  res.cookie(OAUTH_COOKIE, oauth.signStateCookie({
    state: built.state,
    nonce: built.nonce,
    cv: built.codeVerifier,
    exp: built.expiresAt
  }), {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    maxAge: oauth.STATE_TTL_MS,
    path: '/api/auth/google'
  });
  res.redirect(302, built.url);
});

router.get('/google/callback', async (req, res) => {
  const fail = (reason) => res.redirect(303, `${config.publicBaseUrl}/app#/signin?oauth_error=${encodeURIComponent(reason)}`);
  try {
    if (!oauth.isConfigured()) return fail('not_configured');

    const cookie = parseCookies(req)[OAUTH_COOKIE];
    res.clearCookie(OAUTH_COOKIE, { path: '/api/auth/google' });
    const state = oauth.readStateCookie(cookie);
    if (!state) return fail('state_cookie_invalid');

    const { code, state: returnedState, error } = req.query;
    if (error) return fail(String(error).slice(0, 60));
    if (!code || typeof code !== 'string') return fail('missing_code');
    if (typeof returnedState !== 'string' || returnedState !== state.state) return fail('state_mismatch');

    const exchanged = await oauth.exchangeCode(code, state.cv);
    if (!exchanged.ok) {
      console.error('[oauth] code exchange failed:', exchanged.error);
      return fail('exchange_failed');
    }

    let keys;
    try {
      keys = await oauth.fetchJwks();
    } catch (e) {
      console.error('[oauth] JWKS fetch failed:', e.message);
      return fail('jwks_unavailable');
    }

    const verified = oauth.verifyIdToken(exchanged.idToken, { keys, nonce: state.nonce });
    if (!verified.ok) {
      logAuthEvent({ ip: req.ip, action: 'oauth_google', outcome: verified.error });
      return fail(verified.error);
    }

    const resolved = oauth.resolveUser(verified.claims);
    if (!resolved.ok) {
      logAuthEvent({ email: verified.claims.email, ip: req.ip, action: 'oauth_google', outcome: resolved.error });
      return fail(resolved.error);
    }

    startSession(res, resolved.userId);
    logAuthEvent({
      email: verified.claims.email, userId: resolved.userId, ip: req.ip,
      action: 'oauth_google', outcome: resolved.created ? 'created' : 'ok'
    });
    audit(null, resolved.userId, 'auth.oauth_login', { provider: 'google', created: resolved.created });
    return res.redirect(303, `${config.publicBaseUrl}/app#/dashboard`);
  } catch (e) {
    console.error('[oauth] callback error:', e.message);
    return fail('server_error');
  }
});

module.exports = router;
module.exports.meHandler = meHandler;
