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

let AUTH_CFG = null;
async function loadAuthCfg() {
  if (AUTH_CFG) return AUTH_CFG;
  try { AUTH_CFG = await api('/auth/config'); } catch { AUTH_CFG = {}; }
  return AUTH_CFG;
}
function authModeNote() {
  const c = AUTH_CFG || {};
  if (!c.auth_mode) return '';
  if (c.auth_mode === 'instant') {
    // Instant mode is the deployment's own configuration detail, not something a
    // visitor needs to read on the sign-in card. The verification notice below is
    // a different message and stays.
    return '';
  }
  return '<div class="notice" style="margin-bottom:14px;">Email verification is on: we email a confirmation link before your first sign-in.</div>';
}

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
  ['#/results', 'Findings', 'results']
];

const NAV_SECONDARY = [
  ['#/scans', 'Scans', 'bolt'],
  ['#/monitoring', 'Monitoring', 'scans'],
  ['#/changes', 'Changelog', 'doc'],
  ['#/alerts', 'Alerts', 'bolt'],
  ['#/settings', 'Settings', 'settings']
];

// Sidebar sections. The mobile bar keeps the flat NAV order.
const NAV_GROUPS = [
  ['', ['#/dashboard', '#/websites', '#/results']],
  ['More', ['#/scans', '#/monitoring', '#/changes', '#/alerts']]
];

