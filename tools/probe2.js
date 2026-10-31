process.env.SHIELD_ALLOW_PRIVATE_IPS='false';
const { crawlSite } = require('../src/crawler');
const sim = require('../src/similarity');
function site(url){ return { id:'w', workspace_id:'ws', submitted_url:url }; }
(async () => {
  const pagesA=[], pagesB=[];
  const sumA = await crawlSite(site('https://gowthambuilds.in/'), async p => pagesA.push(p), {maxPages:8,maxDepth:1});
  const sumB = await crawlSite(site('https://bhaveshshaha.com/'), async p => pagesB.push(p), {maxPages:8,maxDepth:1});
  console.log('A pages', pagesA.length, 'errors', sumA.errors.length, 'B pages', pagesB.length, 'errors', sumB.errors.length);
  const uniq = (ps)=>{ const seen=new Set(); return ps.filter(p=>{ if(seen.has(p.content_hash)) return false; seen.add(p.content_hash); return true;}); };
  const A=uniq(pagesA), B=uniq(pagesB);
  const boilerA = sim.boilerplateTokens(A.map(p=>p.text_content));
  const boilerB = sim.boilerplateTokens(B.map(p=>p.text_content));
  const corpus=[]; for(const a of A){corpus.push(sim.tokenize(a.text_content));} for(const b of B){corpus.push(sim.tokenize(b.text_content));}
  const pairs=[];
  for(const a of A){ const wa=sim.tokenize(a.text_content).length; if(wa<50) continue;
    for(const b of B){ const wb=sim.tokenize(b.text_content).length; if(wb<50) continue;
      const r = sim.compareTexts(a.text_content,b.text_content,{boilerplateA:boilerA,boilerplateB:boilerB,corpusTokens:corpus.slice(0,200)});
      pairs.push({a:a.url,b:b.url,wa,wb,jac:r.jaccard,cos:r.cosine,long:r.longestPassageWords,np:r.passages.length,type:r.matchType,found:r.isFinding});
    }}
  pairs.sort((x,y)=>Math.max(y.jac,y.cos)-Math.max(x.jac,x.cos));
  console.log('pairs compared:', pairs.length);
  for(const p of pairs.slice(0,10)) console.log(`${p.jac.toFixed(3)} jac | ${p.cos.toFixed(3)} cos | ${p.long}w | ${p.type} | ${p.found?'FINDING':'no'} | ${p.a.replace('https://www.','')} <> ${p.b}`);
})();
