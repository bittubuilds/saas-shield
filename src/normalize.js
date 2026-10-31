'use strict';
// Text normalization for change detection.
//
// Two different normalizations are needed and they must not be confused:
//   - normalizeReadable(): what a human reads in the changelog. Case and
//     punctuation preserved, only whitespace collapsed.
//   - normalizeForHash(): what decides "did this page change". Volatile values
//     that change on every request (timestamps, CSRF tokens, tracking ids,
//     cache busters, counters, "2 minutes ago") are replaced with placeholders
//     so a page that did not really change never raises an alert.
const crypto = require('crypto');

const MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';

// Ordered patterns applied before hashing. Each is deliberately narrow so we
// never erase meaningful copy (prices, plan names, feature names survive).
const VOLATILE_PATTERNS = [
  // ISO timestamps and dates
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, ' <TIMESTAMP> '],
  [/\b\d{4}-\d{2}-\d{2}\b/g, ' <DATE> '],
  // Long-form dates: "January 5, 2026", "5 Jan 2026"
  [new RegExp(`\\b(?:${MONTHS})\\.?\\s+\\d{1,2},?\\s+\\d{4}\\b`, 'gi'), ' <DATE> '],
  [new RegExp(`\\b\\d{1,2}\\s+(?:${MONTHS})\\.?,?\\s+\\d{4}\\b`, 'gi'), ' <DATE> '],
  // Clock times
  [/\b\d{1,2}:\d{2}(?::\d{2})?\s?(?:am|pm|UTC|GMT|[A-Z]{2,4})?\b/gi, ' <TIME> '],
  // Relative timestamps
  [/\b(?:just now|\d+\s*(?:seconds?|minutes?|hours?|days?|weeks?|months?)\s+ago)\b/gi, ' <RELATIVE_TIME> '],
  // Copyright year alone ("© 2026"): the year is not copy
  [/(©|\(c\)|copyright)\s*\d{4}(\s*[-–]\s*\d{4})?/gi, '$1 <YEAR> '],
  // CSRF / nonce / session-ish tokens and hash ids
  [/\b[0-9a-f]{32,}\b/gi, ' <HEXID> '],
  [/\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, ' <JWT> '],
  // Cache busters / version query strings
  [/([?&](?:v|ver|version|build|cb|cachebust|_)=\d{6,})/gi, ' <CACHEBUSTER> '],
  // Numeric counters that tick (visitor counts, "1,234 users online")
  [/\b\d[\d,]{3,}\s+(?:visitors?|users?|people|views?|downloads?)\s+(?:online|today|now)\b/gi, ' <COUNTER> '],
  // Absolute URLs with random query payloads are compared separately as links
  [/\s+/g, ' ']
];

// Elements/strings that are chrome rather than content.
const NOISE_LINE = /^(?:accept (?:all )?cookies?|we use cookies.*|cookie (?:settings|preferences)|manage (?:cookies|preferences)|this (?:website|site) uses cookies.*|subscribe|sign in|log in|no thanks|got it|close|x|menu|toggle navigation|skip to (?:main )?content|loading\.{0,3}|advertisement)$/i;

function collapseWhitespace(text) {
  return String(text == null ? '' : text)
    .replace(/\u00a0/g, ' ')
    .replace(/[\t\r\f\v]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function normalizeReadable(text) {
  return collapseWhitespace(text);
}

// Strip volatile values. `text` is expected to already be readable text.
function stripVolatile(text) {
  let out = String(text == null ? '' : text);
  for (const [re, rep] of VOLATILE_PATTERNS) out = out.replace(re, rep);
  return collapseWhitespace(out);
}

// Drop chrome-only lines and collapse repeated identical lines (a nav repeated
// three times is not three changes).
function dropNoiseLines(text) {
  const seen = new Set();
  const lines = [];
  for (const rawLine of normalizeReadable(text).split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (NOISE_LINE.test(line)) continue;
    if (line.length < 2) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(line);
  }
  return lines.join('\n');
}

// Canonical text used to decide whether anything materially changed.
function normalizeForHash(text) {
  const stripped = stripVolatile(dropNoiseLines(text));
  return stripped
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function hashText(text) {
  return crypto.createHash('sha256').update(String(text == null ? '' : text), 'utf8').digest('hex');
}

// Content hash for a snapshot: readable structure signals + normalized text, so
// a change in headings, prices, links or forms is never missed even when the
// normalized text happens to hash the same.
function snapshotHash({ text, title, headings, pricing, links, images, ctas, forms }) {
  const payload = JSON.stringify({
    text: normalizeForHash(text || ''),
    title: normalizeForHash(title || ''),
    headings: (headings || []).map((h) => normalizeForHash(h.text || '')),
    pricing: (pricing || []).map((p) => [p.name || '', p.amount == null ? '' : p.amount, p.currency || '', p.interval || '']),
    links: (links || []).map((l) => `${l.href}|${normalizeForHash(l.text || '')}`),
    images: (images || []).map((i) => `${i.src}|${normalizeForHash(i.alt || '')}`),
    ctas: (ctas || []).map((c) => normalizeForHash(c)),
    forms: (forms || []).map((f) => `${f.action || ''}|${(f.fields || []).map((x) => x.name).join(',')}|${normalizeForHash(f.submit || '')}`)
  });
  return hashText(payload);
}

function wordCount(text) {
  const t = String(text || '').trim();
  return t ? t.split(/\s+/).length : 0;
}

// Truncate long values for storage in a change row without losing the head of
// the difference (which is what a reader needs first).
function clip(text, max = 2000) {
  const s = String(text == null ? '' : text);
  return s.length <= max ? s : s.slice(0, max) + '…';
}

module.exports = {
  collapseWhitespace,
  normalizeReadable,
  normalizeForHash,
  stripVolatile,
  dropNoiseLines,
  hashText,
  snapshotHash,
  wordCount,
  clip
};