function shell(content, activeRoute) {
  const ws = me && me.workspaces ? me.workspaces.find((w) => w.id === wsId) : null;
  const byHref = new Map(NAV.map(([href, label, icon]) => [href, { label, icon }]));
  const isActive = (href) => location.hash.startsWith(href)
    && !(href === '#/results' && location.hash.startsWith('#/results/'));
  const links = NAV_GROUPS.map(([group, hrefs]) => {
    const section = hrefs.map((href) => {
      const item = byHref.get(href);
      if (!item) return '';
      return `<a class="navlink ${isActive(href) ? 'active' : ''}" href="${href}"${isActive(href) ? ' aria-current="page"' : ''}>${ICONS[item.icon]} ${item.label}</a>`;
    }).join('');
    return `${group ? `<div class="kicker" style="padding:14px 10px 6px;">${group}</div>` : '<div style="height:1px;background:var(--line);margin:10px 10px;"></div>'}${section}`;
  }).join('');
  const mobileLinks = [...NAV, ['#/settings', 'Settings', 'settings']].map(([href, label, icon]) =>
    `<a class="navlink ${location.hash.startsWith(href) ? 'active' : ''}" href="${href}">${ICONS[icon]} ${label}</a>`).join('');
  return `
  <div class="shell">
    <aside class="sidebar">
      <a class="logo" href="#/dashboard">${LOGO_LOCKUP}</a>
      <div class="ws-chip">${esc(ws ? ws.name : '')}</div>
      ${links}
      <div class="spacer"></div>
      <div class="sidebar-foot">
        <a class="navlink" href="#/settings">${ICONS.settings} Settings</a>
        <div class="user-chip" title="${esc(me ? me.user.email : '')}">${esc(me ? me.user.email : '')}</div>
        <a class="navlink" href="/">${ICONS.home} Back to site</a>
        <button class="navlink" style="width:100%;border:none;background:none;text-align:left" id="signoutBtn">${ICONS.signout} Sign out</button>
      </div>
    </aside>
    <main class="main" id="main">
      ${me && me.user && me.user.email_verified === false ? `<div class="notice warn" style="margin-bottom:16px;">
        <strong>Your email address is not confirmed.</strong> Confirm it to receive alerts and digests at ${esc(me.user.email)}.
        <button class="btn ghost sm" id="resendVerifyBtn" type="button" style="margin-left:8px;">Resend email</button>
      </div>` : ''}
      ${content}
    </main>
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
        ${authModeNote()}
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
  const started = sessionStorage.getItem('shield.addedSite') || '';
  const kpi = (num, label, tone) => `<div class="kpi${tone ? ' ' + tone : ''}"><div class="num">${num}</div><div class="lbl">${label}</div></div>`;
  const recent = d.recent_results || [];
  return `
  <div class="page-head">
    <div>
      <h1>Dashboard</h1>
      <p>${d.monitored_websites === 0
        ? 'Add a website and SaaS Shield checks it for copied content automatically.'
        : `Monitoring ${d.monitored_websites} ${d.monitored_websites === 1 ? 'website' : 'websites'}. Everything below updates on its own.`}</p>
    </div>
    <div class="cta-row">
      <a class="btn" href="#/websites" id="addFromDash">+ Add Website</a>
    </div>
  </div>
  ${started ? `<div class="notice" id="addProgress" data-site="${esc(started)}">We are checking <strong>${esc(started)}</strong>. Pages are being read and compared; findings appear below as they are found.</div>` : ''}
  <div class="kpis">
    ${kpi(d.monitored_websites, 'Websites monitored')}
    ${kpi(d.scans_completed, 'Completed scans')}
    ${kpi(d.findings_total, 'Potential findings', d.findings_total > 0 ? 'accent' : '')}
    ${kpi(d.scans_failed, 'Scan failures', d.scans_failed > 0 ? 'warn' : '')}
  </div>
  ${d.monitored_websites === 0 ? `<div class="card" style="margin-top:18px;">
    <h3>How this works</h3>
    <ol class="steps">
      <li><strong>Add your website.</strong> Paste the address, confirm.</li>
      <li><strong>We scan it automatically.</strong> Pages are read and compared against pages found elsewhere.</li>
      <li><strong>Review what we find.</strong> Each match shows both sides and a similarity score.</li>
    </ol>
    <div class="cta-row"><a class="btn" href="#/websites">+ Add Website</a></div>
  </div>` : ''}
  ${d.failing_websites && d.failing_websites.length ? `
    <div class="card" style="margin-top:18px;">
      <h3>We could not read these websites</h3>
      ${d.failing_websites.map((f) => `<p class="small" style="margin:0 0 10px;"><strong>${esc(f.submitted_url)}</strong><br><span class="muted">${esc(f.crawl_error || 'The site did not respond.')}</span></p>`).join('')}
      <p class="hint" style="margin:0;">Check the address opens in a browser, then scan again.</p>
    </div>` : ''}
  <div class="card" style="margin-top:18px;">
    <div class="card-head">
      <h3>Recent findings</h3>
      <a class="link-more" href="#/results">All findings</a>
    </div>
    ${recent.length === 0 ? emptyState('search', 'Nothing found yet', d.monitored_websites ? 'We are still checking. Findings appear here the moment a page overlaps with yours.' : 'Add a website to begin.') :
    `<div class="table-scroll"><table><thead><tr><th>Your website</th><th>Matching website</th><th>Similarity</th><th>Type</th><th>Found</th><th></th></tr></thead><tbody>
    ${recent.map((r) => `<tr>
      <td>${esc(hostOf(r.original_url))}</td>
      <td>${esc(hostOf(r.comparison_url))}</td>
      <td class="num">${fmtScore(r.jaccard_score)}</td>
      <td><span class="badge">${esc((r.match_type || '').replace('_', ' '))}</span></td>
      <td class="muted small">${fmtDate(r.created_at)}</td>
      <td><a class="btn ghost sm" href="#/results/${encodeURIComponent(r.id)}">View details</a></td>
    </tr>`).join('')}
    </tbody></table></div>`}
    <p class="hint">These are potential matches, not proof of plagiarism. Open a finding to see the quoted passages side by side.</p>
  </div>
  ${d.recent_scans && d.recent_scans.length ? `<div class="card" style="margin-top:18px;">
    <div class="card-head"><h3>Recent scans</h3><a class="link-more" href="#/scans">All scans</a></div>
    <div class="table-scroll"><table><thead><tr><th>Comparing</th><th>Status</th><th>Findings</th><th>When</th></tr></thead><tbody>
    ${d.recent_scans.slice(0, 5).map((s) => `<tr><td>${esc(hostOf(s.original_url))} vs ${esc(hostOf(s.comparison_url))}</td>
      <td><span class="badge ${s.status}">${s.status === 'completed' ? 'Completed' : s.status === 'running' ? 'Scanning' : s.status === 'queued' ? 'Queued' : 'Failed'}</span></td>
      <td class="num">${s.findings ?? '-'}</td><td class="muted small">${fmtDate(s.finished_at || s.created_at)}</td></tr>`).join('')}
    </tbody></table></div>
  </div>` : ''}`;
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
    ${searchAvailable ? '' : '<div class="form-error" style="margin-bottom:10px;">Auto-discovery is optional and currently off (no search key). You can still add comparison sites by URL, and monitoring works normally.</div>'}
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
        <td><span class="badge ${r.match_type}">${r.match_type.replace('_', ' ')}</span>${r.verdict ? `<div class="small muted" style="margin-top:4px;">${esc(String(r.verdict).replace(/_/g, ' '))}</div>` : ''}</td>
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

function deliveryToast(verification) {
  const d = verification && verification.delivery;
  if (d === 'sent') {
    return verification.test_sender
      ? { kind: 'error', msg: 'Resend accepted it, but the test sender only delivers to the Resend account owner. Verify a domain to email users.' }
      : { kind: 'success', msg: 'Confirmation email accepted by Resend. Check your inbox.' };
  }
  if (d === 'skipped') {
    return { kind: 'error', msg: 'No email was sent: this deployment has no email provider configured.' };
  }
  return { kind: 'error', msg: 'The confirmation email could not be sent.' };
}

function renderVerificationSent(emailAddress, verification) {
  const v = verification || {};
  const state = v.delivery === 'sent' ? 'sent' : (v.delivery === 'skipped' ? 'skipped' : 'failed');
  const devLink = v.dev_link;
  const note = v.note ? `<p class="small" style="margin:8px 0 0;">${esc(v.note)}</p>` : '';
  const devHint = devLink ? `For local development, use this link: <a href="${esc(devLink)}">confirm now</a>.` : '';
  let notice;
  if (state === 'failed') {
    notice = `<div class="notice warn">
        <strong>We could not send the confirmation email.</strong>${note}
        ${devLink ? `<p class="small" style="margin:8px 0 0;">${devHint}</p>` : ''}
      </div>`;
  } else if (state === 'skipped') {
    notice = `<div class="notice warn">
        <strong>No email was sent.</strong> This deployment has no email provider configured, so the confirmation link could not be delivered.${note}
        ${devLink ? `<p class="small" style="margin:8px 0 0;">${devHint}</p>` : ''}
      </div>`;
  } else if (v.test_sender) {
    notice = `<div class="notice warn">
        <strong>Accepted by Resend, delivery limited.</strong>${note}
      </div>`;
  } else {
    notice = `<div class="notice">
        <strong>Accepted by Resend.</strong> That means the provider queued the message; it is not proof of delivery.
        The link in that email works once and expires in ${esc(String(v.expires_at || '24 hours').slice(0, 10) || '24 hours')}.
      </div>`;
  }
  root.innerHTML = `
  <div class="auth-wrap"><div class="auth-card">
    <div class="auth-brand"><a class="logo" href="/">${LOGO_LOCKUP}</a></div>
    <div class="card">
      <h2>Confirm your email</h2>
      <p class="subhead">We need to confirm <strong>${esc(emailAddress)}</strong> before your workspace is activated.</p>
      ${notice}
      <p class="small muted" style="margin-top:14px;">Nothing arrived? Check spam, or
        <button class="btn ghost sm" id="resendBtn" type="button">resend the confirmation email</button>.</p>
      <p class="small muted" style="margin-top:10px;"><a href="#/signin">Back to sign in</a></p>
    </div>
  </div></div>`;
  const btn = elid('resendBtn');
  if (btn) btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const r = await api('/auth/verify/resend', { method: 'POST', body: { email: emailAddress } });
      const t = deliveryToast(r.verification);
      toast(t.msg, t.kind);
      renderVerificationSent(emailAddress, r.verification || {});
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
    }
  });
}

function verifyFailedView(reason) {
  const messages = {
    expired: 'That confirmation link has expired.',
    used: 'That confirmation link has already been used. Sign in if your address is confirmed.',
    invalidated: 'A newer confirmation email was sent, so this link no longer works. Use the most recent one.',
    invalid: 'That confirmation link is not valid.',
    missing_token: 'That link is missing its confirmation token.'
  };
  return `
  <div class="auth-wrap"><div class="auth-card">
    <div class="auth-brand"><a class="logo" href="/">${LOGO_LOCKUP}</a></div>
    <div class="card">
      <h2>Confirmation failed</h2>
      <p class="subhead">${esc(messages[reason] || 'This confirmation link could not be used.')}</p>
      <p class="small muted">Request a new link from the sign-in page, or sign in if you have already confirmed your address.</p>
      <a class="btn block" href="#/signin">Go to sign in</a>
    </div>
  </div></div>`;
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
    <h3>Notifications</h3>
    ${s.email && !s.email.configured ? `<div class="notice warn" style="margin-bottom:14px;">
      <strong>No email provider is configured on this deployment.</strong> Alerts and digests are recorded in the app but cannot be emailed.
      ${(s.email.missing || []).length ? `Missing: ${s.email.missing.map((m) => `<code>${esc(m)}</code>`).join(', ')}` : ''}
    </div>` : ''}
    <form id="notifForm" novalidate>
      <div class="grid cols-2">
        <div class="field">
          <label><input type="checkbox" id="notifImmediate" style="width:auto;" ${s.notifications.immediate_email ? 'checked' : ''}> Email me immediately for important changes</label>
          <div class="hint">Only changes at or above the severity below are emailed right away.</div>
        </div>
        <div class="field">
          <label for="notifSeverity">Minimum severity for email</label>
          <select id="notifSeverity">
            ${['info', 'normal', 'high', 'critical'].map((v) => `<option value="${v}" ${s.notifications.min_severity === v ? 'selected' : ''}>${v}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="grid cols-3">
        <div class="field">
          <label><input type="checkbox" id="notifDigest" style="width:auto;" ${s.notifications.digest_enabled ? 'checked' : ''}> Weekly digest</label>
        </div>
        <div class="field"><label for="notifDay">Digest day (UTC)</label>
          <select id="notifDay">
            ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d, i) => `<option value="${i}" ${Number(s.notifications.digest_day) === i ? 'selected' : ''}>${d}</option>`).join('')}
          </select></div>
        <div class="field"><label for="notifHour">Hour (UTC)</label>
          <select id="notifHour">
            ${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${Number(s.notifications.digest_hour_utc) === h ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('')}
          </select></div>
      </div>
      <div class="field"><label><input type="checkbox" id="notifEmpty" style="width:auto;" ${s.notifications.include_empty_digest ? 'checked' : ''}> Send the digest even when nothing changed</label></div>
      <div class="form-error" id="notifError" role="alert"></div>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button class="btn" type="submit" ${s.workspace.role === 'member' ? 'disabled title="Admin role required"' : ''}>Save preferences</button>
        <button class="btn secondary" type="button" id="testEmailBtn">Send test email</button>
      </div>
    </form>
    <p class="small muted" style="margin-top:12px;">
      Recipients: ${(s.recipients || []).map((r) => esc(r.email)).join(', ') || 'no confirmed addresses yet'}.
      ${s.next_digest ? `Next digest window ends ${fmtDate(s.next_digest.period_end)}.` : ''}
      ${s.last_digest ? `Last digest ${esc(s.last_digest.period_key)}: ${esc(s.last_digest.status)}${s.last_digest.change_count ? ` (${s.last_digest.change_count} changes)` : ''}.` : ''}
    </p>
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
    const res = await api(`/auth/${mode === 'signup' ? 'signup' : 'signin'}`, { method: 'POST', body });

    if (mode === 'signup' && res.verification && res.verification.required && !res.user) {
      renderVerificationSent(email, res.verification);
      return;
    }
    if (!(await loadMe())) { errEl.textContent = 'Signed in, but the session could not be loaded. Please hard-refresh the page (Ctrl+Shift+R) and try again.'; return; }
    location.hash = '#/dashboard';
    toast(mode === 'signup' ? 'Account created. Welcome!' : 'Signed in.', 'success');
  } catch (err) {
    if (err.status === 403 && /confirm your email/i.test(err.message)) {
      renderVerificationSent(email, { required: true, delivery: 'unknown' });
      return;
    }
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
    const created = await api(`/workspaces/${wsId}/websites`, { method: 'POST', body: { url, kind, label } });
    const site = (created && (created.website || created)) || {};
    // Automatic next step for the site the user just added: the existing discovery
    // job searches for pages that overlap with it and queues a scan for each hit.
    // Nothing is faked: if search is unconfigured or refused, we surface that.
    let auto = '';
    if (kind === 'original' && site.id) {
      try {
        await api(`/workspaces/${wsId}/discover`, { method: 'POST', body: { original_website_id: site.id } });
        auto = ' Automatic checking has started.';
      } catch (err) {
        auto = err.message && /search/i.test(err.message)
          ? ' Automatic checking needs a search provider on this deployment, so add a comparison website and start a scan yourself.'
          : ' We could not start the automatic check just now - open Scans to start one.';
      }
    }
    try { sessionStorage.setItem('shield.addedSite', site.submitted_url || url); } catch { /* private mode */ }
    toast('Website added.' + auto, 'success');
    location.hash = '#/dashboard';
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
// Change monitoring: pages, changelog, alerts
// ---------------------------------------------------------------------------
const CATEGORY_LABELS = {
  pricing: 'Pricing', signup: 'Signup flow', headings: 'Headings', copy: 'Page copy',
  sections: 'Sections', links: 'Links', cta: 'Calls to action', images: 'Images',
  title: 'Title', meta: 'Meta description', other: 'Other'
};

function relTime(iso) {
  if (!iso) return '-';
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return fmtDate(iso);
}

function severityClass(change) {
  const sig = change.significance ?? 0;
  if (sig >= 0.8) return 'status-failed';
  if (sig >= 0.5) return 'status-running';
  if (sig >= 0.25) return 'status-queued';
  return 'status-completed';
}

async function monitoringView() {
  const data = await api(`/workspaces/${wsId}/monitoring`);
  const pages = await api(`/workspaces/${wsId}/pages`);
  const byPage = {};
  for (const p of pages.pages) (byPage[p.website_id] = byPage[p.website_id] || []).push(p);

  const frequencies = data.frequencies || [];
  const siteCards = data.websites.filter((w) => w.kind !== 'original' || w.monitor_enabled).map((w) => {
    const sitePages = byPage[w.id] || [];
    return `
    <div class="card" style="margin-bottom:16px;">
      <div class="page-head" style="margin-bottom:8px;">
        <div>
          <h3 style="margin-bottom:2px;">${esc(w.label || w.submitted_url)}</h3>
          <div class="small muted">${esc(hostOf(w.submitted_url))} &middot;
            ${w.monitor_enabled ? `<span class="badge status-completed">monitoring</span> every ${esc(String(w.frequency_hours || '-'))}h` : '<span class="badge">not monitored</span>'}
            ${w.page_count ? `&middot; ${w.page_count} page(s)` : ''}
            ${w.changes_7d ? `&middot; ${w.changes_7d} change(s) in 7 days` : ''}
          </div>
        </div>
        <div style="display:flex; gap:8px; align-items:center;">
          <select data-freq="${esc(w.id)}" style="width:auto;">
            ${frequencies.map((f) => `<option value="${f}" ${Number(w.frequency_hours) === f ? 'selected' : ''}>every ${f}h</option>`).join('')}
          </select>
          <button class="btn sm ${w.monitor_enabled ? 'secondary' : ''}" data-monitor="${esc(w.id)}" data-enable="${w.monitor_enabled ? '0' : '1'}">
            ${w.monitor_enabled ? 'Pause monitoring' : 'Start monitoring'}
          </button>
        </div>
      </div>
      ${w.baseline_status === 'failed' ? `<div class="notice warn">Baseline failed: ${esc(w.baseline_error || 'the page could not be read')}</div>` : ''}
      ${w.baseline_status === 'created' ? `<p class="small muted">Baseline captured ${fmtDate(w.baseline_at)}. Changes are compared against the last valid snapshot.</p>` : ''}
      ${sitePages.length === 0
        ? '<p class="small muted">No pages registered yet. Start monitoring to discover pricing, signup and feature pages automatically.</p>'
        : `<table><thead><tr><th>Page</th><th>Role</th><th>Status</th><th>Last checked</th><th>Next check</th><th></th></tr></thead><tbody>
          ${sitePages.map((pg) => `<tr>
            <td><div class="url-cell" title="${esc(pg.url)}">${esc(pg.url)}</div>${pg.label ? `<div class="small muted">${esc(pg.label)}</div>` : ''}</td>
            <td><span class="badge">${esc(pg.role)}</span></td>
            <td><span class="badge ${pg.last_status === 'failed' ? 'status-failed' : pg.last_status === 'changed' ? 'status-running' : 'status-completed'}">${esc(pg.last_status || 'pending')}</span>
              ${pg.has_baseline ? '' : '<div class="small muted">no baseline</div>'}
              ${pg.last_error ? `<div class="small" style="color:var(--danger)">${esc(pg.last_error.slice(0, 70))}</div>` : ''}</td>
            <td class="muted small">${relTime(pg.last_checked_at)}</td>
            <td class="muted small">${pg.enabled ? relTime(pg.next_check_at) : 'paused'}</td>
            <td style="text-align:right; white-space:nowrap;">
              <button class="btn ghost sm" data-check="${esc(pg.id)}">Check now</button>
              <button class="btn ghost sm" data-page-toggle="${esc(pg.id)}" data-enabled="${pg.enabled ? '0' : '1'}">${pg.enabled ? 'Disable' : 'Enable'}</button>
            </td></tr>`).join('')}
        </tbody></table>`}
      <form data-add-page="${esc(w.id)}" style="margin-top:12px; display:flex; gap:8px; flex-wrap:wrap;">
        <input placeholder="https://${esc(hostOf(w.submitted_url))}/changelog" style="flex:1 1 260px;" aria-label="Page URL to add">
        <select aria-label="Page role" style="width:auto;">
          ${(pages.roles || []).map((r) => `<option value="${r}">${r}</option>`).join('')}
        </select>
        <button class="btn secondary sm" type="submit">Add page</button>
      </form>
    </div>`;
  }).join('');

  return `
  <div class="page-head">
    <div><h1>Monitoring</h1><p>Competitor pages are re-fetched on a schedule and compared with their last valid snapshot.</p></div>
    <button class="btn" id="runChecksBtn">Run due checks now</button>
  </div>
  <div class="grid cols-3" style="margin-bottom:16px;">
    <div class="stat"><div class="lbl">Checks due now</div><div class="num">${data.due_checks}</div><div class="sub">${data.due_checks ? 'The scheduler picks these up on its next tick' : 'Everything is up to date'}</div></div>
    <div class="stat"><div class="lbl">Monitored websites</div><div class="num">${data.websites.filter((w) => w.monitor_enabled).length}</div></div>
    <div class="stat"><div class="lbl">Failing pages</div><div class="num">${data.websites.reduce((n, w) => n + (w.failing_pages || 0), 0)}</div><div class="sub">Fetches that did not return readable content</div></div>
  </div>
  ${siteCards || emptyState('globe', 'Nothing to monitor yet', 'Add a competitor website first, then start monitoring it.')}`;
}

async function changesView() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const limit = 25;
  const offset = Number(q.get('offset')) || 0;
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  const sites = await api(`/workspaces/${wsId}/websites`);
  for (const key of ['website_id', 'category', 'status']) {
    if (q.get(key)) params.set(key, q.get(key));
  }
  const data = await api(`/workspaces/${wsId}/changes?${params.toString()}`);

  const rows = data.changes.map((c) => `
    <tr class="clickable" data-change="${esc(c.id)}">
      <td><div class="small"><strong>${esc(c.website_label || hostOf(c.website_url))}</strong></div>
          <div class="url-cell small muted" title="${esc(c.page_url)}">${esc(c.page_url)}</div></td>
      <td><span class="badge ${severityClass(c)}">${esc(CATEGORY_LABELS[c.category] || c.category)}</span></td>
      <td class="small">${esc(c.summary)}</td>
      <td><span class="badge ${c.status === 'open' ? 'status-running' : 'status-completed'}">${esc(c.status)}</span></td>
      <td class="muted small" title="${esc(fmtDate(c.detected_at))}">${relTime(c.detected_at)}</td>
    </tr>`).join('');

  const pageLink = (nextOffset) => {
    const p = new URLSearchParams(q.toString());
    p.set('offset', String(nextOffset));
    return '#/changes?' + p.toString();
  };

  return `
  <div class="page-head">
    <div><h1>Changelog</h1><p>Every detected difference, with both snapshots kept.</p></div>
    <a class="btn secondary" href="#/monitoring">Monitoring settings</a>
  </div>
  <div class="card" style="margin-bottom:16px;">
    <div class="grid cols-4">
      <div class="field"><label for="cf_site">Website</label>
        <select id="cf_site"><option value="">All</option>
          ${sites.websites.filter((w) => w.kind !== 'original').map((w) => `<option value="${esc(w.id)}" ${q.get('website_id') === w.id ? 'selected' : ''}>${esc(w.label || hostOf(w.url))}</option>`).join('')}
        </select></div>
      <div class="field"><label for="cf_cat">Category</label>
        <select id="cf_cat"><option value="">All</option>
          ${Object.entries(CATEGORY_LABELS).map(([k, v]) => `<option value="${k}" ${q.get('category') === k ? 'selected' : ''}>${v}</option>`).join('')}
        </select></div>
      <div class="field"><label for="cf_status">Review state</label>
        <select id="cf_status"><option value="">All</option>
          ${['open', 'acknowledged', 'dismissed'].map((v) => `<option value="${v}" ${q.get('status') === v ? 'selected' : ''}>${v}</option>`).join('')}
        </select></div>
      <div class="field"><label>&nbsp;</label>
        <div style="display:flex; gap:8px;">
          <button class="btn sm" id="cfApply">Apply</button>
          <a class="btn ghost sm" href="#/changes">Clear</a>
        </div></div>
    </div>
  </div>
  ${data.changes.length === 0 ? emptyState('doc', 'No changes recorded yet',
      'Once a monitored page differs from its last valid snapshot, the difference is recorded here with both versions.')
    : `<div class="card" style="padding:0; overflow-x:auto;">
      <table><thead><tr><th>Competitor / page</th><th>Category</th><th>What changed</th><th>State</th><th>Detected</th></tr></thead>
      <tbody>${rows}</tbody></table>
    </div>
    <div style="display:flex; justify-content:space-between; align-items:center; margin-top:12px;">
      <span class="small muted">Showing ${offset + 1}-${offset + data.changes.length} of ${data.total}</span>
      <span style="display:flex; gap:8px;">
        ${offset > 0 ? `<a class="btn ghost sm" href="${pageLink(Math.max(0, offset - limit))}">Previous</a>` : ''}
        ${data.has_more ? `<a class="btn secondary sm" href="${pageLink(offset + limit)}">Next</a>` : ''}
      </span>
    </div>`}`;
}

