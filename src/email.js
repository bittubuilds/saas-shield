'use strict';
// Email delivery.
//
// Design rules, in priority order:
//   1. Never claim success without a provider acknowledgement that carries an
//      email id. A 20x response with no id is a FAILURE, not a send.
//   2. Never claim delivery. "Accepted" only means the provider queued it. Real
//      delivery arrives later (or never) and is tracked via provider webhooks.
//   3. Never swallow an error. Every attempt returns a classified status and is
//      written to email_outbox so the outcome stays auditable.
//   4. Never log or return secrets, tokens or full API responses.
//
// Status vocabulary:
//   'sent'    - provider accepted the message AND returned an id
//   'failed'  - provider rejected / network failed / no id returned
//   'skipped' - no provider configured, or an invalid recipient
const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('./db');
const { newId, utcNow } = require('./util');

const EMAIL_RE = /^[^\s@<>,;"]{1,64}@[^\s@<>,;"]{1,255}\.[^\s@<>,;"]{2,}$/;

// Sent by Resend's shared test sender. It can only deliver to the address on the
// Resend account; every other recipient is rejected with HTTP 403.
const RESEND_TEST_SENDER_RE = /(^|<|[\s,])[^@\s<>]*@resend\.dev>?$/i;

function providerName() {
  const p = config.email;
  if (p.provider === 'resend' && p.resendApiKey) return 'resend';
  if (p.provider === 'webhook' && p.webhookUrl) return 'webhook';
  if (p.devSinkFile && !config.isProduction) return 'dev-sink';
  return null;
}

function isResendTestSender(from = config.email.from) {
  return RESEND_TEST_SENDER_RE.test(String(from || '').trim());
}

// "bittu@example.com" -> "b***@example.com": enough to debug, not a leak.
function maskEmail(address) {
  const s = String(address || '');
  const at = s.lastIndexOf('@');
  if (at < 1) return '***';
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  const head = local.slice(0, 1);
  return `${head}${'*'.repeat(Math.max(1, Math.min(6, local.length - 1)))}@${domain}`;
}

function domainOf(address) {
  const s = String(address || '');
  const at = s.lastIndexOf('@');
  return at >= 0 ? s.slice(at + 1).toLowerCase().slice(0, 190) : '';
}

function describeConfig() {
  const provider = providerName();
  const missing = [];
  if (!provider) {
    if (config.email.provider === 'resend') missing.push('RESEND_API_KEY');
    else if (config.email.provider === 'webhook') missing.push('EMAIL_WEBHOOK_URL');
    else missing.push('EMAIL_PROVIDER (set to "resend" or "webhook")');
  }
  const testSender = provider === 'resend' && isResendTestSender();
  const notes = [];
  if (testSender) {
    notes.push(
      'EMAIL_FROM uses Resend\'s test sender (onboarding@resend.dev). Resend only ' +
      'delivers those emails to the address on the Resend account; every other ' +
      'recipient is rejected. Verify a domain at resend.com/domains and set ' +
      'EMAIL_FROM to an address on it to email real users.'
    );
  }
  return {
    configured: Boolean(provider),
    provider,
    from: config.email.from,
    test_sender: testSender,
    delivery_tracking: Boolean(config.email.resendWebhookSecret),
    // Deployment marker: proves which build is live without exposing internals.
    error_redaction: true,
    webhook_signature_version: 'svix-v1',
    detail: provider
      ? `Outbound email uses the "${provider}" provider.`
      : 'No email provider is configured. Verification links and alert emails will be recorded as skipped, not sent.',
    missing,
    notes
  };
}

function isValidRecipient(to) {
  return typeof to === 'string' && EMAIL_RE.test(to.trim()) && to.length <= 320;
}

// Provider errors, classified. `retryable` drives the alert retry ladder.
function classifyProviderError(status, detail) {
  const text = String(detail || '');
  if (/only send testing emails|verify a domain/i.test(text)) {
    return { code: 'test_sender_restricted', retryable: false };
  }
  if (status === 401 || status === 403) return { code: 'auth_error', retryable: false };
  if (status === 422) return { code: 'invalid_request', retryable: false };
  if (status === 429) return { code: 'rate_limited', retryable: true };
  if (status === 413) return { code: 'payload_too_large', retryable: false };
  if (status >= 500) return { code: 'provider_error', retryable: true };
  return { code: 'provider_rejected', retryable: false };
}

function safeErrorText(detail) {
  // Provider messages are short and useful, but they can echo addresses (Resend
  // names the account owner when the test sender is used) and, if a key ever
  // appeared, it must not survive. Mask both before logging or storing.
  return String(detail || '')
    .replace(/re_[A-Za-z0-9_-]{8,}/g, 're_***')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => maskEmail(m))
    .replace(/\s+/g, ' ')
    .slice(0, 240);
}

