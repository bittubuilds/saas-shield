'use strict';
// Structural extraction used by change monitoring and by the structural
// similarity signal. Everything returned is derived only from the fetched HTML.
const { decodeEntities, stripChrome, extractReadable } = require('./extract');

const MAX_HEADINGS = 120;
const MAX_LINKS = 200;
const MAX_IMAGES = 120;
const MAX_CTAS = 60;
const MAX_FORMS = 10;
const MAX_SECTIONS = 60;

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'gclid', 'fbclid', 'msclkid', 'mc_cid', 'mc_eid', 'ref', 'ref_src', 'igshid',
  'yclid', 'dclid', 'twclid', 'li_fat_id', '_hsenc', '_hsmi', 'vero_id'
]);

function collapse(s) {
  return decodeEntities(String(s || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function attr(tag, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const m = tag.match(re);
  if (!m) return null;
  return decodeEntities(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3] || '');
}

function resolveUrl(raw, baseUrl) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed || trimmed.startsWith('#') || /^(javascript|mailto|tel|data|blob):/i.test(trimmed)) return null;
  try {
    const u = new URL(trimmed, baseUrl);
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase()) || key.toLowerCase().startsWith('utm_')) u.searchParams.delete(key);
    }
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

function extractHeadings(html) {
  const out = [];
  const re = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;
  let m;
  while ((m = re.exec(html)) !== null && out.length < MAX_HEADINGS) {
    const text = collapse(m[2]).slice(0, 300);
    if (!text) continue;
    out.push({ level: Number(m[1]), text });
  }
  return out;
}

