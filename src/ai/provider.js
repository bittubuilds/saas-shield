'use strict';
// Provider-independent AI transport.
//
// Only this file knows what a provider looks like on the wire. Everything above
// it speaks in {system, user} -> parsed JSON. Provider keys never leave the
// server: they are read from env, never logged, never returned to a caller.
//
// Verified 2026-11-07 against Groq's official rate-limit docs:
//   openai/gpt-oss-120b on the Free plan = 30 RPM, 1,000 RPD, 8K TPM, 200K TPD
// The 8K TPM ceiling is why every prompt in prompts.js is deliberately small.

const DEFAULT_TIMEOUT_MS = 45_000;

class ProviderError extends Error {
  constructor(message, { code = 'provider_error', retryable = false, status = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

function config() {
  return {
    provider: (process.env.AI_PROVIDER || 'groq').toLowerCase(),
    model: process.env.AI_MODEL || 'openai/gpt-oss-120b',
    baseUrl: process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1',
    apiKey: process.env.AI_API_KEY || process.env.GROQ_API_KEY || '',
    timeoutMs: Number(process.env.AI_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    maxRetries: Number(process.env.AI_MAX_RETRIES || 2),
    temperature: Number(process.env.AI_TEMPERATURE || 0.1)
  };
}

function isConfigured() {
  const c = config();
  return c.provider === 'mock' || Boolean(c.apiKey);
}

// Never echo the key: errors carry a provider name and status, nothing else.
function sanitize(message, apiKey) {
  let out = String(message || 'provider error');
  if (apiKey) out = out.split(apiKey).join('[redacted]');
  return out.replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted]').slice(0, 400);
}

function classifyStatus(status) {
  if (status === 429) return { code: 'quota_exhausted', retryable: true };
  if (status === 401 || status === 403) return { code: 'auth_failed', retryable: false };
  if (status === 404) return { code: 'model_unavailable', retryable: false };
  if (status >= 500) return { code: 'provider_outage', retryable: true };
  return { code: 'provider_error', retryable: false };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Strict JSON extraction: models sometimes wrap output in prose or fences.
// If it will not parse, that is a hard failure, never a guess.
function parseJsonStrict(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : raw).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) throw new ProviderError('model did not return JSON', { code: 'invalid_json' });
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    throw new ProviderError('model returned malformed JSON', { code: 'invalid_json' });
  }
}

async function callGroq({ system, user, jsonSchema }) {
  const c = config();
  if (!c.apiKey) throw new ProviderError('AI provider is not configured', { code: 'not_configured' });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), c.timeoutMs);
  try {
    const res = await fetch(`${c.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${c.apiKey}` },
      body: JSON.stringify({
        model: c.model,
        temperature: c.temperature,
        max_tokens: Number(process.env.AI_MAX_OUTPUT_TOKENS || 1400),
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ]
      })
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const kind = classifyStatus(res.status);
      throw new ProviderError(`provider returned ${res.status} ${sanitize(body, c.apiKey)}`, { ...kind, status: res.status });
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || '';
    return {
      json: parseJsonStrict(text),
      usage: {
        tokens_in: Number(data?.usage?.prompt_tokens || 0),
        tokens_out: Number(data?.usage?.completion_tokens || 0),
        requests: 1
      }
    };
  } catch (e) {
    if (e.name === 'AbortError') throw new ProviderError('provider timed out', { code: 'timeout', retryable: true });
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Deterministic stand-in used by tests: never touches the network, never spends
// quota. Callers inject their own responder.
let mockResponder = null;
function setMockResponder(fn) { mockResponder = fn; }

async function callMock({ system, user, stage }) {
  if (!mockResponder) throw new ProviderError('mock provider has no responder', { code: 'not_configured' });
  const out = await mockResponder({ system, user, stage });
  if (out instanceof Error) {
    if (out instanceof ProviderError) throw out;
    throw new ProviderError(out.message, { code: 'mock_error' });
  }
  return { json: out, usage: { tokens_in: 10, tokens_out: 10, requests: 1 } };
}

// Bounded retry with exponential backoff. Quota exhaustion is surfaced, not
// retried into the ground: the caller pauses and resumes later.
async function complete({ system, user, stage = 'unknown' }) {
  const c = config();
  let lastError = null;
  for (let attempt = 0; attempt <= c.maxRetries; attempt += 1) {
    try {
      const result = c.provider === 'mock'
        ? await callMock({ system, user, stage })
        : await callGroq({ system, user });
      return { ...result, provider: c.provider, model: c.model, attempts: attempt + 1 };
    } catch (e) {
      lastError = e instanceof ProviderError ? e : new ProviderError(e.message);
      if (lastError.code === 'quota_exhausted' || lastError.code === 'not_configured') throw lastError;
      if (!lastError.retryable || attempt === c.maxRetries) throw lastError;
      await sleep(Math.min(8000, 400 * 2 ** attempt));
    }
  }
  throw lastError;
}

module.exports = { complete, isConfigured, config, parseJsonStrict, setMockResponder, ProviderError, sanitize };
