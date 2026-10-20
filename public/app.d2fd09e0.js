'use strict';
/* SaaS Shield SPA - vanilla JS, hash-routed. All rendering escapes user data. */

const root = document.getElementById('root');
let me = null;          // { user, workspaces }
let wsId = null;        // active workspace id

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function elid(id) { return document.getElementById(id); }

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  elid('toasts').appendChild(t);
  setTimeout(() => t.remove(), 4200);
}

function fmtDate(iso) {
  if (!iso) return '-';
  try { return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }
  catch { return iso; }
}
function fmtScore(x) { return (Math.round((x ?? 0) * 1000) / 10).toFixed(1) + '%'; }
function hostOf(u) { try { return new URL(u).host; } catch { return u; } }

function loading() { return `<div class="loading"><div class="spinner"></div> Loading...</div>`; }

const GLYPHS = {
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
  doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M12 18v-6M9 15h6"/></svg>',
  book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V4H6.5A2.5 2.5 0 0 0 4 6.5v13z"/></svg>'
};
function emptyState(glyph, title, sub) {
  return `<div class="empty"><div class="glyph">${GLYPHS[glyph] || GLYPHS.doc}</div><h3>${esc(title)}</h3><p class="muted small">${esc(sub)}</p></div>`;
}
async function showError(e) { toast(e.message, 'error'); }

// ---------------------------------------------------------------------------
// shell
// ---------------------------------------------------------------------------
const LOGO_SVG = '<img src="/brand/logo-mark.png" alt="SaaS Shield" width="24" height="27" style="display:block">';
const LOGO_LOCKUP = '<img class="logo-img" src="/brand/logo-full.png" alt="SaaS Shield - Protect Your Website Content" height="40" width="145">';

const ICONS = {
  dash: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
  sites: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
  scans: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>',
  results: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
  settings: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.4 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7 7 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.4-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.2-.8.2-1.2z"/></svg>',
  signout: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/></svg>',
  home: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10l9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V10z"/></svg>'
};

const NAV = [
  ['#/dashboard', 'Dashboard', 'dash'],
  ['#/websites', 'Websites', 'sites'],
  ['#/scans', 'Scans', 'scans'],
  ['#/results', 'Findings', 'results'],
  ['#/settings', 'Settings', 'settings']
];

function shell(content, activeRoute) {
  const ws = me && me.workspaces ? me.workspaces.find((w) => w.id === wsId) : null;
  const links = NAV.map(([href, label, icon]) =>
    `<a class="navlink ${location.hash.startsWith(href) && (href !== '#/results' || !location.hash.startsWith('#/results/')) ? 'active' : ''}" href="${href}">${ICONS[icon]} ${label}</a>`).join('');
  const mobileLinks = NAV.map(([href, label, icon]) =>
    `<a class="navlink ${location.hash.startsWith(href) ? 'active' : ''}" href="${href}">${ICONS[icon]} ${label}</a>`).join('');
  return `
  <div class="shell">
    <aside class="sidebar">
      <a class="logo" href="#/dashboard">${LOGO_LOCKUP}</a>
      <div class="ws-chip">${esc(ws ? ws.name : '')}</div>
      ${links}
      <div class="spacer"></div>
      <div class="sidebar-foot">
        <div class="user-chip" title="${esc(me ? me.user.email : '')}">${esc(me ? me.user.email : '')}</div>
        <a class="navlink" href="/">${ICONS.home} Back to site</a>
        <button class="navlink" style="width:100%;border:none;background:none;text-align:left" id="signoutBtn">${ICONS.signout} Sign out</button>
      </div>
    </aside>
    <main class="main" id="main">${content}</main>
    <nav class="mobile-nav">${mobileLinks}</nav>
  </div>`;
}

// ---------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------
function authView(mode = 'signin') {
  const isSignup = mode === 'signup';
  return `
  <div class="auth-wrap">
    <div class="auth-card">
      <div class="auth-brand"><a class="logo" href="/">${LOGO_LOCKUP}</a></div>
      <div class="card">
        <h2>${isSignup ? 'Create your account' : 'Welcome back'}</h2>
        <p class="subhead">${isSignup ? 'A workspace is created automatically.' : 'Sign in to your workspace.'}</p>
        <form id="authForm" novalidate>
          <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required></div>
          <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="${isSignup ? 'new-password' : 'current-password'}" minlength="8" required>
            ${isSignup ? '<div class="hint">At least 8 characters.</div>' : ''}</div>
          ${isSignup ? `<div class="field"><label for="wsname">Workspace name</label><input id="wsname" name="workspace_name" placeholder="My startup"></div>` : ''}
          <div class="form-error" id="authError" role="alert"></div>
          <button class="btn block" type="submit">${isSignup ? 'Create account' : 'Log in'}</button>
        </form>
        <p class="small muted" style="margin-top:16px; text-align:center;">
          ${isSignup ? `Already registered? <a href="#/signin">Log in</a>` : `New here? <a href="#/signup">Create an account</a>`}
        </p>
      </div>
    </div>
  </div>`;
}

