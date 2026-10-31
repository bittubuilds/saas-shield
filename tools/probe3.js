process.env.SHIELD_ALLOW_PRIVATE_IPS='false';
const { fetchPage } = require('../src/crawler');
const { extractReadable } = require('../src/extract');
const sim = require('../src/similarity');
(async () => {
  const A = await fetchPage('https://gowthambuilds.in/');
  const B = await fetchPage('https://bhaveshshaha.com/');
  const pa = extractReadable(A.html, A.finalUrl), pb = extractReadable(B.html, B.finalUrl);
  // correct pairwise cosine (no corpus)
  const r = sim.compareTexts(pa.text, pb.text, {});
  console.log('CORRECT pairwise:', JSON.stringify({jac:r.jaccard, cos:r.cosine, longest:r.longestPassageWords, passages:r.passages.length, type:r.matchType, finding:r.isFinding}));
  // what the buggy corpus path yields
  const corpus=[sim.tokenize(pa.text), sim.tokenize('totally unrelated words about fishing boats and weather'), sim.tokenize(pb.text)];
  const rb = sim.compareTexts(pa.text, pb.text, {corpusTokens:corpus});
  console.log('BUGGY corpus path:', JSON.stringify({cos:rb.cosine, jac:rb.jaccard, finding:rb.isFinding, type:rb.matchType}));
  // structure comparison
  const heads = h => [...h.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi)].map(m=>m[2].replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim()).filter(Boolean);
  const imgs = h => [...h.matchAll(/<img\b[^>]*>/gi)].map(m=>m[0]).length;
  const links = h => [...h.matchAll(/<a\b[^>]*>/gi)].length;
  const cls = h => [...h.matchAll(/class\s*=\s*["']([^"']+)["']/gi)].flatMap(m=>m[1].split(/\s+/)).filter(Boolean);
  console.log('A headings', heads(A.html).slice(0,12));
  console.log('B headings', heads(B.html).slice(0,12));
  console.log('A imgs', imgs(A.html), 'links', links(A.html), 'classes', [...new Set(cls(A.html))].slice(0,18));
  console.log('B imgs', imgs(B.html), 'links', links(B.html), 'classes', [...new Set(cls(B.html))].slice(0,18));
  // asset overlap
  const assets = h => new Set([...h.matchAll(/(?:src|href)\s*=\s*["']([^"']+\.(?:png|jpe?g|svg|webp|gif|css))["']/gi)].map(m=>m[1].split('/').pop()));
  const aa=assets(A.html), ba=assets(B.html);
  console.log('A assets', [...aa].slice(0,10));
  console.log('B assets', [...ba].slice(0,10));
  console.log('shared asset basenames', [...aa].filter(x=>ba.has(x)));
})();
