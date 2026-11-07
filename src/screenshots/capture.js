'use strict';
// Screenshot capture orchestration.
//
// One competitor, at most a handful of pages, one browser, bounded concurrency and
// a hard timeout per page. The contract with the caller (the text collector) is
// simple and one-directional:
//
//   * this function never throws;
//   * a browser that is missing, crashes, hangs or returns garbage produces rows
//     with status failed/unavailable and leaves the crawl result untouched;
//   * identical images are stored once, and the second sighting is recorded as a
//     duplicate pointing at the original.
//
// Capture is not analysis. Nothing here looks at the pixels beyond hashing them.
const crypto = require('node:crypto');
const config = require('../config');
const versions = require('../competitor/evidence-versions');
const { getStorage } = require('../storage');
const shotStore = require('./store');
const browser = require('./browser');

// A tiny pool: no dependency needed, and the concurrency limit is observable in
// tests through the provider it calls.
async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const size = Math.max(1, Math.min(Number(limit) || 1, items.length || 1));
  await Promise.all(Array.from({ length: size }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

// Which collected pages are worth a picture. One per page type keeps the cost
// bounded and avoids four screenshots of the same layout.
function targetsFromPages(pages = [], { pageTypes = config.screenshots.pageTypes, max = config.screenshots.maxPerCompetitor } = {}) {
  const allowed = new Set(pageTypes);
  const seenType = new Set();
  const seenUrl = new Set();
  const out = [];
  for (const page of pages) {
    if (out.length >= max) break;
    const pageType = String(page.page_type || page.pageType || 'other');
    if (!allowed.has(pageType)) continue;
    if (seenType.has(pageType)) continue;
    const url = String(page.url || '');
    if (!/^https?:\/\//i.test(url) || seenUrl.has(url)) continue;
    seenType.add(pageType);
    seenUrl.add(url);
    out.push({ pageId: page.page_id || page.id || null, url, pageType });
  }
  return out;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function safeReason(e) {
  const code = (e && e.code) || 'SHOT_FAILED';
  const message = String((e && e.message) || 'unknown error').slice(0, 300);
  return { code, message };
}

// Record screenshot metadata in the evidence model so it is versioned and
// freshness-aware like every other piece of collected evidence. The excerpt is
// descriptive metadata, never a description of what the image "shows".
function linkEvidence({ workspaceId, competitorId, pageId, url, pageType, hash, width, height, capturedAt }) {
  return versions.recordVersion({
    workspaceId, competitorId, pageId,
    sourceUrl: url,
    evidenceType: 'screenshot',
    field: `screenshot:${pageType}`,
    excerpt: `screenshot of ${pageType} page ${url} | ${width}x${height} | sha256:${String(hash).slice(0, 16)}`,
    verificationStatus: 'observed',
    observedAt: capturedAt
  });
}

async function captureFor({
  workspaceId, competitorId, pages = [], pageIds = new Map(),
  storage = null, provider = null,
  settings = config.screenshots,
  enabled = config.screenshots.enabled
} = {}) {
  const started = Date.now();
  if (!enabled) {
    return { enabled: false, reason: 'screenshots_disabled', targets: 0, captured: 0, duplicates: 0, failed: 0, unavailable: 0, results: [] };
  }

  const targets = targetsFromPages(pages, {
    pageTypes: settings.pageTypes,
    max: settings.maxPerCompetitor
  });
  if (!targets.length) {
    return { enabled: true, reason: 'no_supported_pages', targets: 0, captured: 0, duplicates: 0, failed: 0, unavailable: 0, results: [] };
  }

  const engine = provider || browser.playwrightProvider();
  const cap = engine.capability();
  const results = [];

  // No browser on this host: record that honestly, once per target, and return.
  if (!cap.available) {
    for (const target of targets) {
      const row = shotStore.recordScreenshot({
        workspaceId, competitorId, pageId: target.pageId, url: target.url, pageType: target.pageType,
        status: 'unavailable', reason: `${cap.reason}${cap.hint ? ` (${cap.hint})` : ''}`
      });
      results.push({ url: target.url, page_type: target.pageType, status: row.status, id: row.id });
    }
    return {
      enabled: true, reason: 'browser_unavailable', browser: cap,
      targets: targets.length, captured: 0, duplicates: 0, failed: 0, unavailable: targets.length,
      results, duration_ms: Date.now() - started
    };
  }

  // Storage problems (a read-only filesystem, a bad provider name) must not take
  // the run down either: fall back to a provider that still works, and say so.
  let activeStorage = storage;
  let storageNote = null;
  if (!activeStorage) {
    try {
      activeStorage = getStorage({ provider: settings.storageProvider, dir: settings.dir });
    } catch (e) {
      const reason = safeReason(e);
      for (const target of targets) {
        const row = shotStore.recordScreenshot({
          workspaceId, competitorId, pageId: target.pageId, url: target.url, pageType: target.pageType,
          status: 'unavailable', reason: `storage unavailable: ${reason.message}`
        });
        results.push({ url: target.url, page_type: target.pageType, status: row.status, id: row.id });
      }
      return {
        enabled: true, reason: 'storage_unavailable',
        targets: targets.length, captured: 0, duplicates: 0, failed: 0, unavailable: targets.length,
        results, duration_ms: Date.now() - started
      };
    }
  }
  const describe = typeof activeStorage.describe === 'function' ? activeStorage.describe() : {};

  let session = null;
  let launchError = null;
  try {
    session = await engine.open();
  } catch (e) {
    launchError = safeReason(e);
  }

  if (!session) {
    for (const target of targets) {
      const row = shotStore.recordScreenshot({
        workspaceId, competitorId, pageId: target.pageId, url: target.url, pageType: target.pageType,
        status: 'unavailable', reason: `${launchError.code}: ${launchError.message}`
      });
      results.push({ url: target.url, page_type: target.pageType, status: row.status, id: row.id });
    }
    return {
      enabled: true, reason: 'browser_unavailable', error: launchError,
      targets: targets.length, captured: 0, duplicates: 0, failed: 0, unavailable: targets.length,
      results, duration_ms: Date.now() - started
    };
  }

  try {
    const outcomes = await runPool(targets, settings.concurrency, async (target) => {
      const pageId = target.pageId || pageIds.get(target.url) || null;
      let shot;
      try {
        // Defence in depth: the adapter has its own deadline, and the pool refuses
        // to wait longer than that plus a small grace even if a provider hangs.
        shot = await browser.withTimeout(engine.capture(session, {
          url: target.url,
          timeoutMs: settings.timeoutMs,
          navigationTimeoutMs: settings.navigationTimeoutMs,
          viewport: settings.viewport,
          fullPage: settings.fullPage,
          maxHeight: settings.maxHeight,
          maxBytes: settings.maxBytes
        }), Number(settings.timeoutMs || 15000) + 500);
      } catch (e) {
        const { code, message } = safeReason(e);
        const row = shotStore.recordScreenshot({
          workspaceId, competitorId, pageId, url: target.url, pageType: target.pageType,
          status: 'failed', reason: `${code}: ${message}`
        });
        return { url: target.url, page_type: target.pageType, status: 'failed', reason: code, id: row.id };
      }

      const hash = sha256(shot.buffer);
      const capturedAt = require('../util').utcNow();

      // Deduplicate before writing: the same image for this competitor is stored
      // once. The new row points at the stored one and carries the same reference.
      const existing = shotStore.findByHash({ competitorId, contentHash: hash });
      if (existing) {
        const row = shotStore.recordScreenshot({
          workspaceId, competitorId, pageId, url: target.url, pageType: target.pageType,
          status: 'duplicate', reason: `identical to ${existing.id}`,
          contentHash: hash,
          storageProvider: existing.storage_provider, storageKey: existing.storage_key,
          storageUrl: existing.storage_url, bytes: existing.bytes,
          width: shot.width, height: shot.height, durationMs: shot.durationMs,
          capturedAt, duplicateOf: existing.id
        });
        try {
          linkEvidence({ workspaceId, competitorId, pageId, url: target.url, pageType: target.pageType, hash, width: shot.width, height: shot.height, capturedAt });
        } catch { /* evidence linking must not fail a capture */ }
        return { url: target.url, page_type: target.pageType, status: 'duplicate', id: row.id, duplicate_of: existing.id };
      }

      const key = require('../storage').keyFor({ workspaceId, competitorId, contentHash: hash });
      let stored;
      try {
        stored = await activeStorage.put({ key, buffer: shot.buffer, contentType: 'image/png' });
      } catch (e) {
        const { code, message } = safeReason(e);
        const row = shotStore.recordScreenshot({
          workspaceId, competitorId, pageId, url: target.url, pageType: target.pageType,
          status: 'failed', reason: `STORAGE_ERROR: ${message}`,
          contentHash: hash, width: shot.width, height: shot.height,
          durationMs: shot.durationMs, capturedAt
        });
        return { url: target.url, page_type: target.pageType, status: 'failed', reason: 'storage_error', code, id: row.id };
      }

      let row;
      try {
        row = shotStore.recordScreenshot({
          workspaceId, competitorId, pageId, url: target.url, pageType: target.pageType,
          status: 'captured', contentHash: hash,
          storageProvider: describe.provider || activeStorage.provider || settings.storageProvider,
          storageKey: stored.key, storageUrl: stored.url || null,
          bytes: shot.buffer.length, width: shot.width, height: shot.height,
          durationMs: shot.durationMs, capturedAt
        });
      } catch (e) {
        // The image is on disk but the row failed. Remove the orphan so storage and
        // metadata do not drift apart, then report the failure.
        try { await activeStorage.delete(stored.key); } catch { /* ignore */ }
        const { code, message } = safeReason(e);
        return { url: target.url, page_type: target.pageType, status: 'failed', reason: `DB_ERROR: ${message}`, code };
      }

      try {
        linkEvidence({ workspaceId, competitorId, pageId, url: target.url, pageType: target.pageType, hash, width: shot.width, height: shot.height, capturedAt });
      } catch { /* evidence linking must not fail a capture */ }

      return { url: target.url, page_type: target.pageType, status: 'captured', id: row.id, bytes: shot.buffer.length };
    });
    results.push(...outcomes);
  } finally {
    if (session && typeof session.close === 'function') {
      await session.close().catch(() => {});
    }
  }

  const count = (s) => results.filter((r) => r.status === s).length;
  return {
    enabled: true,
    browser: cap,
    storage: { ...describe, note: storageNote },
    targets: targets.length,
    captured: count('captured'),
    duplicates: count('duplicate'),
    failed: count('failed'),
    unavailable: count('unavailable'),
    results,
    duration_ms: Date.now() - started
  };
}

module.exports = { captureFor, targetsFromPages, runPool, sha256, linkEvidence };