async function dashboardView() {
  const d = await api(`/workspaces/${wsId}/dashboard`);
  const statCard = (label, num, sub) => `<div class="stat"><div class="lbl">${label}</div><div class="num">${num}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  return `
  <div class="page-head">
    <div><h1>Dashboard</h1><p>Real data from your workspace - no sample records.</p></div>
    <div style="display:flex; gap:10px;">
      <a class="btn secondary" href="#/websites">Manage websites</a>
      <a class="btn" href="#/scans/new">New scan</a>
    </div>
  </div>
  <div class="grid cols-4">
    ${statCard('Websites monitored', d.monitored_websites)}
    ${statCard('Scans completed', d.scans_completed, 'Last success: ' + fmtDate(d.last_successful_scan))}
    ${statCard('Potential matches', d.findings_total, `${d.findings_needing_review} need review &middot; ${d.findings_confirmed} confirmed`)}
    ${statCard('Scan failures', d.scans_failed, d.scans_failed > 0 ? 'Check scan history for next steps' : 'None')}
  </div>
  ${d.failing_websites && d.failing_websites.length ? `
    <div class="card" style="margin-top:16px; border-color:rgba(248,113,113,.35);">
      <h3>Crawl failures</h3>
      ${d.failing_websites.map((f) => `<p class="small" style="margin:0 0 10px;"><strong>${esc(f.submitted_url)}</strong><br><span class="muted">${esc(f.crawl_error || 'Unknown error')}</span> - verify the URL is public and reachable, then retry a scan.</p>`).join('')}
    </div>` : ''}
  <div class="grid cols-2" style="margin-top:16px;">
    <div class="card">
      <h3>Recent scans</h3>
      ${d.recent_scans.length === 0 ? emptyState('bolt', 'No scans yet', 'Add an original and a comparison website, then run your first scan.') :
      `<table><thead><tr><th>Websites</th><th>Status</th><th>Findings</th><th>When</th></tr></thead><tbody>
      ${d.recent_scans.map((s) => `<tr><td>${esc(hostOf(s.original_url))} &rarr; ${esc(hostOf(s.comparison_url))}</td>
        <td><span class="badge ${s.status}">${s.status}</span></td><td class="num">${s.findings ?? '-'}</td><td class="muted small">${fmtDate(s.finished_at || s.created_at)}</td></tr>`).join('')}
      </tbody></table>`}
    </div>
    <div class="card">
      <h3>Recent potential matches</h3>
      ${d.recent_results.length === 0 ? emptyState('search', 'No findings yet', 'Potential matches appear here once a scan finds shared passages.') :
      `<table><thead><tr><th>Pages</th><th>Score</th><th>Status</th></tr></thead><tbody>
      ${d.recent_results.map((r) => `<tr class="clickable" data-result="${esc(r.id)}"><td><span class="small">${esc(hostOf(r.original_url))} vs ${esc(hostOf(r.comparison_url))}</span></td>
        <td class="num">${fmtScore(r.jaccard_score)}</td><td><span class="badge ${r.status}">${r.status.replace('_', ' ')}</span></td></tr>`).join('')}
      </tbody></table>`}
    </div>
  </div>`;
}

async function websitesView() {
  const { websites } = await api(`/workspaces/${wsId}/websites`);
  return `
  <div class="page-head">
    <div><h1>Websites</h1><p>Your original site plus comparison sites to check against.</p></div>
    <button class="btn" id="addSiteBtn">Add website</button>
  </div>
  <div id="addSiteForm" style="display:none; margin-bottom:16px;" class="card">
    <h3>Add a website</h3>
    <form id="siteForm" novalidate>
      <div class="grid cols-2">
        <div class="field"><label for="siteUrl">URL</label><input id="siteUrl" type="url" placeholder="https://example.com" required></div>
        <div class="field"><label for="siteKind">Role</label>
          <select id="siteKind"><option value="comparison">Comparison site</option><option value="original">Original (my) site</option></select>
          <div class="hint">One active original site per workspace.</div></div>
      </div>
      <div class="field"><label for="siteLabel">Label (optional)</label><input id="siteLabel" placeholder="e.g. Main competitor"></div>
      <div class="form-error" id="siteError" role="alert"></div>
      <button class="btn" type="submit">Add website</button>
    </form>
  </div>
  ${websites.length === 0 ? emptyState('globe', 'No websites registered', 'Add your original website first, then add competitor sites to compare.') :
  `<div class="card" style="padding:0; overflow-x:auto;">
    <table>
      <thead><tr><th>Role</th><th>URL</th><th>Status</th><th>Crawl</th><th>Pages</th><th>Last scanned</th><th></th></tr></thead>
      <tbody>
      ${websites.map((w) => `<tr>
        <td><span class="badge ${w.kind === 'original' ? 'original' : ''}">${w.kind}</span></td>
        <td><div class="url-cell" title="${esc(w.url)}">${esc(w.url)}</div>${w.label ? `<div class="small muted">${esc(w.label)}</div>` : ''}</td>
        <td><span class="badge ${w.status}">${w.status}</span></td>
        <td><span class="badge ${w.crawl_status}">${w.crawl_status}</span>${w.crawl_error ? `<div class="small" style="color:var(--danger)">${esc(w.crawl_error.slice(0, 80))}</div>` : ''}</td>
        <td class="num">${w.accessible_page_count}</td>
        <td class="muted small">${fmtDate(w.last_scanned_at)}</td>
        <td style="white-space:nowrap; text-align:right;">
          <button class="btn ghost sm" data-toggle="${esc(w.id)}" data-status="${w.status === 'paused' ? 'active' : 'paused'}">${w.status === 'paused' ? 'Resume' : 'Pause'}</button>
          <button class="btn danger sm" data-delete="${esc(w.id)}">Remove</button>
        </td></tr>`).join('')}
      </tbody>
    </table>
  </div>`}`;
}

async function scansView() {
  if (location.hash.startsWith('#/scans/new')) return newScanView();
  const { scans } = await api(`/workspaces/${wsId}/scans`);
  return `
  <div class="page-head">
    <div><h1>Scans</h1><p>Compare your original site against a comparison site.</p></div>
    <a class="btn" href="#/scans/new">New scan</a>
  </div>
  ${scans.length === 0 ? emptyState('bolt', 'No scans yet', 'Start your first scan from two registered websites.') :
  `<div class="card" style="padding:0; overflow-x:auto;">
    <table>
      <thead><tr><th>Original</th><th>Comparison</th><th>Status</th><th>Compared</th><th>Findings</th><th>Started</th><th>Finished</th><th>Error</th><th></th></tr></thead>
      <tbody>
      ${scans.map((s) => `<tr>
        <td class="url-cell" title="${esc(s.original_url)}">${esc(s.original_url)}</td>
        <td class="url-cell" title="${esc(s.comparison_url)}">${esc(s.comparison_url)}</td>
        <td><span class="badge ${s.status}">${s.status}</span></td>
        <td class="num">${s.pages_compared ?? '-'}</td><td class="num">${s.findings ?? '-'}</td>
        <td class="muted small">${fmtDate(s.created_at)}</td>
        <td class="muted small">${fmtDate(s.finished_at)}</td>
        <td class="small" style="color:var(--danger); max-width:200px;">${s.error ? esc(s.error.slice(0, 120)) : ''}</td>
        <td style="white-space:nowrap;">
          ${['queued', 'running'].includes(s.status) ? `<button class="btn ghost sm" data-cancel="${esc(s.id)}">Cancel</button>` : ''}
          ${['failed', 'cancelled'].includes(s.status) ? `<button class="btn secondary sm" data-retry="${esc(s.id)}">Retry</button>` : ''}
        </td></tr>`).join('')}
      </tbody>
    </table>
  </div>`}`;
}

async function newScanView() {
  const websitesResp = await api(`/workspaces/${wsId}/websites`);
  const websites = websitesResp.websites || [];
  try {
    const d = await api(`/workspaces/${wsId}/discoveries`);
    websites.__searchAvailable = d.search_available === true;
  } catch { websites.__searchAvailable = null; }
  const originals = websites.filter((w) => w.kind === 'original' && w.status !== 'paused');
  const comparisons = websites.filter((w) => w.kind === 'comparison' && w.status !== 'paused');
  if (originals.length === 0) {
    return `
    <div class="page-head"><div><h1>New scan</h1><p>You need one active original site to start.</p></div>
    <a class="btn secondary" href="#/scans">Back to scans</a></div>
    ${emptyState('book', 'Not ready yet', 'Add your original website first.')}
    <a class="btn" href="#/websites">Go to Websites</a>`;
  }
  const searchAvailable = websites.__searchAvailable === true;
  const manualForm = comparisons.length === 0 ? '' : `
    <form id="scanForm" novalidate>
      <div class="field"><label for="origSel">Original website</label>
        <select id="origSel">${originals.map((w) => `<option value="${esc(w.id)}">${esc(w.url)}</option>`).join('')}</select></div>
      <div class="field"><label for="compSel">Comparison website</label>
        <select id="compSel">${comparisons.map((w) => `<option value="${esc(w.id)}">${esc(w.url)}${w.label ? ' - ' + esc(w.label) : ''}</option>`).join('')}</select></div>
      <div class="grid cols-2">
        <div class="field"><label for="maxPages">Max pages per site</label><input id="maxPages" type="number" min="1" max="25" value="10"><div class="hint">Crawl limit: 25.</div></div>
        <div class="field"><label for="maxDepth">Crawl depth</label><input id="maxDepth" type="number" min="0" max="2" value="1"><div class="hint">0 = seed page only. Max: 2.</div></div>
      </div>
      <div class="field"><label for="recrawl" style="display:flex; gap:9px; align-items:center;"><input id="recrawl" type="checkbox" style="width:auto;"> Re-fetch pages now (otherwise cached content is used)</label></div>
      <div class="form-error" id="scanError" role="alert"></div>
      <button class="btn" type="submit" id="scanSubmit">Start scan</button>
      <span class="small muted" style="margin-left:10px;">Duplicate scans for the same pair are blocked while one is running.</span>
    </form>
    <div id="scanProgress" style="display:none; margin-top:18px;">
      <div class="loading" style="padding:10px 0;"><div class="spinner"></div><span id="scanStatusText">Scan running... fetching pages and comparing content.</span></div>
    </div>`;
  return `
  <div class="page-head"><div><h1>New scan</h1><p>Compare manually, or let SaaS Shield find copying sites automatically.</p></div>
    <a class="btn secondary" href="#/scans">Back to scans</a></div>
  <div style="display:grid; gap:22px; max-width:580px;">
  ${manualForm ? `<div class="card">${manualForm}</div>` : ''}
  <div class="card">
    <h3 style="margin:0 0 6px;">Auto-discover copies</h3>
    <p class="small muted" style="margin:0 0 14px;">We pick distinctive sentences from your original site, search the web for them, and scan every site that shows up. No comparison site needed.</p>
    ${searchAvailable ? '' : '<div class="form-error" style="margin-bottom:10px;">Search API key not configured. Add SERPER_API_KEY in Render &rarr; Environment (free key: serper.dev). Manual scans work without it.</div>'}
    <form id="discoverForm" novalidate>
      <div class="field"><label for="discSel">Original website</label>
        <select id="discSel">${originals.map((w) => `<option value="${esc(w.id)}">${esc(w.url)}</option>`).join('')}</select></div>
      <div class="form-error" id="discoverError" role="alert"></div>
      <button class="btn" type="submit" id="discoverSubmit">Find copying sites</button>
      <span class="small muted" style="margin-left:10px;">Up to 6 sites per run.</span>
    </form>
    <div id="discoverProgress" style="display:none; margin-top:18px;">
      <div class="loading" style="padding:10px 0;"><div class="spinner"></div><span id="discoverStatusText">Searching the web for your content...</span></div>
    </div>
  </div>
  </div>`;
}

async function resultsView() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const q = [];
  for (const [k, v] of params) q.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  const { results } = await api(`/workspaces/${wsId}/results${q.length ? '?' + q.join('&') : ''}`);
  const { websites } = await api(`/workspaces/${wsId}/websites`);
  const f = (name, label, options) => `<div class="field"><label for="f_${name}">${label}</label>${options}</div>`;
  return `
  <div class="page-head">
    <div><h1>Potential matches</h1><p>Similarity scores measure text overlap - not infringement. Review each finding yourself.</p></div>
    <div style="display:flex; gap:10px;">
      <a class="btn secondary" href="/api/workspaces/${esc(wsId)}/reports/export" target="_blank">Export JSON</a>
      <a class="btn secondary" href="/api/workspaces/${esc(wsId)}/reports/export.pdf" target="_blank">Export PDF</a>
    </div>
  </div>
  <div class="card" style="padding:16px;">
    <div class="toolbar">
      ${f('website', 'Website', `<select id="f_website"><option value="">All</option>${websites.map((w) => `<option value="${esc(w.id)}" ${params.get('website_id') === w.id ? 'selected' : ''}>${esc(w.domain)}</option>`).join('')}</select>`)}
      ${f('status', 'Status', `<select id="f_status"><option value="">All</option>${['new', 'in_review', 'confirmed', 'dismissed'].map((s) => `<option ${params.get('status') === s ? 'selected' : ''}>${s.replace('_', ' ')}</option>`).join('')}</select>`)}
      ${f('min', 'Min score %', `<input id="f_min" type="number" min="0" max="100" value="${esc(params.get('min_score') || '')}" placeholder="0">`)}
      ${f('type', 'Match type', `<select id="f_type"><option value="">All</option>${['long_passage', 'partial_passage', 'phrase', 'low_similarity'].map((s) => `<option ${params.get('match_type') === s ? 'selected' : ''}>${s.replace('_', ' ')}</option>`).join('')}</select>`)}
      <div class="field"><label for="f_since">Observed since</label><input id="f_since" type="date" value="${esc(params.get('since') || '')}"></div>
      <button class="btn secondary" id="applyFilters">Apply filters</button>
      <button class="btn ghost" id="clearFilters">Clear</button>
    </div>
  </div>
  ${results.length === 0 ? emptyState('search', 'No matching findings', 'Try adjusting the filters, or run a new scan.') :
  `<div class="card" style="padding:0; margin-top:16px; overflow-x:auto;">
    <table>
      <thead><tr><th>Original page</th><th>Comparison page</th><th>Type</th><th>Jaccard</th><th>Cosine</th><th>Status</th><th>Last seen</th></tr></thead>
      <tbody>
      ${results.map((r) => `<tr class="clickable" data-result="${esc(r.id)}">
        <td class="url-cell" title="${esc(r.original_url)}">${esc(r.original_url)}</td>
        <td class="url-cell" title="${esc(r.comparison_url)}">${esc(r.comparison_url)}</td>
        <td><span class="badge ${r.match_type}">${r.match_type.replace('_', ' ')}</span></td>
        <td><span class="score-pill"><span class="dot" style="background:var(--accent)"></span>${fmtScore(r.jaccard_score)}</span></td>
        <td><span class="score-pill"><span class="dot" style="background:#a5b4fc"></span>${fmtScore(r.cosine_score)}</span></td>
        <td><span class="badge ${r.status}">${r.status.replace('_', ' ')}</span></td>
        <td class="muted small">${fmtDate(r.last_observed_at)}</td>
      </tr>`).join('')}
      </tbody>
    </table>
  </div>`}`;
}

async function resultDetailView(id) {
  const { result } = await api(`/workspaces/${wsId}/results/${encodeURIComponent(id)}`);
  const ev = result.evidence;
  return `
  <div class="page-head">
    <div><h1>Potential match</h1><p class="muted small">${esc(result.scoring_method)}</p></div>
    <div style="display:flex; gap:10px;">
      <a class="btn secondary" href="/api/workspaces/${esc(wsId)}/reports/export?result_id=${encodeURIComponent(result.id)}" target="_blank">Evidence (JSON)</a>
      <a class="btn secondary" href="/api/workspaces/${esc(wsId)}/reports/export.pdf?result_id=${encodeURIComponent(result.id)}" target="_blank">Evidence (PDF)</a>
      <a class="btn ghost" href="#/results">&larr; Back</a>
    </div>
  </div>
  <div class="grid cols-4">
    <div class="stat"><div class="lbl">Match type</div><div class="num" style="font-size:16px;">${result.match_type.replace('_', ' ')}</div></div>
    <div class="stat"><div class="lbl">Jaccard (shingles)</div><div class="num">${fmtScore(result.jaccard_score)}</div></div>
    <div class="stat"><div class="lbl">TF-IDF cosine</div><div class="num">${fmtScore(result.cosine_score)}</div></div>
    <div class="stat"><div class="lbl">Review status</div>
      <div style="margin-top:6px;">
        <select id="reviewSelect" data-id="${esc(result.id)}" style="font-size:13px;">
          ${['new', 'in_review', 'confirmed', 'dismissed'].map((s) => `<option value="${s}" ${result.status === s ? 'selected' : ''}>${s.replace('_', ' ')}</option>`).join('')}
        </select>
      </div>
    </div>
  </div>
  <div class="grid cols-2" style="margin-top:16px;">
    <div class="card">
      <h3>Original page</h3>
      <a class="mono small" href="${esc(result.original_url)}" target="_blank" rel="noopener noreferrer">${esc(result.original_url)}</a>
    </div>
    <div class="card">
      <h3>Comparison page</h3>
      <a class="mono small" href="${esc(result.comparison_url)}" target="_blank" rel="noopener noreferrer">${esc(result.comparison_url)}</a>
    </div>
  </div>
  <div class="card" style="margin-top:16px;">
    <h3>Evidence record</h3>
    ${!ev ? `<p class="muted">No evidence record stored for this finding.</p>` : `
    <div class="grid cols-2">
      <dl class="defgrid">
        <dt>Captured (UTC)</dt><dd>${fmtDate(ev.captured_at)}</dd>
        <dt>Capture status</dt><dd><span class="badge ${ev.capture_status}">${ev.capture_status}</span></dd>
        <dt>Hash (original)</dt><dd class="mono small">${esc(ev.original_hash)}</dd>
        <dt>Hash (comparison)</dt><dd class="mono small">${esc(ev.comparison_hash)}</dd>
        <dt>Screenshot</dt><dd>${ev.screenshot_ref ? `<a href="${esc(ev.screenshot_ref)}" target="_blank">View</a>` : '<span class="muted small">Not captured - this build has no browser screenshot engine. Excerpt and hashes are the stored evidence.</span>'}</dd>
      </dl>
      <dl class="defgrid">
        <dt>First observed</dt><dd>${fmtDate(result.first_observed_at)}</dd>
        <dt>Last observed</dt><dd>${fmtDate(result.last_observed_at)}</dd>
        <dt>Review history</dt><dd>
        ${result.review_history.length === 0 ? '<span class="muted small">No changes yet.</span>' :
          result.review_history.map((h) => `<div class="small">${fmtDate(h.created_at)}: ${esc(h.from_status || 'new')} &rarr; <strong>${esc(h.to_status)}</strong>${h.note ? ' - ' + esc(h.note) : ''}${h.user_email ? ` <span class="muted">by ${esc(h.user_email)}</span>` : ''}</div>`).join('')}
        </dd>
      </dl>
    </div>`}
  </div>
  <h2 style="margin-top:24px; font-size:17px;">Shared passages</h2>
  ${result.passages.length === 0 ? emptyState('doc', 'No passages', 'This finding was recorded on score thresholds alone.') :
  result.passages.map((p, i) => `
  <div class="card" style="margin-top:14px;">
    <div class="passage-head"><h3 style="margin:0;">Passage ${i + 1}</h3><span class="badge">${p.word_count} words</span></div>
    <div class="grid cols-2">
      <div><div class="small muted" style="margin-bottom:7px;">Original text</div><div class="excerpt">${esc(p.original_text)}</div></div>
      <div><div class="small muted" style="margin-bottom:7px;">Comparison text</div><div class="excerpt">${esc(p.comparison_text)}</div></div>
    </div>
  </div>`).join('')}
  <p class="muted small" style="margin-top:18px;">This record shows what the system observed on public pages at capture time. It does not independently prove ownership, intent, or infringement.</p>`;
}

async function settingsView() {
  const s = await api(`/workspaces/${wsId}/settings`);
  return `
  <div class="page-head"><div><h1>Settings</h1><p>Workspace profile, members, and account.</p></div></div>
  <div class="grid cols-2">
    <div class="card">
      <h3>Workspace profile</h3>
      <form id="wsForm" novalidate>
        <div class="field"><label for="wsName">Name</label><input id="wsName" value="${esc(s.workspace.name)}" required></div>
        <div class="form-error" id="wsError" role="alert"></div>
        <button class="btn" type="submit" ${s.workspace.role === 'member' ? 'disabled title="Admin role required"' : ''}>Save</button>
      </form>
      <p class="small muted" style="margin-top:14px;">Signed in as <strong>${esc(me.user.email)}</strong> (${esc(s.workspace.role)}).</p>
    </div>
    <div class="card">
      <h3>Members</h3>
      <table><thead><tr><th>Email</th><th>Role</th><th>Joined</th></tr></thead><tbody>
      ${s.members.map((m) => `<tr><td>${esc(m.email)}</td><td><span class="badge ${m.role === 'owner' ? 'confirmed' : ''}">${m.role}</span></td><td class="muted small">${fmtDate(m.created_at)}</td></tr>`).join('')}
      </tbody></table>
      ${s.workspace.role !== 'member' ? `
      <form id="memberForm" novalidate style="margin-top:16px;">
        <div class="grid cols-2">
          <div class="field"><label for="memberEmail">Email (existing account)</label><input id="memberEmail" type="email" placeholder="teammate@example.com"></div>
          <div class="field"><label for="memberRole">Role</label><select id="memberRole"><option value="member">member</option><option value="admin">admin</option></select></div>
        </div>
        <div class="form-error" id="memberError" role="alert"></div>
        <button class="btn secondary" type="submit">Add member</button>
      </form>` : ''}
    </div>
  </div>
  <div class="card" style="margin-top:16px;">
    <h3>Notification preferences</h3>
    <label style="display:flex; gap:9px; align-items:center;"><input type="checkbox" id="notifFindings" style="width:auto;"> Email me when new potential matches are found</label>
    <p class="muted small" style="margin-top:10px;">${esc(s.note)}</p>
  </div>
  <div class="card" style="margin-top:16px;">
    <h3>Website management</h3>
    <p class="muted small">Add, pause, resume, or remove monitored websites.</p>
    <a class="btn secondary" href="#/websites">Manage websites</a>
  </div>
  <div class="card" style="margin-top:16px;">
    <h3>Account security</h3>
    <p class="muted small">Sessions are HttpOnly cookies stored as SHA-256 hashes; passwords use scrypt. Sign out everywhere by changing your password (not yet supported in this build).</p>
    <button class="btn danger" id="signoutBtn2">Sign out</button>
  </div>`;
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------
async function handleAuthForm(e, mode) {
  e.preventDefault();
  const email = elid('email').value.trim();
  const password = elid('password').value;
  const errEl = elid('authError');
  errEl.textContent = '';
  if (!email || !password) { errEl.textContent = 'Email and password are required.'; return; }
  if (mode === 'signup' && password.length < 8) { errEl.textContent = 'Password must be at least 8 characters.'; return; }
  try {
    const body = mode === 'signup'
      ? { email, password, workspace_name: elid('wsname') ? elid('wsname').value.trim() : undefined }
      : { email, password };
    await api(`/auth/${mode === 'signup' ? 'signup' : 'signin'}`, { method: 'POST', body });
    if (!(await loadMe())) { errEl.textContent = 'Signed in, but the session could not be loaded. Please hard-refresh the page (Ctrl+Shift+R) and try again.'; return; }
    location.hash = '#/dashboard';
    toast(mode === 'signup' ? 'Account created. Welcome!' : 'Signed in.', 'success');
  } catch (err) {
    errEl.textContent = err.message;
  }
}

async function handleSiteForm(e) {
  e.preventDefault();
  const errEl = elid('siteError');
  errEl.textContent = '';
  const url = elid('siteUrl').value.trim();
  const kind = elid('siteKind').value;
  const label = elid('siteLabel').value.trim() || undefined;
  if (!url) { errEl.textContent = 'URL is required.'; return; }
  try {
    await api(`/workspaces/${wsId}/websites`, { method: 'POST', body: { url, kind, label } });
    toast('Website added. It will be crawled during the first scan.', 'success');
    render();
  } catch (err) { errEl.textContent = err.message; }
}

async function handleScanForm(e) {
  e.preventDefault();
  const errEl = elid('scanError');
  errEl.textContent = '';
  try {
    const body = {
      original_website_id: elid('origSel').value,
      comparison_website_id: elid('compSel').value,
      recrawl: elid('recrawl').checked,
      max_pages: Number(elid('maxPages').value) || undefined,
      max_depth: Number(elid('maxDepth').value)
    };
    const { scan } = await api(`/workspaces/${wsId}/scans`, { method: 'POST', body });
    elid('scanForm').style.display = 'none';
    elid('scanProgress').style.display = 'block';
    elid('scanSubmit').disabled = true;
    pollScan(scan.id);
  } catch (err) { errEl.textContent = err.message; }
}

async function pollScan(scanId) {
  try {
    const { scan } = await api(`/workspaces/${wsId}/scans/${scanId}`);
    if (scan.status === 'queued' || scan.status === 'running') {
      setTimeout(() => pollScan(scanId), 1500);
      return;
    }
    if (scan.status === 'completed') {
      toast(`Scan completed: ${scan.findings} potential match${scan.findings === 1 ? '' : 'es'} found.`, 'success');
      location.hash = '#/results';
    } else {
      toast(scan.error || 'Scan failed or was cancelled.', 'error');
      render();
    }
  } catch (err) {
    toast(err.message, 'error');
    render();
  }
}

async function updateReview(id, status) {
  try {
    await api(`/workspaces/${wsId}/results/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status } });
    toast('Review status updated.', 'success');
    render();
  } catch (err) { showError(err); }
}

