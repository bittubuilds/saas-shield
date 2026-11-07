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
  isProduction: (env.NODE_ENV || 'development') === 'production',
  publicBaseUrl: (env.PUBLIC_BASE_URL || `http://localhost:${num(env.PORT, 3000)}`).replace(/\/+$/, ''),
  databaseFile: env.DATABASE_FILE || path.join(__dirname, '..', 'data', 'saas-shield.db'),

  // Number of reverse-proxy hops in front of the app. Used for the client IP that
  // rate limiting keys on. Never trust an unbounded number of X-Forwarded-For hops:
  // that lets a client mint arbitrary IPs.
  trustProxyHops: num(env.TRUST_PROXY_HOPS, 1),

  sessionTtlHours: num(env.SESSION_TTL_HOURS, 168),
  cookieSecure: bool(env.COOKIE_SECURE, false),
  cookieSameSite: env.COOKIE_SAME_SITE || 'lax',

  authRateLimit: num(env.AUTH_RATE_LIMIT, 10),
  authRateWindowMinutes: num(env.AUTH_RATE_WINDOW_MINUTES, 15),

  auth: {
    // New accounts must confirm their email before they get a session.
    requireEmailVerification: bool(env.AUTH_REQUIRE_EMAIL_VERIFICATION, true),
    // Existing accounts created before email verification existed are treated as
    // confirmed and flagged with source='migration' so this decision stays auditable.
    grandfatherExistingUsers: bool(env.AUTH_GRANDFATHER_EXISTING, true),
    verificationTtlHours: num(env.AUTH_VERIFICATION_TTL_HOURS, 24),
    verificationResendMax: num(env.AUTH_VERIFICATION_RESEND_MAX, 5),
    verificationResendWindowMinutes: num(env.AUTH_VERIFICATION_RESEND_WINDOW_MINUTES, 60),
    // Dev only: return the verification link in the API response when no email
    // provider is configured. Forced off in production.
    devExposeVerificationLink: bool(env.AUTH_DEV_EXPOSE_LINK, false)
  },

  // Email delivery. The app never pretends an email was sent: with no provider
  // configured, sends are recorded with status 'skipped' and a reason.
  email: {
    provider: (env.EMAIL_PROVIDER || '').toLowerCase(), // '', 'resend', 'webhook'
    from: env.EMAIL_FROM || 'SaaS Shield <no-reply@saas-shield.local>',
    resendApiKey: env.RESEND_API_KEY || '',
    resendEndpoint: env.RESEND_ENDPOINT || 'https://api.resend.com/emails',
    webhookUrl: env.EMAIL_WEBHOOK_URL || '',
    webhookToken: env.EMAIL_WEBHOOK_TOKEN || '',
    timeoutMs: num(env.EMAIL_TIMEOUT_MS, 10000),
    // Svix signing secret for Resend delivery webhooks (whsec_...).
    resendWebhookSecret: env.RESEND_WEBHOOK_SECRET || '',
    // Dev sink: append every outbound email to this file instead of sending.
    devSinkFile: env.EMAIL_DEV_SINK || ''
  },

  oauth: {
    google: {
      clientId: env.GOOGLE_CLIENT_ID || '',
      clientSecret: env.GOOGLE_CLIENT_SECRET || '',
      redirectUri: env.GOOGLE_REDIRECT_URI || '',
      authorizationEndpoint: env.GOOGLE_AUTH_ENDPOINT || 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: env.GOOGLE_TOKEN_ENDPOINT || 'https://oauth2.googleapis.com/token',
      jwksEndpoint: env.GOOGLE_JWKS_URI || 'https://www.googleapis.com/oauth2/v3/certs',
      issuer: env.GOOGLE_ISSUER || 'https://accounts.google.com'
    }
  },

  crawl: {
    timeoutMs: num(env.CRAWL_TIMEOUT_MS, 10000),
    maxPagesPerSite: num(env.CRAWL_MAX_PAGES_PER_SITE, 25),
    maxDepth: num(env.CRAWL_MAX_DEPTH, 2),
    maxResponseBytes: num(env.CRAWL_MAX_RESPONSE_BYTES, 2097152),
    delayMs: num(env.CRAWL_DELAY_MS, 1000),
    userAgent: env.CRAWL_USER_AGENT || 'SaaSShieldBot/0.1 (+https://saas-shield.example/bot)',
    respectRobots: bool(env.CRAWL_RESPECT_ROBOTS, true)
  },

  // Phase 4 competitor intelligence collection. Bounded by design: a competitor
  // costs at most maxPages fetches, and no single page type may take the whole
  // budget. These are read at call time so tests and operators can tune them.
  competitorIntel: {
    maxPages: num(env.CINT_MAX_PAGES, 12),
    maxPerType: num(env.CINT_MAX_PAGES_PER_TYPE, 3),
    maxTextChars: num(env.CINT_MAX_TEXT_CHARS, 20000),
    staleAfterMs: num(env.CINT_STALE_AFTER_MINUTES, 20) * 60 * 1000,
    // A pricing page is required evidence for a price statement; without one the
    // competitor's price stays unknown rather than being guessed from a homepage.
    pageTypes: ['homepage', 'pricing', 'features', 'product', 'docs', 'about', 'blog']
  },

  ssrf: {
    // Only for local development and automated tests. Production must keep false.
    allowPrivateIps: bool(env.SHIELD_ALLOW_PRIVATE_IPS, false)
  },

  sim: {
    minShingleJaccard: num(env.SIM_MIN_SHINGLE_JACCARD, 0.12),
    minTfidfCosine: num(env.SIM_MIN_TFIDF_COSINE, 0.25),
    minPassageWords: num(env.SIM_MIN_PASSAGE_WORDS, 12),
    shingleSize: num(env.SIM_SHINGLE_SIZE, 5),
    // A cosine score is only meaningful on pages with enough words. Very short
    // pages (a 60-word landing page) produce high cosine on everyday vocabulary.
    minCosineWords: num(env.SIM_MIN_COSINE_WORDS, 140),
    // A cosine-only agreement also needs short-phrase (3-gram) overlap above this
    // floor. Measured: unrelated portfolio sites 0.007, same-industry-but-original
    // 0.034, genuinely copied 26-word passage 0.093.
    minShortShingleJaccard: num(env.SIM_MIN_SHORT_SHINGLE_JACCARD, 0.05),
    minStructuralScore: num(env.SIM_MIN_STRUCTURAL_SCORE, 0.55)
  },

  monitor: {
    // Supported scan frequencies, in hours. Anything else is rejected.
    frequencies: [1, 6, 12, 24, 72, 168],
    defaultFrequencyHours: num(env.MONITOR_DEFAULT_FREQUENCY_HOURS, 24),
    useSitemap: bool(env.MONITOR_USE_SITEMAP, true),
    maxPagesPerWebsite: num(env.MONITOR_MAX_PAGES_PER_SITE, 12),
    // Bounded work per scheduler tick so one tick can never run away.
    maxChecksPerTick: num(env.MONITOR_MAX_CHECKS_PER_TICK, 6),
    // A check older than this in 'running' state is considered abandoned.
    staleCheckMinutes: num(env.MONITOR_STALE_CHECK_MINUTES, 20),
    // Ignore changes whose significance score is below this when deciding
    // whether to raise an immediate notification (they stay in the changelog).
    notifyMinSignificance: num(env.MONITOR_NOTIFY_MIN_SIGNIFICANCE, 0.4)
  },

  alerts: {
    // Immediate-notification retry ladder in minutes (bounded, no infinite retry).
    retryDelaysMinutes: (env.ALERT_RETRY_DELAYS_MINUTES || '5,30,120')
      .split(',').map((s) => num(s.trim(), 0)).filter((n) => n > 0),
    defaultDigestDay: num(env.DIGEST_DEFAULT_DAY, 1),      // 1 = Monday (0 = Sunday)
    defaultDigestHourUtc: num(env.DIGEST_DEFAULT_HOUR_UTC, 8)
  },

  scheduler: {
    enabled: bool(env.ENABLE_INTERNAL_SCHEDULER, true),
    intervalSeconds: num(env.SCHEDULER_INTERVAL_SECONDS, 300),
    // Shared secret for POST /api/internal/cron. Without it that endpoint is off.
    cronSecret: env.CRON_SECRET || '',
    lockTtlSeconds: num(env.SCHEDULER_LOCK_TTL_SECONDS, 600)
  },

  retentionDays: num(env.RETENTION_DAYS, 0)
};

