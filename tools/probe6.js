process.env.SHIELD_ALLOW_PRIVATE_IPS='false';
const { fetchPage } = require('../src/crawler');
const { extractStructure } = require('../src/structure');
const { extractReadable, stripChrome } = require('../src/extract');
(async () => {
  for (const url of ['https://gowthambuilds.in/','https://bhaveshshaha.com/']) {
    const f = await fetchPage(url);
    const s = extractStructure(f.html, f.finalUrl);
    const chrome = stripChrome(f.html);
    console.log(url, 'html', f.html.length, 'chrome', chrome.length, 'headings', s.headings.length, 'links', s.links.length, 'images', s.images.length, 'ctas', s.ctas.length, 'forms', s.forms.length, 'sections', s.sections.length, 'words', s.wordCount, 'textLen', s.text.length);
    console.log('  headings sample', s.headings.slice(0,4));
    console.log('  links sample', s.links.slice(0,3));
    const raw = extractReadable(f.html, f.finalUrl);
    console.log('  readable words', raw.text.split(/\s+/).length);
  }
})();
