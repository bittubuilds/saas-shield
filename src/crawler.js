'use strict';
// Secure public-content crawler. Follows redirects manually (each hop is
// revalidated against SSRF rules), respects robots.txt, applies timeouts,
// size limits, conservative per-host rate limiting, and depth/page caps.
const config = require('./config');
const { assertSafeUrl, UnsafeUrlError, normalizeUrl, domainOf } = require('./ssrf');
const { extractReadable, extractLinks } = require('./extract');
const { sha256, newId, utcNow } = require('./util');

const MAX_REDIRECTS = 5;
const ALLOWED_CONTENT_TYPES = /text\/html|application\/xhtml\+xml|text\/plain/i;

const robotsCache = new Map();   // origin -> { rules, fetchedAt }
const lastHit = new Map();       // host -> timestamp for rate limiting
const crawlDelays = new Map();   // host -> promise chain for conservative pacing

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function pace(host) {
  const prev = crawlDelays.get(host) || Promise.resolve();
  const next = prev.then(async () => {
    const last = lastHit.get(host) || 0;
    const wait = config.crawl.delayMs - (Date.now() - last);
    if (wait > 0) await sleep(wait);
    lastHit.set(host, Date.now());
  });
  crawlDelays.set(host, next);
  await next;
}

function matchesRobotsPath(path, disallow) {
  return disallow.some((pfx) => typeof pfx === 'string' && pfx.length > 0 && path.startsWith(pfx));
}

async function getRobots(origin) {
  const cached = robotsCache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < 30 * 60 * 1000) return cached;
  let rules = { disallow: [], fetchedAt: Date.now(), reachable: false };
  try {
    const res = await fetchRobots(origin + '/robots.txt');
    if (res.ok) {
      const body = await res.text();
      rules = parseRobots(body);
      rules.reachable = true;
    }
  } catch { /* no robots or blocked: treat as empty rules */ }
  robotsCache.set(origin, rules);
  return rules;
}

async function fetchRobots(url) {
  const u = await assertSafeUrl(url);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), Math.min(config.crawl.timeoutMs, 8000));
  try {
    return await fetch(u, { method: 'GET', redirect: 'manual', signal: ac.signal,
      headers: { 'user-agent': config.crawl.userAgent, accept: 'text/plain,*/*' } });
  } finally {
    clearTimeout(t);
  }
}

function parseRobots(body) {
  const uaGroup = [];
  let inGroup = false;
  const lines = String(body).split(/\r?\n/).slice(0, 2000);
  for (const raw of lines) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;
    const [k, ...rest] = line.split(':');
    const key = k.trim().toLowerCase();
    const val = rest.join(':').trim();
    if (key === 'user-agent') {
      inGroup = val === '*' || /saasshield/i.test(val);
    } else if (key === 'disallow' && inGroup) {
      if (val) uaGroup.push(val);
    } else if (key === 'allow' && inGroup) {
      // MVP: we honor Disallow only.
    }
  }
  return { disallow: uaGroup, fetchedAt: Date.now(), reachable: true };
}

async function robotsAllows(urlObj) {
  if (!config.crawl.respectRobots) return true;
  const robots = await getRobots(urlObj.origin);
  if (!robots.reachable || robots.disallow.length === 0) return true;
  if (matchesRobotsPath(urlObj.pathname + urlObj.search, robots.disallow)) return false;
  return true;
}

