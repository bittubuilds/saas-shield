'use strict';
// Internal endpoints for an external scheduler.
//
// Render's free tier (and any host that sleeps idle services) cannot guarantee
// in-process timers, so this route is the supported way to keep checks running:
// point a cron service at POST /api/internal/cron with the CRON_SECRET header.
// It is disabled entirely until CRON_SECRET is set, and the comparison is
// timing-safe.
const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const scheduler = require('../scheduler');
const email = require('../email');

const router = express.Router();

function secretFromRequest(req) {
  const header = req.get('x-cron-secret');
  if (header) return header;
  const auth = req.get('authorization') || '';
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '');
  return null;
}

function secretMatches(provided) {
  if (!config.scheduler.cronSecret || !provided) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(config.scheduler.cronSecret));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireCronSecret(req, res, next) {
  if (!config.scheduler.cronSecret) {
    return res.status(503).json({
      error: 'External scheduling is not configured. Set CRON_SECRET to enable this endpoint.',
      code: 'cron_not_configured'
    });
  }
  if (!secretMatches(secretFromRequest(req))) {
    // Uniform response: no hint about whether a secret was supplied or wrong.
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  next();
}

router.post('/cron', requireCronSecret, async (req, res, next) => {
  try {
    const limit = req.body && req.body.limit ? Number(req.body.limit) : undefined;
    const result = await scheduler.runTick({ source: 'external-cron', limit });
    res.json({
      ok: true,
      skipped: Boolean(result.skipped),
      reason: result.reason || null,
      monitor: result.monitor || null,
      digests: result.digests || null,
      deliveries: result.deliveries || null,
      duration_ms: result.durationMs
    });
  } catch (e) {
    next(e);
  }
});

router.get('/status', requireCronSecret, (req, res) => {
  res.json({
    scheduler: scheduler.status(),
    email: email.describeConfig(),
    config: {
      email_verification_required: config.auth.requireEmailVerification,
      google_oauth_configured: config.oauth.google.configured,
      monitor_frequencies: config.monitor.frequencies,
      ssrf_private_ips_allowed: config.ssrf.allowPrivateIps
    }
  });
});

module.exports = router;
