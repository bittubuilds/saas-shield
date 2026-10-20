'use strict';
// Minimal, dependency-free HTML text extraction: strips scripts, styles, and
// common boilerplate (nav/header/footer/aside, cookie/consent banners),
// then produces normalized readable text plus title/canonical/meta.

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  hellip: '…', copy: '©', reg: '®', trade: '™', rsquo: '\u2019', lsquo: '\u2018',
  ldquo: '\u201c', rdquo: '\u201d', laquo: '«', raquo: '»', deg: '°', middot: '·',
  bull: '•', dagger: '†', sect: '§', para: '¶', eacute: 'é', egrave: 'è',
  agrave: 'à', ccedil: 'ç', uuml: 'ü', ouml: 'ö', auml: 'ä', szlig: 'ß'
};

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, name) => ENTITIES[name] || m);
}

const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'canvas', 'object', 'embed', 'form', 'select', 'option']);
const BOILERPLATE_TAGS = new Set(['nav', 'header', 'footer', 'aside']);
const BOILERPLATE_HINT = /(cookie|consent|gdpr|banner|navigation|menu|skip[-_ ]?to|subscribe|newsletter|social|share|breadcrumb|pagination|copyright|all rights reserved)/i;

function extractReadable(html, baseUrl) {
  const out = {
    title: '',
    canonicalUrl: null,
    metaDescription: '',
    text: ''
  };
  if (typeof html !== 'string') return out;

  // <title>
  const tm = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (tm) out.title = decodeEntities(tm[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim().slice(0, 300);

  // canonical
  const cm = html.match(/<link[^>]+rel=["']canonical["'][^>]*>/i) ||
             html.match(/<link[^>]+href=["'][^"']+["'][^>]+rel=["']canonical["'][^>]*>/i);
  if (cm) {
    const href = cm[0].match(/href=["']([^"']+)["']/i);
    if (href && baseUrl) {
      try {
        out.canonicalUrl = new URL(decodeEntities(href[1]), baseUrl).toString();
      } catch { /* ignore bad canonical */ }
    }
  }

  // meta description
  const md = html.match(/<meta[^>]+name=["']description["'][^>]*>/i) ||
             html.match(/<meta[^>]+property=["']og:description["'][^>]*>/i);
  if (md) {
    const c = md[0].match(/content=["']([^"']*)["']/i);
    if (c) out.metaDescription = decodeEntities(c[1]).replace(/\s+/g, ' ').trim().slice(0, 500);
  }

  // Strip tags we never want, and remove comments.
  let s = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|iframe|canvas|object|embed|form|select|option)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');

  // Remove boilerplate containers by walking with a simple scanner:
  // drop nav/header/footer/aside blocks and elements whose class/id look like boilerplate.
  s = removeTagBlocks(s, BOILERPLATE_TAGS);
  s = removeHintedDivs(s);

  // Convert block-level boundaries to spaces, strip remaining tags.
  s = s
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|section|article|main|ul|ol|table|dl|dd|dt|pre|figure)>/gi, ' \n ')
    .replace(/<br\s*\/?>/gi, ' \n ')
    .replace(/<[^>]+>/g, ' ');

  s = decodeEntities(s)
    .replace(/[\t\r]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/[ \u00a0]{2,}/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();

  out.text = s;
  return out;
}

function removeTagBlocks(s, tags) {
  for (const tag of tags) {
    const re = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
    let m;
    // Remove matching open/close pairs (non-nested assumption is acceptable for MVP).
    while ((m = re.exec(s)) !== null) {
      const closeRe = new RegExp(`</${tag}\\s*>`, 'gi');
      closeRe.lastIndex = m.index + m[0].length;
      const cm = closeRe.exec(s);
      if (cm) {
        s = s.slice(0, m.index) + ' ' + s.slice(cm.index + cm[0].length);
      } else {
        s = s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length);
      }
      re.lastIndex = 0;
    }
  }
  return s;
}

function removeHintedDivs(s) {
  // Drop <div|section> elements whose class/id contain boilerplate hints.
  const re = /<(div|section|span)\b[^>]*\b(class|id)\s*=\s*["'][^"']*["'][^>]*>/gi;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const attrs = m[0];
    if (!BOILERPLATE_HINT.test(attrs)) continue;
    const closeRe = new RegExp(`</${m[1]}\\s*>`, 'gi');
    closeRe.lastIndex = re.lastIndex;
    const cm = closeRe.exec(s);
    const end = cm ? cm.index + cm[0].length : re.lastIndex;
    out += s.slice(last, m.index) + ' ';
    last = end;
    re.lastIndex = end;
  }
  out += s.slice(last);
  return out;
}

// Extract same-site links for crawling, capped and normalized.
function extractLinks(html, baseUrl, sameSiteOnly = true) {
  const links = new Set();
  const base = new URL(baseUrl);
  const re = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null && links.size < 500) {
    const raw = decodeEntities(m[1].trim());
    if (!raw || raw.startsWith('mailto:') || raw.startsWith('tel:') || raw.startsWith('javascript:')) continue;
    let u;
    try {
      u = new URL(raw, baseUrl);
    } catch {
      continue;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
    if (sameSiteOnly && u.hostname !== base.hostname) continue;
    u.hash = '';
    links.add(u.toString());
  }
  return [...links];
}

module.exports = { extractReadable, extractLinks, decodeEntities };
