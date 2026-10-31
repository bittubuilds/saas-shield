'use strict';
// Deterministic diffing helpers. No fuzzy matching, no random output: the same
// two inputs always produce the same diff, which is what makes a changelog
// trustworthy.

const MAX_LCS_CELLS = 400000;   // ~630x630 units; above that use multiset diff

function splitUnits(text) {
  const out = [];
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    // Split long lines into sentences so a one-paragraph change does not
    // report the whole paragraph as removed and re-added.
    if (line.length <= 240) {
      out.push(line);
      continue;
    }
    const parts = line.split(/(?<=[.!?])\s+/);
    let buf = '';
    for (const part of parts) {
      if ((buf + ' ' + part).trim().length > 240 && buf) {
        out.push(buf.trim());
        buf = part;
      } else {
        buf = (buf + ' ' + part).trim();
      }
    }
    if (buf.trim()) out.push(buf.trim());
  }
  return out;
}

function normalizeUnit(unit) {
  return String(unit).toLowerCase().replace(/\s+/g, ' ').trim();
}

// Longest common subsequence diff over normalized units.
function lcsDiff(prevUnits, currUnits) {
  const a = prevUnits;
  const b = currUnits;
  if (a.length === 0 && b.length === 0) return { added: [], removed: [], kept: 0 };
  if (a.length === 0) return { added: b.slice(), removed: [], kept: 0 };
  if (b.length === 0) return { added: [], removed: a.slice(), kept: 0 };

  if (a.length * b.length > MAX_LCS_CELLS) {
    return multisetDiff(a, b);
  }

  const keyA = a.map(normalizeUnit);
  const keyB = b.map(normalizeUnit);
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint32Array(rows * cols);

  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const idx = i * cols + j;
      if (keyA[i] === keyB[j]) {
        table[idx] = table[(i + 1) * cols + (j + 1)] + 1;
      } else {
        const down = table[(i + 1) * cols + j];
        const right = table[i * cols + (j + 1)];
        table[idx] = down >= right ? down : right;
      }
    }
  }

  const added = [];
  const removed = [];
  let kept = 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (keyA[i] === keyB[j]) {
      kept++;
      i++; j++;
    } else if (table[(i + 1) * cols + j] >= table[i * cols + (j + 1)]) {
      removed.push(a[i]);
      i++;
    } else {
      added.push(b[j]);
      j++;
    }
  }
  while (i < a.length) { removed.push(a[i]); i++; }
  while (j < b.length) { added.push(b[j]); j++; }

  return { added, removed, kept };
}

function multisetDiff(a, b) {
  const counts = new Map();
  for (const unit of b) {
    const k = normalizeUnit(unit);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const removed = [];
  let kept = 0;
  for (const unit of a) {
    const k = normalizeUnit(unit);
    const c = counts.get(k) || 0;
    if (c > 0) {
      counts.set(k, c - 1);
      kept++;
    } else {
      removed.push(unit);
    }
  }
  const added = [];
  const remaining = new Map();
  for (const unit of a) {
    const k = normalizeUnit(unit);
    remaining.set(k, (remaining.get(k) || 0) + 1);
  }
  for (const unit of b) {
    const k = normalizeUnit(unit);
    const c = remaining.get(k) || 0;
    if (c > 0) remaining.set(k, c - 1);
    else added.push(unit);
  }
  return { added, removed, kept };
}

function wordsOf(units) {
  let n = 0;
  for (const unit of units) n += String(unit).trim().split(/\s+/).filter(Boolean).length;
  return n;
}

/**
 * Text change statistics between two page texts.
 * changeRatio is measured against the previous text so "how much of the page
 * changed" has a consistent meaning across short and long pages.
 */
function textChange(previousText, currentText) {
  const prevUnits = splitUnits(previousText);
  const currUnits = splitUnits(currentText);
  const { added, removed, kept } = lcsDiff(prevUnits, currUnits);
  const addedWords = wordsOf(added);
  const removedWords = wordsOf(removed);
  const prevWords = wordsOf(prevUnits);
  const changeRatio = prevWords === 0
    ? (currUnits.length > 0 ? 1 : 0)
    : Math.min(1, (addedWords + removedWords) / (prevWords * 2));
  return {
    added,
    removed,
    kept,
    addedWords,
    removedWords,
    previousWords: prevWords,
    currentWords: wordsOf(currUnits),
    changeRatio: Math.round(changeRatio * 10000) / 10000
  };
}

/**
 * Set diff over structured items (headings, links, images, ctas).
 * @param {Array} previous
 * @param {Array} current
 * @param {(item:any)=>string} keyFn identity used for comparison
 * @returns {{added:any[], removed:any[], unchanged:number}}
 */
function diffItems(previous, current, keyFn) {
  const prevMap = new Map();
  for (const item of previous || []) prevMap.set(keyFn(item), item);
  const currMap = new Map();
  for (const item of current || []) currMap.set(keyFn(item), item);
  const added = [];
  const removed = [];
  let unchanged = 0;
  for (const [key, item] of currMap) {
    if (prevMap.has(key)) unchanged++;
    else added.push(item);
  }
  for (const [key, item] of prevMap) {
    if (!currMap.has(key)) removed.push(item);
  }
  return { added, removed, unchanged };
}

module.exports = {
  splitUnits,
  lcsDiff,
  multisetDiff,
  textChange,
  diffItems,
  wordsOf,
  normalizeUnit
};
