'use strict';
const path = require('path');
const express = require('express');
const config = require('./config');
const db = require('./db/index');
const durability = require('./db/durability');
const email = require('./email');
const authRoutes = require('./routes/auth-routes');
const { requireAuth } = require('./auth');
const websiteRoutes = require('./routes/website-routes');
const scanRoutes = require('./routes/scan-routes');
const resultRoutes = require('./routes/result-routes');
const reportRoutes = require('./routes/report-routes');
const workspaceRoutes = require('./routes/workspace-routes');
const monitorRoutes = require('./routes/monitor-routes');
const alertRoutes = require('./routes/alert-routes');
const internalRoutes = require('./routes/internal-routes');
const webhookRoutes = require('./routes/webhook-routes');
const discoverRoutes = require('./routes/discover-routes');

const app = express();
app.disable('x-powered-by');

// Trust exactly the configured number of proxy hops. An unbounded value would
// let a client spoof its IP through X-Forwarded-For and defeat rate limiting.
if (config.trustProxyHops > 0) {
  app.set('trust proxy', config.trustProxyHops);
} else {
  app.set('trust proxy', false);
}

// Webhooks need the raw body for signature verification, so they are mounted
// before the JSON parser.
app.use('/api', webhookRoutes);
app.use(express.json({ limit: '64kb' }));

// Security headers. No user-controlled HTML is rendered by the API, and the
// frontend escapes all interpolated data, so a strict script-src is viable.
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('X-Frame-Options', 'DENY');
  res.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.set('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'"
  ].join('; '));
  if (config.cookieSecure) {
    res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
});

// Health check for deployment platforms. No auth, no data, no secrets.
// Probed at startup so an ephemeral deployment announces itself in the deploy log
// instead of only after the first data loss.
try { durability.announce(); } catch (e) {
  console.error('[db] durability check failed:', e.message);
  if (process.env.DB_REQUIRE_DURABLE === 'true') throw e;
}

app.get('/api/health', (req, res) => {
  let dbOk = true;
  try {
    db.prepare('SELECT 1').get();
  } catch {
    dbOk = false;
  }
  res.status(dbOk ? 200 : 503).json({
    ok: dbOk,
    uptime: Math.round(process.uptime()),
    env: config.nodeEnv,
    email_configured: email.describeConfig().configured,
    google_oauth_configured: config.oauth.google.configured,
    database: (() => { try { return durability.probe(); } catch (e) { return { error: e.message }; } })(),
    scheduler_enabled: config.scheduler.enabled,
    external_cron_configured: Boolean(config.scheduler.cronSecret)
  });
});

// --- API ---
app.use('/api/auth', authRoutes);
// The SPA reads the session from /api/me (see public/app.js). Keep it working.
app.get('/api/me', requireAuth, authRoutes.meHandler);
app.use('/api/internal', internalRoutes);
app.use('/api', websiteRoutes.router);
app.use('/api', scanRoutes);
app.use('/api', resultRoutes);
app.use('/api', reportRoutes);
app.use('/api', require('./routes/ai-routes'));
app.use('/api', workspaceRoutes);
app.use('/api', monitorRoutes);
app.use('/api', alertRoutes);
app.use('/api', discoverRoutes);
app.use('/api', require('./routes/competitor-routes'));

// API 404 + error handling
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, next) => {   // eslint-disable-line no-unused-vars
  // Never leak stack traces to clients. Request bodies, cookies and tokens are
  // never logged.
  const status = err && err.status ? err.status : 500;
  const msg = status >= 500 ? 'Internal server error.' : (err && err.message) || 'Error.';
  if (status >= 500) console.error('[error]', req.method, req.path, err && err.message);
  res.status(status).json({ error: msg });
});

// --- Static frontend ---
const publicDir = path.join(__dirname, '..', 'public');
// Code files (html/js/css) use ETag revalidation so deploys are picked up
// immediately; immutable assets get a short cache. The service worker handles
// offline caching separately.
app.use(express.static(publicDir, {
  index: false,
  extensions: false,
  maxAge: 0,
  etag: true,
  setHeaders: (res, filePath) => {
    if (/\.(png|ico|webmanifest)$/.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=3600');
    else res.setHeader('Cache-Control', 'no-cache');
  }
}));
app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.get('/app', (req, res) => res.sendFile(path.join(publicDir, 'app.html')));

// Workspace-isolated deep links all render the SPA shell.
app.get('/app/*', (req, res) => res.sendFile(path.join(publicDir, 'app.html')));

const server = app.listen(config.port, config.host, () => {
  console.log(`SaaS Shield listening on http://localhost:${config.port} (env=${config.nodeEnv})`);
  if (config.ssrf.allowPrivateIps) {
    console.warn('WARNING: SHIELD_ALLOW_PRIVATE_IPS is true. SSRF protections are relaxed - local/dev mode only.');
  }
  if (!email.describeConfig().configured) {
    console.warn('NOTE: no email provider configured. Verification and alert emails will be recorded as skipped.');
  }
  if (!config.oauth.google.configured) {
    console.log('NOTE: Google sign-in is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).');
  }
});

// The in-process scheduler is useful for a long-running process, but it is not
// a guarantee: on hosts that sleep idle instances it stops while asleep. The
// /api/internal/cron endpoint exists for that case.
let scheduler = null;
if (config.scheduler.enabled && config.nodeEnv !== 'test') {
  scheduler = require('./scheduler');
  scheduler.start();
}

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received, shutting down`);
  if (scheduler) scheduler.stop();
  server.close(() => {
    try { db.close(); } catch { /* already closed */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = { app, server };