// ---------------------------------------------------------------------------
// boot / router
// ---------------------------------------------------------------------------
async function loadMe() {
  try {
    me = await api('/auth/me');
    if (me.workspaces.length === 0) throw new Error('No workspace');
    wsId = me.workspaces[0].id;
    return true;
  } catch {
    me = null;
    wsId = null;
    return false;
  }
}

async function render() {
  const hash = location.hash || '#/';
  const authed = me || (await loadMe());
  if (!authed) {
    root.innerHTML = authView(hash.startsWith('#/signup') ? 'signup' : 'signin');
    elid('authForm').addEventListener('submit', (e) => handleAuthForm(e, hash.startsWith('#/signup') ? 'signup' : 'signin'));
    return;
  }

  let content = loading();
  root.innerHTML = shell(content, hash);
  bindShell();

  try {
    if (hash.startsWith('#/results/')) {
      content = await resultDetailView(decodeURIComponent(hash.slice('#/results/'.length)));
    } else if (hash.startsWith('#/results')) {
      content = await resultsView();
    } else if (hash.startsWith('#/websites')) {
      content = await websitesView();
    } else if (hash.startsWith('#/scans')) {
      content = await scansView();
    } else if (hash.startsWith('#/settings')) {
      content = await settingsView();
    } else {
      content = await dashboardView();
    }
  } catch (err) {
    if (err.status === 401) { me = null; wsId = null; render(); return; }
    content = `<div class="card"><h3>Something went wrong</h3><p class="muted">${esc(err.message)}</p><button class="btn secondary" onclick="render()">Retry</button></div>`;
  }
  elid('main').innerHTML = content;
  bindPage(hash);
}