function evidenceBlock(detail) {
  const change = detail.change;
  const ev = change.evidence || {};
  if (ev.kind === 'pricing') {
    const row = (p, cls) => `<tr class="${cls}"><td>${esc(p.name || 'unnamed plan')}</td>
      <td class="num">${p.amount === null || p.amount === undefined ? '-' : esc(String(p.amount))}</td>
      <td>${esc(p.currency || '')}</td><td>${esc(p.interval || '-')}</td>
      <td class="small">${esc((p.limits || []).join('; ') || '-')}</td>
      <td><span class="badge">${esc(p.confidence || 'n/a')}</span></td></tr>`;
    const changed = (ev.changed || []).map((c) => `<tr><td>${esc(c.previous.name || '-')}</td>
      <td class="num">${esc(String(c.previous.amount))} &rarr; ${esc(String(c.current.amount))}</td>
      <td>${esc(c.current.currency || '')}</td><td>${esc(c.current.interval || '-')}</td>
      <td class="small">${esc((c.current.limits || []).join('; ') || '-')}</td><td><span class="badge status-running">changed</span></td></tr>`).join('');
    return `<h4>Plan comparison</h4>
      <table><thead><tr><th>Plan</th><th>Price</th><th>Currency</th><th>Interval</th><th>Limits</th><th>Confidence</th></tr></thead>
      <tbody>${changed}${(ev.added || []).map((p) => row(p, '')).join('')}${(ev.removed || []).map((p) => row(p, 'dim')).join('')}</tbody></table>
      <p class="small muted" style="margin-top:8px;">${esc(ev.note || '')}</p>`;
  }
  if (ev.kind === 'forms') {
    return `<h4>Form fields</h4>
      ${(ev.addedFields || []).length ? `<p class="small">Added: ${ev.addedFields.map((f) => `<code>${esc(f)}</code>`).join(', ')}</p>` : ''}
      ${(ev.removedFields || []).length ? `<p class="small">Removed: ${ev.removedFields.map((f) => `<code>${esc(f)}</code>`).join(', ')}</p>` : ''}
      ${!(ev.addedFields || []).length && !(ev.removedFields || []).length ? '<p class="small muted">The form target or submit label changed.</p>' : ''}`;
  }
  if (ev.kind === 'text') {
    const list = (items, cls, label) => (items && items.length)
      ? `<h4>${label}</h4><ul class="evidence-list ${cls}">${items.slice(0, 20).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '';
    return `${list(ev.addedSentences, 'added', 'Added')}${list(ev.removedSentences, 'removed', 'Removed')}
      ${ev.note ? `<p class="small muted">${esc(ev.note)}</p>` : ''}`;
  }
  if (ev.kind === 'items') {
    const list = (items, cls, label, fmt) => (items && items.length)
      ? `<h4>${label}</h4><ul class="evidence-list ${cls}">${items.slice(0, 15).map((i) => `<li>${esc(fmt(i))}</li>`).join('')}</ul>` : '';
    const fmt = (i) => (typeof i === 'string' ? i : i.text || i.href || i.src || i.heading || JSON.stringify(i));
    return `${list(ev.added, 'added', 'Added', fmt)}${list(ev.removed, 'removed', 'Removed', fmt)}`;
  }
  return '';
}

async function changeDetailView(id) {
  const detail = await api(`/workspaces/${wsId}/changes/${encodeURIComponent(id)}`);
  const c = detail.change;
  const snapCard = (snap, label) => snap ? `
    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:baseline;">
        <h3>${label}</h3>
        <span class="small muted">${fmtDate(snap.fetched_at)}</span>
      </div>
      <p class="small muted" style="margin:0 0 8px;">${esc(snap.final_url)} &middot; HTTP ${esc(String(snap.http_status))} &middot; ${esc(String(snap.word_count))} words &middot; capture: ${esc(snap.capture_status)}</p>
      ${snap.redirect_chain && snap.redirect_chain.length ? `<p class="small muted">Redirects: ${snap.redirect_chain.map((r) => esc(r)).join(' &rarr; ')}</p>` : ''}
      <details><summary class="small">Prices found on this snapshot (${(snap.pricing || []).length})</summary>
        ${(snap.pricing || []).length ? `<table><thead><tr><th>Plan</th><th>Price</th><th>Interval</th><th>Confidence</th></tr></thead><tbody>
          ${snap.pricing.map((p) => `<tr><td>${esc(p.name || '-')}</td><td class="num">${esc(String(p.amount))}</td><td>${esc(p.interval || '-')}</td><td>${esc(p.confidence)}</td></tr>`).join('')}
        </tbody></table>` : '<p class="small muted">No structured prices could be read from this snapshot.</p>'}
      </details>
    </div>` : '';

  return `
  <div class="page-head">
    <div>
      <p class="small muted" style="margin:0;"><a href="#/changes">&larr; Changelog</a></p>
      <h1 style="margin-top:6px;">${esc(CATEGORY_LABELS[c.category] || c.category)} change</h1>
      <p>${esc(c.website_label || hostOf(c.website_url))} &middot; ${esc(c.page_url)}</p>
    </div>
    <div style="display:flex; gap:8px;">
      <select id="changeStatus" data-id="${esc(c.id)}" style="width:auto;">
        ${['open', 'acknowledged', 'dismissed'].map((v) => `<option value="${v}" ${c.status === v ? 'selected' : ''}>${v}</option>`).join('')}
      </select>
    </div>
  </div>
  <div class="card" style="margin-bottom:16px;">
    <p style="margin:0 0 10px; font-size:15px;">${esc(c.summary)}</p>
    <div class="small muted">
      Detected ${fmtDate(c.detected_at)} &middot; significance ${Math.round((c.significance || 0) * 100)}% (${esc(c.significance_label || '')}) &middot;
      confidence ${esc(c.confidence || 'n/a')}
    </div>
    <p class="small muted" style="margin-top:10px;">Evidence comes from two saved snapshots of a public page. This is an observed difference, not a legal conclusion.</p>
  </div>
  <div class="card" style="margin-bottom:16px;">
    ${evidenceBlock(detail) || '<p class="small muted">No structured evidence is attached to this entry.</p>'}
  </div>
  <div class="grid cols-2">
    ${snapCard(detail.previousSnapshot, 'Before')}
    ${snapCard(detail.currentSnapshot, 'After')}
  </div>
  <div class="card" style="margin-top:16px;">
    <h3>Text comparison</h3>
    <div class="grid cols-2">
      <div><h4 class="small muted">Before (${(c.previous_value || '').length} chars)</h4>
        <pre class="snapshot-text">${esc(normaliseForDisplay(detail.previousText || c.previous_value || 'No text stored.'))}</pre></div>
      <div><h4 class="small muted">After (${(c.current_value || '').length} chars)</h4>
        <pre class="snapshot-text">${esc(normaliseForDisplay(detail.currentText || c.current_value || 'No text stored.'))}</pre></div>
    </div>
  </div>`;
}

function normaliseForDisplay(text) {
  const s = String(text || '');
  return s.length > 6000 ? s.slice(0, 6000) + '\n… (truncated for display)' : s;
}

async function alertsView() {
  const data = await api(`/workspaces/${wsId}/alerts?limit=50`);
  const rows = data.alerts.map((a) => `
    <tr>
      <td><span class="badge ${a.severity === 'critical' ? 'status-failed' : a.severity === 'high' ? 'status-running' : 'status-queued'}">${esc(a.severity)}</span></td>
      <td><div class="small"><strong>${esc(a.title)}</strong></div>
          ${a.summary ? `<div class="small muted">${esc(a.summary.slice(0, 160))}</div>` : ''}
          ${a.change_id ? `<a class="small" href="#/changes/${esc(a.change_id)}">Open changelog entry</a>` : ''}</td>
      <td class="muted small">${relTime(a.created_at)}</td>
      <td style="text-align:right; white-space:nowrap;">
        ${a.status === 'unread' ? `<button class="btn ghost sm" data-alert-read="${esc(a.id)}">Mark read</button>` : `<span class="badge status-completed">${esc(a.status)}</span>`}
        ${a.status !== 'dismissed' ? `<button class="btn ghost sm" data-alert-dismiss="${esc(a.id)}">Dismiss</button>` : ''}
      </td>
    </tr>`).join('');

  return `
  <div class="page-head">
    <div><h1>Alerts</h1><p>High-signal changes, each linked to the evidence that produced it.</p></div>
    <button class="btn secondary" id="readAllBtn">Mark all read</button>
  </div>
  ${data.total === 0 ? emptyState('bolt', 'No alerts yet',
      'Alerts appear when a monitored page changes meaningfully. Dismissing one keeps it out of emails and the digest.')
    : `<div class="card" style="padding:0; overflow-x:auto;">
      <table><thead><tr><th>Severity</th><th>Alert</th><th>When</th><th></th></tr></thead><tbody>${rows}</tbody></table>
    </div>`}`;
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
    await loadAuthCfg();   // the sign-in screen states whether verification is on
    root.innerHTML = authView(hash.startsWith('#/signup') ? 'signup' : 'signin');
    elid('authForm').addEventListener('submit', (e) => handleAuthForm(e, hash.startsWith('#/signup') ? 'signup' : 'signin'));
    return;
  }

  let content = loading();
  root.innerHTML = shell(content, hash);
  bindShell();

  try {
    if (hash.startsWith('#/verify-failed')) {
      const reason = new URLSearchParams(hash.split('?')[1] || '').get('reason') || 'invalid';
      root.innerHTML = verifyFailedView(reason);
      return;
    }
    if (hash.startsWith('#/changes/')) {
      content = await changeDetailView(decodeURIComponent(hash.slice('#/changes/'.length).split('?')[0]));
    } else if (hash.startsWith('#/changes')) {
      content = await changesView();
    } else if (hash.startsWith('#/alerts')) {
      content = await alertsView();
    } else if (hash.startsWith('#/monitoring')) {
      content = await monitoringView();
    } else if (hash.startsWith('#/results/')) {
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
  // ---- change monitoring ----
  const runChecks = elid('runChecksBtn');
  if (runChecks) runChecks.addEventListener('click', async () => {
    runChecks.disabled = true;
    runChecks.textContent = 'Running checks...';
    try {
      const { result } = await api(`/workspaces/${wsId}/monitoring/run`, { method: 'POST' });
      const m = result.monitor || {};
      toast(result.skipped
        ? `Another tick is already running (${result.reason}).`
        : `Checked ${m.checked || 0} page(s): ${m.changed || 0} changed, ${m.baselines || 0} new baselines, ${m.failed || 0} failed.`,
        result.skipped ? '' : 'success');
      render();
    } catch (err) {
      toast(err.message, 'error');
      runChecks.disabled = false;
      runChecks.textContent = 'Run due checks now';
    }
  });

  document.querySelectorAll('[data-monitor]').forEach((b) => b.addEventListener('click', async () => {
    const enable = b.dataset.enable === '1';
    const freqSel = document.querySelector(`[data-freq="${b.dataset.monitor}"]`);
    b.disabled = true;
    try {
      const body = enable
        ? { enabled: true, frequency_hours: Number(freqSel && freqSel.value) || undefined }
        : { enabled: false };
      const res = await api(`/workspaces/${wsId}/websites/${b.dataset.monitor}/monitor`, { method: 'POST', body });
      if (res.homepage_fetch_error) {
        toast(`Monitoring enabled, but the homepage could not be fetched: ${res.homepage_fetch_error}`, 'error');
      } else {
        toast(enable ? `Monitoring on: ${res.pages.length} page(s) registered.` : 'Monitoring paused.', 'success');
      }
      render();
    } catch (err) {
      toast(err.message, 'error');
      b.disabled = false;
    }
  }));

  document.querySelectorAll('[data-check]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    b.textContent = 'Checking...';
    try {
      const { result } = await api(`/workspaces/${wsId}/pages/${b.dataset.check}/check`, { method: 'POST' });
      const map = {
        baseline_created: 'Baseline created. Future checks compare against it.',
        unchanged: 'No change since the last snapshot.',
        changed: `${result.changes.length} change(s) recorded.`,
        failed: `Check failed: ${result.error}`
      };
      toast(map[result.status] || result.status, result.status === 'failed' ? 'error' : 'success');
      render();
    } catch (err) {
      toast(err.message, 'error');
      b.disabled = false;
      b.textContent = 'Check now';
    }
  }));

  document.querySelectorAll('[data-page-toggle]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await api(`/workspaces/${wsId}/pages/${b.dataset.pageToggle}`, { method: 'PATCH', body: { enabled: b.dataset.enabled === '1' } });
      render();
    } catch (err) { showError(err); }
  }));

  document.querySelectorAll('[data-add-page]').forEach((form) => form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = form.querySelector('input');
    const role = form.querySelector('select').value;
    if (!input.value.trim()) return;
    try {
      await api(`/workspaces/${wsId}/websites/${form.dataset.addPage}/pages`, { method: 'POST', body: { url: input.value.trim(), role } });
      toast('Page added. It gets a baseline on the next check.', 'success');
      render();
    } catch (err) { toast(err.message, 'error'); }
  }));

  document.querySelectorAll('[data-change]').forEach((tr) => tr.addEventListener('click', () => {
    location.hash = '#/changes/' + tr.dataset.change;
  }));
  const cfApply = elid('cfApply');
  if (cfApply) cfApply.addEventListener('click', () => {
    const p = new URLSearchParams();
    if (elid('cf_site').value) p.set('website_id', elid('cf_site').value);
    if (elid('cf_cat').value) p.set('category', elid('cf_cat').value);
    if (elid('cf_status').value) p.set('status', elid('cf_status').value);
    location.hash = '#/changes' + (p.toString() ? '?' + p.toString() : '');
  });
  const changeStatus = elid('changeStatus');
  if (changeStatus) changeStatus.addEventListener('change', async () => {
    try {
      await api(`/workspaces/${wsId}/changes/${changeStatus.dataset.id}`, { method: 'PATCH', body: { status: changeStatus.value } });
      toast('Review state updated.', 'success');
    } catch (err) { showError(err); }
  });

  // ---- alerts ----
  document.querySelectorAll('[data-alert-read]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await api(`/workspaces/${wsId}/alerts/${b.dataset.alertRead}`, { method: 'PATCH', body: { status: 'read' } });
      render();
    } catch (err) { showError(err); }
  }));
  document.querySelectorAll('[data-alert-dismiss]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await api(`/workspaces/${wsId}/alerts/${b.dataset.alertDismiss}`, { method: 'PATCH', body: { status: 'dismissed' } });
      toast('Alert dismissed. The change stays in the changelog.');
      render();
    } catch (err) { showError(err); }
  }));
  const readAll = elid('readAllBtn');
  if (readAll) readAll.addEventListener('click', async () => {
    try {
      const r = await api(`/workspaces/${wsId}/alerts/read-all`, { method: 'POST' });
      toast(`${r.updated} alert(s) marked read.`, 'success');
      render();
    } catch (err) { showError(err); }
  });

  // ---- notification preferences ----
  const notifForm = elid('notifForm');
  if (notifForm) notifForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = elid('notifError');
    errEl.textContent = '';
    try {
      await api(`/workspaces/${wsId}/notifications`, {
        method: 'PATCH',
        body: {
          immediate_email: elid('notifImmediate').checked,
          digest_enabled: elid('notifDigest').checked,
          digest_day: Number(elid('notifDay').value),
          digest_hour_utc: Number(elid('notifHour').value),
          min_severity: elid('notifSeverity').value,
          include_empty_digest: elid('notifEmpty').checked
        }
      });
      toast('Notification preferences saved.', 'success');
      render();
    } catch (err) { errEl.textContent = err.message; }
  });
  const testEmail = elid('testEmailBtn');
  if (testEmail) testEmail.addEventListener('click', async () => {
    testEmail.disabled = true;
    try {
      const r = await api(`/workspaces/${wsId}/notifications/test`, { method: 'POST' });
      toast(`Test email ${r.status} via ${r.provider}.`, 'success');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      testEmail.disabled = false;
    }
  });
  const resendVerify = elid('resendVerifyBtn');
  if (resendVerify) resendVerify.addEventListener('click', async () => {
    try {
      const r = await api('/auth/verify/resend', { method: 'POST', body: { email: me.user.email } });
      const t = deliveryToast(r.verification);
      toast(t.msg, t.kind);
    } catch (err) { toast(err.message, 'error'); }
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

// A verification link redirects to /app#/dashboard?verified=1
if (/[?&]verified=1/.test(location.hash)) {
  setTimeout(() => toast('Email confirmed. Your workspace is active.', 'success'), 400);
}
if (/[?&]oauth_error=/.test(location.hash)) {
  const reason = new URLSearchParams(location.hash.split('?')[1]).get('oauth_error');
  setTimeout(() => toast(`Google sign-in failed: ${String(reason).replace(/_/g, ' ')}`, 'error'), 400);
}

// Service worker (offline shell is optional; failure is harmless).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* offline shell optional */ });
  });
}

render();
