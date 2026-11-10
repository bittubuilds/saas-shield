const { chromium } = require('playwright');
(async () => {
  const ctx = await (await chromium.launch()).newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  await ctx.request.post('http://localhost:3105/api/auth/signup', { data: { email: `of-${Date.now()}@example.com`, password: 'LocalOnly!2026', name: 'OF' } });
  await p.goto('http://localhost:3105/app', { waitUntil: 'networkidle' });
  await p.waitForTimeout(700);
  console.log(JSON.stringify(await p.evaluate(() => {
    const info = (s) => { const e = document.querySelector(s); if (!e) return null; const c = getComputedStyle(e); const r = e.getBoundingClientRect(); return { top: Math.round(r.top), pt: c.paddingTop, mt: c.marginTop, h: Math.round(r.height) }; };
    return { shell: info('.shell'), main: info('.main'), db: info('.db'), hero: info('.db-hero'),
             firstChildOfMain: document.querySelector('.main').firstElementChild?.className };
  })));
  await (await chromium.launch()).close?.();
})();
