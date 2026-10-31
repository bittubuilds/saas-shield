'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sim = require('../src/similarity');

const ORIGINAL = `Acme Flow builds workflow automation software for modern operations teams.
Our platform helps companies automate repetitive processes, connect their tools, and
visualize every step of their pipeline. With Acme Flow, teams reduce manual data entry,
eliminate handoff errors, and ship changes faster. Trusted by more than two thousand
companies across forty countries, our product delivers real-time analytics and
enterprise-grade security out of the box. Getting started takes less than ten minutes:
connect your data sources, define your first automation, and watch the results roll in.
Every workflow runs on the same battle-tested engine that powers our largest customers,
with audit logs, versioned revisions, and granular role-based access control included
in every plan at no additional cost.`;

const UNIQUE_LONG = `The history of the printing press begins in the fifteenth century.
Gutenberg developed movable type in Mainz around 1440, transforming how knowledge
spread across Europe. Before printing, monks copied manuscripts by hand in scriptoria,
a slow and costly process. Printed books changed literacy, science, and religion forever,
enabling the Renaissance and the Reformation to reach ordinary readers.`;

const BOILERPLATE_NAV = `Home Products Pricing Blog About Contact Sign in Cart.
Copyright Acme Inc. All rights reserved. Privacy policy. Terms of service.
Cookie settings. Back to top. Follow us on social media.`;

function words(n, prefix = 'lorem') {
  const out = [];
  for (let i = 0; i < n; i++) out.push(prefix + i);
  return out.join(' ');
}

test('identical pages produce a strong finding with reproducible scores', () => {
  const r1 = sim.compareTexts(ORIGINAL, ORIGINAL);
  const r2 = sim.compareTexts(ORIGINAL, ORIGINAL);
  assert.equal(r1.isFinding, true);
  assert.equal(r1.matchType, 'long_passage');
  assert.ok(r1.jaccard >= 0.99, `jaccard ${r1.jaccard}`);
  assert.ok(r1.cosine >= 0.99, `cosine ${r1.cosine}`);
  assert.ok(r1.passages.length >= 1);
  assert.ok(r1.passages[0].wordCount >= 100);
  // Deterministic: identical inputs -> identical outputs
  assert.deepEqual(r1.jaccard, r2.jaccard);
  assert.deepEqual(r1.cosine, r2.cosine);
  assert.deepEqual(r1.passages.map((p) => p.aText), r2.passages.map((p) => p.aText));
});

test('partial copied passage is detected and extracted exactly', () => {
  const copied = 'Trusted by more than two thousand companies across forty countries, our product delivers real-time analytics and enterprise-grade security out of the box.';
  const comparison = `Zeta Flow is a different product entirely. ${words(60, 'zeta')}.
    However we also say: ${copied} And then some more unique ${words(40, 'beta')} content here.`;
  const r = sim.compareTexts(ORIGINAL, comparison);
  assert.equal(r.isFinding, true);
  assert.ok(r.passages.length >= 1, 'expected at least one passage');
  const joined = r.passages.map((p) => p.bText).join(' ');
  assert.ok(joined.includes('trusted by more than two thousand'), 'copied sentence should be in extracted passage');
  assert.ok(r.matchType === 'partial_passage' || r.matchType === 'long_passage');
});

test('unrelated pages are not flagged', () => {
  const r = sim.compareTexts(ORIGINAL, UNIQUE_LONG);
  assert.equal(r.isFinding, false);
  assert.equal(r.matchType, 'low_similarity');
  assert.equal(r.passages.length, 0);
  assert.ok(r.jaccard < 0.05, `jaccard ${r.jaccard}`);
});

test('generic shared phrases do not create findings', () => {
  const a = `${words(80, 'alpha')} Contact us today for a free demo. Sign up now.`;
  const b = `${words(80, 'kappa')} Contact us today for a free demo. Sign up now.`;
  const r = sim.compareTexts(a, b);
  assert.equal(r.isFinding, false);
  assert.equal(r.passages.length, 0, '8-word generic phrases should not produce passages');
});

