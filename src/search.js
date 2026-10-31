'use strict';

const fs = require('fs');

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

// Web search provider for auto-discovery.
//
// Honest capability note: every keyless search engine (DuckDuckGo HTML, Bing
// scraping, Mojeek) returns anti-bot shells from datacenter IPs, so a search
// API key is REQUIRED for auto-discovery. Serper.dev offers a free tier
// (2,500 queries/month) and is the supported provider.
//
// No results are ever fabricated: without a key this module throws
// SearchUnavailableError and the discovery fails with a clear message.

const SEARCH_TIMEOUT_MS = 15000;

class SearchUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.code = 'SEARCH_UNAVAILABLE';
  }
}

// Returns an array of result URL strings for a query.
async function searchWeb(query, { num = 10 } = {}) {
  // Key comes from either an environment variable or a Render Secret File
  // (/etc/secrets/SERPER_API_KEY). Whichever is configured wins.
  const key = getSerperKey();
  if (!key) {
    throw new SearchUnavailableError(
      'Auto-discovery needs a search API key. Add SERPER_API_KEY in Render (Environment tab). A free key is available at serper.dev (2,500 searches/month).'
    );
  }
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
  if (!res.ok) {
    throw new SearchUnavailableError(`Search API error (HTTP ${res.status}).`);
  }
  let data;
  try {
    data = await res.json();
  } catch {
    throw new SearchUnavailableError('Search API returned an invalid response.');
  }
  const urls = Array.isArray(data.organic)
    ? data.organic.map((r) => (r && typeof r.link === 'string' ? r.link : null)).filter(Boolean)
    : [];
  return urls;
}

module.exports = { searchWeb, isSearchConfigured: () => Boolean(getSerperKey()), SearchUnavailableError };
