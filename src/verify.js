'use strict';
// Email verification tokens.
//
// Security properties:
//   - 256 bits of CSPRNG entropy in the token; only its SHA-256 is stored.
//   - Single use: consuming a token stamps used_at inside a transaction.
//   - Expiring: TTL from config (default 24h); expired rows are rejected.
//   - Superseded: issuing a new token invalidates any unused earlier token.
//   - Attempt limited: a 6-digit code path allows at most 10 tries per token.
//   - Constant-time comparisons for both token and code lookups.
const db = require('./db/index');
const config = require('./config');
const { sha256, utcNow, randomBytes } = require('./util');
const { safeEqual } = require('./util');

const MAX_CODE_ATTEMPTS = 10;

function buildLink(rawToken) {
  return `${config.publicBaseUrl}/api/auth/verify?token=${encodeURIComponent(rawToken)}`;
}

function countRecentTokens(userId, windowMinutes) {
  const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
  return db.prepare('SELECT COUNT(*) c FROM email_verification_tokens WHERE user_id=? AND created_at>=?')
    .get(userId, since).c;
}

/**
 * Issue a verification token for a user.
 * @returns {{ok:true, token:string, code:string, link:string, expiresAt:string} | {ok:false, error:string, retryAfterSeconds?:number}}
 */
function issueVerification({ userId, email, ip, purpose = 'signup' }) {
  const windowMinutes = config.auth.verificationResendWindowMinutes;
  const max = config.auth.verificationResendMax;
  const recent = countRecentTokens(userId, windowMinutes);
  if (recent >= max) {
    const oldest = db.prepare('SELECT created_at FROM email_verification_tokens WHERE user_id=? AND created_at>=? ORDER BY created_at LIMIT 1')
      .get(userId, new Date(Date.now() - windowMinutes * 60 * 1000).toISOString());
    const retryAfterSeconds = oldest
      ? Math.max(1, Math.ceil((new Date(oldest.created_at).getTime() + windowMinutes * 60000 - Date.now()) / 1000))
      : windowMinutes * 60;
    return { ok: false, error: 'rate_limited', retryAfterSeconds };
  }

  const token = randomBytes(32).toString('base64url');
  // 6-digit code from a CSPRNG (never derived from time or the user id).
  const codeBytes = randomBytes(4).readUInt32BE(0) % 1000000;
  const finalCode = String(codeBytes).padStart(6, '0');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.auth.verificationTtlHours * 3600 * 1000).toISOString();

  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE email_verification_tokens SET invalidated_reason='superseded'
                WHERE user_id=? AND used_at IS NULL AND invalidated_reason IS NULL`).run(userId);
    db.prepare(`INSERT INTO email_verification_tokens
      (id, user_id, code_hash, purpose, created_at, expires_at, used_at, attempts, requested_ip, invalidated_reason)
      VALUES (?,?,?,?,?,?,NULL,0,?,NULL)`)
      .run(sha256(token), userId, sha256(finalCode), purpose, utcNow(), expiresAt, ip || null);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }

  return { ok: true, token, code: finalCode, link: buildLink(token), expiresAt, email: email || null };
}

function isUsable(row) {
  if (!row) return 'invalid';
  if (row.used_at) return 'used';
  if (row.invalidated_reason) return 'invalidated';
  if (new Date(row.expires_at).getTime() <= Date.now()) return 'expired';
  return null;
}

function markVerified(userId, source) {
  const now = utcNow();
  db.prepare(`UPDATE users SET email_verified_at=?, email_verified_source=?
              WHERE id=? AND email_verified_at IS NULL`).run(now, source, userId);
  return db.prepare('SELECT id, email, email_verified_at, email_verified_source FROM users WHERE id=?').get(userId);
}

function consumeByToken(rawToken) {
  if (typeof rawToken !== 'string' || rawToken.length < 20 || rawToken.length > 200) {
    return { ok: false, error: 'invalid' };
  }
  const id = sha256(rawToken);
  const row = db.prepare('SELECT * FROM email_verification_tokens WHERE id=?').get(id);
  // Compare the derived id in constant time as well, so a lookup miss and a
  // mismatch take the same path.
  if (!row || !safeEqual(row.id, id)) return { ok: false, error: 'invalid' };

  const reason = isUsable(row);
  if (reason) return { ok: false, error: reason };

  db.exec('BEGIN');
  try {
    const updated = db.prepare(`UPDATE email_verification_tokens SET used_at=?
                                WHERE id=? AND used_at IS NULL AND invalidated_reason IS NULL`)
      .run(utcNow(), id);
    if (!updated.changes) { db.exec('ROLLBACK'); return { ok: false, error: 'used' }; }
    markVerified(row.user_id, row.purpose === 'signup' ? 'email_link' : 'email_link');
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
  return { ok: true, userId: row.user_id, purpose: row.purpose };
}

function consumeByCode(email, code) {
  const clean = String(code || '').replace(/\D/g, '');
  if (clean.length !== 6) return { ok: false, error: 'invalid' };
  const user = db.prepare('SELECT id, email FROM users WHERE email=?').get(String(email || '').trim().toLowerCase());
  if (!user) return { ok: false, error: 'invalid' };

  const rows = db.prepare(`SELECT * FROM email_verification_tokens
                           WHERE user_id=? AND used_at IS NULL AND invalidated_reason IS NULL
                           ORDER BY created_at DESC LIMIT 3`).all(user.id);
  if (rows.length === 0) return { ok: false, error: 'invalid' };

  const candidate = rows.find((r) => r.code_hash && safeEqual(r.code_hash, sha256(clean)));
  if (!candidate) {
    db.prepare('UPDATE email_verification_tokens SET attempts = attempts + 1 WHERE id=?').run(rows[0].id);
    const attempts = rows[0].attempts + 1;
    if (attempts >= MAX_CODE_ATTEMPTS) {
      db.prepare(`UPDATE email_verification_tokens SET invalidated_reason='too_many_attempts' WHERE id=?`).run(rows[0].id);
      return { ok: false, error: 'too_many_attempts' };
    }
    return { ok: false, error: 'incorrect_code', attemptsLeft: MAX_CODE_ATTEMPTS - attempts };
  }

  const reason = isUsable(candidate);
  if (reason) return { ok: false, error: reason };

  db.exec('BEGIN');
  try {
    const updated = db.prepare('UPDATE email_verification_tokens SET used_at=? WHERE id=? AND used_at IS NULL')
      .run(utcNow(), candidate.id);
    if (!updated.changes) { db.exec('ROLLBACK'); return { ok: false, error: 'used' }; }
    markVerified(user.id, 'email_code');
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
  return { ok: true, userId: user.id, purpose: candidate.purpose };
}

function isVerified(userId) {
  const row = db.prepare('SELECT email_verified_at FROM users WHERE id=?').get(userId);
  return Boolean(row && row.email_verified_at);
}

function invalidateForUser(userId, reason = 'cancelled') {
  db.prepare(`UPDATE email_verification_tokens SET invalidated_reason=?
              WHERE user_id=? AND used_at IS NULL AND invalidated_reason IS NULL`).run(reason, userId);
}

module.exports = {
  issueVerification,
  consumeByToken,
  consumeByCode,
  markVerified,
  isVerified,
  invalidateForUser,
  buildLink,
  countRecentTokens,
  MAX_CODE_ATTEMPTS
};
