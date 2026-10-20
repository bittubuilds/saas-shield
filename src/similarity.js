'use strict';
// Deterministic similarity detection engine.
//
// Methods (all reported, no random numbers anywhere):
//   1. Word shingle (n-gram) Jaccard overlap  - "jaccard_score"
//   2. TF-IDF cosine similarity               - "cosine_score"
//   3. Longest/long common passage extraction - matched excerpts for review
//
// A "similarity score" measures textual overlap only. It is NOT a probability
// of infringement and must never be presented as one.

const crypto = require('crypto');
const config = require('./config');

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------
function normalizeText(text) {
  if (typeof text !== 'string') return '';
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
  if (tokens.length < k) {
    if (tokens.length > 0) set.add(hashShingle(tokens));
    return set;
  }
  for (let i = 0; i + k <= tokens.length; i++) {
    set.add(hashShingle(tokens.slice(i, i + k)));
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

// TF-IDF cosine over a corpus of documents (list of token arrays).
// idf for a term = ln((N + 1) / (df + 1)) + 1 (smoothed).
function tfidfVectors(docTokensList) {
  const N = docTokensList.length;
  const df = new Map();
  for (const toks of docTokensList) {
    for (const t of new Set(toks)) df.set(t, (df.get(t) || 0) + 1);
  }
  const vecs = docTokensList.map((toks) => {
    const tf = termFreq(toks);
    const vec = new Map();
    for (const [t, count] of tf) {
      const idf = Math.log((N + 1) / ((df.get(t) || 0) + 1)) + 1;
      vec.set(t, count * idf);
    }
    // L2 normalize
    let norm = 0;
    for (const v of vec.values()) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    for (const [t, v] of vec) vec.set(t, v / norm);
    return vec;
  });
  return vecs;
}

function cosine(vecA, vecB) {
  let dot = 0;
  const [small, big] = vecA.size <= vecB.size ? [vecA, vecB] : [vecB, vecA];
  for (const [t, v] of small) {
    const w = big.get(t);
    if (w) dot += v * w;
  }
  return dot; // vectors are unit-length already
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
    i = best.bStart + best.len;   // skip past this match
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
// Main pair comparison.
// comparePages(textA, textB, opts) -> {
//   jaccard, cosine, passages[], isFinding, matchType, explanation
// }
// opts: { boilerplateA?:Set, boilerplateB?:Set, corpusTokens?:string[][] (for idf),
//         minWords?:number, isOriginalExcerptSource?:bool }
// ---------------------------------------------------------------------------
function compareTexts(textA, textB, opts = {}) {
  const rawA = tokenize(textA);
  const rawB = tokenize(textB);
  const toksA = filterTokens(rawA, opts.boilerplateA);
  const toksB = filterTokens(rawB, opts.boilerplateB);

  const setA = shingleSet(toksA);
  const setB = shingleSet(toksB);
  const jac = jaccard(setA, setB);

  // TF-IDF cosine over corpus if given, else just the pair.
  let cos;
  if (opts.corpusTokens && opts.corpusTokens.length > 1) {
    const vecs = tfidfVectors(opts.corpusTokens.map((t) => filterTokens(t, opts.boilerplateAll)));
    cos = cosine(vecs[0], vecs[1]);
  } else {
    const vecs = tfidfVectors([toksA, toksB]);
    cos = cosine(vecs[0], vecs[1]);
  }

  // Passage matching runs on the unfiltered token streams (passage text is
  // shown to humans, so we do not remove words from it). Passages that are
  // almost entirely site-wide boilerplate words (nav menus, footers) are
  // dropped so repeated templates are not treated as evidence.
  const boilerAll = new Set([...(opts.boilerplateA || []), ...(opts.boilerplateB || [])]);
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
  const minP = opts.minWords ?? config.sim.minPassageWords;

  const isFinding = jac >= minJ || cos >= minC || longest >= minP;

  let matchType = 'low_similarity';
  if (longest >= 100) matchType = 'long_passage';
  else if (longest >= minP) matchType = 'partial_passage';
  else if (isFinding) matchType = 'phrase';

  const matchedWords = passages.reduce((s, p) => s + p.wordCount, 0);

  return {
    jaccard: round4(jac),
    cosine: round4(cos),
    passages,
    longestPassageWords: longest,
    matchedWords,
    wordsA: rawA.length,
    wordsB: rawB.length,
    isFinding,
    matchType,
    method: 'word-shingle Jaccard (k=' + config.sim.shingleSize + ') + TF-IDF cosine + longest common word passages',
    explanation: {
      jaccard: `${round4(jac)} of ${config.sim.shingleSize}-word shingles overlap between the two pages`,
      cosine: `${round4(cos)} TF-IDF cosine similarity across the scan corpus`,
      passages: `${passages.length} shared passage(s) of ${minWordsDisplay(minP)}+ words, longest ${longest} words (${matchedWords} words total in matched passages)`
    }
  };
}

function minWordsDisplay(minP) {
  return minP;
}

function round4(x) {
  return Math.round(x * 10000) / 10000;
}

module.exports = {
  normalizeText, tokenize, shingleSet, jaccard, tfidfVectors, cosine,
  findPassages, boilerplateTokens, compareTexts, filterTokens
};
