process.env.SHIELD_ALLOW_PRIVATE_IPS='false';
const { fetchPage } = require('../src/crawler');
const { extractReadable } = require('../src/extract');
const sim = require('../src/similarity');
function jacK(a,b,k){ const s=new Set(); for(let i=0;i+k<=a.length;i++) s.add(a.slice(i,i+k).join(' '));
 const t=new Set(); for(let i=0;i+k<=b.length;i++) t.add(b.slice(i,i+k).join(' '));
 let inter=0; for(const x of s) if(t.has(x)) inter++; const u=s.size+t.size-inter; return u?inter/u:0; }
(async () => {
  const A = await fetchPage('https://gowthambuilds.in/');
  const B = await fetchPage('https://bhaveshshaha.com/');
  const ta = sim.tokenize(extractReadable(A.html, A.finalUrl).text);
  const tb = sim.tokenize(extractReadable(B.html, B.finalUrl).text);
  for (const k of [2,3,4,5]) console.log('real sites k='+k, jacK(ta,tb,k).toFixed(4), 'words', ta.length, tb.length);
  const ORIG = `Acme Flow builds workflow automation software for modern operations teams. Our platform helps companies automate repetitive processes, connect their tools, and visualize every step of their pipeline. With Acme Flow, teams reduce manual data entry, eliminate handoff errors, and ship changes faster. Trusted by more than two thousand companies across forty countries, our product delivers real-time analytics and enterprise-grade security out of the box. Getting started takes less than ten minutes: connect your data sources, define your first automation, and watch the results roll in. Every workflow runs on the same battle-tested engine that powers our largest customers, with audit logs, versioned revisions, and granular role-based access control included in every plan at no additional cost.`;
  const COPIED = 'Trusted by more than two thousand companies across forty countries, our product delivers real-time analytics and enterprise-grade security out of the box.';
  const filler = Array.from({length:60},(_,i)=>'zeta'+i).join(' ');
  const CMP = `Zeta Flow is a different product entirely. ${filler} However we also say: ${COPIED} And then some more unique ${Array.from({length:40},(_,i)=>'beta'+i).join(' ')} content here.`;
  const oa = sim.tokenize(ORIG), ob = sim.tokenize(CMP);
  for (const k of [2,3,4,5]) console.log('partial copy k='+k, jacK(oa,ob,k).toFixed(4));
  // topical-only: same industry, no shared passages
  const IND = `Acme Flow builds workflow automation software for growing finance teams. Finance leaders use our dashboards to approve invoices, reconcile payments and forecast runway with confidence. Pricing starts low and scales with seats, and every plan includes audit history.`;
  const ia = sim.tokenize(ORIG), ib = sim.tokenize(IND);
  for (const k of [2,3,4,5]) console.log('topical only k='+k, jacK(ia,ib,k).toFixed(4));
})();