test('repeated navigation boilerplate is filtered from scores', () => {
  // Two pages whose ONLY shared content is a nav menu repeated on every page.
  const a = BOILERPLATE_NAV + ' ' + words(120, 'alpha');
  const b = BOILERPLATE_NAV + ' ' + words(120, 'kappa');
  const boiler = sim.boilerplateTokens([BOILERPLATE_NAV, BOILERPLATE_NAV, BOILERPLATE_NAV]);
  const r = sim.compareTexts(a, b, { boilerplateA: boiler, boilerplateB: boiler });
  assert.equal(r.isFinding, false, `boilerplate should not be strong evidence (jaccard=${r.jaccard}, passages=${r.passages.length})`);
});

test('boilerplateTokens finds words repeated across pages of a site', () => {
  const pages = [
    'Home Pricing Contact newsletter subscribe',
    'Home About Contact newsletter subscribe',
    'Home Blog Contact newsletter subscribe'
  ];
  const b = sim.boilerplateTokens(pages);
  assert.ok(b.has('home') && b.has('contact') && b.has('newsletter'));
  assert.equal(sim.boilerplateTokens(['one page only']).size, 0, 'fewer than 3 pages -> no boilerplate');
});

test('empty and malformed inputs do not crash and are not findings', () => {
  for (const [a, b] of [[ '', '' ], [ '', 'some text here' ], [ null, ORIGINAL ], [ '<script>', '   ' ], [ undefined, {} ]]) {
    const r = sim.compareTexts(a, b);
    assert.equal(r.isFinding, false);
    assert.equal(typeof r.jaccard, 'number');
    assert.equal(typeof r.cosine, 'number');
    assert.ok(Array.isArray(r.passages));
  }
});

test('similarity scores are never random - same input, same score, many runs', () => {
  const scores = new Set();
  for (let i = 0; i < 5; i++) {
    scores.add(sim.compareTexts(ORIGINAL, ORIGINAL + ' ' + words(30)).jaccard);
  }
  assert.equal(scores.size, 1, 'score must be reproducible');
});

test('normalization: unicode, case, whitespace differences do not hide copying', () => {
  const fancy = ORIGINAL.toUpperCase().replace(/ /g, '  ').normalize('NFD') + ' \u00a0';
  const r = sim.compareTexts(ORIGINAL, fancy);
  assert.equal(r.isFinding, true);
  assert.ok(r.jaccard >= 0.95, `jaccard ${r.jaccard}`);
});

// ---------------------------------------------------------------------------
// Regression: per-pair scoring (the original cosine bug)
// ---------------------------------------------------------------------------
test('each page pair gets its own cosine score, not the first pair in the corpus', () => {
  // Four documents where doc1/doc2 are near-identical and doc3/doc4 share nothing
  // with them. The old implementation built corpus vectors and read vectors[0]
  // and vectors[1] for every pair, so every pair reported the same cosine.
  const d1 = `${words(90, 'alpha')} shared workflow automation engine analytics`;
  const d2 = `${d1} extra clause`;
  const d3 = `${words(90, 'omega')} printing press movable type gutenberg`;
  const d4 = `${words(90, 'sigma')} warehouse dock carrier routing timeline`;
  const corpus = [d1, d2, d3, d4].map((t) => sim.tokenize(t));

  const close = sim.compareTexts(d1, d2, { corpusTokens: corpus });
  const far = sim.compareTexts(d3, d4, { corpusTokens: corpus });
  const cross = sim.compareTexts(d1, d4, { corpusTokens: corpus });

  assert.ok(close.cosine > 0.9, `near-identical pair should score high, got ${close.cosine}`);
  assert.ok(far.cosine < 0.05, `unrelated pair should score ~0, got ${far.cosine}`);
  assert.ok(cross.cosine < 0.2, `cross pair should score low, got ${cross.cosine}`);
  assert.notEqual(close.cosine, far.cosine, 'pairs must not share a score');
  // Two unrelated pairs may both legitimately score 0; what matters is that the
  // close pair does not (the old bug gave all 35 real pairs one identical score).
  assert.equal(far.cosine, 0);
  assert.equal(cross.cosine, 0);

  // The reported cosine must equal a direct two-document computation.
  const direct = sim.cosine(
    sim.tfidfVectors([sim.tokenize(d3), sim.tokenize(d4)])[0],
    sim.tfidfVectors([sim.tokenize(d3), sim.tokenize(d4)])[1]
  );
  assert.ok(Math.abs(far.cosine - sim.round4(direct)) < 0.0002,
    `corpus cosine ${far.cosine} should match the pair's own cosine ${direct}`);
});

