'use strict';
// Disposable email detection, deliberately conservative.
//
// The list is a maintained JSON file of EXACT registrable domains. Matching is
// exact after normalisation - never a substring - because a rule like "%mail.com"
// would also reject gmail.com. Unknown domains are allowed: blocking a real
// founder is worse than letting one throwaway inbox through.

const fs = require('fs');
const path = require('path');
const config = require('./config');

let cache = null;
let cacheAt = 0;
const TTL_MS = 60 * 60 * 1000;

function loadList() {
  const now = Date.now();
  if (cache && now - cacheAt < TTL_MS) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'disposable-domains.json'), 'utf8'));
    cache = new Set((raw.domains || []).map(normalise));
  } catch (e) {
    console.error('[disposable] list unreadable:', e.message);
    cache = new Set();
  }
  cacheAt = now;
  return cache;
}

// lowercase, trim, drop a leading www., drop a trailing dot
function normalise(input) {
  return String(input || '').trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
}

function domainOfEmail(email) {
  const at = String(email || '').lastIndexOf('@');
  return at === -1 ? '' : normalise(String(email).slice(at + 1));
}

function isDisposable(email) {
  const domain = domainOfEmail(email);
  if (!domain) return false;
  return loadList().has(domain);
}

// 'off' | 'warn' | 'block' - warn is the default so a stale list cannot stop
// real signups.
function mode() {
  const m = String(config.signup.disposablePolicy || 'warn').toLowerCase();
  return ['off', 'warn', 'block'].includes(m) ? m : 'warn';
}

function check(email) {
  const flagged = isDisposable(email);
  const policy = mode();
  return {
    flagged,
    domain: domainOfEmail(email),
    policy,
    block: flagged && policy === 'block',
    warn: flagged && policy === 'warn'
  };
}

module.exports = { isDisposable, check, normalise, domainOfEmail, mode };