// Fetch a single URL with manual redirect revalidation and response caps.
async function fetchPage(rawUrl) {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = await assertSafeUrl(current);   // validates + DNS-checks every hop
    if (!(await robotsAllows(u))) {
      const err = new Error('Blocked by robots.txt'); err.code = 'ROBOTS'; throw err;
    }
    await pace(u.hostname);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), config.crawl.timeoutMs);
    let res;
    try {
      res = await fetch(u, {
        method: 'GET',
        redirect: 'manual',
        signal: ac.signal,
        headers: {
          'user-agent': config.crawl.userAgent,
          accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
          'accept-language': 'en'
        }
      });
    } catch (e) {
      const err = new Error(e.name === 'AbortError' ? `timed out after ${config.crawl.timeoutMs}ms` : `network error: ${e.message}`);
      err.code = e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK';
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error('redirect without location header');
      let next;
      try {
        next = new URL(loc, u).toString();
      } catch {
        throw new Error('invalid redirect location');
      }
      current = next;
      continue;   // revalidated at loop head
    }

    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.code = 'HTTP_ERROR'; err.status = res.status;
      try { await res.body.cancel(); } catch { /* ignore */ }
      throw err;
    }

    const ctype = res.headers.get('content-type') || '';
    if (!ALLOWED_CONTENT_TYPES.test(ctype)) {
      const err = new Error(`unsupported content-type "${ctype || 'none'}"`);
      err.code = 'UNSUPPORTED_TYPE';
      throw err;
    }

    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > config.crawl.maxResponseBytes) {
      const err = new Error(`response too large (${declared} bytes)`);
      err.code = 'TOO_LARGE';
      throw err;
    }

    // Read with a hard cap to guard against lying/absent content-length.
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    let truncated = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > config.crawl.maxResponseBytes) { truncated = true; break; }
      chunks.push(value);
    }
    try { await reader.cancel(); } catch { /* ignore */ }
    if (truncated) {
      const err = new Error(`response exceeded ${config.crawl.maxResponseBytes} byte limit`);
      err.code = 'TOO_LARGE';
      throw err;
    }
    const html = Buffer.concat(chunks).toString('utf8');
    return { html, finalUrl: u.toString(), httpStatus: res.status };
  }
  throw new UnsafeUrlError('too many redirects');
}

// Crawl a website seed URL. Returns summary { pages, errors, ... } and stores
// pages via the provided onPage callback (async, (page) => void).
async function crawlSite(website, onPage, opts = {}) {
  const maxPages = Math.min(opts.maxPages ?? config.crawl.maxPagesPerSite, config.crawl.maxPagesPerSite);
  const maxDepth = Math.min(opts.maxDepth ?? config.crawl.maxDepth, config.crawl.maxDepth);
  const seen = new Set();           // normalized URLs
  const seenHashes = new Set();     // content dedupe
  const queue = [{ url: normalizeUrl(website.submitted_url), depth: 0 }];
  const errors = [];
  let stored = 0;
  let startedAt = Date.now();

  while (queue.length > 0 && stored < maxPages) {
    const { url, depth } = queue.shift();
    const key = normalizeUrl(url);
    if (seen.has(key)) continue;
    seen.add(key);

    let fetched;
    try {
      fetched = await fetchPage(key);
    } catch (e) {
      if (e instanceof UnsafeUrlError) throw e;   // fatal for the whole crawl: seed is unsafe
      errors.push({ url: key, error: e.message, code: e.code || 'ERROR' });
      continue;
    }

    const page = extractReadable(fetched.html, fetched.finalUrl);
    const hash = sha256(page.text);
    const dup = seenHashes.has(hash);
    seenHashes.add(hash);

    await onPage({
      id: newId('pg'),
      website_id: website.id,
      workspace_id: website.workspace_id,
      url: normalizeUrl(fetched.finalUrl),
      submitted_url: url,
      canonical_url: page.canonicalUrl || null,
      title: page.title || null,
      text_content: page.text,
      meta_description: page.metaDescription || null,
      content_hash: hash,
      http_status: fetched.httpStatus,
      fetched_at: utcNow(),
      duplicate: dup
    });
    if (!dup) stored += 1;

    if (depth < maxDepth) {
      for (const link of extractLinks(fetched.html, fetched.finalUrl, true)) {
        const lk = normalizeUrl(link);
        if (!seen.has(lk) && !queue.some((q) => normalizeUrl(q.url) === lk)) {
          queue.push({ url: lk, depth: depth + 1 });
        }
      }
      queue.sort((a, b) => a.depth - b.depth);
    }
  }

  return { pagesStored: stored, urlsSeen: seen.size, errors, elapsedMs: Date.now() - startedAt };
}

module.exports = { crawlSite, fetchPage, getRobots, parseRobots, isPrivateAddressForTest: require('./ssrf') };
