/**
 * SaaS Shield API adapter.
 *
 * Verified line by line against the backend on feat/db-durability:
 *   src/server.js, src/auth.js, src/routes/{auth,website,scan,result,report,ai,competitor,discover}-routes.js
 *
 * Rules that come from the server, not from taste:
 *  - auth is an httpOnly cookie (shield_session); there is no Bearer scheme, so
 *    every call sends credentials and must be same-origin (see vite.config.js proxy)
 *  - every data route lives under /api/workspaces/:workspaceId/...
 *  - errors are { error: "..." }, never { message }
 *  - a workspace the user is not a member of answers 404, not 403
 */
const BASE = '/api';

export class ApiError extends Error {
  constructor(message, status = 0, body = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.code = (body && body.code) || null;
  }
}

let workspaceId = null;
export const setWorkspaceId = (id) => { workspaceId = id; };
export const getWorkspaceId = () => workspaceId;

const enc = encodeURIComponent;
function ws(p) {
  if (!workspaceId) throw new ApiError('No workspace selected. Sign in again.', 401);
  return `/workspaces/${enc(workspaceId)}${p}`;
}

async function request(path, { method = 'GET', body, raw = false } = {}) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      credentials: 'include',
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('Cannot reach the server. Check your connection and try again.', 0);
  }
  if (!res.ok) {
    let payload = null;
    try { payload = await res.json(); } catch { /* non-JSON body */ }
    const msg = (payload && (payload.error || payload.message)) || `Request failed (${res.status}).`;
    throw new ApiError(msg, res.status, payload);
  }
  if (raw) return res;
  if (res.status === 204) return null;
  try { return await res.json(); } catch { return null; }
}

/* ------------------------------------------------------------------ auth */

export async function getAuthConfig() {
  try { return await request('/auth/config'); } catch { return null; }
}

/** Returns { user, workspaces } or null when not signed in. */
export async function loadSession() {
  try {
    return await request('/auth/me');
  } catch (e) {
    if (e.status === 401) return null;
    throw e;
  }
}

export const signIn = (email, password) => request('/auth/signin', { method: 'POST', body: { email, password } });
export const signUp = (email, password, name) => request('/auth/signup', { method: 'POST', body: { email, password, name } });

export async function signOut() {
  try { await request('/auth/signout', { method: 'POST', body: {} }); } catch { /* already gone */ }
  setWorkspaceId(null);
}

export const primaryWorkspace = (session) =>
  (session && Array.isArray(session.workspaces) && session.workspaces.length ? session.workspaces[0] : null);

/* -------------------------------------------------------------- websites */

export const listWebsites = async () => (await request(ws('/websites'))).websites || [];

/**
 * Adding a site is one call: the backend starts the one-shot scan itself and
 * answers 201 { website, initial_scan }. `initial_scan.mode` is one of
 * scan | discovery | already_scanned | needs_comparison | paused | missing | error.
 */
export async function addWebsite(url, { kind = 'original', autoScan = true } = {}) {
  const body = await request(ws('/websites'), { method: 'POST', body: { url, kind, auto_scan: autoScan } });
  return { website: body.website, initialScan: body.initial_scan || null };
}

export const deleteAccount = (confirm) =>
  request('/auth/account', { method: 'DELETE', body: { confirm } });

export const removeWebsite = (id) => request(ws(`/websites/${enc(id)}`), { method: 'DELETE' });

export const updateWebsite = async (id, patch) =>
  (await request(ws(`/websites/${enc(id)}`), { method: 'PATCH', body: patch })).website;

/** The polling endpoint for the one-shot scan. Authoritative, no invented progress. */
export const getInitialScan = (websiteId) => request(ws(`/websites/${enc(websiteId)}/initial-scan`));

/* ----------------------------------------------------------------- scans */

export const listScans = async () => (await request(ws('/scans'))).scans || [];
export const getScan = async (id) => (await request(ws(`/scans/${enc(id)}`))).scan;

export async function createScan({ originalWebsiteId, comparisonWebsiteId, recrawl = false }) {
  const body = await request(ws('/scans'), {
    method: 'POST',
    body: { original_website_id: originalWebsiteId, comparison_website_id: comparisonWebsiteId, recrawl },
  });
  return body.scan;
}

export const cancelScan = (id) => request(ws(`/scans/${enc(id)}/cancel`), { method: 'POST', body: {} });
export const retryScan = async (id) => (await request(ws(`/scans/${enc(id)}/retry`), { method: 'POST', body: {} })).scan;

/* --------------------------------------------------------------- results */

export async function listResults({ scanId, status, minScore, maxScore, matchType, limit = 100, offset = 0 } = {}) {
  const q = new URLSearchParams();
  if (scanId) q.set('scan_id', scanId);
  if (status) q.set('status', status);
  if (minScore != null) q.set('min_score', String(minScore));
  if (maxScore != null) q.set('max_score', String(maxScore));
  if (matchType) q.set('match_type', matchType);
  q.set('limit', String(limit));
  q.set('offset', String(offset));
  return request(ws(`/results?${q.toString()}`));
}

