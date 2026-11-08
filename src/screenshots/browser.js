'use strict';
// Headless browser adapter for screenshot capture.
//
// Playwright is an OPTIONAL dependency. It is required lazily, inside a try/catch,
// so a host without it (a Render free instance, a slim container) reports "no
// browser available" instead of failing to boot or failing the text crawl.
//
// Two safety properties matter here, because the URL comes from a competitor:
//   1. the target URL goes through the same SSRF pipeline as the text crawler
//      (ssrf.assertSafeUrl: scheme, port, DNS resolution, private/reserved ranges);
//   2. every subresource request is filtered too, so a page cannot pull in an
//      image or script from a private address after the top-level URL passed.
// A browser can never be perfectly sandboxed by a URL check alone; the paginated
// response is untrusted pixels, and the docs say so. This filtering removes the
// obvious internal-network paths.
const config = require('../config');
const ssrf = require('../ssrf');

let cached = null;

// Probe without launching anything: can we load Playwright, and is a browser built?
function playwrightModule() {
  if (cached) return cached;
  try {
    // eslint-disable-next-line global-require
    const pw = require('playwright');
    cached = { module: pw, error: null };
    return cached;
  } catch (e) {
    cached = { module: null, error: e };
    return cached;
  }
}

function capability() {
  const loaded = playwrightModule();
  if (!loaded.module) {
    return {
      available: false,
      engine: 'playwright',
      reason: 'playwright is not installed on this host',
      hint: 'npm run screenshots:install (downloads Chromium), then set SHOT_ENABLED=true'
    };
  }
  const version = (() => {
    try { return require('playwright/package.json').version; } catch { return null; }
  })();
  return { available: true, engine: 'playwright', version, reason: null };
}

// Hosts that must never be rendered: loopback names and link-local metadata style
// literals. Full private-range detection happens on the top-level URL via SSRF DNS
// checks; this is the per-request guard for subresources.
function blockedHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  // Cloud metadata endpoints are never a legitimate page resource, not even in the
  // development mode that otherwise allows private targets.
  if (h === 'metadata.google.internal' || h === '169.254.169.254') return true;
  // config.ssrf.allowPrivateIps exists only for local development and tests (a smoke
  // test against 127.0.0.1 needs it); production keeps it false.
  if (config.ssrf.allowPrivateIps) return false;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true;
  if (h === '::1') return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return ssrf.isPrivateAddress(h);
  return false;
}

class CaptureError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CaptureError';
    this.code = code;
  }
}

function withTimeout(promise, ms, onTimeout) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { if (onTimeout) onTimeout(); } catch { /* best effort */ }
      reject(new CaptureError(`capture timed out after ${ms}ms`, 'SHOT_TIMEOUT'));
    }, Math.max(1, ms));
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// A provider is the thing the capture layer talks to. Tests inject a fake one with
// the same shape, so no test needs a real browser.
function playwrightProvider({ capabilityOverride = null } = {}) {
  return {
    name: 'playwright',
    capability() { return capabilityOverride || capability(); },

    async open() {
      const loaded = playwrightModule();
      if (!loaded.module) {
        const err = new CaptureError('playwright is not installed', 'SHOT_BROWSER_UNAVAILABLE');
        throw err;
      }
      const s = config.screenshots;
      try {
        const browser = await loaded.module.chromium.launch({
          headless: true,
          args: s.browserArgs
        });
        return {
          browser,
          async close() {
            try { await browser.close(); } catch { /* already gone */ }
          }
        };
      } catch (e) {
        // A missing shared library, a sandbox restriction or an out-of-memory
        // failure all land here. They mean "this host cannot capture", not "the
        // crawl failed".
        const code = /Executable doesn't exist|ENOENT|Cannot find module/i.test(String(e.message))
          ? 'SHOT_BROWSER_UNAVAILABLE'
          : 'SHOT_BROWSER_LAUNCH_FAILED';
        throw new CaptureError(`browser launch failed: ${e.message}`, code);
      }
    },

    // Capture one page inside an already-open browser. Always closes the context,
    // whatever happens, so a bad page cannot leak a renderer.
    async capture(session, {
      url, timeoutMs, navigationTimeoutMs, viewport, fullPage, maxHeight, maxBytes
    }) {
      const started = Date.now();
      await ssrf.assertSafeUrl(url);        // throws UnsafeUrlError for internal targets
      const context = await session.browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
        javaScriptEnabled: true,
        reducedMotion: 'reduce',
        serviceWorkers: 'block',
        userAgent: config.crawl.userAgent
      });
      try {
        await context.route('**/*', (route) => {
          const request = route.request();
          let target;
          try { target = new URL(request.url()); } catch { return route.abort(); }
          if (target.protocol !== 'http:' && target.protocol !== 'https:') return route.abort();
          if (blockedHost(target.hostname)) return route.abort();
          // Video and sockets cost memory and never appear in a still image.
          if (request.resourceType() === 'media' || request.resourceType() === 'websocket') return route.abort();
          return route.continue();
        });

        const page = await context.newPage();
        const work = (async () => {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs });
          // Best effort: give fonts and layout a moment, but never fail a capture
          // because a page keeps a connection open.
          await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
          const size = await page.evaluate(() => ({
            width: Math.max(document.documentElement.scrollWidth || 0, window.innerWidth || 0),
            height: Math.max(document.documentElement.scrollHeight || 0, window.innerHeight || 0)
          })).catch(() => ({ width: viewport.width, height: viewport.height }));

          const width = Math.max(1, Math.min(viewport.width, size.width || viewport.width));
          const height = Math.max(1, Math.min(maxHeight, Math.max(viewport.height, size.height || viewport.height)));
          if (fullPage) await page.setViewportSize({ width, height }).catch(() => {});

          const buffer = await page.screenshot({ type: 'png', fullPage: false, caret: 'hide', animations: 'disabled' });
          if (buffer.length > maxBytes) {
            throw new CaptureError(`screenshot is ${buffer.length} bytes, over the ${maxBytes} byte limit`, 'SHOT_TOO_LARGE');
          }
          return { buffer, width, height, durationMs: Date.now() - started, finalUrl: page.url() };
        })();

        return await withTimeout(work, timeoutMs, () => { page.close().catch(() => {}); });
      } catch (e) {
        if (e instanceof CaptureError) throw e;
        if (e && e.name === 'UnsafeUrlError') throw new CaptureError(e.message, 'SHOT_UNSAFE_URL');
        const code = e && e.name === 'TimeoutError' ? 'SHOT_TIMEOUT' : 'SHOT_FAILED';
        throw new CaptureError(`capture failed: ${e && e.message ? e.message : 'unknown error'}`, code);
      } finally {
        await context.close().catch(() => {});
      }
    }
  };
}

module.exports = {
  capability, playwrightProvider, blockedHost, CaptureError, withTimeout, playwrightModule
};
