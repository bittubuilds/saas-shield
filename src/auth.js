'use strict';
const db = require('./db');
const config = require('./config');
const { newId, hashPassword, verifyPassword, sha256, utcNow } = require('./util');

const SESSION_COOKIE = 'shield_session';

// --------------------------------------------------------------------------
// Sessions (opaque random token, only its SHA-256 is stored server-side)
// --------------------------------------------------------------------------
function createSession(userId) {
  const token = newId('tok') + newId('tok');   // 48+ chars of entropy
  const expires = new Date(Date.now() + config.sessionTtlHours * 3600 * 1000);
  db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .run(sha256(token), userId, utcNow(), expires.toISOString());
  return { token, expires };
}

function destroySession(token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sha256(token));
}

function destroyAllSessions(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function userFromRequest(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const row = db.prepare(`
    SELECT s.expires_at, u.id, u.email, u.name, u.email_verified_at, u.email_verified_source
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ?
  `).get(sha256(token));
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    destroySession(token);
    return null;
  }
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    email_verified: Boolean(row.email_verified_at),
    email_verified_source: row.email_verified_source || null
  };
}

function requireAuth(req, res, next) {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Authentication required.' });
  req.user = user;
  next();
}

// Optional gate for actions that need a confirmed address. Not applied to core
// workspace features so a deployment without an email provider stays usable;
// it exists so sensitive flows can require it explicitly.
function requireVerifiedEmail(req, res, next) {
  if (!req.user || !req.user.email_verified) {
    return res.status(403).json({
      error: 'Confirm your email address to continue.',
      code: 'email_not_verified'
    });
  }
  next();
}

// Resolve the workspace from :workspaceId (or the user's first membership) and
// verify the user belongs to it. Server-side tenant isolation happens here.
function requireWorkspace(allowRole = null) {
  return (req, res, next) => {
    const wsId = req.params.workspaceId || req.body.workspace_id || req.query.workspace_id;
    let membership;
    if (wsId) {
      membership = db.prepare(`
        SELECT m.role, w.id, w.name FROM memberships m
        JOIN workspaces w ON w.id = m.workspace_id
        WHERE m.user_id = ? AND m.workspace_id = ?
      `).get(req.user.id, wsId);
    } else {
      membership = db.prepare(`
        SELECT m.role, w.id, w.name FROM memberships m
        JOIN workspaces w ON w.id = m.workspace_id
        WHERE m.user_id = ? ORDER BY m.created_at LIMIT 1
      `).get(req.user.id);
    }
    if (!membership) return res.status(404).json({ error: 'Workspace not found.' });
    if (allowRole && !['owner', 'admin'].includes(membership.role)) {
      return res.status(403).json({ error: 'Insufficient workspace role.' });
    }
    req.workspace = membership;
    next();
  };
}

function requireAdminRole(req, res, next) {
  if (!req.workspace || !['owner', 'admin'].includes(req.workspace.role)) {
    return res.status(403).json({ error: 'Admin role required.' });
  }
  next();
}

// --------------------------------------------------------------------------
// In-memory rate limiter (per IP + route bucket).
// Keys are the socket/proxy-resolved IP (see server.js trust proxy setting), not
// a raw X-Forwarded-For header, so a client cannot mint unlimited identities.
// --------------------------------------------------------------------------
const buckets = new Map();
let lastSweep = Date.now();

function sweepBuckets(now) {
  if (now - lastSweep < 60000) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (now - bucket.start > 60 * 60 * 1000) buckets.delete(key);
  }
}

function rateLimit({ limit, windowMs, bucket }) {
  return (req, res, next) => {
    const ip = req.ip || 'unknown';
    const key = `${bucket}:${ip}`;
    const now = Date.now();
    sweepBuckets(now);
    let b = buckets.get(key);
    if (!b || now - b.start > windowMs) {
      b = { start: now, count: 0 };
      buckets.set(key, b);
    }
    b.count++;
    if (b.count > limit) {
      res.set('Retry-After', String(Math.ceil((b.start + windowMs - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests. Try again shortly.' });
    }
    next();
  };
}

// --------------------------------------------------------------------------
// Persistent auth event log + rate limiting that survives a restart.
// Stores only an email, an IP, an action and an outcome. Never a password,
// token, or code.
// --------------------------------------------------------------------------
function logAuthEvent({ email, userId, ip, action, outcome }) {
  try {
    db.prepare('INSERT INTO auth_events (id, email, user_id, ip, action, outcome, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(newId('aev'), email ? String(email).slice(0, 320) : null, userId || null,
        ip || null, String(action).slice(0, 60), String(outcome).slice(0, 40), utcNow());
  } catch {
    /* audit logging must never break the request */
  }
}

function recentAuthEventCount({ email, ip, action, windowMs }) {
  const since = new Date(Date.now() - windowMs).toISOString();
  if (email) {
    return db.prepare('SELECT COUNT(*) c FROM auth_events WHERE lower(email)=lower(?) AND action=? AND created_at>=?')
      .get(email, action, since).c;
  }
  return db.prepare('SELECT COUNT(*) c FROM auth_events WHERE ip=? AND action=? AND created_at>=?')
    .get(ip, action, since).c;
}

function persistentRateLimit({ action, limit, windowMs, by = 'ip' }) {
  return (req, res, next) => {
    const email = req.body && typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : null;
    if (by === 'email' && !email) return next();
    const count = recentAuthEventCount({
      email: by === 'email' ? email : null,
      ip: req.ip || 'unknown',
      action,
      windowMs
    });
    if (count >= limit) {
      res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({ error: 'Too many attempts. Please wait before trying again.' });
    }
    next();
  };
}

function setSessionCookie(res, token, expires) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: config.cookieSameSite,
    secure: config.cookieSecure,
    expires,
    path: '/'
  });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: config.cookieSameSite, secure: config.cookieSecure, path: '/' });
}

function audit(workspaceId, userId, action, details) {
  db.prepare('INSERT INTO audit_events (id, workspace_id, user_id, action, details, created_at) VALUES (?,?,?,?,?,?)')
    .run(newId('aud'), workspaceId || null, userId || null, action, details ? JSON.stringify(details) : null, utcNow());
}

module.exports = {
  SESSION_COOKIE, createSession, destroySession, destroyAllSessions, parseCookies, userFromRequest,
  requireAuth, requireVerifiedEmail, requireWorkspace, requireAdminRole, rateLimit,
  persistentRateLimit, recentAuthEventCount, logAuthEvent,
  setSessionCookie, clearSessionCookie, audit, hashPassword, verifyPassword
};
