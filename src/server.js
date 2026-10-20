'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const config = require('./config');
const db = require('./db');
const authRoutes = require('./routes/auth-routes');
const websiteRoutes = require('./routes/website-routes');
const scanRoutes = require('./routes/scan-routes');
const resultRoutes = require('./routes/result-routes');
const reportRoutes = require('./routes/report-routes');
const workspaceRoutes = require('./routes/workspace-routes');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);   // for correct client IP behind a reverse proxy

app.use(express.json({ limit: '64kb' }));

// Health check for deployment platforms (no auth, no data).
app.get('/api/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// --- API ---
app.use('/api/auth', authRoutes);
app.use('/api', websiteRoutes.router);
app.use('/api', scanRoutes);
app.use('/api', resultRoutes);
app.use('/api', reportRoutes);
app.use('/api', workspaceRoutes);

// API 404 + error handling
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, next) => {   // eslint-disable-line no-unused-vars
  // Never leak stack traces to clients.
  const status = err && err.status ? err.status : 500;
  const msg = status >= 500 ? 'Internal server error.' : (err && err.message) || 'Error.';
  if (status >= 500) console.error('[error]', req.method, req.path, err && err.message); // no bodies/tokens logged
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
});

module.exports = { app, server };
