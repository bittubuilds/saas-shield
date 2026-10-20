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