async function handleDiscoverForm(e) {
  e.preventDefault();
  const errEl = elid('discoverError');
  errEl.textContent = '';
  const origId = elid('discSel').value;
  try {
    const { discovery } = await api(`/workspaces/${wsId}/discover`, { method: 'POST', body: { original_website_id: origId } });
    elid('discoverForm').style.display = 'none';
    elid('discoverProgress').style.display = 'block';
    elid('discoverSubmit').disabled = true;
    pollDiscovery(discovery.id);
  } catch (err) { errEl.textContent = err.message; }
}

async function pollDiscovery(id) {
  try {
    const { discovery } = await api(`/workspaces/${wsId}/discoveries/${id}`);
    if (discovery.status === 'completed') {
      elid('discoverStatusText').textContent = `Done. ${discovery.created_scan_count} scan(s) queued.`;
      toast(`Auto-discovery finished: ${discovery.created_scan_count} scan(s) started.`, 'success');
      setTimeout(() => { location.hash = '#/scans'; }, 1400);
      return;
    }
    if (discovery.status === 'failed') {
      elid('discoverProgress').style.display = 'none';
      elid('discoverForm').style.display = '';
      elid('discoverSubmit').disabled = false;
      elid('discoverError').textContent = discovery.error || 'Discovery failed.';
      return;
    }
  } catch { /* transient - keep polling */ }
  setTimeout(() => pollDiscovery(id), 3000);
}

