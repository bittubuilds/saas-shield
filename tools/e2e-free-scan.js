// Real end-to-end: two controlled local sites, the app itself, and the browser.
const http = require('http');
const puppeteer = require('/tmp/shot/node_modules/puppeteer-core');
const APP = 'http://127.0.0.1:46600';
const COPY = 'Our logistics platform gives warehouse teams a live tracking timeline for every shipment. Predictive arrival windows alert the right operator before a dock is blocked, and every handoff is written to an audit trail that survives weather delays and carrier changes. Forty percent fewer support tickets, thirty percent faster dock turnaround, and one honest schedule for the whole yard.';
const page = (t, b) => `<!DOCTYPE html><html><head><title>${t}</title></head><body>${b}</body></html>`;
const filler = (n, p) => Array.from({ length: n }, (_, i) => `${p}${i}`).join(' ');
function site(routes) {
  return new Promise((r) => {
    const s = http.createServer((q, res) => {
      const h = routes[q.url];
      res.setHeader('content-type', q.url.endsWith('.xml') ? 'application/xml' : 'text/html');
      if (h) return res.end(h);
      res.statusCode = 404; res.end('nope');
    });
    s.listen(0, '127.0.0.1', () => r({ s, port: s.address().port }));
  });
}
async function j(path, opts = {}) {
  const r = await fetch(APP + '/api' + path, opts);
  let d = {};
  try { d = await r.json(); } catch { /* empty */ }
  return { status: r.status, d, cookie: r.headers.get('set-cookie') };
}
(async () => {
  const A = await site({ '/robots.txt': 'User-agent: *\nAllow: /', '/': page('Acme', `<p>${COPY}</p><p>${filler(180, 'a')}</p>`) });
  const B = await site({ '/robots.txt': 'User-agent: *\nAllow: /', '/': page('Copy', `<p>${COPY}</p><p>${filler(180, 'b')}</p>`) });
  const su = await j('/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `e2e-${Date.now()}@example.test`, password: 'E2e!pass12345', workspace_name: 'E2E' }) });
  const ck = String(su.cookie || '').split(';')[0];
  const H = { cookie: ck, 'content-type': 'application/json' };
  const me = await j('/me', { headers: H });
  const ws = (me.d.workspaces || [{}])[0].id;
  const s1 = await j(`/workspaces/${ws}/websites`, { method: 'POST', headers: H, body: JSON.stringify({ url: `http://127.0.0.1:${A.port}/`, kind: 'original' }) });
  console.log('add own site  ->', s1.status, JSON.stringify(s1.d.initial_scan));
  const s2 = await j(`/workspaces/${ws}/websites`, { method: 'POST', headers: H, body: JSON.stringify({ url: `http://127.0.0.1:${B.port}/`, kind: 'comparison', label: 'Copy site' }) });
  console.log('add competitor->', s2.status, JSON.stringify(s2.d.initial_scan));
  let st = null;
  for (let i = 0; i < 70; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    st = (await j(`/workspaces/${ws}/websites/${s2.d.website.id}/initial-scan`, { headers: H })).d;
    if (st.scan && ['completed', 'failed'].includes(st.scan.status)) break;
  }
  console.log('final status  ->', JSON.stringify(st));
  const res = await j(`/workspaces/${ws}/results`, { headers: H });
  const one = (res.d.results || [])[0];
  console.log('findings      ->', (res.d.results || []).length, one ? JSON.stringify({ score: one.score, method: one.match_type, excerpt_chars: (one.excerpt || '').length }) : 'none');
  const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const pg = await b.newPage();
  await pg.setViewport({ width: 1440, height: 950 });
  await pg.setCookie({ name: ck.split('=')[0], value: ck.split('=')[1], domain: '127.0.0.1', path: '/' });
  await pg.goto(APP + '/app#/results', { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 1500));
  await pg.screenshot({ path: '/tmp/shots/e2e-findings.png' });
  console.log('rows rendered ->', await pg.evaluate(() => document.querySelectorAll('tbody tr').length));
  await b.close(); A.s.close(); B.s.close();
})().catch((e) => { console.error('E2E ERROR:', e.message); process.exit(1); });
