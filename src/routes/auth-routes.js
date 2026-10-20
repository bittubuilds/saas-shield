'use strict';
const express = require('express');
const db = require('../db');
const config = require('../config');
const { newId, hashPassword, verifyPassword, utcNow } = require('../util');
const {
  createSession, destroySession, parseCookies, SESSION_COOKIE,
  requireAuth, rateLimit, setSessionCookie, clearSessionCookie, audit
} = require('../auth');

const router = express.Router();

function validEmail(email) {
  return typeof email === 'string' && /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(email.trim());
}

const authLimiter = rateLimit({
  limit: config.authRateLimit,
  windowMs: config.authRateWindowMinutes * 60 * 1000,
  bucket: 'auth'
});

router.post('/signup', authLimiter, express.json({ limit: '16kb' }), async (req, res) => {
  const { email, password, workspace_name } = req.body || {};
  const normEmail = validEmail(email) ? email.trim().toLowerCase() : null;
  if (!normEmail) return res.status(400).json({ error: 'A valid email address is required.' });
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE email=?').get(normEmail);
  if (existing) return res.status(409).json({ error: 'An account with this email already exists.' });

  const userId = newId('usr');
  const wsId = newId('wsp');
  const wsName = (typeof workspace_name === 'string' && workspace_name.trim().slice(0, 80)) || 'My workspace';
  const now = utcNow();
  const passwordHash = await hashPassword(password);

  try {
    db.exec('BEGIN');
    db.prepare('INSERT INTO users (id, email, password_hash, name, created_at) VALUES (?,?,?,?,?)')
      .run(userId, normEmail, passwordHash, null, now);
    db.prepare('INSERT INTO workspaces (id, name, created_at) VALUES (?,?,?)').run(wsId, wsName, now);
    db.prepare('INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?,?,?,?)')
      .run(wsId, userId, 'owner', now);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    return res.status(409).json({ error: 'Could not create the account.' });
  }

  const { token, expires } = createSession(userId);
  setSessionCookie(res, token, expires);
  audit(wsId, userId, 'auth.signup', {});
  res.status(201).json({ user: { id: userId, email: normEmail }, workspace: { id: wsId, name: wsName, role: 'owner' } });
});

router.post('/signin', authLimiter, express.json({ limit: '16kb' }), async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(String(email).trim().toLowerCase());
  const ok = user ? await verifyPassword(password, user.password_hash) : false;
  if (!ok) return res.status(401).json({ error: 'Invalid email or password.' });

  const { token, expires } = createSession(user.id);
  setSessionCookie(res, token, expires);
  const ws = db.prepare(`SELECT w.id, w.name, m.role FROM memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=? ORDER BY m.created_at LIMIT 1`).get(user.id);
  res.json({ user: { id: user.id, email: user.email, name: user.name }, workspace: ws || null });
});

router.post('/signout', (req, res) => {
  const cookies = parseCookies(req);
  destroySession(cookies[SESSION_COOKIE]);
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  const workspaces = db.prepare(`
    SELECT w.id, w.name, m.role FROM memberships m
    JOIN workspaces w ON w.id = m.workspace_id
    WHERE m.user_id = ? ORDER BY m.created_at
  `).all(req.user.id);
  res.json({ user: req.user, workspaces });
});

module.exports = router;