async function postJson(url, body, headers = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.email.timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ac.signal
    });
    const raw = await res.text();
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { /* non-JSON provider response */ }
    if (!res.ok) {
      const detail = (parsed && (parsed.message || parsed.error)) || raw.slice(0, 300) || `HTTP ${res.status}`;
      return { ok: false, httpStatus: res.status, detail: safeErrorText(detail), body: parsed };
    }
    return { ok: true, httpStatus: res.status, body: parsed };
  } catch (e) {
    const timedOut = e.name === 'AbortError';
    return {
      ok: false,
      httpStatus: 0,
      detail: timedOut ? `provider timeout after ${config.email.timeoutMs}ms` : `network error: ${e.message}`,
      transport: true
    };
  } finally {
    clearTimeout(timer);
  }
}

function appendToDevSink(record) {
  const file = path.resolve(config.email.devSinkFile);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Audit trail for every attempt, so "did the email go out?" is answerable.
// ---------------------------------------------------------------------------
function recordAttempt(result, message) {
  try {
    const now = utcNow();
    db.prepare(`INSERT INTO email_outbox
      (id, to_email, to_domain, subject, provider, provider_message_id, status,
       error_code, error_message, test_sender, context, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      newId('eml'),
      String(message.to || '').slice(0, 320),
      domainOf(message.to),
      String(message.subject || '').slice(0, 240),
      result.provider || null,
      result.messageId || null,
      result.status,
      result.errorCode || null,
      result.error ? safeErrorText(result.error) : null,
      result.testSender ? 1 : 0,
      String(message.context || 'generic').slice(0, 60),
      now,
      now
    );
  } catch (e) {
    // Never let auditing break delivery.
    console.error('[email] could not record outbox row:', e.message);
  }
}

// Called by the Resend webhook. Returns true when a row was updated.
function applyProviderEvent({ messageId, event, at }) {
  if (!messageId || !event) return false;
  const map = {
    'email.sent': 'accepted',
    'email.delivered': 'delivered',
    'email.delivery_delayed': 'delayed',
    'email.bounced': 'bounced',
    'email.complained': 'complained',
    'email.opened': 'opened',
    'email.clicked': 'clicked'
  };
  const status = map[event];
  if (!status) return false;

  // Events can arrive out of order and can be retried. Rank them so a late
  // 'email.sent' never overwrites a 'delivered'/'bounced' outcome, and a terminal
  // state is never replaced by a softer one.
  const RANK = { failed: 1, accepted: 1, delayed: 2, delivered: 3, bounced: 3, complained: 3, opened: 4, clicked: 4 };
  const TERMINAL = new Set(['delivered', 'bounced', 'complained']);
  const now = utcNow();
  const rows = db.prepare('SELECT id, status FROM email_outbox WHERE provider_message_id=?').all(messageId);
  let changed = 0;
  for (const row of rows) {
    const current = row.status;
    const isTerminal = TERMINAL.has(current);
    const rankNow = RANK[status] || 0;
    const rankCur = RANK[current] || 0;
    if (isTerminal && rankNow < RANK.delivered) continue;       // never soften a terminal outcome
    if (rankNow < rankCur) continue;                            // never move backwards
    db.prepare(`UPDATE email_outbox
        SET status=?, last_event=?, last_event_at=?,
            delivered_at=CASE WHEN ?='delivered' THEN COALESCE(delivered_at, ?) ELSE delivered_at END,
            updated_at=?
        WHERE id=?`).run(status, event, at || now, status, at || now, now, row.id);
    changed += 1;
  }
  return changed > 0;
}

function logOutcome(result, message) {
  const line = [
    '[email]',
    `provider=${result.provider || 'none'}`,
    `status=${result.status}`,
    result.errorCode ? `code=${result.errorCode}` : null,
    result.retryable ? 'retryable=yes' : null,
    `to=${maskEmail(message.to)}`,
    result.messageId ? `id=${result.messageId}` : null,
    result.testSender ? 'test_sender=yes' : null
  ].filter(Boolean).join(' ');
  if (result.status === 'failed') console.error(line, result.error ? `- ${result.error}` : '');
  else console.log(line);
}

/**
 * Send one email.
 * @param {{to:string, subject:string, text:string, html?:string, context?:string}} message
 * @returns {Promise<{status:'sent'|'failed'|'skipped', provider:string|null,
 *   messageId?:string|null, errorCode?:string|null, error?:string|null,
 *   retryable?:boolean, testSender?:boolean}>}
 */
async function sendMail(message) {
  const msg = message && typeof message === 'object' ? message : {};
  const to = String(msg.to || '').trim();
  const base = { provider: null, messageId: null, errorCode: null, error: null, retryable: false, testSender: false };

  if (!isValidRecipient(to)) {
    const result = { ...base, status: 'skipped', errorCode: 'invalid_recipient', error: 'invalid recipient address' };
    logOutcome(result, { to });
    return result;
  }

  const provider = providerName();
  if (!provider) {
    // Configuration error, not a send. Loud on the server, honest to the caller.
    const wants = config.email.provider || '(unset)';
    console.error(`[email] not sent: EMAIL_PROVIDER=${wants} but no usable provider is configured ` +
      `(set RESEND_API_KEY for resend, or EMAIL_WEBHOOK_URL for webhook). to=${maskEmail(to)}`);
    const result = {
      ...base,
      status: 'skipped',
      errorCode: 'not_configured',
      error: 'no email provider configured'
    };
    recordAttempt(result, { to, subject: msg.subject, context: msg.context });
    return result;
  }

  if (provider === 'dev-sink') {
    try {
      appendToDevSink({ to, subject: msg.subject, text: msg.text, html: msg.html || null, at: utcNow() });
      const result = { ...base, provider: 'dev-sink', status: 'sent', messageId: `dev-${Date.now()}` };
      logOutcome(result, { to });
      return result;
    } catch (e) {
      const result = { ...base, provider: 'dev-sink', status: 'failed', errorCode: 'dev_sink_error', error: e.message };
      logOutcome(result, { to });
      return result;
    }
  }

  if (provider === 'resend') {
    const testSender = isResendTestSender();
    const r = await postJson(config.email.resendEndpoint, {
      from: config.email.from,
      to: [to],
      subject: String(msg.subject || '').slice(0, 240),
      text: String(msg.text || ''),
      ...(msg.html ? { html: String(msg.html) } : {})
    }, { authorization: `Bearer ${config.email.resendApiKey}` });

    if (!r.ok) {
      const classified = r.transport
        ? { code: 'network', retryable: true }
        : classifyProviderError(r.httpStatus, r.detail);
      const result = {
        ...base,
        provider: 'resend',
        status: 'failed',
        errorCode: classified.code,
        retryable: classified.retryable,
        error: r.detail,
        httpStatus: r.httpStatus
      };
      recordAttempt(result, { to, subject: msg.subject, context: msg.context });
      logOutcome(result, { to });
      return result;
    }

    const messageId = r.body && typeof r.body.id === 'string' ? r.body.id : null;
    if (!messageId) {
      // A 20x without an id cannot be traced, retried or status-tracked.
      const result = {
        ...base,
        provider: 'resend',
        status: 'failed',
        errorCode: 'missing_message_id',
        retryable: true,
        error: 'provider accepted the request but returned no email id'
      };
      recordAttempt(result, { to, subject: msg.subject, context: msg.context });
      logOutcome(result, { to });
      return result;
    }

    const result = { ...base, provider: 'resend', status: 'sent', messageId, testSender };
    recordAttempt(result, { to, subject: msg.subject, context: msg.context });
    logOutcome(result, { to });
    return result;
  }

  if (provider === 'webhook') {
    const headers = config.email.webhookToken ? { authorization: `Bearer ${config.email.webhookToken}` } : {};
    const r = await postJson(config.email.webhookUrl, {
      from: config.email.from, to, subject: msg.subject, text: msg.text, ...(msg.html ? { html: msg.html } : {})
    }, headers);
    if (!r.ok) {
      const classified = r.transport ? { code: 'network', retryable: true } : classifyProviderError(r.httpStatus, r.detail);
      const result = {
        ...base, provider: 'webhook', status: 'failed',
        errorCode: classified.code, retryable: classified.retryable, error: r.detail
      };
      recordAttempt(result, { to, subject: msg.subject, context: msg.context });
      logOutcome(result, { to });
      return result;
    }
    const messageId = (r.body && (r.body.id || r.body.messageId)) || null;
    if (!messageId) {
      const result = {
        ...base, provider: 'webhook', status: 'failed',
        errorCode: 'missing_message_id', retryable: true,
        error: 'webhook accepted the request but returned no id'
      };
      recordAttempt(result, { to, subject: msg.subject, context: msg.context });
      logOutcome(result, { to });
      return result;
    }
    const result = { ...base, provider: 'webhook', status: 'sent', messageId };
    recordAttempt(result, { to, subject: msg.subject, context: msg.context });
    logOutcome(result, { to });
    return result;
  }

  const result = { ...base, status: 'skipped', errorCode: 'misconfigured', error: 'email provider misconfigured' };
  logOutcome(result, { to });
  return result;
}

// ---------------------------------------------------------------------------
// Templates. Plain text plus minimal HTML. All interpolated values are escaped.
// ---------------------------------------------------------------------------
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function textToHtml(text) {
  const paragraphs = String(text).split(/\n{2,}/).map((block) =>
    `<p style="margin:0 0 14px;line-height:1.55">${escapeHtml(block).replace(/\n/g, '<br>')}</p>`).join('');
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1d21">
    <div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e3e6ea;border-radius:10px;padding:26px 28px">
      ${paragraphs}
      <p style="margin:22px 0 0;padding-top:16px;border-top:1px solid #eceef1;font-size:12px;color:#6b7280">SaaS Shield monitors public competitor pages and records what changed. You are receiving this because you are an owner or admin of the workspace.</p>
    </div></body></html>`;
}

function verificationMessage({ email, link, code, workspaceName, ttlHours }) {
  const subject = 'Confirm your SaaS Shield email address';
  const text = [
    `Confirm your email address to activate your SaaS Shield workspace${workspaceName ? ` "${workspaceName}"` : ''}.`,
    `Open this link to confirm: ${link}`,
    code ? `Or enter this code in the app: ${code}` : null,
    `This link expires in ${ttlHours} hour${ttlHours === 1 ? '' : 's'} and can be used once.`,
    `If you did not create a SaaS Shield account, ignore this email and no account will be activated.`
  ].filter(Boolean).join('\n\n');
  return { to: email, subject, text, html: textToHtml(text), context: 'signup_verification' };
}

module.exports = {
  sendMail,
  describeConfig,
  providerName,
  isValidRecipient,
  isResendTestSender,
  maskEmail,
  applyProviderEvent,
  classifyProviderError,
  verificationMessage,
  textToHtml,
  escapeHtml
};
