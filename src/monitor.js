'use strict';
// Competitor change monitoring.
//
// Pipeline for one monitored page:
//   claim -> fetch (SSRF-safe, redirects revalidated) -> structure + pricing
//   extraction -> normalized snapshot -> compare with the previous VALID
//   snapshot -> persist changes -> raise alerts
//
// Guarantees that matter:
//   - A change is never reported without a valid baseline to compare against.
//   - Volatile values (dates, tokens, cache busters, counters) are normalized
//     away before hashing, so a page that did not really change is "unchanged".
//   - Each detected change is deduplicated on (page, category, previous
//     evidence, current evidence): re-observing the same difference does not
//     create a second changelog entry or a second alert.
//   - A failed fetch is recorded as a failure, never as a change.
const db = require('./db');
const config = require('./config');
const { fetchPage } = require('./crawler');
const { extractStructure, normalizeAssetUrl } = require('./structure');
const { extractPlans, diffPlans, formatPlan, planSignature } = require('./pricing');
const normalize = require('./normalize');
const diffUtil = require('./diff');
const { newId, utcNow, sha256 } = require('./util');
const { extractLinks } = require('./extract');

const PAGE_ROLES = ['homepage', 'pricing', 'signup', 'features', 'docs', 'blog', 'changelog', 'other'];

const CATEGORY_LABELS = {
  pricing: 'Pricing',
  signup: 'Signup flow',
  headings: 'Headings',
  copy: 'Page copy',
  sections: 'Page sections',
  links: 'Links',
  cta: 'Calls to action',
  images: 'Images',
  title: 'Page title',
  meta: 'Meta description',
  other: 'Other'
};

const DEFAULT_PAGE_PATHS = [
  { pattern: /(^|\/)pricing\/?$/i, role: 'pricing' },
  { pattern: /(^|\/)plans\/?$/i, role: 'pricing' },
  { pattern: /(^|\/)(signup|sign-up|register|get-started|start)\/?$/i, role: 'signup' },
  { pattern: /(^|\/)(features?|product|solutions)\/?$/i, role: 'features' },
  { pattern: /(^|\/)(changelog|whats-new|releases?)\/?$/i, role: 'changelog' }
];

function guessRole(rawUrl) {
  let pathname = '/';
  try {
    pathname = new URL(rawUrl).pathname;
  } catch {
    return 'other';
  }
  if (pathname === '/' || pathname === '') return 'homepage';
  for (const { pattern, role } of DEFAULT_PAGE_PATHS) {
    if (pattern.test(pathname)) return role;
  }
  if (/^\/docs?(\/|$)/i.test(pathname)) return 'docs';
  if (/^\/blog(\/|$)/i.test(pathname)) return 'blog';
  return 'other';
}

function defaultLabel(role, url) {
  try {
    const u = new URL(url);
    const map = {
      homepage: 'Homepage', pricing: 'Pricing', signup: 'Signup', features: 'Features',
      docs: 'Docs', blog: 'Blog', changelog: 'Changelog', other: u.pathname
    };
    return map[role] || u.pathname;
  } catch {
    return role;
  }
}

function setOf(values) {
  return new Set(values.map((v) => String(v)));
}

