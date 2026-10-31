'use strict';
// Email delivery.
//
// Design rule: this module never pretends an email was sent. Every call returns
// an explicit status:
//   'sent'    - the provider accepted the message (or the dev sink wrote it)
//   'failed'  - the provider rejected it / the network failed (retryable)
//   'skipped' - no provider configured, or an invalid recipient
//
// Providers: Resend (HTTP API), a generic JSON webhook, or a local dev sink file.
// No API key is ever hardcoded, logged, or returned to a client.
const fs = require('fs');
const path = require('path');
const config = require('./config');

const EMAIL_RE = /^[^\s@<>,;"]{1,64}@[^\s@<>,;"]{1,255}\.[^\s@<>,;"]{2,}$/;

function providerName() {
  const p = config.email;
  if (p.provider === 'resend' && p.resendApiKey) return 'resend';
  if (p.provider === 'webhook' && p.webhookUrl) return 'webhook';
  if (p.devSinkFile && !config.isProduction) return 'dev-sink';
  return null;
}

function describeConfig() {
  const provider = providerName();
  const missing = [];
  if (!provider) {
    missing.push('EMAIL_PROVIDER (set to "resend" or "webhook")');
    if (config.email.provider === 'resend') missing.push('RESEND_API_KEY');
    if (config.email.provider === 'webhook') missing.push('EMAIL_WEBHOOK_URL');
  }
  return {
    configured: Boolean(provider),
    provider,
    from: config.email.from,
    detail: provider
      ? `Outbound email uses the "${provider}" provider.`
      : 'No email provider is configured. Verification links and alert emails will be recorded as skipped, not sent.',
    missing
  };
}

function isValidRecipient(to) {
  return typeof to === 'string' && EMAIL_RE.test(to.trim()) && to.length <= 320;
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
      // Provider error bodies are safe to surface to logs: they contain no
      // secrets. Truncate so a huge HTML error page cannot flood a log line.
      const detail = (parsed && (parsed.message || parsed.error)) || raw.slice(0, 300) || `HTTP ${res.status}`;
      return { ok: false, error: String(detail).slice(0, 300), status: res.status, body: parsed };
    }
    return { ok: true, body: parsed };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? `provider timeout after ${config.email.timeoutMs}ms` : `network error: ${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

function appendToDevSink(record) {
  const file = path.resolve(config.email.devSinkFile);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
}

/**
 * Send one email.
 * @param {{to:string, subject:string, text:string, html?:string, tags?:object}} message
 * @returns {Promise<{status:'sent'|'failed'|'skipped', provider:string|null, messageId?:string|null, error?:string}>}
 */
async function sendMail(message) {
  const to = String(message && message.to || '').trim();
  const subject = String(message && message.subject || '').slice(0, 240);
  const text = String(message && message.text || '');
  const html = message && message.html ? String(message.html) : undefined;

  if (!isValidRecipient(to)) {
    return { status: 'skipped', provider: null, error: 'invalid recipient address' };
  }

  const provider = providerName();
  if (!provider) {
    return {
      status: 'skipped',
      provider: null,
      error: 'no email provider configured (see README: email provider configuration)'
    };
  }

  if (provider === 'dev-sink') {
    try {
      appendToDevSink({ to, subject, text, html: html || null, at: new Date().toISOString() });
      return { status: 'sent', provider: 'dev-sink', messageId: `dev-${Date.now()}` };
    } catch (e) {
      return { status: 'failed', provider: 'dev-sink', error: `dev sink write failed: ${e.message}` };
    }
  }

  if (provider === 'resend') {
    const r = await postJson(config.email.resendEndpoint, {
      from: config.email.from,
      to: [to],
      subject,
      text,
      ...(html ? { html } : {})
    }, { authorization: `Bearer ${config.email.resendApiKey}` });
    if (!r.ok) return { status: 'failed', provider: 'resend', error: r.error };
    return { status: 'sent', provider: 'resend', messageId: (r.body && r.body.id) || null };
  }

  if (provider === 'webhook') {
    const headers = config.email.webhookToken ? { authorization: `Bearer ${config.email.webhookToken}` } : {};
    const r = await postJson(config.email.webhookUrl, {
      from: config.email.from, to, subject, text, ...(html ? { html } : {})
    }, headers);
    if (!r.ok) return { status: 'failed', provider: 'webhook', error: r.error };
    return { status: 'sent', provider: 'webhook', messageId: (r.body && (r.body.id || r.body.messageId)) || null };
  }

  return { status: 'skipped', provider: null, error: 'email provider misconfigured' };
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
  return { to: email, subject, text, html: textToHtml(text) };
}

module.exports = {
  sendMail,
  describeConfig,
  providerName,
  isValidRecipient,
  verificationMessage,
  textToHtml,
  escapeHtml
};
