'use strict';
const crypto = require('crypto');
const { randomBytes, scrypt, timingSafeEqual } = crypto;
const { promisify } = require('util');
const scryptAsync = promisify(scrypt);

const SCRYPT_KEYLEN = 32;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

function newId(prefix) {
  return `${prefix}_${randomBytes(12).toString('base64url')}`;
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scryptAsync(String(password), salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  return `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, N, r, p, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const derived = await scryptAsync(String(password), salt, expected.length, { N: +N, r: +r, p: +p });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function hmacToken(secret, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyHmacToken(secret, token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  let expected;
  try {
    expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  } catch {
    return null;
  }
  const sigBuf = Buffer.from(sig || '');
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// Timing-safe string compare for tokens that are not HMAC'd (session ids).
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function utcNow() {
  return new Date().toISOString();
}

module.exports = { newId, hashPassword, verifyPassword, sha256, hmacToken, verifyHmacToken, safeEqual, utcNow, randomBytes };
