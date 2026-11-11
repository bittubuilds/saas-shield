'use strict';
// JavaScript render fallback for pages that ship a shell instead of content.
//
// Some hosts (InfinityFree and similar free tiers, plus many SPA sites) answer a
// plain GET with a stub that says "enable JavaScript" and deliver the real page
// only after script runs. Without a render step the crawler stores an empty page,
// discovery has no sentence to search, and the scan has nothing to compare.
//
// The rendered browser is the one screenshots already use, and its per-request
// guard is shared so a rendered page cannot reach an internal address.
const config = require('./config');

let playwrightCache;
function playwright() {
  if (playwrightCache !== undefined) return playwrightCache;
  try {
    playwrightCache = require('playwright');
  } catch {
    playwrightCache = null;
  }
  return playwrightCache;
}

function available() {
  return Boolean(playwright());
}

// Tests and operators can switch this off; the default mirrors the crawl config.
function enabled() {
  const raw = process.env.CRAWL_RENDER_THIN_PAGES;
  if (raw === '0' || raw === 'false') return false;
  if (raw) return available();
  // Automatic only in production: a dev server or a test run must never spawn a
  // browser just because a page happened to be short.
  return process.env.NODE_ENV === 'production' && available();
}

// Renders one URL and returns the fully hydrated HTML. Throws on failure; the
// caller keeps the thin static response rather than losing the page.
async function renderHtml(url, { timeoutMs = 20000 } = {}) {
  const pw = playwright();
  if (!pw) {
    const err = new Error('playwright is not installed on this host');
    err.code = 'RENDER_UNAVAILABLE';
    throw err;
  }
  const { blockedHost } = require('./screenshots/browser');

  let browser;
  try {
    browser = await pw.chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const context = await browser.newContext({
      userAgent: config.crawl.userAgent,
      javaScriptEnabled: true,
      viewport: { width: 1280, height: 900 }
    });
    // Same guard as capture: a page cannot pull an internal resource in through
    // a script, an image or a fetch.
    await context.route('**/*', (route) => {
      let target;
      try { target = new URL(route.request().url()); } catch { return route.abort(); }
      if (target.protocol !== 'http:' && target.protocol !== 'https:') return route.abort();
      if (blockedHost(target.hostname)) return route.abort();
      return route.continue();
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    // Give scripted content a moment to settle without waiting on a hung socket.
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    const html = await page.content();
    return { html, finalUrl: page.url() };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { renderHtml, available, enabled };