function jaccardSets(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const v of a) if (b.has(v)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ---------------------------------------------------------------------------
// Page registration
// ---------------------------------------------------------------------------
function normalizedPageUrl(raw, baseUrl) {
  const u = new URL(raw, baseUrl);
  u.hash = '';
  return u.toString();
}

function listMonitoredPages(wsId, websiteId = null) {
  const sql = `SELECT p.*, w.submitted_url AS website_url, w.kind AS website_kind, w.label AS website_label
               FROM monitored_pages p JOIN websites w ON w.id = p.website_id
               WHERE p.workspace_id = ?` + (websiteId ? ' AND p.website_id = ?' : '') +
               ' ORDER BY w.submitted_url, p.role, p.url';
  const args = websiteId ? [wsId, websiteId] : [wsId];
  return db.prepare(sql).all(...args);
}

function addMonitoredPage({ workspaceId, websiteId, url, role, label, now = new Date() }) {
  const website = db.prepare('SELECT * FROM websites WHERE id=? AND workspace_id=?').get(websiteId, workspaceId);
  if (!website) return { ok: false, error: 'website_not_found' };

  let normalized;
  try {
    normalized = normalizedPageUrl(url);
  } catch {
    return { ok: false, error: 'invalid_url' };
  }
  // Keep a monitored page on the same registrable host as its website. Fetching
  // is SSRF-guarded anyway; this keeps the product model coherent.
  const siteHost = new URL(website.submitted_url).hostname.replace(/^www\./, '');
  const pageHost = new URL(normalized).hostname.replace(/^www\./, '');
  if (pageHost !== siteHost) return { ok: false, error: 'different_host' };

  const count = db.prepare('SELECT COUNT(*) c FROM monitored_pages WHERE website_id=?').get(websiteId).c;
  if (count >= config.monitor.maxPagesPerWebsite) {
    return { ok: false, error: 'page_limit', limit: config.monitor.maxPagesPerWebsite };
  }

  const existing = db.prepare('SELECT id FROM monitored_pages WHERE website_id=? AND normalized_url=?').get(websiteId, normalized);
  if (existing) return { ok: false, error: 'duplicate' };

  const pageRole = PAGE_ROLES.includes(role) ? role : guessRole(normalized);
  const id = newId('mpg');
  const iso = now.toISOString();
  db.prepare(`INSERT INTO monitored_pages
    (id, workspace_id, website_id, url, normalized_url, role, label, enabled, last_checked_at, next_check_at,
     last_status, last_error, last_change_at, baseline_snapshot_id, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,1,NULL,?, 'pending', NULL, NULL, NULL, ?, ?)`)
    .run(id, workspaceId, websiteId, normalized, normalized, pageRole,
         label || defaultLabel(pageRole, normalized), iso, iso, iso);
  return { ok: true, page: db.prepare('SELECT * FROM monitored_pages WHERE id=?').get(id) };
}

/**
 * Turn monitoring on for a website and register its pages.
 * Candidate pages come only from links that actually exist in the fetched HTML,
 * plus the homepage itself. Nothing is invented.
 */
async function enableMonitoring({ workspaceId, websiteId, frequencyHours, roles, now = new Date() }) {
  const website = db.prepare('SELECT * FROM websites WHERE id=? AND workspace_id=?').get(websiteId, workspaceId);
  if (!website) return { ok: false, error: 'website_not_found' };

  const frequency = Number(frequencyHours) || config.monitor.defaultFrequencyHours;
  if (!config.monitor.frequencies.includes(frequency)) {
    return { ok: false, error: 'unsupported_frequency', allowed: config.monitor.frequencies };
  }

  let html = null;
  let finalUrl = website.submitted_url;
  let fetchError = null;
  try {
    const fetched = await fetchPage(website.submitted_url);
    html = fetched.html;
    finalUrl = fetched.finalUrl;
  } catch (e) {
    fetchError = e.message;
  }

  const wanted = new Set(roles && roles.length ? roles : ['homepage', 'pricing', 'signup', 'features']);
  const candidates = [];
  const homepageUrl = normalizedPageUrl(finalUrl, website.submitted_url);
  if (wanted.has('homepage')) candidates.push({ url: homepageUrl, role: 'homepage' });

  if (html) {
    // Discovery must see navigation links too, so it reads every anchor in the
    // document. (structure.links keeps only in-content links, which is right for
    // change detection but would miss a pricing link in the nav.)
    for (const href of extractLinks(html, finalUrl, true)) {
      const role = guessRole(href);
      if (role === 'other' || role === 'docs' || role === 'blog') continue;
      if (!wanted.has(role)) continue;
      if (new URL(href).hostname.replace(/^www\./, '') !== new URL(finalUrl).hostname.replace(/^www\./, '')) continue;
      if (candidates.some((c) => c.url === normalizedPageUrl(href, finalUrl))) continue;
      candidates.push({ url: normalizedPageUrl(href, finalUrl), role });
    }
  }

  const added = [];
  for (const candidate of candidates.slice(0, config.monitor.maxPagesPerWebsite)) {
    const res = addMonitoredPage({
      workspaceId, websiteId, url: candidate.url, role: candidate.role, now
    });
    if (res.ok) added.push(res.page);
  }

  db.prepare(`UPDATE websites SET monitor_enabled=1, frequency_hours=?, next_check_at=?,
              baseline_status=CASE WHEN baseline_status='none' THEN 'none' ELSE baseline_status END,
              updated_at=? WHERE id=?`)
    .run(frequency, now.toISOString(), now.toISOString(), websiteId);

  await auditLog(workspaceId, 'monitor.enabled', { websiteId, frequencyHours: frequency, pages: added.length, fetchError });

  return {
    ok: true,
    frequencyHours: frequency,
    pages: added,
    discovered: candidates.length,
    homepageFetchError: fetchError,
    note: added.length === 0
      ? 'No pages could be registered. Check that the site is reachable and public.'
      : undefined
  };
}

function setMonitoringEnabled({ workspaceId, websiteId, enabled, frequencyHours, now = new Date() }) {
  const website = db.prepare('SELECT * FROM websites WHERE id=? AND workspace_id=?').get(websiteId, workspaceId);
  if (!website) return { ok: false, error: 'website_not_found' };
  const frequency = frequencyHours === undefined ? website.frequency_hours : Number(frequencyHours);
  if (!config.monitor.frequencies.includes(frequency)) {
    return { ok: false, error: 'unsupported_frequency', allowed: config.monitor.frequencies };
  }
  db.prepare('UPDATE websites SET monitor_enabled=?, frequency_hours=?, next_check_at=?, updated_at=? WHERE id=?')
    .run(enabled ? 1 : 0, frequency, enabled ? now.toISOString() : null, now.toISOString(), websiteId);
  db.prepare('UPDATE monitored_pages SET enabled=?, updated_at=? WHERE website_id=?')
    .run(enabled ? 1 : 0, now.toISOString(), websiteId);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Snapshot capture
// ---------------------------------------------------------------------------
function buildSnapshotDraft({ page, fetched, now }) {
  const structure = extractStructure(fetched.html, fetched.finalUrl);
  const text = normalize.normalizeReadable(structure.text);
  const plans = extractPlans(text, { headings: structure.headings });
  const words = normalize.wordCount(text);

  let captureStatus = 'ok';
  if (words < 5 && structure.headings.length === 0) captureStatus = 'empty';
  else if (words < 30) captureStatus = 'partial';

  const hash = normalize.snapshotHash({
    text,
    title: structure.title,
    headings: structure.headings,
    pricing: plans,
    links: structure.links,
    images: structure.images,
    ctas: structure.ctas,
    forms: structure.forms
  });

  return {
    id: newId('snap'),
    workspace_id: page.workspace_id,
    website_id: page.website_id,
    monitored_page_id: page.id,
    requested_url: page.normalized_url,
    final_url: fetched.finalUrl,
    http_status: fetched.httpStatus,
    fetched_at: now.toISOString(),
    title: structure.title || '',
    meta_description: structure.metaDescription || '',
    headings: structure.headings,
    links: structure.links,
    images: structure.images,
    ctas: structure.ctas,
    forms: structure.forms,
    pricing: plans,
    structure: { sections: structure.sections, wordCount: words },
    text_normalized: normalize.normalizeForHash(text),
    text_raw: normalize.clip(text, 120000),
    content_hash: hash,
    byte_length: Buffer.byteLength(fetched.html, 'utf8'),
    redirect_chain: fetched.redirectChain || [],
    capture_status: captureStatus,
    is_baseline: 0
  };
}

function insertSnapshot(snapshot) {
  db.prepare(`INSERT INTO snapshots
    (id, workspace_id, website_id, monitored_page_id, requested_url, final_url, http_status, fetched_at,
     title, meta_description, headings, links, images, ctas, forms, pricing, structure,
     text_normalized, text_raw, content_hash, byte_length, redirect_chain, capture_status, capture_error, is_baseline, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(snapshot.id, snapshot.workspace_id, snapshot.website_id, snapshot.monitored_page_id,
      snapshot.requested_url, snapshot.final_url, snapshot.http_status, snapshot.fetched_at,
      snapshot.title, snapshot.meta_description,
      JSON.stringify(snapshot.headings), JSON.stringify(snapshot.links), JSON.stringify(snapshot.images),
      JSON.stringify(snapshot.ctas), JSON.stringify(snapshot.forms), JSON.stringify(snapshot.pricing),
      JSON.stringify(snapshot.structure), snapshot.text_normalized, snapshot.text_raw,
      snapshot.content_hash, snapshot.byte_length, JSON.stringify(snapshot.redirect_chain),
      snapshot.capture_status, snapshot.capture_error || null, snapshot.is_baseline, snapshot.fetched_at);
}

function hydrateSnapshot(row) {
  if (!row) return null;
  return {
    ...row,
    headings: safeJson(row.headings, []),
    links: safeJson(row.links, []),
    images: safeJson(row.images, []),
    ctas: safeJson(row.ctas, []),
    forms: safeJson(row.forms, []),
    pricing: safeJson(row.pricing, []),
    structure: safeJson(row.structure, {}),
    redirect_chain: safeJson(row.redirect_chain, [])
  };
}

function safeJson(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function latestValidSnapshot(monitoredPageId, excludeId = null) {
  const row = db.prepare(`SELECT * FROM snapshots
    WHERE monitored_page_id=? AND capture_status IN ('ok','partial')
      ${excludeId ? 'AND id != ?' : ''}
    ORDER BY fetched_at DESC LIMIT 1`)
    .get(...(excludeId ? [monitoredPageId, excludeId] : [monitoredPageId]));
  return hydrateSnapshot(row);
}

// ---------------------------------------------------------------------------
// Change detection
// ---------------------------------------------------------------------------
function significanceLabel(sig) {
  if (sig >= 0.8) return 'critical';
  if (sig >= 0.5) return 'major';
  if (sig >= 0.25) return 'moderate';
  return 'minor';
}

function changeKey(pageId, category, previousValue, currentValue) {
  return sha256(`${pageId}\u0000${category}\u0000${sha256(previousValue || '')}\u0000${sha256(currentValue || '')}`);
}

function truncateList(list, max = 6) {
  const items = (list || []).map((x) => (typeof x === 'string' ? x : JSON.stringify(x)));
  if (items.length <= max) return items;
  return [...items.slice(0, max), `…and ${items.length - max} more`];
}

/**
 * Compare two snapshots and return change drafts (not yet persisted).
 * Each draft: { category, summary, significance, confidence, previousValue,
 *               currentValue, evidence }
 */
function detectChanges(previous, current, page) {
  const drafts = [];
  const role = page.role;
  const isPricingPage = role === 'pricing';

  // ---- Pricing -----------------------------------------------------------
  const planDiff = diffPlans(previous.pricing, current.pricing);
  const pricingChanged = planDiff.added.length || planDiff.removed.length || planDiff.changed.length;
  if (pricingChanged) {
    const confidenceRank = { low: 0, medium: 1, high: 2 };
    const lowest = (plans) => plans.reduce((worst, p) => {
      const rank = confidenceRank[p.confidence] ?? 0;
      return rank < confidenceRank[worst] ? p.confidence : worst;
    }, 'high');
    const allPlans = [...planDiff.added, ...planDiff.removed, ...planDiff.changed.flatMap((c) => [c.previous, c.current])];
    const confidence = lowest(allPlans.filter(Boolean));

    const parts = [];
    let significance = 0;
    for (const { previous: prevPlan, current: currPlan } of planDiff.changed) {
      const priceMoved = prevPlan.amount !== currPlan.amount || prevPlan.currency !== currPlan.currency;
      parts.push(`${currPlan.name || 'Plan'} ${priceMoved ? 'price changed' : 'plan changed'}: ${formatPlan(prevPlan)} → ${formatPlan(currPlan)}`);
      significance = Math.max(significance, priceMoved ? 0.95 : 0.7);
    }
    for (const p of planDiff.added) {
      parts.push(`New plan detected: ${formatPlan(p)}`);
      significance = Math.max(significance, 0.75);
    }
    for (const p of planDiff.removed) {
      parts.push(`Plan no longer shown: ${formatPlan(p)}`);
      significance = Math.max(significance, 0.7);
    }

    drafts.push({
      category: 'pricing',
      summary: parts.join('; ').slice(0, 600),
      significance,
      confidence,
      previousValue: JSON.stringify(previous.pricing || []),
      currentValue: JSON.stringify(current.pricing || []),
      evidence: {
        kind: 'pricing',
        changed: planDiff.changed.map((c) => ({ previous: c.previous, current: c.current })),
        added: planDiff.added,
        removed: planDiff.removed,
        note: confidence === 'low'
          ? 'At least one plan was extracted with low confidence. Confirm the highlighted price on the live page before acting on it.'
          : 'Prices were read from the rendered page text exactly as displayed.'
      }
    });
  }

  // ---- Signup form -------------------------------------------------------
  // Key function for ONE form (diffItems calls it per item), plus a list
  // signature used as the stored before/after value.
  const formKey = (f) => `${f.action || ''}|${f.method || ''}|` +
    (f.fields || []).map((x) => `${x.name}:${x.type}${x.required ? ':required' : ''}`).join(',') +
    `|${f.submit || ''}`;
  const formSig = (forms) => (forms || []).map(formKey);
  const formDiff = diffUtil.diffItems(previous.forms || [], current.forms || [], formKey);
  const fieldSets = (forms) => new Set((forms || []).flatMap((f) => (f.fields || []).map((x) => x.name)));
  const prevFields = fieldSets(previous.forms);
  const currFields = fieldSets(current.forms);
  const addedFields = [...currFields].filter((f) => !prevFields.has(f));
  const removedFields = [...prevFields].filter((f) => !currFields.has(f));

  if (addedFields.length || removedFields.length || (formDiff.removed.length && formDiff.added.length)) {
    const bits = [];
    if (addedFields.length) bits.push(`added field${addedFields.length > 1 ? 's' : ''} ${addedFields.map((f) => `"${f}"`).join(', ')}`);
    if (removedFields.length) bits.push(`removed field${removedFields.length > 1 ? 's' : ''} ${removedFields.map((f) => `"${f}"`).join(', ')}`);
    if (!bits.length) bits.push('form action or submit label changed');
    drafts.push({
      category: 'signup',
      summary: `Signup/contact form changed: ${bits.join('; ')}`.slice(0, 400),
      significance: role === 'signup' ? 0.8 : 0.55,
      confidence: 'high',
      previousValue: formSig(previous.forms || []).join('\n'),
      currentValue: formSig(current.forms || []).join('\n'),
      evidence: {
        kind: 'forms',
        addedFields,
        removedFields,
        added: formDiff.added,
        removed: formDiff.removed
      }
    });
  }

  // ---- Title / meta ------------------------------------------------------
  if ((previous.title || '') !== (current.title || '')) {
    drafts.push({
      category: 'title',
      summary: `Page title changed: "${normalize.clip(previous.title, 160) || '(empty)'}" → "${normalize.clip(current.title, 160) || '(empty)'}"`,
      significance: 0.35,
      confidence: 'high',
      previousValue: previous.title || '',
      currentValue: current.title || '',
      evidence: { kind: 'text', previous: previous.title || '', current: current.title || '' }
    });
  }
  if ((previous.meta_description || '') !== (current.meta_description || '')) {
    drafts.push({
      category: 'meta',
      summary: 'Meta description changed.',
      significance: 0.2,
      confidence: 'high',
      previousValue: previous.meta_description || '',
      currentValue: current.meta_description || '',
      evidence: { kind: 'text', previous: previous.meta_description || '', current: current.meta_description || '' }
    });
  }

  // ---- Headings ----------------------------------------------------------
  const headingKey = (h) => normalize.normalizeForHash(h.text || '');
  const headingDiff = diffUtil.diffItems(previous.headings || [], current.headings || [], headingKey);
  if (headingDiff.added.length || headingDiff.removed.length) {
    const bits = [];
    if (headingDiff.added.length) bits.push(`${headingDiff.added.length} heading${headingDiff.added.length > 1 ? 's' : ''} added`);
    if (headingDiff.removed.length) bits.push(`${headingDiff.removed.length} removed`);
    drafts.push({
      category: 'headings',
      summary: `Headings changed (${bits.join(', ')})${headingDiff.added.length ? `: ${truncateList(headingDiff.added.map((h) => `"${h.text}"`), 3).join(', ')}` : ''}`.slice(0, 500),
      significance: headingDiff.removed.length >= 2 ? 0.6 : 0.45,
      confidence: 'high',
      previousValue: (previous.headings || []).map((h) => h.text).join('\n'),
      currentValue: (current.headings || []).map((h) => h.text).join('\n'),
      evidence: {
        kind: 'items',
        added: headingDiff.added,
        removed: headingDiff.removed,
        unchanged: headingDiff.unchanged
      }
    });
  }

  // ---- Sections ----------------------------------------------------------
  const sectionKey = (s) => normalize.normalizeForHash(s.heading || '');
  const sectionDiff = diffUtil.diffItems((previous.structure && previous.structure.sections) || [],
    (current.structure && current.structure.sections) || [], sectionKey);
  if (sectionDiff.added.length || sectionDiff.removed.length) {
    drafts.push({
      category: 'sections',
      summary: `Page sections changed: ${sectionDiff.added.length} added, ${sectionDiff.removed.length} removed${sectionDiff.added.length ? ` (new: ${sectionDiff.added.slice(0, 3).map((s) => `"${s.heading}"`).join(', ')})` : ''}`.slice(0, 500),
      significance: 0.5,
      confidence: 'high',
      previousValue: ((previous.structure && previous.structure.sections) || []).map((s) => s.heading).join('\n'),
      currentValue: ((current.structure && current.structure.sections) || []).map((s) => s.heading).join('\n'),
      evidence: { kind: 'items', added: sectionDiff.added, removed: sectionDiff.removed }
    });
  }

  // ---- Calls to action ---------------------------------------------------
  const ctaKey = (c) => normalize.normalizeForHash(c);
  const ctaDiff = diffUtil.diffItems(previous.ctas || [], current.ctas || [], ctaKey);
  if (ctaDiff.added.length || ctaDiff.removed.length) {
    drafts.push({
      category: 'cta',
      summary: `Calls to action changed: ${truncateList([...ctaDiff.added.map((c) => `+${c}`), ...ctaDiff.removed.map((c) => `-${c}`)], 4).join(', ')}`.slice(0, 400),
      significance: 0.4,
      confidence: 'high',
      previousValue: (previous.ctas || []).join('\n'),
      currentValue: (current.ctas || []).join('\n'),
      evidence: { kind: 'items', added: ctaDiff.added, removed: ctaDiff.removed }
    });
  }

  // ---- Links -------------------------------------------------------------
  const linkKey = (l) => normalizeAssetUrl(l.href || '');
  const linkDiff = diffUtil.diffItems(previous.links || [], current.links || [], linkKey);
  if (linkDiff.added.length || linkDiff.removed.length) {
    drafts.push({
      category: 'links',
      summary: `Page links changed: ${linkDiff.added.length} added, ${linkDiff.removed.length} removed`.slice(0, 300),
      significance: 0.3,
      confidence: 'high',
      previousValue: (previous.links || []).map((l) => l.href).join('\n'),
      currentValue: (current.links || []).map((l) => l.href).join('\n'),
      evidence: {
        kind: 'items',
        added: linkDiff.added.slice(0, 25),
        removed: linkDiff.removed.slice(0, 25)
      }
    });
  }

  // ---- Images ------------------------------------------------------------
  const imageKey = (i) => normalizeAssetUrl(i.src || '');
  const imageDiff = diffUtil.diffItems(previous.images || [], current.images || [], imageKey);
  if (imageDiff.added.length || imageDiff.removed.length) {
    drafts.push({
      category: 'images',
      summary: `Images changed: ${imageDiff.added.length} added, ${imageDiff.removed.length} removed`,
      significance: 0.25,
      confidence: 'medium',
      previousValue: (previous.images || []).map((i) => i.src).join('\n'),
      currentValue: (current.images || []).map((i) => i.src).join('\n'),
      evidence: { kind: 'items', added: imageDiff.added.slice(0, 20), removed: imageDiff.removed.slice(0, 20) }
    });
  }

  // ---- Body copy ---------------------------------------------------------
  const textDiff = diffUtil.textChange(previous.text_raw || '', current.text_raw || '');
  const meaningfulCopy = (textDiff.addedWords + textDiff.removedWords) >= 12 && textDiff.changeRatio >= 0.01;
  if (meaningfulCopy && !isPricingPage) {
    const significance = Math.min(0.85, 0.25 + textDiff.changeRatio * 1.4);
    drafts.push({
      category: 'copy',
      summary: `Page copy changed: ${textDiff.removedWords} words removed, ${textDiff.addedWords} added (${Math.round(textDiff.changeRatio * 100)}% of previous text).`.slice(0, 400),
      significance,
      confidence: textDiff.changeRatio < 0.02 ? 'medium' : 'high',
      previousValue: truncateList(textDiff.removed, 30).join('\n'),
      currentValue: truncateList(textDiff.added, 30).join('\n'),
      evidence: {
        kind: 'text',
        removedSentences: textDiff.removed.slice(0, 30),
        addedSentences: textDiff.added.slice(0, 30),
        removedWords: textDiff.removedWords,
        addedWords: textDiff.addedWords,
        changeRatio: textDiff.changeRatio
      }
    });
  } else if (isPricingPage && meaningfulCopy && !pricingChanged) {
    // Pricing page copy moved but no structured plan could be read. Report a
    // general page change instead of inventing plan details.
    drafts.push({
      category: 'copy',
      summary: `Pricing page content changed (${textDiff.removedWords} words removed, ${textDiff.addedWords} added), but no plan/price could be extracted with confidence.`.slice(0, 400),
      significance: 0.5,
      confidence: 'medium',
      previousValue: truncateList(textDiff.removed, 20).join('\n'),
      currentValue: truncateList(textDiff.added, 20).join('\n'),
      evidence: {
        kind: 'text',
        removedSentences: textDiff.removed.slice(0, 20),
        addedSentences: textDiff.added.slice(0, 20),
        note: 'Structured pricing extraction found no reliable plan rows for this page.'
      }
    });
  }

  // Sort strongest first and cap so one noisy page cannot flood the changelog.
  const sorted = drafts
    .sort((a, b) => b.significance - a.significance)
    .slice(0, 8);

  for (const draft of sorted) {
    draft.significance = Math.round(draft.significance * 100) / 100;
    draft.significance_label = significanceLabel(draft.significance);
    draft.dedupe_key = changeKey(page.id, draft.category, draft.previousValue, draft.currentValue);
  }
  return sorted;
}

// ---------------------------------------------------------------------------
// Run one check
// ---------------------------------------------------------------------------
function claimPage(pageId, now, minutes = 10) {
  const until = new Date(now.getTime() + minutes * 60 * 1000).toISOString();
  return db.prepare(`UPDATE monitored_pages SET next_check_at=?, updated_at=?
                     WHERE id=? AND enabled=1`).run(until, now.toISOString(), pageId).changes > 0;
}

function scheduleNext(page, now, { failed = false } = {}) {
  const hours = page.frequency_hours || db.prepare('SELECT frequency_hours FROM websites WHERE id=?').get(page.website_id)?.frequency_hours || config.monitor.defaultFrequencyHours;
  const delayMs = failed
    ? Math.min(hours * 3600 * 1000, 30 * 60 * 1000)
    : hours * 3600 * 1000;
  return new Date(now.getTime() + delayMs).toISOString();
}

/**
 * Check one monitored page end to end.
 * @returns {{status:string, ...}} status: baseline_created | unchanged | changed | failed | skipped
 */
async function runPageCheck(pageId, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const page = db.prepare('SELECT * FROM monitored_pages WHERE id=?').get(pageId);
  if (!page) return { status: 'skipped', reason: 'not_found' };
  const website = db.prepare('SELECT * FROM websites WHERE id=?').get(page.website_id);
  if (!website) return { status: 'skipped', reason: 'website_not_found' };
  if (!page.enabled || website.status === 'paused' || !website.monitor_enabled) {
    return { status: 'skipped', reason: 'disabled' };
  }
  if (opts.claim !== false && !claimPage(pageId, now)) {
    return { status: 'skipped', reason: 'claimed_elsewhere' };
  }

  const frequencyHours = website.frequency_hours || config.monitor.defaultFrequencyHours;

  // ---- Fetch (network, outside any transaction) ----
  let fetched;
  try {
    fetched = await fetchPage(page.normalized_url);
  } catch (e) {
    const message = `${e.code ? e.code + ': ' : ''}${e.message}`;
    db.exec('BEGIN');
    try {
      db.prepare(`UPDATE monitored_pages SET last_status='failed', last_error=?, last_checked_at=?, next_check_at=?, updated_at=? WHERE id=?`)
        .run(message.slice(0, 500), now.toISOString(), scheduleNext(page, now, { failed: true }), now.toISOString(), page.id);
      db.prepare(`UPDATE websites SET last_checked_at=?, baseline_status=CASE WHEN baseline_status='none' THEN 'failed' ELSE baseline_status END,
                  baseline_error=?, updated_at=? WHERE id=?`)
        .run(now.toISOString(), message.slice(0, 500), now.toISOString(), website.id);
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    }
    return { status: 'failed', error: message, pageId: page.id, retryAt: scheduleNext(page, now, { failed: true }) };
  }

  const draft = buildSnapshotDraft({ page, fetched, now });
  const captureProblem = draft.capture_status === 'empty';
  const previous = captureProblem ? null : latestValidSnapshot(page.id);

  // No usable content: record the attempt, never a change.
  if (captureProblem) {
    db.exec('BEGIN');
    try {
      insertSnapshot({ ...draft, capture_error: 'No readable text or headings were extracted from the page.' });
      db.prepare(`UPDATE monitored_pages SET last_status='failed', last_error=?, last_checked_at=?, next_check_at=?, updated_at=? WHERE id=?`)
        .run('Page returned no readable content (possibly JavaScript-rendered or blocked).', now.toISOString(),
          scheduleNext(page, now, { failed: true }), now.toISOString(), page.id);
      db.prepare(`UPDATE websites SET last_checked_at=?, baseline_status=CASE WHEN baseline_status='none' THEN 'failed' ELSE baseline_status END,
                  baseline_error=?, updated_at=? WHERE id=?`)
        .run(now.toISOString(), 'Baseline page contained no readable content.', now.toISOString(), website.id);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
    return { status: 'failed', error: 'no_readable_content', pageId: page.id };
  }

  // ---- Baseline ----
  if (!previous || !page.baseline_snapshot_id) {
    db.exec('BEGIN');
    try {
      insertSnapshot({ ...draft, is_baseline: 1 });
      db.prepare(`UPDATE monitored_pages SET baseline_snapshot_id=?, last_status='ok', last_error=NULL,
                  last_checked_at=?, next_check_at=?, updated_at=? WHERE id=?`)
        .run(draft.id, now.toISOString(), scheduleNext(page, now), now.toISOString(), page.id);
      db.prepare(`UPDATE websites SET last_checked_at=?, baseline_at=COALESCE(baseline_at, ?), baseline_status='created',
                  baseline_error=NULL, status=CASE WHEN status='pending' THEN 'active' ELSE status END, updated_at=? WHERE id=?`)
        .run(now.toISOString(), now.toISOString(), now.toISOString(), website.id);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
    return { status: 'baseline_created', pageId: page.id, snapshotId: draft.id, words: draft.structure.wordCount };
  }

  // ---- Unchanged ----
  if (draft.content_hash === previous.content_hash) {
    db.exec('BEGIN');
    try {
      insertSnapshot(draft);
      db.prepare(`UPDATE monitored_pages SET last_status='unchanged', last_error=NULL, last_checked_at=?, next_check_at=?, updated_at=? WHERE id=?`)
        .run(now.toISOString(), scheduleNext(page, now), now.toISOString(), page.id);
      db.prepare('UPDATE websites SET last_checked_at=?, baseline_status=\'created\', baseline_error=NULL, updated_at=? WHERE id=?')
        .run(now.toISOString(), now.toISOString(), website.id);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
    return { status: 'unchanged', pageId: page.id, snapshotId: draft.id };
  }

  // ---- Changed ----
  const drafts = detectChanges(previous, draft, page);
  const alerts = require('./alerts');
  const insertedChanges = [];
  db.exec('BEGIN');
  try {
    insertSnapshot(draft);
    for (const changeDraft of drafts) {
      const existing = db.prepare('SELECT id FROM changes WHERE workspace_id=? AND dedupe_key=?')
        .get(page.workspace_id, changeDraft.dedupe_key);
      if (existing) {
        // Same difference observed again: refresh recency, keep the original
        // entry and its review state. No duplicate alert is created.
        db.prepare('UPDATE changes SET detected_at=? WHERE id=?').run(now.toISOString(), existing.id);
        continue;
      }
      const changeId = newId('chg');
      db.prepare(`INSERT INTO changes
        (id, workspace_id, website_id, monitored_page_id, page_role, page_url,
         previous_snapshot_id, current_snapshot_id, detected_at, category, summary, significance,
         confidence, significance_label, previous_value, current_value, evidence, dedupe_key,
         status, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'open', ?)`)
        .run(changeId, page.workspace_id, page.website_id, page.id, page.role, page.url,
          previous.id, draft.id, now.toISOString(), changeDraft.category, changeDraft.summary,
          changeDraft.significance, changeDraft.confidence, changeDraft.significance_label,
          normalize.clip(changeDraft.previousValue, 8000), normalize.clip(changeDraft.currentValue, 8000),
          JSON.stringify({
            ...changeDraft.evidence,
            previous_snapshot_id: previous.id,
            current_snapshot_id: draft.id,
            previous_url: previous.final_url,
            current_url: draft.final_url,
            requested_url: page.normalized_url
          }), changeDraft.dedupe_key, now.toISOString());
      insertedChanges.push({ id: changeId, ...changeDraft });
    }
    db.prepare(`UPDATE monitored_pages SET last_status='changed', last_error=NULL, last_checked_at=?,
                next_check_at=?, last_change_at=?, updated_at=? WHERE id=?`)
      .run(now.toISOString(), scheduleNext(page, now),
        insertedChanges.length ? now.toISOString() : page.last_change_at, now.toISOString(), page.id);
    db.prepare(`UPDATE websites SET last_checked_at=?, baseline_status='created', baseline_error=NULL, updated_at=? WHERE id=?`)
      .run(now.toISOString(), now.toISOString(), website.id);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }

  // Alerts are raised after the changelog commit: a delivery failure must never
  // roll back a detected change.
  const alertRows = [];
  for (const change of insertedChanges) {
    try {
      const alert = alerts.raiseAlertForChange({
        change: db.prepare('SELECT * FROM changes WHERE id=?').get(change.id),
        page,
        website,
        now
      });
      if (alert) alertRows.push(alert);
    } catch (e) {
      console.error('[monitor] alert creation failed for change', change.id, e.message);
    }
  }

  return {
    status: 'changed',
    pageId: page.id,
    snapshotId: draft.id,
    changes: insertedChanges.map((c) => ({ id: c.id, category: c.category, summary: c.summary, significance: c.significance })),
    alerts: alertRows.map((a) => a.id),
    frequencyHours
  };
}

/**
 * Run every page whose next_check_at is due. Bounded by maxChecksPerTick.
 */
async function runDueChecks(opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const limit = Math.min(opts.limit || config.monitor.maxChecksPerTick, config.monitor.maxChecksPerTick);
  const rows = db.prepare(`
    SELECT p.id FROM monitored_pages p JOIN websites w ON w.id = p.website_id
    WHERE p.enabled = 1 AND w.monitor_enabled = 1 AND w.status = 'active'
      AND (p.next_check_at IS NULL OR p.next_check_at <= ?)
    ORDER BY COALESCE(p.next_check_at, '1970-01-01') ASC
    LIMIT ?`).all(now.toISOString(), limit);

  const results = [];
  for (const row of rows) {
    if (opts.shouldStop && opts.shouldStop()) break;
    try {
      results.push(await runPageCheck(row.id, { now: new Date(), claim: false }));
    } catch (e) {
      results.push({ status: 'failed', pageId: row.id, error: e.message });
    }
  }
  return {
    checked: results.length,
    changed: results.filter((r) => r.status === 'changed').length,
    baselines: results.filter((r) => r.status === 'baseline_created').length,
    failed: results.filter((r) => r.status === 'failed').length,
    results
  };
}

// ---------------------------------------------------------------------------
// Changelog queries
// ---------------------------------------------------------------------------
function listChanges(wsId, filters = {}) {
  const limit = Math.min(Math.max(Number(filters.limit) || 25, 1), 100);
  const offset = Math.max(Number(filters.offset) || 0, 0);
  const where = ['c.workspace_id = ?'];
  const args = [wsId];
  if (filters.website_id) { where.push('c.website_id = ?'); args.push(filters.website_id); }
  if (filters.category) { where.push('c.category = ?'); args.push(filters.category); }
  if (filters.status) { where.push('c.status = ?'); args.push(filters.status); }
  if (filters.page_role) { where.push('c.page_role = ?'); args.push(filters.page_role); }
  if (filters.since) {
    const d = new Date(filters.since);
    if (!Number.isNaN(d.getTime())) { where.push('c.detected_at >= ?'); args.push(d.toISOString()); }
  }
  const whereSql = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) c FROM changes c WHERE ${whereSql}`).get(...args).c;
  const rows = db.prepare(`
    SELECT c.*, w.submitted_url AS website_url, w.label AS website_label
    FROM changes c JOIN websites w ON w.id = c.website_id
    WHERE ${whereSql}
    ORDER BY c.detected_at DESC, c.significance DESC
    LIMIT ? OFFSET ?`).all(...args, limit, offset);
  return {
    changes: rows.map((r) => ({
      ...r,
      evidence: safeJson(r.evidence, {})
    })),
    total,
    has_more: offset + rows.length < total,
    limit,
    offset
  };
}

function getChange(wsId, changeId) {
  const row = db.prepare(`SELECT c.*, w.submitted_url AS website_url, w.label AS website_label
                          FROM changes c JOIN websites w ON w.id = c.website_id
                          WHERE c.id = ? AND c.workspace_id = ?`).get(changeId, wsId);
  if (!row) return null;
  const previous = row.previous_snapshot_id ? hydrateSnapshot(db.prepare('SELECT * FROM snapshots WHERE id=?').get(row.previous_snapshot_id)) : null;
  const current = row.current_snapshot_id ? hydrateSnapshot(db.prepare('SELECT * FROM snapshots WHERE id=?').get(row.current_snapshot_id)) : null;
  return {
    change: { ...row, evidence: safeJson(row.evidence, {}) },
    previousSnapshot: previous ? summarizeSnapshot(previous) : null,
    currentSnapshot: current ? summarizeSnapshot(current) : null,
    previousText: previous ? previous.text_raw : null,
    currentText: current ? current.text_raw : null
  };
}

function summarizeSnapshot(s) {
  return {
    id: s.id,
    final_url: s.final_url,
    fetched_at: s.fetched_at,
    http_status: s.http_status,
    title: s.title,
    capture_status: s.capture_status,
    content_hash: s.content_hash,
    word_count: (s.structure && s.structure.wordCount) || normalize.wordCount(s.text_raw),
    pricing: s.pricing,
    headings: s.headings,
    redirect_chain: s.redirect_chain
  };
}

function setChangeStatus(wsId, changeId, { status, userId, now = new Date() }) {
  if (!['open', 'acknowledged', 'dismissed'].includes(status)) return { ok: false, error: 'invalid_status' };
  const change = db.prepare('SELECT * FROM changes WHERE id=? AND workspace_id=?').get(changeId, wsId);
  if (!change) return { ok: false, error: 'not_found' };
  db.prepare('UPDATE changes SET status=?, reviewed_by=?, reviewed_at=? WHERE id=?')
    .run(status, userId || null, now.toISOString(), changeId);
  if (status === 'dismissed') {
    db.prepare("UPDATE alerts SET status='dismissed' WHERE change_id=?").run(changeId);
  }
  return { ok: true };
}

function monitoringOverview(wsId, now = new Date()) {
  const sites = db.prepare(`SELECT w.id, w.submitted_url, w.label, w.monitor_enabled, w.frequency_hours,
      w.last_checked_at, w.next_check_at, w.baseline_status, w.baseline_at, w.baseline_error,
      (SELECT COUNT(*) FROM monitored_pages p WHERE p.website_id = w.id) AS page_count,
      (SELECT COUNT(*) FROM monitored_pages p WHERE p.website_id = w.id AND p.last_status='failed') AS failing_pages,
      (SELECT COUNT(*) FROM changes c WHERE c.website_id = w.id AND c.detected_at >= ?) AS changes_7d
    FROM websites w WHERE w.workspace_id = ? ORDER BY w.created_at DESC`).all(new Date(now.getTime() - 7 * 86400000).toISOString(), wsId);
  const dueCount = db.prepare(`SELECT COUNT(*) c FROM monitored_pages p JOIN websites w ON w.id=p.website_id
      WHERE p.workspace_id=? AND p.enabled=1 AND w.monitor_enabled=1 AND w.status='active'
        AND (p.next_check_at IS NULL OR p.next_check_at <= ?)`).get(wsId, now.toISOString()).c;
  return { websites: sites, due_checks: dueCount, frequencies: config.monitor.frequencies };
}

async function auditLog(workspaceId, action, details) {
  const { audit } = require('./auth');
  audit(workspaceId, details && details.userId ? details.userId : null, action, details);
}

module.exports = {
  PAGE_ROLES,
  CATEGORY_LABELS,
  guessRole,
  defaultLabel,
  addMonitoredPage,
  enableMonitoring,
  setMonitoringEnabled,
  listMonitoredPages,
  buildSnapshotDraft,
  detectChanges,
  runPageCheck,
  runDueChecks,
  latestValidSnapshot,
  listChanges,
  getChange,
  setChangeStatus,
  monitoringOverview,
  hydrateSnapshot,
  safeJson,
  significanceLabel,
  jaccardSets,
  setOf
};
