process.env.SHIELD_ALLOW_PRIVATE_IPS='false';
const { crawlSite } = require('../src/crawler');
const { extractStructure } = require('../src/structure');
const sim = require('../src/similarity');
const { fetchPage } = require('../src/crawler');
function site(url){ return { id:'w', workspace_id:'ws', submitted_url:url }; }
(async () => {
  const A=[],B=[];
  await crawlSite(site('https://gowthambuilds.in/'), async p=>A.push(p), {maxPages:8,maxDepth:1});
  await crawlSite(site('https://bhaveshshaha.com/'), async p=>B.push(p), {maxPages:8,maxDepth:1});
  const uniq=(ps)=>{const s=new Set();return ps.filter(p=>{if(s.has(p.content_hash))return false;s.add(p.content_hash);return true;});};
  const UA=uniq(A), UB=uniq(B);
  const boilerA=sim.boilerplateTokens(UA.map(p=>p.text_content));
  const boilerB=sim.boilerplateTokens(UB.map(p=>p.text_content));
  const corpus=[]; UA.forEach(p=>corpus.push(sim.tokenize(p.text_content))); UB.forEach(p=>corpus.push(sim.tokenize(p.text_content)));
  const structCache=new Map();
  async function structOf(url){
    if(structCache.has(url)) return structCache.get(url);
    const f=await fetchPage(url); const s=extractStructure(f.html,f.finalUrl); structCache.set(url,s); return s;
  }
  let findings=0, compared=0, rows=[];
  for(const a of UA){ if(sim.tokenize(a.text_content).length<50) continue;
    for(const b of UB){ if(sim.tokenize(b.text_content).length<50) continue;
      const sa=await structOf(a.url), sb=await structOf(b.url);
      const r=sim.compareTexts(a.text_content,b.text_content,{boilerplateA:boilerA,boilerplateB:boilerB,corpusTokens:corpus,structureA:sa,structureB:sb});
      compared++; if(r.isFinding) findings++;
      rows.push({a:a.url,b:b.url,jac:r.jaccard,jac3:r.jaccard3,cos:r.cosine,struct:r.structural.score,verdict:r.verdict,f:r.isFinding,long:r.longestPassageWords});
    }}
  rows.sort((x,y)=>Math.max(y.jac,y.cos,y.struct||0)-Math.max(x.jac,x.cos,x.struct||0));
  console.log('compared', compared, 'findings', findings);
  for(const r of rows.slice(0,6)) console.log(`jac ${r.jac} jac3 ${r.jac3} cos ${r.cos} struct ${r.struct} → ${r.verdict} ${r.f?'FINDING':'none'} ${r.a.replace('https://www.','')} <> ${r.b}`);
  const homepage = rows.find(r=>r.a.endsWith('gowthambuilds.in/') && r.b.endsWith('bhaveshshaha.com/'));
  console.log('HOMEPAGE PAIR:', JSON.stringify(homepage));
})();
