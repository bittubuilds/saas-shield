process.env.SHIELD_ALLOW_PRIVATE_IPS='false';
const { fetchPage } = require('../src/crawler');
const { extractReadable } = require('../src/extract');
(async () => {
  for (const url of ['https://gowthambuilds.in/','https://bhaveshshaha.com/']) {
    try {
      const r = await fetchPage(url);
      const p = extractReadable(r.html, r.finalUrl);
      console.log('OK', url, '->', r.finalUrl, 'status', r.httpStatus, 'htmlLen', r.html.length, 'textWords', p.text.split(/\s+/).length, 'title:', JSON.stringify(p.title));
      console.log('  first 300 chars:', JSON.stringify(p.text.slice(0,300)));
    } catch (e) {
      console.log('FAIL', url, e.code || '', e.message);
    }
  }
})();