test('a cosine-only agreement cannot raise a finding on its own', () => {
  // Same vocabulary domain, no shared phrasing. This is what produced the false
  // positive on two unrelated portfolio sites (cosine 0.31, no passages, 3-gram
  // overlap 0.007).
  const a = 'Workflow automation for operations. Track handoffs, retry failed steps ' +
    'automatically, and keep a permanent audit trail of every run so nothing is lost ' +
    'between shifts. Connect your tools in minutes and let the engine handle the rest ' +
    'while your team focuses on the customers who need attention today.';
  const b = 'Automation tooling for finance. Reconcile ledgers nightly, chase unpaid ' +
    'invoices politely, and export an audit trail before every board meeting. Your ' +
    'accountants connect their spreadsheets and the platform keeps watch over every ' +
    'entry, flagging the ones that look unusual before close.';
  const r = sim.compareTexts(a, b, { corpusTokens: [sim.tokenize(a), sim.tokenize(b)] });
  assert.ok(r.cosine > 0.15, `expected topical cosine, got ${r.cosine}`);
  assert.ok(r.jaccard3 < 0.05, `expected low short-phrase overlap, got ${r.jaccard3}`);
  assert.equal(r.isFinding, false, 'topical overlap alone is not evidence of copying');
  assert.equal(r.verdict, 'no_evidence');
});

// ---------------------------------------------------------------------------
// Structural comparison and verdicts
// ---------------------------------------------------------------------------
function structureOf({ headings, sections = [], links = [], ctas = [], images = [], forms = [] }) {
  return {
    headings: headings.map((h, i) => ({ level: i === 0 ? 1 : 2, text: h })),
    links: links.map((href) => ({ href, text: href })),
    ctas, images: images.map((src) => ({ src, alt: '' })), forms,
    sections: sections.map((heading) => ({ heading, approxWords: 40 }))
  };
}

test('structural comparison separates shared layout from shared content', () => {
  const a = structureOf({
    headings: ['Welcome to Acme', 'What we do', 'Pricing'],
    sections: ['What we do', 'Pricing'],
    links: ['https://acme.example/pricing', 'https://acme.example/about'],
    ctas: ['Start free'], images: ['https://acme.example/me.png']
  });
  const b = structureOf({
    headings: ['Hi, I am Bea', 'What I do', 'Contact'],
    sections: ['What I do', 'Contact'],
    links: ['https://bea.example/work', 'https://bea.example/contact'],
    ctas: ['Hire me'], images: ['https://bea.example/avatar.jpg']
  });

  const cs = sim.compareStructure(a, b);
  assert.equal(cs.headings.score, 0, 'no shared heading text');
  assert.equal(cs.links.score, 0, 'no shared links');
  assert.equal(cs.ctas.score, 0);
  // Both are single-column pages with a headline, sections, a CTA and a portrait.
  assert.ok(cs.layout.shared.count >= 2, JSON.stringify(cs.layout.shared));
  assert.ok(cs.layout.shared.shared.some((s) => s.key === 'avatar_or_portrait'));

  const same = sim.compareStructure(a, a);
  assert.equal(same.score, 1, 'a structure compared with itself matches fully');
  assert.ok(same.score > cs.score);
});