export const getResult = (id) => request(ws(`/results/${enc(id)}`));
export const reviewResult = (id, status) => request(ws(`/results/${enc(id)}`), { method: 'PATCH', body: { status } });

/* ------------------------------------------------------- AI analysis/report */

export const getAiStatus = (scanId) => request(ws(`/scans/${enc(scanId)}/ai`));
export const startAi = (scanId) => request(ws(`/scans/${enc(scanId)}/ai`), { method: 'POST', body: {} });

/** null means "no report yet" (server 404 + code no_report), not an error. */
export async function getAiReport(scanId, version) {
  const q = version != null ? `?version=${enc(version)}` : '';
  try {
    return await request(ws(`/scans/${enc(scanId)}/ai/report${q}`));
  } catch (e) {
    if (e.status === 404 && e.code === 'no_report') return null;
    throw e;
  }
}

export const aiPdfUrl = (scanId, version) =>
  `${BASE}${ws(`/scans/${enc(scanId)}/ai/report.pdf`)}${version != null ? `?version=${enc(version)}` : ''}`;

export async function downloadPdf(url, filename = 'saas-shield-report.pdf') {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    let payload = null;
    try { payload = await res.json(); } catch { /* not JSON */ }
    throw new ApiError((payload && (payload.error || payload.message)) || `Download failed (${res.status}).`, res.status, payload);
  }
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

/* ------------------------------------------------------------ competitors */

export const listCompetitors = async () => (await request(ws('/competitors'))).competitors || [];
export const getCompetitorIntelligence = (id) => request(ws(`/competitors/${enc(id)}/intelligence`));
export const collectCompetitor = (id) => request(ws(`/competitors/${enc(id)}/collect`), { method: 'POST', body: {} });
export const listScreenshots = (id, pageType) =>
  request(ws(`/competitors/${enc(id)}/screenshots${pageType ? `?page_type=${enc(pageType)}` : ''}`));
export const screenshotCapability = () => request(ws('/screenshots/capability'));

/* ------------------------------------------------------------- discovery */

export const startDiscovery = (originalWebsiteId) =>
  request(ws('/discover'), { method: 'POST', body: { original_website_id: originalWebsiteId } });
export const listDiscoveries = () => request(ws('/discoveries'));
export const getDiscovery = (id) => request(ws(`/discoveries/${enc(id)}`));

/* ------------------------------------------------------------- view model */

/**
 * Turns the initial-scan payload into what the progress screen shows.
 * Nothing here is guessed: every number comes from the payload.
 */
export function describeInitialScan(payload) {
  if (!payload) return null;
  const { website, scan, comparison, discovery, findings_total: findingsTotal, done } = payload;
  const status = scan ? scan.status : (website && website.crawl_status === 'crawling' ? 'running' : 'queued');
  const pages = website && website.pages_discovered != null ? website.pages_discovered : null;
  const compared = scan && scan.pages_compared != null ? scan.pages_compared : null;

  let stageIndex = 0;
  if (compared != null || (scan && ['completed', 'failed', 'cancelled'].includes(scan.status))) stageIndex = 3;
  else if (pages != null && pages > 0) stageIndex = 2;
  else if (website && website.crawl_status === 'crawling') stageIndex = 1;

  return {
    websiteId: website && website.id,
    url: website && website.url,
    crawlStatus: website && website.crawl_status,
    crawlError: website && website.crawl_error,
    pages,
    comparisonAvailable: !!(comparison && comparison.available),
    discovery: discovery || null,
    scanId: scan && scan.id,
    status,
    pagesCompared: compared,
    findings: findingsTotal != null ? findingsTotal : (scan && scan.findings != null ? scan.findings : null),
    notice: (scan && scan.notice) || null,
    error: (scan && scan.error) || null,
    // Nothing is running and nothing will start on its own: no scan row, no
    // discovery, and no comparison site to scan against. Terminal, not "queued".
    needsComparison: !(scan && scan.id) && !discovery && !(comparison && comparison.available),
    done: !!done,
    cancelled: !!(scan && scan.status === 'cancelled'),
    failed: !!(scan && scan.status === 'failed'),
    stageIndex,
  };
}

export const STAGES = [
  { key: 'added', label: 'Website Added', description: 'Your website has been added to the scan queue.' },
  { key: 'crawling', label: 'Crawling Pages', description: 'Reading the public pages of your site.' },
  { key: 'comparing', label: 'Comparing Content', description: 'Looking for overlapping passages on other sites.' },
  { key: 'done', label: 'Findings Ready', description: 'The comparison finished.' },
];


// Emails are shown masked in the UI and in logs.
export function maskEmail(value) {
  const s = String(value || '');
  const at = s.indexOf('@');
  if (at < 1) return s ? '***' : '';
  return s.slice(0, 1) + '***' + s.slice(at);
}
