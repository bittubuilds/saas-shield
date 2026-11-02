'use strict';
// Resend delivery webhooks.
//
// A successful send request only means Resend accepted the message. This endpoint
// receives the provider's later events (delivered, bounced, complained, delayed)
// and attaches them to the email_outbox row by provider message id.
//
// Security: Resend signs webhooks with Svix. We verify the signature over the RAW
// body with the shared secret, enforce a timestamp tolerance to stop replays, and
// compare in constant time. Without RESEND_WEBHOOK_SECRET the endpoint is closed.
const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const email = require('../email');

const TOLERANCE_SECONDS = 300;   // reject events older/newer than 5 minutes

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verify a Svix-signed webhook.
 * @param {Buffer} rawBody
 * @param {object} headers
 * @param {string} secret  whsec_... (or the raw base64 secret)
 * @param {number} [nowMs]
 * @returns {{ok:boolean, reason?:string}}
 */
function verifySvix(rawBody, headers, secret, nowMs = Date.now()) {
  const id = headers['svix-id'];
  const timestamp = headers['svix-timestamp'];
  const signature = headers['svix-signature'];
  if (!id || !timestamp || !signature) return { ok: false, reason: 'missing_headers' };
  if (!/^\d+$/.test(String(timestamp))) return { ok: false, reason: 'bad_timestamp' };
  const skew = Math.abs(Math.floor(nowMs / 1000) - Number(timestamp));
  if (skew > TOLERANCE_SECONDS) return { ok: false, reason: 'stale_timestamp' };

  const keyB64 = String(secret).replace(/^whsec_/, '');
  let key;
  try { key = Buffer.from(keyB64, 'base64'); } catch { return { ok: false, reason: 'bad_secret' }; }
  if (!key.length) return { ok: false, reason: 'bad_secret' };

  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ''));
  const expected = crypto.createHmac('sha256', key)
    .update(`${id}.${timestamp}.`)
    .update(body)
    .digest('base64');

  // Header can carry several space-separated "v1,<sig>" entries during rotation.
  const candidates = String(signature).split(' ').map((part) => {
    const idx = part.indexOf(',');
    return idx === -1 ? part : part.slice(idx + 1);
  }).filter(Boolean);

  const ok = candidates.some((candidate) => timingSafeEqualStr(candidate, expected));
  return ok ? { ok: true } : { ok: false, reason: 'bad_signature' };
}

const router = express.Router();

router.post('/webhooks/resend', express.raw({ type: '*/*', limit: '256kb' }), (req, res) => {
  if (!config.email.resendWebhookSecret) {
    // Closed by default: no secret means we cannot tell a real event from a forged one.
    return res.status(503).json({ error: 'Delivery webhooks are not configured.', code: 'webhook_not_configured' });
  }

  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
  const check = verifySvix(raw, req.headers, config.email.resendWebhookSecret);
  if (!check.ok) {
    console.warn(`[webhook] resend event rejected (${check.reason})`);
    return res.status(401).json({ error: 'Invalid signature.' });
  }

  let payload = null;
  try { payload = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({ error: 'Invalid JSON.' }); }

  const type = typeof payload.type === 'string' ? payload.type : '';
  const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
  const messageId = data.email_id || data.id || null;
  const at = payload.created_at ? String(payload.created_at) : new Date().toISOString();

  if (!type.startsWith('email.') || !messageId) {
    // Acknowledge unknown event types so Resend does not retry them forever.
    return res.json({ ok: true, ignored: true });
  }

  let updated = false;
  try {
    updated = email.applyProviderEvent({ messageId, event: type, at });
  } catch (e) {
    console.error('[webhook] could not record resend event:', e.message);
    return res.status(500).json({ error: 'Could not record event.' });
  }

  // Never log the payload: it can contain the recipient address and headers.
  console.log(`[webhook] resend ${type} id=${messageId} recorded=${updated ? 'yes' : 'no match'}`);
  res.json({ ok: true, updated });
});

module.exports = router;
module.exports.verifySvix = verifySvix;
