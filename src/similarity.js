'use strict';
// Deterministic similarity detection engine.
//
// Methods (all reported, no random numbers anywhere):
//   1. Word shingle (n-gram) Jaccard overlap at k=5  ("jaccard")
//   2. Short n-gram overlap at k=3                  ("jaccard3")
//   3. TF-IDF cosine over the scan corpus           ("cosine")
//   4. Longest/long common passage extraction       (matched excerpts)
//   5. Structural comparison of headings, sections, links, CTAs, images and
//      form fields ("structural") - reported separately and never treated as
//      evidence of copying.
//
// Why three text measures: cosine alone is NOT evidence. Measured on real
// content, two unrelated portfolio sites that share a common landing-page
// convention score cosine 0.31 while sharing no phrase at all (k=3 overlap
// 0.007). A genuinely copied 26-word passage scores k=3 overlap 0.093. So a
// cosine-only agreement is only allowed to raise a finding when short-phrase
// overlap also clears a floor. Every number below is reproducible.
//
// A "similarity score" measures observable overlap in fetched content. It is
// NOT a probability of infringement and must never be presented as one.

const crypto = require('crypto');
const config = require('./config');
const normalize = require('./normalize');

const SHORT_SHINGLE_K = 3;

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------
function normalizeText(text) {
  if (typeof text !== 'string') {
    if (text === null || text === undefined) return '';
    text = String(text);
  }
  return text.normalize('NFKC').toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokenize(text) {
  const norm = normalizeText(text);
  if (!norm) return [];
  return norm.split(' ');
}

function hashShingle(tokens) {
  return crypto.createHash('sha1').update(tokens.join(' ')).digest('hex').slice(0, 16);
}

function shingleSet(tokens, k = config.sim.shingleSize) {
  const set = new Set();
  if (!Array.isArray(tokens) || tokens.length === 0) return set;
  const size = Math.max(1, Math.floor(k));
  if (tokens.length < size) {
    set.add(hashShingle(tokens));
    return set;
  }
  for (let i = 0; i + size <= tokens.length; i++) {
    set.add(hashShingle(tokens.slice(i, i + size)));
  }
  return set;
}

// Remove boilerplate tokens (site-wide template words) before shingling so
// repeated navigation menus and cookie notices do not drive the score.
function filterTokens(tokens, boilerplate) {
  if (!boilerplate || boilerplate.size === 0) return tokens;
  const filtered = tokens.filter((t) => !boilerplate.has(t));
  return filtered;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------
function jaccard(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 0;
  let inter = 0;
  for (const s of setA) if (setB.has(s)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

function termFreq(tokens) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  return tf;
}

// Document frequencies for a corpus of token arrays.
function documentFrequencies(docTokensList) {
  const df = new Map();
  for (const toks of docTokensList) {
    for (const t of new Set(toks)) df.set(t, (df.get(t) || 0) + 1);
  }
  return df;
}

function idfValue(term, N, df) {
  return Math.log((N + 1) / ((df.get(term) || 0) + 1)) + 1;
}

// One L2-normalized tf-idf vector, using idf weights derived from `corpusStats`.
function tfidfVector(tokens, corpusStats) {
  const tf = termFreq(tokens);
  const vec = new Map();
  for (const [t, count] of tf) {
    vec.set(t, count * idfValue(t, corpusStats.N, corpusStats.df));
  }
  let norm = 0;
  for (const v of vec.values()) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  for (const [t, v] of vec) vec.set(t, v / norm);
  return vec;
}

// Backwards-compatible helper: vectors for a list of documents.
function tfidfVectors(docTokensList) {
  const stats = { N: docTokensList.length, df: documentFrequencies(docTokensList) };
  return docTokensList.map((toks) => tfidfVector(toks, stats));
}

function cosine(vecA, vecB) {
  let dot = 0;
  const [small, big] = vecA.size <= vecB.size ? [vecA, vecB] : [vecB, vecA];
  for (const [t, v] of small) {
    const w = big.get(t);
    if (w) dot += v * w;
  }
  return Math.max(0, Math.min(1, dot));   // vectors are unit length
}

/**
 * Cosine for exactly ONE pair, with inverse document frequencies taken from the
 * surrounding corpus when one is supplied.
 *
 * This is the fix for the original scoring bug: the previous implementation
 * built corpus vectors for every document and then read vectors [0] and [1],
 * so every page pair in a scan received the cosine of the first two documents
 * in the corpus. On a real 35-pair scan that produced the identical score
 * 0.384 for every pair regardless of content.
 */
function cosineForPair(tokensA, tokensB, corpusTokens, boilerplate) {
  const a = filterTokens(tokensA, boilerplate);
  const b = filterTokens(tokensB, boilerplate);
  let stats;
  if (Array.isArray(corpusTokens) && corpusTokens.length > 1) {
    const filtered = corpusTokens.map((t) => filterTokens(t, boilerplate));
    stats = { N: filtered.length + 2, df: documentFrequencies([...filtered, a, b]) };
  } else {
    stats = { N: 2, df: documentFrequencies([a, b]) };
  }
  return cosine(tfidfVector(a, stats), tfidfVector(b, stats));
}

// ---------------------------------------------------------------------------
// Matching-passage extraction.
// Finds long contiguous word sequences shared between A and B via k-gram
// seeding + greedy extension, then merges overlaps. Deterministic.
// ---------------------------------------------------------------------------
const PASSAGE_SEED_K = 5;

function findPassages(tokensA, tokensB, opts = {}) {
  const minWords = opts.minWords ?? config.sim.minPassageWords;
  const k = PASSAGE_SEED_K;
  const maxPassages = opts.maxPassages ?? 20;

  if (!Array.isArray(tokensA) || !Array.isArray(tokensB)) return [];
  if (tokensA.length < k || tokensB.length < k) return [];

  // Index k-grams of A.
  const index = new Map();
  for (let i = 0; i + k <= tokensA.length; i++) {
    const key = tokensA.slice(i, i + k).join('\u0001');
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(i);
  }

  const matches = [];  // { bStart, bEnd, aStart, aEnd, len }
  let i = 0;
  while (i + k <= tokensB.length) {
    const key = tokensB.slice(i, i + k).join('\u0001');
    const positions = index.get(key);
    if (!positions || positions.length === 0) { i++; continue; }
    // Extend each seed to the longest run; keep the longest over all seeds.
    let best = null;
    for (const j of positions.slice(0, 10)) {
      let len = k;
      while (j + len < tokensA.length && i + len < tokensB.length &&
             tokensA[j + len] === tokensB[i + len] && len < 5000) len++;
      // extend backwards within reason
      let back = 0;
      while (j - back - 1 >= 0 && i - back - 1 >= 0 &&
             tokensA[j - back - 1] === tokensB[i - back - 1] && back < 200) back++;
      const aStart = j - back, bStart = i - back;
      const total = len + back;
      if (!best || total > best.len) best = { aStart, bStart, len: total };
    }
    matches.push(best);
    i = best.bStart + best.len;   // always advances by at least k
  }

  // Drop short runs, sort by length desc, cap.
  const passages = matches
    .filter((m) => m.len >= minWords)
    .sort((x, y) => y.len - x.len)
    .slice(0, maxPassages);

  return passages.map((m) => ({
    aText: tokensA.slice(m.aStart, m.aStart + m.len).join(' '),
    bText: tokensB.slice(m.bStart, m.bStart + m.len).join(' '),
    wordCount: m.len
  }));
}

// ---------------------------------------------------------------------------
// Site boilerplate detection: tokens present in nearly all pages of a site.
// ---------------------------------------------------------------------------
function boilerplateTokens(pageTexts, threshold = 0.8) {
  if (!Array.isArray(pageTexts) || pageTexts.length < 3) return new Set();
  const df = new Map();
  for (const text of pageTexts) {
    for (const t of new Set(tokenize(text))) df.set(t, (df.get(t) || 0) + 1);
  }
  const boiler = new Set();
  const cutoff = Math.ceil(pageTexts.length * threshold);
  for (const [t, count] of df) {
    if (count >= cutoff) boiler.add(t);
  }
  return boiler;
}

// ---------------------------------------------------------------------------
// Structural comparison.
// Compares how pages are built, not what they say. High structural similarity
// with no textual overlap is reported as a shared layout convention, which is
// normal across websites and is not evidence of copying.
// ---------------------------------------------------------------------------
function setJaccard(listA, listB, keyFn) {
  const a = new Set((listA || []).map(keyFn).filter(Boolean));
  const b = new Set((listB || []).map(keyFn).filter(Boolean));
  if (a.size === 0 && b.size === 0) return { score: 0, aCount: 0, bCount: 0, shared: 0 };
  let inter = 0;
  for (const v of a) if (b.has(v)) inter++;
  const union = a.size + b.size - inter;
  return { score: union ? inter / union : 0, aCount: a.size, bCount: b.size, shared: inter };
}

function compareStructure(structA, structB) {
  const A = structA || {};
  const B = structB || {};
  const norm = (s) => normalize.normalizeForHash(s || '');
  const pathOf = (href) => {
    try {
      const u = new URL(href);
      return u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/+$/, '');
    } catch {
      return String(href || '');
    }
  };
  const basename = (src) => {
    try {
      return new URL(src).pathname.split('/').pop() || '';
    } catch {
      return String(src || '').split('/').pop() || '';
    }
  };

  const headings = setJaccard(A.headings, B.headings, (h) => norm(h.text));
  const sections = setJaccard((A.structure && A.structure.sections) || A.sections, (B.structure && B.structure.sections) || B.sections,
    (s) => norm(s.heading));
  const links = setJaccard(A.links, B.links, (l) => pathOf(l.href));
  const ctas = setJaccard(A.ctas, B.ctas, (c) => norm(c));
  const images = setJaccard(A.images, B.images, (i) => basename(i.src));
  const forms = setJaccard(A.forms, B.forms, (f) => (f.fields || []).map((x) => x.name).sort().join(','));
  const headingLevels = setJaccard(A.headings, B.headings, (h) => String(h.level));

  // Only signals that both pages can actually produce are weighted, and the
  // weights are renormalised. Otherwise two pages that simply have no forms (or
  // no images) would be penalised for a difference that does not exist.
  const weighted = [
    [headings, 0.24],
    [sections, 0.2],
    [links, 0.2],
    [ctas, 0.16],
    [images, 0.1],
    [forms, 0.1]
  ].filter(([signal]) => signal.aCount > 0 || signal.bCount > 0);
  const totalWeight = weighted.reduce((sum, [, w]) => sum + w, 0);
  const score = totalWeight === 0
    ? 0
    : weighted.reduce((sum, [signal, w]) => sum + signal.score * (w / totalWeight), 0);

  return {
    score: round4(score),
    headings: { ...headings, score: round4(headings.score) },
    sections: { ...sections, score: round4(sections.score) },
    links: { ...links, score: round4(links.score) },
    ctas: { ...ctas, score: round4(ctas.score) },
    images: { ...images, score: round4(images.score) },
    forms: { ...forms, score: round4(forms.score) },
    headingStructure: { ...headingLevels, score: round4(headingLevels.score) },
    layout: {
      a: layoutShape(A),
      b: layoutShape(B),
      shared: sharedLayoutConventions(layoutShape(A), layoutShape(B))
    },
    note: 'Structural similarity reflects layout and information architecture. Shared templates and common design conventions produce high structural scores between unrelated sites, so this is reported as context, never as evidence of copying.'
  };
}

// Coarse layout shape. Used only to explain why two pages can *look* similar
// while sharing no content: it names the conventions they have in common.
function layoutShape(structure) {
  const s = structure || {};
  const headings = s.headings || [];
  const sections = (s.structure && s.structure.sections) || s.sections || [];
  const images = s.images || [];
  const links = s.links || [];
  const ctas = s.ctas || [];
  const forms = s.forms || [];
  return {
    single_column: sections.length <= 10 && links.length <= 40,
    has_primary_heading: headings.filter((h) => h.level === 1).length > 0,
    section_list: sections.length >= 2,
    avatar_or_portrait: images.some((i) => /avatar|profile|portrait|headshot|\bme\b|photo/i.test(`${i.src} ${i.alt || ''}`)),
    call_to_action: ctas.length > 0,
    contact_form: forms.length > 0,
    section_count: sections.length,
    heading_count: headings.length,
    image_count: images.length,
    link_count: links.length
  };
}

const LAYOUT_LABELS = {
  single_column: 'single-column layout',
  has_primary_heading: 'a single primary headline',
  section_list: 'a list of content sections',
  avatar_or_portrait: 'an avatar or portrait image',
  call_to_action: 'a call-to-action',
  contact_form: 'a contact or signup form'
};

// Which layout conventions two pages share (as opposed to content they share).
function sharedLayoutConventions(layoutA, layoutB) {
  const shared = [];
  for (const key of Object.keys(LAYOUT_LABELS)) {
    if (layoutA[key] && layoutB[key]) shared.push({ key, label: LAYOUT_LABELS[key] });
  }
  const comparable = Object.keys(LAYOUT_LABELS).filter((k) => layoutA[k] || layoutB[k]);
  return {
    shared,
    count: shared.length,
    comparable: comparable.length,
    ratio: comparable.length ? shared.length / comparable.length : 0
  };
}

// ---------------------------------------------------------------------------
// Main pair comparison.
// compareTexts(textA, textB, opts) -> {
//   jaccard, jaccard3, cosine, passages[], isFinding, matchType, verdict,
//   signals, limitations, explanation
// }
// opts: { boilerplateA?:Set, boilerplateB?:Set, corpusTokens?:string[][],
//         structureA?, structureB?, minWords?, minJaccard?, minCosine?,
//         minShortJaccard? }
// ---------------------------------------------------------------------------
function compareTexts(textA, textB, opts = {}) {
  const rawA = tokenize(textA);
  const rawB = tokenize(textB);
  const boilerA = opts.boilerplateA;
  const boilerB = opts.boilerplateB;
  const boilerAll = new Set([...(boilerA || []), ...(boilerB || [])]);

  const toksA = filterTokens(rawA, boilerA);
  const toksB = filterTokens(rawB, boilerB);

  const setA5 = shingleSet(toksA, config.sim.shingleSize);
  const setB5 = shingleSet(toksB, config.sim.shingleSize);
  const jac = jaccard(setA5, setB5);

  const setA3 = shingleSet(toksA, SHORT_SHINGLE_K);
  const setB3 = shingleSet(toksB, SHORT_SHINGLE_K);
  const jac3 = jaccard(setA3, setB3);

  // Pair-wise TF-IDF cosine (idf from the scan corpus when provided).
  const cos = cosineForPair(toksA, toksB, opts.corpusTokens, boilerAll);

  // Passage matching runs on the unfiltered token streams (passage text is
  // shown to humans, so we do not remove words from it). Passages that are
  // almost entirely site-wide boilerplate words (nav menus, footers) are
  // dropped so repeated templates are not treated as evidence.
  const minPw = opts.minWords ?? config.sim.minPassageWords;
  let passages = findPassages(rawA, rawB, { minWords: minPw });
  if (boilerAll.size > 0 && passages.length > 0) {
    passages = passages.filter((p) => {
      const toks = p.aText.split(' ');
      const boilerCount = toks.filter((t) => boilerAll.has(t)).length;
      return boilerCount / toks.length <= 0.8;
    });
  }
  const longest = passages.length ? passages[0].wordCount : 0;

  const minJ = opts.minJaccard ?? config.sim.minShingleJaccard;
  const minC = opts.minCosine ?? config.sim.minTfidfCosine;
  const minShort = opts.minShortJaccard ?? config.sim.minShortShingleJaccard;
  const minCosineWords = opts.minCosineWords ?? config.sim.minCosineWords;

  const bothLongEnough = toksA.length >= minCosineWords && toksB.length >= minCosineWords;

  // A finding needs textual evidence that survives more than one measure:
  //  - a shared passage of at least `minPw` words, or
  //  - high 5-gram overlap, or
  //  - cosine agreement AND short-phrase (3-gram) overlap above a floor.
  // Cosine by itself is never enough: it fires on ordinary shared vocabulary.
  const jaccardFinding = jac >= minJ;
  const passageFinding = longest >= minPw;
  const distributedOverlap = cos >= minC && jac3 >= minShort && bothLongEnough;
  const isFinding = jaccardFinding || passageFinding || distributedOverlap;

  let matchType = 'low_similarity';
  if (longest >= 100) matchType = 'long_passage';
  else if (longest >= minPw) matchType = 'partial_passage';
  else if (isFinding) matchType = 'phrase';

  let verdict = 'no_evidence';
  if (matchType === 'long_passage') verdict = 'verbatim_passage';
  else if (matchType === 'partial_passage') verdict = 'copied_passage';
  else if (isFinding && jaccardFinding) verdict = 'high_shingle_overlap';
  else if (isFinding) verdict = 'distributed_overlap';

  const structural = (opts.structureA && opts.structureB)
    ? compareStructure(opts.structureA, opts.structureB)
    : null;

  // Shared conventions: the pages are built the same way but do not share
  // content. This is the honest explanation for "these two sites look alike"
  // and is explicitly NOT evidence of copying.
  const layoutShared = structural ? structural.layout.shared : null;
  const sharedConventions = Boolean(
    structural &&
    !isFinding &&
    toksA.length >= 60 && toksB.length >= 60 &&
    (structural.score >= config.sim.minStructuralScore || (layoutShared && layoutShared.count >= 2))
  );
  if (sharedConventions) verdict = 'shared_conventions';

  const matchedWords = passages.reduce((s, p) => s + p.wordCount, 0);

  const limitations = [
    'Scores measure observable overlap between two fetched public pages. They are not a probability of infringement.',
    'Only content reachable without authentication is compared.',
    'JavaScript-rendered content is only present if the server response contained it.',
    'Visual similarity (screenshots, fonts, images as rendered) is not measured. Structural similarity is computed from HTML and is reported separately.'
  ];
  if (Math.min(toksA.length, toksB.length) < minCosineWords) {
    limitations.push(`At least one page is short (${Math.min(toksA.length, toksB.length)} words; cosine is only treated as corroborating evidence above ${minCosineWords} words).`);
  }
  if (passages.length === 0) {
    limitations.push('No contiguous shared passage of the minimum length was found, so there is no quotable copied text.');
  }
  if (boilerAll.size > 0) {
    limitations.push('Words repeated across most pages of a site are excluded as site chrome.');
  }

  return {
    jaccard: round4(jac),
    jaccard3: round4(jac3),
    cosine: round4(cos),
    passages,
    longestPassageWords: longest,
    matchedWords,
    wordsA: rawA.length,
    wordsB: rawB.length,
    isFinding,
    matchType,
    verdict,
    sharedConventions,
    structural,
    signals: {
      shingle_jaccard_k5: round4(jac),
      shingle_jaccard_k3: round4(jac3),
      tfidf_cosine: round4(cos),
      longest_passage_words: longest,
      matched_passage_words: matchedWords,
      words_a: rawA.length,
      words_b: rawB.length,
      cosine_corroborated: distributedOverlap,
      structural_score: structural ? structural.score : null,
      shared_layout_conventions: layoutShared ? layoutShared.shared.map((x) => x.label) : [],
      thresholds: {
        min_shingle_jaccard: minJ,
        min_short_shingle_jaccard: minShort,
        min_tfidf_cosine: minC,
        min_passage_words: minPw,
        min_cosine_words: minCosineWords
      }
    },
    limitations,
    method: 'word-shingle Jaccard (k=5, k=3) + pair-wise TF-IDF cosine + longest common word passages' +
      (structural ? ' + structural comparison' : ''),
    explanation: {
      jaccard: `${round4(jac)} of ${config.sim.shingleSize}-word shingles overlap between the two pages`,
      jaccard3: `${round4(jac3)} of 3-word shingles overlap (catches short lifted phrases)`,
      cosine: `${round4(cos)} TF-IDF cosine for this specific page pair (corpus-weighted)`,
      passages: `${passages.length} shared passage(s) of ${minPw}+ words, longest ${longest} words (${matchedWords} words total in matched passages)`,
      structural: structural
        ? `${structural.score} structural similarity across headings, sections, links, CTAs, images and form fields`
        : 'Structural comparison not requested for this pair'
    }
  };
}

// Human explanation of a verdict, used by the API and the UI.
function verdictExplanation(verdict) {
  switch (verdict) {
    case 'verbatim_passage':
      return 'A long contiguous passage appears on both pages word for word. This is the strongest textual evidence the tool can show; compare the excerpts and the page history before drawing conclusions.';
    case 'copied_passage':
      return 'A short contiguous passage appears on both pages word for word. Check whether the phrase is a quotation, a shared term, or original wording.';
    case 'high_shingle_overlap':
      return 'The wording overlaps far beyond what unrelated pages in the same industry produce, even without one long identical passage.';
    case 'distributed_overlap':
      return 'Similar vocabulary appears at higher rates than unrelated pages normally show, but no contiguous shared passage was found. This is weak evidence: common industry language explains it often.';
    case 'shared_conventions':
      return 'The layout and structure look alike, but the words do not. This pattern is normal for sites built on the same template or following the same design conventions, and is not evidence that content was copied.';
    default:
      return 'No meaningful textual overlap was found between these pages.';
  }
}

function round4(x) {
  return Math.round(x * 10000) / 10000;
}

module.exports = {
  normalizeText, tokenize, shingleSet, jaccard, tfidfVectors, tfidfVector, cosine, cosineForPair,
  findPassages, boilerplateTokens, compareTexts, filterTokens, compareStructure, verdictExplanation,
  documentFrequencies, layoutShape, sharedLayoutConventions, SHORT_SHINGLE_K, round4
};
