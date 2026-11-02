'use strict';
// Sitemap-based page discovery.
//
// Purpose: find a site's own pages without any search API. This is the free
// replacement for the "search the web" step when a user is registering pages to
// monitor. It reads robots.txt for Sitemap: directives, then follows sitemap
// files (bounded), so discovery stays within what the site owner published.
//
// Everything goes through crawler.fetchPage, which already enforces the SSRF
// rules, timeouts and size caps, so a malicious sitemap URL cannot do more than
// a normal crawl could.
const { fetchPage } = require('./crawler');

const MAX_SITEMAPS = 8;         // one index plus a few children
const MAX_URLS = 500;           // hard cap on URLs read from sitemaps
const MAX_BYTES = 3 * 1024 * 1024;

function originOf(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

// Sitemap: directives live in robots.txt as absolute URLs.
function sitemapsFromRobots(robotsText, origin) {
  if (!robotsText) return [];
  const found = [];
  for (const line of String(robotsText).split(/\r?\n/)) {
    const m = /^\s*sitemap\s*:\s*(\S+)\s*$/i.exec(line);
    if (!m) continue;
    try {
      const u = new URL(m[1], origin);
      if (u.protocol === 'http:' || u.protocol === 'https:') found.push(u.toString());
    } catch { /* ignore malformed */ }
  }
  return [...new Set(found)];
}

// Returns { urls: [...loc], children: [...sitemap locs] } for one document.
function parseSitemap(xml) {
  const text = String(xml || '');
  const locs = [];
  const re = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(text)) !== null && locs.length < MAX_URLS) {
    const raw = m[1].replace(/&amp;/g, '&').trim();
    if (raw) locs.push(raw);
  }
  const isIndex = /<sitemapindex\b/i.test(text);
  return isIndex ? { children: locs, urls: [] } : { children: [], urls: locs };
}

async function readUrl(url) {
  const fetched = await fetchPage(url, { accept: ['application/xml', 'text/xml', 'text/plain'] });
  return { body: fetched.html, finalUrl: fetched.finalUrl };
}

// Discover the site's own http(s) URLs from robots.txt + sitemaps.
// Never throws: returns { ok, urls, sitemaps, error } so callers can degrade.
async function discoverFromSitemaps(siteUrl) {
  const origin = originOf(siteUrl);
  const host = hostOf(siteUrl);
  if (!origin || !host) return { ok: false, urls: [], sitemaps: [], error: 'invalid_url' };

  const queue = [];
  const seenSitemaps = new Set();
  const urls = new Set();

  // robots.txt first: it is the published list of sitemaps, and it is cheap.
  try {
    const robots = await readUrl(`${origin}/robots.txt`);
    for (const s of sitemapsFromRobots(robots.body, origin)) queue.push(s);
  } catch { /* a missing robots.txt is normal */ }

  // Conventional locations as a fallback when robots.txt lists nothing.
  if (queue.length === 0) queue.push(`${origin}/sitemap.xml`);

  let firstError = null;
  while (queue.length && seenSitemaps.size < MAX_SITEMAPS) {
    const next = queue.shift();
    if (seenSitemaps.has(next)) continue;
    seenSitemaps.add(next);
    let parsed;
    try {
      const doc = await readUrl(next);
      parsed = parseSitemap(doc.body);
    } catch (e) {
      if (!firstError) firstError = e.message;
      continue;
    }
    for (const child of parsed.children) {
      if (hostOf(child) === host && !seenSitemaps.has(child)) queue.push(child);
    }
    for (const loc of parsed.urls) {
      if (hostOf(loc) !== host) continue;      // same site only
      try {
        const u = new URL(loc);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
        u.hash = '';
        urls.add(u.toString());
      } catch { /* ignore */ }
      if (urls.size >= MAX_URLS) break;
    }
  }

  return {
    ok: urls.size > 0,
    urls: [...urls],
    sitemaps: [...seenSitemaps],
    error: urls.size > 0 ? null : (firstError || 'no_sitemap_urls')
  };
}

module.exports = { discoverFromSitemaps, parseSitemap, sitemapsFromRobots };
