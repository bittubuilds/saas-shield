'use strict';
const express = require('express');
const config = require('./config');
const db = require('./db');
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

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function userFromRequest(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const row = db.prepare(`
    SELECT s.expires_at, u.id, u.email, u.name
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ?
  `).get(sha256(token));
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    destroySession(token);
    return null;
  }
  return { id: row.id, email: row.email, name: row.name };
}

function requireAuth(req, res, next) {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Authentication required.' });
  req.user = user;
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
// In-memory rate limiter (per IP + route bucket)
// --------------------------------------------------------------------------
const buckets = new Map();
function rateLimit({ limit, windowMs, bucket }) {
  return (req, res, next) => {
    const ip = req.ip || 'unknown';
    const key = `${bucket}:${ip}`;
    const now = Date.now();
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
  SESSION_COOKIE, createSession, destroySession, parseCookies, userFromRequest,
  requireAuth, requireWorkspace, requireAdminRole, rateLimit, setSessionCookie,
  clearSessionCookie, audit, hashPassword, verifyPassword
};
