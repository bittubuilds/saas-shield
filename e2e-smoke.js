// End-to-end HTTP smoke test: real signup -> verification -> monitor -> change -> alert.
// Uses a local fixture competitor site. Not part of `npm test`; run with: node e2e-smoke.js
const http = require('http');

const fixture = { home: '', pricing: '' };
const ok = (c, m, extra = '') => { console.log((c ? 'PASS ' : 'FAIL ') + m + (extra ? ' -> ' + extra : '')); if (!c) process.exitCode = 1; };

function startFixture() {
  const srv = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/robots.txt') { res.setHeader('content-type', 'text/plain'); return res.end('User-agent: *\nAllow: /\n'); }
    const body = url === '/pricing' ? fixture.pricing : fixture.home;
    if (url !== '/' && url !== '/pricing') { res.statusCode = 404; return res.end('nope'); }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(body);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

(async () => {
  const fix = await startFixture();
  const fixUrl = `http://127.0.0.1:${fix.address().port}`;
  fixture.home = `<!doctype html><html><head><title>Rival CRM</title></head><body>
    <nav><a href="/pricing">Pricing</a></nav>
    <main><h1>Rival CRM for revenue teams</h1>
    <p>Rival CRM keeps pipeline review fast. Every deal gets a next step, and forecast rolls up weekly.</p>
    </main></body></html>`;
  fixture.pricing = `<html><head><title>Pricing</title></head><body><main>
    <h1>Pricing</h1><h2>Starter</h2><p>$19 per month</p><p>Up to 3 seats</p>
    <h2>Pro</h2><p>$29 per month</p><p>Up to 10 seats</p>
    </main></body></html>`;

  process.env.DATABASE_FILE = '/tmp/e2e-' + Date.now() + '.db';
  process.env.PORT = '3998';
  process.env.NODE_ENV = 'development';
  process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:3998';
  process.env.AUTH_DEV_EXPOSE_LINK = 'true';
  process.env.SHIELD_ALLOW_PRIVATE_IPS = 'true';
  process.env.ENABLE_INTERNAL_SCHEDULER = 'false';

  const { server } = require('./src/server');
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  const api = 'http://127.0.0.1:3998/api';

  let cookie = null;
  const req = async (method, path, body) => {
    const res = await fetch(api + path, {
      method, redirect: 'manual',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of sc) if (c.startsWith('shield_session=') && !/^shield_session=;/.test(c)) cookie = c.split(';')[0];
    let data = {}; try { data = await res.json(); } catch { }
    return { status: res.status, data, headers: res.headers };
  };

  // 1. signup + verification
  const su = await req('POST', '/auth/signup', { email: 'e2e@example.com', password: 'correcthorse1', workspace_name: 'E2E Co' });
  ok(su.status === 201 && !cookie, 'signup creates account without a session', 'status ' + su.status);
  const devLink = su.data.verification && su.data.verification.dev_link;
  ok(!!devLink, 'verification link generated', devLink ? 'ok' : 'missing');
  const path = new URL(devLink).pathname.replace(/^\/api/, '') + new URL(devLink).search;
  const vres = await fetch(api + path, { redirect: 'manual' });
  for (const c of (vres.headers.getSetCookie ? vres.headers.getSetCookie() : [])) if (c.startsWith('shield_session=')) cookie = c.split(';')[0];
  ok(vres.status === 303 && cookie, 'magic link verifies and starts a session', 'status ' + vres.status);

  const me = await req('GET', '/me');
  ok(me.status === 200 && Array.isArray(me.data.workspaces), 'session resolves to a workspace',
    'status ' + me.status + ' keys ' + Object.keys(me.data || {}).join(','));
  const ws = (me.data.workspaces || [])[0] && me.data.workspaces[0].id;
  ok(me.data.user.email_verified === true, 'account is verified');

  // 2. website + monitoring
  const site = await req('POST', `/workspaces/${ws}/websites`, { url: fixUrl + '/', kind: 'comparison', label: 'Rival' });
  ok(site.status === 201, 'competitor website added', 'status ' + site.status + ' ' + JSON.stringify(site.data.error || ''));
  const siteId = site.data.website.id;

  const mon = await req('POST', `/workspaces/${ws}/websites/${siteId}/monitor`, { enabled: true, frequency_hours: 1 });
  ok(mon.data.ok === true, 'monitoring enabled', JSON.stringify(mon.data.error || ''));
  const pages = mon.data.pages || [];
  ok(pages.length >= 2, 'pages discovered automatically', pages.map((p) => p.role).join(','));
  const pricing = pages.find((p) => p.url.endsWith('/pricing')) || pages[0];

  const c1 = await req('POST', `/workspaces/${ws}/pages/${pricing.id}/check`);
  ok(c1.data.result.status === 'baseline_created', 'baseline created', c1.data.result.status);

  const c2 = await req('POST', `/workspaces/${ws}/pages/${pricing.id}/check`);
  ok(c2.data.result.status === 'unchanged', 'unchanged scan reports no change', c2.data.result.status);

  // 3. real change
  fixture.pricing = fixture.pricing.replace('$29 per month', '$39 per month');
  const c3 = await req('POST', `/workspaces/${ws}/pages/${pricing.id}/check`);
  ok(c3.data.result.status === 'changed', 'price change detected', c3.data.result.status + ' ' + JSON.stringify(c3.data.result.error || ''));

  const changes = await req('GET', `/workspaces/${ws}/changes`);
  const pricingChange = (changes.data.changes || []).find((c) => c.category === 'pricing');
  ok(!!pricingChange, 'changelog row stored', String(changes.data.total));
  if (pricingChange) ok(/29/.test(pricingChange.summary) && /39/.test(pricingChange.summary), 'summary quotes both prices', pricingChange.summary);

  const detail = await req('GET', `/workspaces/${ws}/changes/${pricingChange.id}`);
  ok(detail.data.previousText && detail.data.currentText, 'detail returns both snapshots');

  const alerts = await req('GET', `/workspaces/${ws}/alerts`);
  ok((alerts.data.alerts || []).length >= 1, 'alert raised for the change', String((alerts.data.alerts || []).length));

  const settings = await req('GET', `/workspaces/${ws}/settings`);
  ok(settings.data.notifications && settings.data.email, 'settings expose notification prefs and provider state');
  ok(settings.data.email.configured === false, 'no provider is reported honestly');

  // 4. workspace isolation on the new endpoints
  cookie = null;
  const su2 = await req('POST', '/auth/signup', { email: 'other@example.com', password: 'correcthorse1', workspace_name: 'Other Co' });
  const l2 = new URL(su2.data.verification.dev_link).pathname.replace(/^\/api/, '') + new URL(su2.data.verification.dev_link).search;
  const v2 = await fetch(api + l2, { redirect: 'manual' });
  for (const c of (v2.headers.getSetCookie ? v2.headers.getSetCookie() : [])) if (c.startsWith('shield_session=')) cookie = c.split(';')[0];
  const leak1 = await req('GET', `/workspaces/${ws}/changes`);
  const leak2 = await req('GET', `/workspaces/${ws}/alerts`);
  const leak3 = await req('GET', `/workspaces/${ws}/pages`);
  ok([leak1, leak2, leak3].every((r) => r.status === 404), 'other workspace data is not reachable', [leak1.status, leak2.status, leak3.status].join(','));

  fix.close(); server.close();
  console.log(process.exitCode ? '\nSMOKE FAILED' : '\nSMOKE OK');
  setTimeout(() => process.exit(process.exitCode || 0), 200);
})().catch((e) => { console.error('SMOKE ERROR', e); process.exit(1); });