config.email.configured = Boolean(
  (config.email.provider === 'resend' && config.email.resendApiKey) ||
  (config.email.provider === 'webhook' && config.email.webhookUrl) ||
  (config.email.devSinkFile && !config.isProduction)
);

config.oauth.google.configured = Boolean(
  config.oauth.google.clientId && config.oauth.google.clientSecret
);

// Absolute OAuth callback. Derived from PUBLIC_BASE_URL unless explicitly set.
config.oauth.google.redirectUri = config.oauth.google.redirectUri ||
  `${config.publicBaseUrl}/api/auth/google/callback`;

config.monitor.frequencies = config.monitor.frequencies
  .map((n) => Number(n))
  .filter((n) => Number.isFinite(n) && n > 0);

if (!config.monitor.frequencies.includes(config.monitor.defaultFrequencyHours)) {
  config.monitor.frequencies.push(config.monitor.defaultFrequencyHours);
  config.monitor.frequencies.sort((a, b) => a - b);
}

require('./authmode').apply(config);

// Durability policy. Nothing here changes where data lives by default; it only
// decides whether the app shouts when that location cannot survive a deploy.
config.durability = {
  requireDurable: env.DB_REQUIRE_DURABLE === 'true',
  persistentPath: env.DB_PERSISTENT_PATH || null,
  backupDir: env.DB_BACKUP_DIR || null,
  backupKeep: num(env.DB_BACKUP_KEEP, 7)
};

// A scan that has not finished within this window is treated as orphaned by a
// crashed process and recovered. Cancellation and long crawls of big sites stay
// well inside it; override with SCAN_STALE_AFTER_MINUTES.
config.scan = { staleAfterMs: num(env.SCAN_STALE_AFTER_MINUTES, 15) * 60 * 1000 };

module.exports = config;
