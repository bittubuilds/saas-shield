'use strict';
// Google sign-in (OAuth 2.0 authorization code + OIDC id_token).
//
// Server-side validation, in this order:
//   1. state cookie must match the state returned by Google (CSRF / login CSRF)
//   2. PKCE code_verifier must match the S256 challenge we sent
//   3. id_token signature must verify against Google's published JWKS (RS256)
//   4. iss, aud, exp, iat and nonce must all match the values we issued
//   5. email_verified must be true before the identity is trusted
//
// Account linking is deliberately conservative: an existing password account is
// only linked when it was already confirmed. An unverified local account is
// never linked from an email claim alone.
const crypto = require('crypto');
const config = require('./config');
const db = require('./db/index');
const { newId, utcNow, sha256 } = require('./util');

const STATE_TTL_MS = 10 * 60 * 1000;
const JWKS_TTL_MS = 60 * 60 * 1000;

let jwksCache = null;   // { keys, fetchedAt }

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}
function fromB64url(str) {
  return Buffer.from(String(str), 'base64url');
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function pkceChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function isConfigured() {
  return config.oauth.google.configured;
}

function missingConfig() {
  const missing = [];
  if (!config.oauth.google.clientId) missing.push('GOOGLE_CLIENT_ID');
  if (!config.oauth.google.clientSecret) missing.push('GOOGLE_CLIENT_SECRET');
  return missing;
}

/**
 * Begin a login: returns the URL to send the browser to, plus the values that
 * must be stored in an HttpOnly cookie until the callback arrives.
 */
function buildAuthorizeUrl() {
  if (!isConfigured()) {
    return { ok: false, error: 'not_configured', missing: missingConfig() };
  }
  const state = randomToken(24);
  const nonce = randomToken(24);
  const codeVerifier = randomToken(32);
  const url = new URL(config.oauth.google.authorizationEndpoint);
  url.searchParams.set('client_id', config.oauth.google.clientId);
  url.searchParams.set('redirect_uri', config.oauth.google.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', pkceChallenge(codeVerifier));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('prompt', 'select_account');
  return { ok: true, url: url.toString(), state, nonce, codeVerifier, expiresAt: Date.now() + STATE_TTL_MS };
}

// The state cookie carries only what the callback needs. It is HMAC-signed and
// HttpOnly, so a tampered cookie is rejected before Google is contacted.
function stateSecret(provider = 'google') {
  const secret = provider === 'github'
    ? config.oauth.github.clientSecret
    : config.oauth.google.clientSecret;
  return secret || 'unconfigured';
}

function signStateCookie(payload, provider = 'google') {
  const secret = stateSecret(provider);
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function readStateCookie(value, provider = 'google') {
  if (typeof value !== 'string' || !value.includes('.')) return null;
  const [body, sig] = value.split('.');
  const secret = stateSecret(provider);
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(fromB64url(body).toString('utf8'));
    if (!payload || typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

async function fetchJwks({ force = false, fetchImpl = globalThis.fetch } = {}) {
  if (!force && jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) return jwksCache.keys;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetchImpl(config.oauth.google.jwksEndpoint, { signal: ac.signal });
    if (!res.ok) throw new Error(`JWKS endpoint returned HTTP ${res.status}`);
    const body = await res.json();
    if (!body || !Array.isArray(body.keys) || body.keys.length === 0) throw new Error('JWKS response contained no keys');
    jwksCache = { keys: body.keys, fetchedAt: Date.now() };
    return body.keys;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Verify a Google id_token. Exported for tests; `keys` can be injected so the
 * whole check runs without network access.
 */
function verifyIdToken(idToken, opts = {}) {
  const { keys, nonce, audience, issuer, now = Date.now() } = opts;
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) return { ok: false, error: 'malformed_token' };
  const [rawHeader, rawPayload, rawSig] = parts;

  let header;
  let payload;
  try {
    header = JSON.parse(fromB64url(rawHeader).toString('utf8'));
    payload = JSON.parse(fromB64url(rawPayload).toString('utf8'));
  } catch {
    return { ok: false, error: 'malformed_token' };
  }

  if (header.alg !== 'RS256') return { ok: false, error: 'unexpected_alg' };
  const keyList = Array.isArray(keys) ? keys : [];
  // An unknown key id is rejected outright. The single-key fallback only applies
  // when the token does not claim a key id at all (a JWKS without kids), so a
  // token can never be validated against a key it did not name.
  const jwk = header.kid
    ? keyList.find((k) => k.kid === header.kid && k.kty === 'RSA')
    : (keyList.length === 1 && keyList[0].kty === 'RSA' ? keyList[0] : null);
  if (!jwk) return { ok: false, error: 'unknown_signing_key' };

  let verified = false;
  try {
    const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    verified = crypto.verify('RSA-SHA256', Buffer.from(`${rawHeader}.${rawPayload}`), publicKey, fromB64url(rawSig));
  } catch {
    return { ok: false, error: 'signature_verification_failed' };
  }
  if (!verified) return { ok: false, error: 'bad_signature' };

  const expectedIssuers = new Set([issuer || config.oauth.google.issuer, 'accounts.google.com', 'https://accounts.google.com']);
  if (!expectedIssuers.has(payload.iss)) return { ok: false, error: 'bad_issuer' };

  const expectedAud = audience || config.oauth.google.clientId;
  if (!payload.aud || payload.aud !== expectedAud) return { ok: false, error: 'bad_audience' };

  const nowSec = Math.floor(now / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= nowSec) return { ok: false, error: 'expired' };
  if (typeof payload.iat === 'number' && payload.iat > nowSec + 120) return { ok: false, error: 'issued_in_future' };

  if (nonce) {
    if (typeof payload.nonce !== 'string' || payload.nonce !== nonce) return { ok: false, error: 'bad_nonce' };
  }

  if (payload.email_verified !== true && payload.email_verified !== 'true') {
    return { ok: false, error: 'email_not_verified_by_provider' };
  }
  if (!payload.sub || !payload.email) return { ok: false, error: 'missing_claims' };

  return {
    ok: true,
    claims: {
      sub: String(payload.sub),
      email: String(payload.email).toLowerCase(),
      emailVerified: true,
      name: payload.name || null,
      picture: payload.picture || null
    }
  };
}

async function exchangeCode(code, codeVerifier, { fetchImpl = globalThis.fetch } = {}) {
  const body = new URLSearchParams({
    code: String(code),
    client_id: config.oauth.google.clientId,
    client_secret: config.oauth.google.clientSecret,
    redirect_uri: config.oauth.google.redirectUri,
    grant_type: 'authorization_code',
    code_verifier: codeVerifier
  });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10000);
  try {
    const res = await fetchImpl(config.oauth.google.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: ac.signal
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* ignore */ }
    if (!res.ok || !parsed || !parsed.id_token) {
      return { ok: false, error: (parsed && (parsed.error_description || parsed.error)) || `token endpoint HTTP ${res.status}` };
    }
    return { ok: true, idToken: parsed.id_token, accessToken: parsed.access_token || null };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'token endpoint timeout' : `token endpoint error: ${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve a verified provider identity (Google or GitHub) to a local user.
 * @returns {{ok:true, userId:string, linked:boolean, created:boolean} | {ok:false, error:string}}
 */
function resolveUser(claims, provider = 'google') {
  const existingLink = db.prepare('SELECT user_id FROM oauth_accounts WHERE provider=? AND provider_user_id=?')
    .get(provider, claims.sub);
  if (existingLink) {
    db.prepare('UPDATE oauth_accounts SET last_login_at=? WHERE provider=? AND provider_user_id=?')
      .run(utcNow(), provider, claims.sub);
    return { ok: true, userId: existingLink.user_id, linked: true, created: false };
  }

  const localUser = db.prepare('SELECT id, email, email_verified_at, password_hash FROM users WHERE email=?').get(claims.email);
  if (localUser) {
    if (!localUser.email_verified_at) {
      // Never link on the strength of an unverified local account: whoever
      // registered it may not control the mailbox.
      return { ok: false, error: 'local_account_unverified' };
    }
    linkAccount(localUser.id, claims, provider);
    return { ok: true, userId: localUser.id, linked: true, created: false };
  }

  // Brand new account. Unusable password hash: this account can only be entered
  // through the provider until the user sets a password.
  const userId = newId('usr');
  const wsId = newId('wsp');
  const now = utcNow();
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO users (id, email, password_hash, name, created_at, email_verified_at, email_verified_source) VALUES (?,?,?,?,?,?,?)')
      .run(userId, claims.email, 'oauth-only$', claims.name || null, now, now, provider);
    db.prepare('INSERT INTO workspaces (id, name, created_at) VALUES (?,?,?)')
      .run(wsId, claims.name ? `${claims.name}'s workspace` : 'My workspace', now);
    db.prepare('INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?,?,?,?)')
      .run(wsId, userId, 'owner', now);
    db.prepare(`INSERT INTO notification_settings
      (workspace_id, immediate_email, digest_enabled, digest_day, digest_hour_utc, min_severity, include_empty_digest, updated_at)
      VALUES (?,1,1,?,?, 'high',0,?)`)
      .run(wsId, config.alerts.defaultDigestDay, config.alerts.defaultDigestHourUtc, now);
    linkAccount(userId, claims, provider);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
  return { ok: true, userId, linked: true, created: true };
}

function linkAccount(userId, claims, provider = 'google') {
  db.prepare(`INSERT INTO oauth_accounts (provider, provider_user_id, user_id, email, email_verified, created_at, last_login_at)
              VALUES (?,?,?,?,1,?,?)
              ON CONFLICT (provider, provider_user_id) DO UPDATE SET last_login_at=excluded.last_login_at`)
    .run(provider, claims.sub, userId, claims.email, utcNow(), utcNow());
}

// ---------------------------------------------------------------------------
// GitHub sign-in (OAuth 2.0 authorization code)
//
// GitHub differs from Google in three ways that shape this code:
//   1. No OIDC id_token, so nothing can be verified locally. Identity is only
//      trusted after calling the API with the token we just exchanged.
//   2. No PKCE support, so the state cookie (HMAC-signed, HttpOnly) plus the
//      server-side client secret are the whole of the redirect protection.
//   3. A GitHub profile can expose an unverified, or a hidden, email address.
//      Only an address GitHub marks `verified` is ever trusted, and a profile
//      without one is refused rather than guessed.
// ---------------------------------------------------------------------------
function isGithubConfigured() {
  return config.oauth.github.configured;
}

function missingGithubConfig() {
  const missing = [];
  if (!config.oauth.github.clientId) missing.push('GITHUB_CLIENT_ID');
  if (!config.oauth.github.clientSecret) missing.push('GITHUB_CLIENT_SECRET');
  return missing;
}

function buildGithubAuthorizeUrl() {
  if (!isGithubConfigured()) {
    return { ok: false, error: 'not_configured', missing: missingGithubConfig() };
  }
  const state = randomToken(24);
  const url = new URL(config.oauth.github.authorizationEndpoint);
  url.searchParams.set('client_id', config.oauth.github.clientId);
  url.searchParams.set('redirect_uri', config.oauth.github.redirectUri);
  url.searchParams.set('scope', config.oauth.github.scope);
  url.searchParams.set('state', state);
  url.searchParams.set('allow_signup', 'true');
  return { ok: true, url: url.toString(), state, expiresAt: Date.now() + STATE_TTL_MS };
}

async function exchangeGithubCode(code, { fetchImpl = globalThis.fetch } = {}) {
  const body = new URLSearchParams({
    code: String(code),
    client_id: config.oauth.github.clientId,
    client_secret: config.oauth.github.clientSecret,
    redirect_uri: config.oauth.github.redirectUri
  });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10000);
  try {
    const res = await fetchImpl(config.oauth.github.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
      signal: ac.signal
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* GitHub answers form-encoded on some errors */ }
    if (!res.ok || !parsed || !parsed.access_token) {
      const reason = parsed && (parsed.error_description || parsed.error);
      return { ok: false, error: reason || `token endpoint HTTP ${res.status}` };
    }
    return { ok: true, accessToken: parsed.access_token, scope: parsed.scope || '' };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'token endpoint timeout' : `token endpoint error: ${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Primary verified address if there is one, otherwise the first verified one. */
function pickGithubEmail(emails) {
  if (!Array.isArray(emails)) return null;
  const verified = emails.filter((e) => e && e.verified === true && typeof e.email === 'string' && e.email.includes('@'));
  const primary = verified.find((e) => e.primary === true);
  const chosen = primary || verified[0];
  return chosen ? chosen.email.toLowerCase() : null;
}

async function fetchGithubIdentity(accessToken, { fetchImpl = globalThis.fetch } = {}) {
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${accessToken}`,
    'user-agent': 'SaaSShield/0.1',
    'x-github-api-version': '2022-11-28'
  };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10000);
  const get = async (url) => {
    const res = await fetchImpl(url, { headers, signal: ac.signal });
    if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
    return res.json();
  };
  try {
    const user = await get(config.oauth.github.userEndpoint);
    if (!user || user.id === undefined || user.id === null) return { ok: false, error: 'missing_claims' };
    const emails = await get(config.oauth.github.emailsEndpoint);
    const email = pickGithubEmail(emails);
    if (!email) return { ok: false, error: 'email_not_verified_by_provider' };
    return {
      ok: true,
      claims: {
        sub: String(user.id),
        email,
        emailVerified: true,
        name: user.name || user.login || null,
        picture: user.avatar_url || null
      }
    };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'identity endpoint timeout' : `identity endpoint error: ${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

// Reset the cached JWKS (tests, or after a key rotation error).
function clearJwksCache() {
  jwksCache = null;
}

module.exports = {
  isConfigured,
  missingConfig,
  isGithubConfigured,
  missingGithubConfig,
  buildGithubAuthorizeUrl,
  exchangeGithubCode,
  fetchGithubIdentity,
  pickGithubEmail,
  buildAuthorizeUrl,
  signStateCookie,
  readStateCookie,
  fetchJwks,
  verifyIdToken,
  exchangeCode,
  resolveUser,
  clearJwksCache,
  pkceChallenge,
  STATE_TTL_MS
};
