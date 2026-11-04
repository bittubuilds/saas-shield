'use strict';
// Review probe for the one-time scan branch. Boots the app against a scratch
// database, stands up controlled fixture sites, and checks the six review items.
// Prints JSON so the results can be quoted directly.
const http = require('http');

const PORT = process.env.PROBE_PORT || '46700';
const BASE = `http://127.0.0.1:${PORT}/api`;

function site(routes) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const r = routes[req.url.split('?')[0]];
      if (!r) { res.statusCode = 404; res.end('not found'); return; }
      res.setHeader('content-type', r.type || 'text/html');
      res.end(r.body);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

const TEXT = 'Our platform helps logistics teams coordinate warehouse operations in real time. '
  + 'Every shipment gets a live tracking timeline, predictive arrival windows and automated '
  + 'exception alerts routed to the right operator. Customers report fewer support tickets and '
  + 'faster dock turnaround with a complete audit trail of every handoff between carriers. '
  + 'The engine models each facility as a graph of dock doors, staging lanes and commitments.';

const page = (t) => `<!DOCTYPE html><html><head><title>${t}</title></head><body><p>${TEXT}</p></body></html>`;

async function api(path, opts = {}, cookie) {
  const res = await fetch(BASE + path, {
    method: opts.method || 'GET',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}

async function main() {
  const orig = await site({
    '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nAllow: /\n' },
    '/sitemap.xml': { type: 'application/xml', body: '<?xml version="1.0"?><urlset><url><loc>PLACEHOLDER</loc></url></urlset>' },
    '/': { body: page('Home') }
  });
  const copycat = await site({ '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nAllow: /\n' }, '/': { body: page('Copy') } });
  const emptySitemap = await site({ '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nAllow: /\n' }, '/sitemap.xml': { type: 'application/xml', body: '<?xml version="1.0"?><urlset></urlset>' }, '/': { body: page('Empty sitemap') } });

  const out = {};

  // ---- two workspaces, isolated users
  const a = await api('/auth/signup', { method: 'POST', body: { email: `probe-a-${Date.now()}@example.test`, password: 'Probe!pass1234', workspace_name: 'A' } });
  const b = await api('/auth/signup', { method: 'POST', body: { email: `probe-b-${Date.now()}@example.test`, password: 'Probe!pass1234', workspace_name: 'B' } });
  const wsA = a.data.workspace.id;
  const wsB = b.data.workspace.id;

  // ---- 1. duplicate detection across URL spellings
  const base = `http://127.0.0.1:${orig.address().port}`;
  const variants = [base + '/', base, base + '/?utm=1', base.toUpperCase().replace('HTTP://', 'http://')];
  const dupeResults = [];
  for (const v of variants) {
    const r = await api(`/workspaces/${wsA}/websites`, { method: 'POST', body: { url: v, kind: 'original', auto_scan: false } }, a.cookie);
    dupeResults.push({ url: v.replace(base, '<base>'), status: r.status });
  }
  const wwwVariant = await api(`/workspaces/${wsA}/websites`, { method: 'POST', body: { url: base.replace('127.0.0.1', 'www.127.0.0.1'), kind: 'original', auto_scan: false } }, a.cookie);
  out.duplicates = { same_url_variants: dupeResults, www_variant_status: wwwVariant.status };

  // ---- 3a. invalid URL
  const invalid = await api(`/workspaces/${wsA}/websites`, { method: 'POST', body: { url: 'not a url', kind: 'comparison', auto_scan: false } }, a.cookie);
  out.invalid_url = { status: invalid.status, message: invalid.data.error };

  // ---- 3b. missing discovery provider on the only site
  out.no_provider = a.data.initial_scan;

  // ---- 5. same site cannot be its own competitor
  const selfPair = await api(`/workspaces/${wsA}/websites`, { method: 'POST', body: { url: base + '/', kind: 'comparison' } }, a.cookie);
  out.same_site_pairing = { status: selfPair.status, mode: selfPair.data.initial_scan && selfPair.data.initial_scan.mode, message: (selfPair.data.initial_scan || {}).message };

  // ---- 2. concurrency: two competitors at the same moment, different domains
  const c1 = `http://127.0.0.1:${copycat.address().port}`;
  const c2 = `http://127.0.0.1:${emptySitemap.address().port}`;
  const [r1, r2] = await Promise.all([
    api(`/workspaces/${wsA}/websites`, { method: 'POST', body: { url: c1, kind: 'comparison' } }, a.cookie),
    api(`/workspaces/${wsA}/websites`, { method: 'POST', body: { url: c2, kind: 'comparison' } }, a.cookie)
  ]);
  await new Promise((r) => setTimeout(r, 2500));
  const siteA = (await api(`/workspaces/${wsA}/websites`, {}, a.cookie)).data.websites;
  const scansList = (await api(`/workspaces/${wsA}/scans`, {}, a.cookie));
  out.concurrency = {
    add_statuses: [r1.status, r2.status],
    modes: [(r1.data.initial_scan || {}).mode, (r2.data.initial_scan || {}).mode],
    scan_jobs_created: Array.isArray(scansList.data.scans) ? scansList.data.scans.length : scansList.status,
    websites: siteA.map((w) => ({ kind: w.kind, crawl_status: w.crawl_status }))
  };

  // ---- 3c. empty sitemap + unreachable competitor handled honestly
  const firstScan = (scansList.data.scans || [])[0] || null;
  out.failure_modes = { first_scan_status: firstScan && firstScan.status, first_scan_findings: firstScan && firstScan.findings };

  // ---- 4. cross-workspace isolation
  const target = siteA[siteA.length - 1];
  const crossStatus = await api(`/workspaces/${wsB}/websites/${target.id}/initial-scan`, {}, b.cookie);
  const crossFindings = await api(`/workspaces/${wsB}/results`, {}, b.cookie);
  const crossSitePatch = await api(`/workspaces/${wsB}/websites/${target.id}`, { method: 'PATCH', body: { label: 'hijack' } }, b.cookie);
  out.isolation = {
    status_endpoint: crossStatus.status,
    findings_visible_in_other_workspace: (crossFindings.data.results || []).length,
    patch_other_workspace_site: crossSitePatch.status
  };

  // ---- 6. restart consistency: same rows/status after the server is restarted
  const before = await api(`/workspaces/${wsA}/websites/${target.id}/initial-scan`, {}, a.cookie);
  out.restart = { before: { scan_status: before.data.scan && before.data.scan.status, done: before.data.done, findings: before.data.findings_total }, note: 'caller restarts the server and re-reads' };
  require('fs').writeFileSync('/tmp/probe-handoff.json', JSON.stringify({ cookie: a.cookie, ws: wsA, site: target.id }));

  console.log(JSON.stringify(out, null, 1));
  process.exit(0);
}

main().catch((e) => { console.error('probe failed:', e.message); process.exit(1); });