function extractLinks(html, baseUrl) {
  const out = [];
  const seen = new Set();
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  let m;
  while ((m = re.exec(html)) !== null && out.length < MAX_LINKS) {
    const tag = `<a ${m[1]}>`;
    const href = resolveUrl(attr(tag, 'href'), baseUrl);
    if (!href) continue;
    const text = collapse(m[2]).slice(0, 200);
    const key = `${href}|${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ href, text });
  }
  return out;
}

function extractImages(html, baseUrl) {
  const out = [];
  const seen = new Set();
  const re = /<img\b([^>]*)\/?>/gi;
  let m;
  while ((m = re.exec(html)) !== null && out.length < MAX_IMAGES) {
    const tag = `<img ${m[1]}>`;
    const src = resolveUrl(attr(tag, 'src') || attr(tag, 'data-src') || attr(tag, 'srcset'), baseUrl);
    if (!src) continue;
    const alt = collapse(attr(tag, 'alt') || '').slice(0, 200);
    if (seen.has(src)) continue;
    seen.add(src);
    out.push({ src, alt });
  }
  return out;
}

const CTA_CLASS_HINT = /(btn|button|cta|call-to-action|primary-action)/i;

function extractCtas(html) {
  const out = [];
  const seen = new Set();
  const push = (text) => {
    const t = collapse(text).slice(0, 120);
    if (!t || t.length < 2) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    if (out.length < MAX_CTAS) out.push(t);
  };
  let m;
  const btn = /<button\b([^>]*)>([\s\S]*?)<\/button\s*>/gi;
  while ((m = btn.exec(html)) !== null) push(m[2]);
  const inputBtn = /<input\b([^>]*)\/?>/gi;
  while ((m = inputBtn.exec(html)) !== null) {
    const tag = `<input ${m[1]}>`;
    const type = (attr(tag, 'type') || '').toLowerCase();
    if (type === 'submit' || type === 'button') push(attr(tag, 'value') || '');
  }
  const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  while ((m = anchor.exec(html)) !== null) {
    const tag = `<a ${m[1]}>`;
    const cls = `${attr(tag, 'class') || ''} ${attr(tag, 'role') || ''}`;
    if (!CTA_CLASS_HINT.test(cls)) continue;
    push(m[2]);
  }
  return out;
}

function extractForms(html, baseUrl) {
  const out = [];
  const re = /<form\b([^>]*)>([\s\S]*?)<\/form\s*>/gi;
  let m;
  while ((m = re.exec(html)) !== null && out.length < MAX_FORMS) {
    const tag = `<form ${m[1]}>`;
    const body = m[2];
    const fields = [];
    const fieldRe = /<(input|select|textarea)\b([^>]*)\/?>/gi;
    let f;
    while ((f = fieldRe.exec(body)) !== null && fields.length < 40) {
      const ftag = `<${f[1]} ${f[2]}>`;
      const name = attr(ftag, 'name') || attr(ftag, 'id') || '';
      const type = (attr(ftag, 'type') || (f[1] === 'select' ? 'select' : f[1] === 'textarea' ? 'textarea' : 'text')).toLowerCase();
      if (type === 'hidden' && !/csrf|token|nonce/i.test(name)) continue;
      if (!name && type === 'hidden') continue;
      fields.push({ name: name.slice(0, 80), type, required: /\brequired\b/i.test(ftag) });
    }
    let submit = '';
    const submitMatch = body.match(/<button\b[^>]*>([\s\S]*?)<\/button\s*>/i) ||
      body.match(/<input\b[^>]*type=["']submit["'][^>]*>/i);
    if (submitMatch) {
      submit = submitMatch[1] !== undefined
        ? collapse(submitMatch[1]).slice(0, 80)
        : collapse(attr(submitMatch[0], 'value') || '').slice(0, 80);
    }
    out.push({
      action: resolveUrl(attr(tag, 'action'), baseUrl) || null,
      method: (attr(tag, 'method') || 'get').toLowerCase(),
      fields,
      submit
    });
  }
  return out;
}

// Page sections: heading plus the amount of content that follows it. Used to
// detect added/removed sections without diffing every character.
function extractSections(html, text) {
  const headings = extractHeadings(html);
  const sections = [];
  if (headings.length === 0) {
    return { sections: [], words: String(text || '').trim().split(/\s+/).filter(Boolean).length };
  }
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  const perHeading = Math.max(1, Math.round(words / headings.length));
  for (const h of headings.slice(0, MAX_SECTIONS)) {
    sections.push({ level: h.level, heading: h.text, approxWords: perHeading });
  }
  return { sections, words };
}

function extractStructure(html, baseUrl, precomputedReadable) {
  const readable = precomputedReadable || extractReadable(html, baseUrl);
  const content = stripChrome(html);        // nav/header/footer removed
  const headings = extractHeadings(content);
  const links = extractLinks(content, baseUrl);
  const images = extractImages(content, baseUrl);
  const ctas = extractCtas(content);
  const forms = extractForms(html, baseUrl);   // forms live inside <form>, keep them
  const { sections, words } = extractSections(content, readable.text);

  return {
    title: readable.title,
    canonicalUrl: readable.canonicalUrl,
    metaDescription: readable.metaDescription,
    text: readable.text,
    headings,
    links,
    images,
    ctas,
    forms,
    sections,
    wordCount: words
  };
}

// Canonical key for a link/image so trivial differences (tracking params,
// trailing slash) do not look like content changes.
function normalizeAssetUrl(raw) {
  try {
    const u = new URL(raw);
    u.hash = '';
    let path = u.pathname.replace(/\/+$/, '');
    if (!path) path = '/';
    const params = [...u.searchParams.entries()]
      .filter(([k]) => !TRACKING_PARAMS.has(k.toLowerCase()) && !k.toLowerCase().startsWith('utm_'))
      .sort(([a], [b]) => a.localeCompare(b));
    const qs = params.length ? '?' + params.map(([k, v]) => `${k}=${v}`).join('&') : '';
    return `${u.hostname.toLowerCase()}${path}${qs}`;
  } catch {
    return String(raw || '');
  }
}

module.exports = {
  extractStructure,
  extractHeadings,
  extractLinks,
  extractImages,
  extractCtas,
  extractForms,
  extractSections,
  normalizeAssetUrl,
  resolveUrl,
  collapse
};