test('pages that share a layout but no wording are labelled shared conventions', () => {
  const layoutA = structureOf({
    headings: ['Acme builds automations', 'Features', 'Pricing'],
    sections: ['Features', 'Pricing'],
    ctas: ['Get started'], images: ['https://acme.example/me.png'],
    forms: [{ fields: [{ name: 'email' }], submit: 'Join' }]
  });
  const layoutB = structureOf({
    headings: ['Kite writes essays', 'Writing', 'Contact'],
    sections: ['Writing', 'Contact'],
    ctas: ['Read more'], images: ['https://kite.example/avatar.png'],
    forms: [{ fields: [{ name: 'email' }], submit: 'Subscribe' }]
  });
  const textA = `${words(80, 'acme')} We automate recurring operations work for logistics teams.`;
  const textB = `${words(80, 'kite')} I write long essays about urban planning and transit.`;

  const r = sim.compareTexts(textA, textB, { structureA: layoutA, structureB: layoutB });
  assert.equal(r.isFinding, false);
  assert.equal(r.verdict, 'shared_conventions');
  assert.ok(r.signals.shared_layout_conventions.length >= 2);
  assert.match(sim.verdictExplanation(r.verdict), /not evidence that content was copied/i);
  assert.ok(r.limitations.some((l) => /Structural similarity|Visual similarity/i.test(l)));
});

test('structural comparison tolerates missing or partial structures', () => {
  for (const pair of [[{}, {}], [null, { headings: [{ level: 1, text: 'x' }] }], [{ links: [] }, undefined]]) {
    const r = sim.compareTexts('some text here for both sides to compare', 'some other words entirely', {
      structureA: pair[0], structureB: pair[1]
    });
    assert.equal(typeof r.jaccard, 'number');
    assert.equal(r.isFinding, false);
    const cs = sim.compareStructure(pair[0], pair[1]);
    assert.equal(typeof cs.score, 'number');
    assert.ok(Number.isFinite(cs.score));
  }
});

test('every verdict has a plain-language explanation and a documented method', () => {
  const verdicts = ['verbatim_passage', 'copied_passage', 'high_shingle_overlap', 'distributed_overlap', 'shared_conventions', 'no_evidence'];
  for (const v of verdicts) {
    const text = sim.verdictExplanation(v);
    assert.ok(text.length > 40, `${v} needs a real explanation`);
  }
  const r = sim.compareTexts(ORIGINAL, ORIGINAL);
  assert.match(r.method, /Jaccard|cosine/);
  assert.ok(r.signals.thresholds.min_passage_words >= 1, 'thresholds are recorded with the result');
  assert.ok(r.explanation.passages.includes('words'));
  // The engine must never make a legal claim, and must always carry the caveat.
  const everything = [r.verdict, sim.verdictExplanation(r.verdict), ...r.limitations].join(' ');
  assert.ok(!/\bis (?:clear )?(?:copyright )?infringement\b|\bhas plagiaris/i.test(everything), 'no legal claims in output');
  assert.match(everything, /not a probability of infringement|not a legal conclusion/i, 'the caveat is present');
});

test('matched passage text is identical on both sides (evidence integrity)', () => {
  const copied = 'Trusted by more than two thousand companies across forty countries, our product delivers real-time analytics and enterprise-grade security out of the box.';
  const other = `${words(70, 'quux')} ${copied} ${words(30, 'delta')}`;
  const r = sim.compareTexts(ORIGINAL, other);
  assert.ok(r.passages.length >= 1);
  for (const p of r.passages) {
    assert.equal(p.aText, p.bText, 'a reported passage must be word-for-word on both pages');
    assert.ok(p.wordCount >= 12);
  }
});