function bindShell() {
  const so = elid('signoutBtn');
  if (so) so.addEventListener('click', async () => {
    await api('/auth/signout', { method: 'POST' });
    me = null; wsId = null;
    location.hash = '#/';
    toast('Signed out.');
    render();
  });
}

function bindPage(hash) {
  // website rows
  document.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await api(`/workspaces/${wsId}/websites/${b.dataset.toggle}`, { method: 'PATCH', body: { status: b.dataset.status } });
      toast('Website updated.', 'success');
      render();
    } catch (err) { showError(err); }
  }));
  document.querySelectorAll('[data-delete]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Remove this website and all its crawled pages, scans and findings?')) return;
    try {
      await api(`/workspaces/${wsId}/websites/${b.dataset.delete}`, { method: 'DELETE' });
      toast('Website removed.', 'success');
      render();
    } catch (err) { showError(err); }
  }));
  const addBtn = elid('addSiteBtn');
  if (addBtn) addBtn.addEventListener('click', () => {
    const f = elid('addSiteForm');
    f.style.display = f.style.display === 'none' ? 'block' : 'none';
  });
  const sf = elid('siteForm');
  if (sf) sf.addEventListener('submit', handleSiteForm);

  // scan rows
  document.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await api(`/workspaces/${wsId}/scans/${b.dataset.cancel}/cancel`, { method: 'POST' });
      toast('Cancellation requested.');
      setTimeout(render, 800);
    } catch (err) { showError(err); }
  }));
  document.querySelectorAll('[data-retry]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await api(`/workspaces/${wsId}/scans/${b.dataset.retry}/retry`, { method: 'POST' });
      toast('Scan queued again.', 'success');
      render();
    } catch (err) { showError(err); }
  }));
  const scanForm = elid('scanForm');
  if (scanForm) scanForm.addEventListener('submit', handleScanForm);
  const discoverForm = elid('discoverForm');
  if (discoverForm) discoverForm.addEventListener('submit', handleDiscoverForm);

  // result rows
  document.querySelectorAll('[data-result]').forEach((tr) => tr.addEventListener('click', () => {
    location.hash = '#/results/' + tr.dataset.result;
  }));

  // review select
  const rs = elid('reviewSelect');
  if (rs) rs.addEventListener('change', () => updateReview(rs.dataset.id, rs.value));

  // filters
  const apply = elid('applyFilters');
  if (apply) apply.addEventListener('click', () => {
    const p = new URLSearchParams();
    const website = elid('f_website').value;
    const status = elid('f_status').value.replace(' ', '_');
    const min = elid('f_min').value;
    const type = elid('f_type').value.replace(' ', '_');
    const since = elid('f_since').value;
    if (website) p.set('website_id', website);
    if (status) p.set('status', status);
    if (min) p.set('min_score', (Number(min) / 100).toFixed(4));
    if (type) p.set('match_type', type);
    if (since) p.set('since', since);
    location.hash = '#/results' + (p.toString() ? '?' + p.toString() : '');
  });
  const clear = elid('clearFilters');
  if (clear) clear.addEventListener('click', () => { location.hash = '#/results'; });

  // settings
  const wsForm = elid('wsForm');
  if (wsForm) wsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(`/workspaces/${wsId}/settings`, { method: 'PATCH', body: { name: elid('wsName').value } });
      me = null; await loadMe();
      toast('Workspace updated.', 'success');
      render();
    } catch (err) { elid('wsError').textContent = err.message; }
  });
  const mf = elid('memberForm');
  if (mf) mf.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(`/workspaces/${wsId}/members`, { method: 'POST', body: { email: elid('memberEmail').value, role: elid('memberRole').value } });
      toast('Member added.', 'success');
      render();
    } catch (err) { elid('memberError').textContent = err.message; }
  });
  const so2 = elid('signoutBtn2');
  if (so2) so2.addEventListener('click', async () => {
    await api('/auth/signout', { method: 'POST' });
    me = null; wsId = null;
    location.hash = '#/';
    render();
  });
}

window.addEventListener('hashchange', render);
render();
