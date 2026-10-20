'use strict';
const path = require('path');

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}
function bool(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  return String(v).toLowerCase() === 'true';
}

const env = process.env;

const config = {
  port: num(env.PORT, 3000),
  host: env.HOST || '0.0.0.0',
  nodeEnv: env.NODE_ENV || 'development',
  publicBaseUrl: (env.PUBLIC_BASE_URL || `http://localhost:${num(env.PORT, 3000)}`).replace(/\/+$/, ''),
  databaseFile: env.DATABASE_FILE || path.join(__dirname, '..', 'data', 'saas-shield.db'),

  sessionTtlHours: num(env.SESSION_TTL_HOURS, 168),
  cookieSecure: bool(env.COOKIE_SECURE, false),
  cookieSameSite: env.COOKIE_SAME_SITE || 'lax',

  authRateLimit: num(env.AUTH_RATE_LIMIT, 10),
  authRateWindowMinutes: num(env.AUTH_RATE_WINDOW_MINUTES, 15),

  crawl: {
    timeoutMs: num(env.CRAWL_TIMEOUT_MS, 10000),
    maxPagesPerSite: num(env.CRAWL_MAX_PAGES_PER_SITE, 25),
    maxDepth: num(env.CRAWL_MAX_DEPTH, 2),
    maxResponseBytes: num(env.CRAWL_MAX_RESPONSE_BYTES, 2097152),
    delayMs: num(env.CRAWL_DELAY_MS, 1000),
    userAgent: env.CRAWL_USER_AGENT || 'SaaSShieldBot/0.1 (+https://saas-shield.example/bot)',
    respectRobots: bool(env.CRAWL_RESPECT_ROBOTS, true)
  },

  ssrf: {
    // Only for local development and automated tests. Production must keep false.
    allowPrivateIps: bool(env.SHIELD_ALLOW_PRIVATE_IPS, false)
  },

  sim: {
    minShingleJaccard: num(env.SIM_MIN_SHINGLE_JACCARD, 0.12),
    minTfidfCosine: num(env.SIM_MIN_TFIDF_COSINE, 0.25),
    minPassageWords: num(env.SIM_MIN_PASSAGE_WORDS, 12),
    shingleSize: num(env.SIM_SHINGLE_SIZE, 5)
  },

  retentionDays: num(env.RETENTION_DAYS, 0)
};

module.exports = config;
