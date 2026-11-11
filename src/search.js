'use strict';

const fs = require('fs');

const SEARCH_TIMEOUT_MS = 15000;
const KEYLESS_TIMEOUT_MS = 12000;
// A browser-shaped user agent: the keyless HTML endpoints serve a stub page to
// obvious bots, and this is the same string a person's browser would send.
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function getSerperKey() {
  if (process.env.SERPER_API_KEY) return process.env.SERPER_API_KEY;
  try {
    const v = fs.readFileSync('/etc/secrets/SERPER_API_KEY', 'utf8').trim();
    if (v) return v;
  } catch {
    // secret file not present
  }
  return null;
}

// Web search for auto-discovery.
//
// Provider order:
//   1. Serper, when SERPER_API_KEY is set. Fast, stable, free tier is generous.
//   2. DuckDuckGo's HTML endpoint, then Mojeek, both keyless.
//
// Auto-discovery used to be impossible without a key because "keyless engines
// block datacenter IPs". That is often true for a single endpoint and worth
// retrying across engines, so the keyless chain is tried in order and the first
// engine that returns links wins. Nothing is fabricated: if every provider
// fails, this throws SearchUnavailableError and discovery reports the failure.
class SearchUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.code = 'SEARCH_UNAVAILABLE';
  }
}

async function fetchText(url, { timeout = KEYLESS_TIMEOUT_MS, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'user-agent': BROWSER_UA, accept: 'text/html,application/xhtml+xml', 'accept-language': 'en', ...headers },
      signal: controller.signal
    });
    const text = res.ok ? await res.text() : '';
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

function decodeHtml(value) {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function uniqueHttp(urls) {
  const seen = new Set();
  const out = [];
  for (const u of urls) {
    if (!/^https?:\/\//i.test(u)) continue;
    const key = u.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u);
  }
  return out;
}

// DuckDuckGo's HTML endpoint wraps every result as /l/?uddg=<encoded target>.
function parseDuckDuckGo(html) {
  const found = [];
  const re = /href="([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = decodeHtml(m[1]);
    let target = null;
    try {
      const u = new URL(raw, 'https://duckduckgo.com');
      const q = u.searchParams.get('uddg');
      if (q) target = q;
    } catch {
      // not a URL we can read; skip it
    }
    if (target) found.push(target);
  }
  return uniqueHttp(found).filter((u) => !/duckduckgo\.com/i.test(u));
}

// Mojeek renders plain anchors; result rows carry class "ob".
function parseMojeek(html) {
  const found = [];
  const re = /<a\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    if (!/class="[^"]*\bob\b/i.test(tag)) continue;
    const href = /href="([^"]+)"/i.exec(tag);
    if (href) found.push(decodeHtml(href[1]));
  }
  return uniqueHttp(found).filter((u) => !/mojeek\.com/i.test(u));
}

const KEYLESS_PROVIDERS = [
  { name: 'duckduckgo', url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, parse: parseDuckDuckGo },
  { name: 'mojeek', url: (q) => `https://www.mojeek.com/search?q=${encodeURIComponent(q)}`, parse: parseMojeek }
];

async function serperSearch(query, num, key) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': key, 'content-type': 'application/json' },
      body: JSON.stringify({ q: query, num }),
      signal: controller.signal
    });
  } catch (e) {
    throw new SearchUnavailableError(`Search request failed: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 || res.status === 403) {
    throw new SearchUnavailableError('Search API rejected the SERPER_API_KEY. Check the key value in Render (Environment tab).');
  }
  if (!res.ok) throw new SearchUnavailableError(`Search API error (HTTP ${res.status}).`);
  let data;
  try {
    data = await res.json();
  } catch {
    throw new SearchUnavailableError('Search API returned an invalid response.');
  }
  const urls = Array.isArray(data.organic)
    ? data.organic.map((r) => (r && typeof r.link === 'string' ? r.link : null)).filter(Boolean)
    : [];
  return urls.slice(0, num);
}

async function keylessSearch(query, num) {
  const failures = [];
  for (const provider of KEYLESS_PROVIDERS) {
    try {
      const res = await fetchText(provider.url(query));
      if (!res.ok) {
        failures.push(`${provider.name}: HTTP ${res.status}`);
        continue;
      }
      const urls = provider.parse(res.text).slice(0, num);
      if (urls.length > 0) return urls;
      failures.push(`${provider.name}: no results`);
    } catch (e) {
      failures.push(`${provider.name}: ${e.name === 'AbortError' ? 'timed out' : e.message}`);
    }
  }
  throw new SearchUnavailableError(
    `No search engine returned results (${failures.join('; ')}). Set SERPER_API_KEY in Render for reliable discovery; a free key is available at serper.dev.`
  );
}

// Keyless engines are tried in production. Tests must never touch the network,
// so the chain is off under NODE_ENV=test unless something forces it on.
function keylessEnabled() {
  if (process.env.SEARCH_KEYLESS_DISABLED === '1') return false;
  if (process.env.SEARCH_KEYLESS_FORCED === '1') return true;
  return process.env.NODE_ENV !== 'test';
}

// Returns an array of result URL strings for a query.
async function searchWeb(query, { num = 10 } = {}) {
  const key = getSerperKey();
  if (!key && !keylessEnabled()) {
    throw new SearchUnavailableError(
      'Auto-discovery needs a search provider. Add SERPER_API_KEY in Render (Environment tab); a free key is available at serper.dev (2,500 searches/month).'
    );
  }
  if (key) {
    try {
      return await serperSearch(query, num, key);
    } catch (e) {
      // A dead key should not switch discovery off entirely: the keyless chain
      // still answers, and its results go through the same host filtering.
      const fallback = await keylessSearch(query, num).catch(() => null);
      if (fallback) return fallback;
      throw e;
    }
  }
  return keylessSearch(query, num);
}

// Discovery is usable without a key now, so this is always true unless every
// engine is unreachable at request time (which surfaces as a discovery error).
function isSearchConfigured() {
  return Boolean(getSerperKey()) || keylessEnabled();
}

function describe() {
  const keyed = Boolean(getSerperKey());
  const enabled = keyed || keylessEnabled();
  return {
    available: enabled,
    provider: keyed ? 'serper' : enabled ? 'keyless' : null,
    providers: keyed ? ['serper', 'duckduckgo', 'mojeek'] : ['duckduckgo', 'mojeek'],
    optional: true,
    detail: !enabled
      ? 'Auto-discovery is off: no search key and the keyless chain is disabled on this deployment. Add comparison sites by URL, or set SERPER_API_KEY.'
      : keyed
      ? 'Auto-discovery searches the web with Serper, falling back to public engines if it fails.'
      : 'Auto-discovery searches the web through public engines without a key. Set SERPER_API_KEY in Render for faster, more reliable discovery.'
  };
}

module.exports = {
  searchWeb, describe, isSearchConfigured, SearchUnavailableError,
  parseDuckDuckGo, parseMojeek
};
