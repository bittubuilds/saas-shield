'use strict';
// Minimal PDF 1.4 writer: plain Helvetica text, wrapped lines, multipage.
//
// Extracted from the deterministic report exporter so both exports share one
// engine. Nothing here renders user HTML: every string is flattened to Latin-safe
// text, which is also why a crawled page cannot inject active content into a PDF.
// The deterministic export's byte output is unchanged by the move.

function pdfEscape(s) {
  return String(s)
    .replace(/[\r\n]+/g, ' ')
    .replace(/[^\x20-\x7E]/g, (c) => { // keep ASCII; transliterate the rest
      const map = { '\u2018': "'", '\u2019': "'", '\u201c': '"', '\u201d': '"', '\u2013': '-', '\u2014': '-', '\u2026': '...', '\u00a9': '(c)', '\u2122': '(TM)' };
      return map[c] || '?';
    })
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function wrap(text, width) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width) {
      if (line) lines.push(line.trim());
      line = w;
    } else {
      line += ' ' + w;
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}

// A small line-oriented document builder. Callers push text; the engine handles
// wrapping, page splitting and the PDF object graph.
function createDocument({ maxWidth = 92, headingWidth = 70 } = {}) {
  const pages = [];
  let lines = [];
  const push = (text, style) => {
    const wrapped = wrap(text === undefined || text === null ? '' : text, style === 'h' ? headingWidth : maxWidth);
    for (const l of wrapped) lines.push({ text: l, style: style || 'n' });
  };
  const blank = () => { if (lines.length) lines.push({ text: '', style: 'n' }); };
  const newPage = () => { pages.push(lines); lines = []; };
  const finish = () => { pages.push(lines); return pages; };
  return { push, blank, newPage, finish, pages };
}

function renderPdfPages(pages) {
  const pageW = 595, pageH = 842, margin = 56, lineH = 13;

  // Assemble PDF objects.
  const objects = [];
  const addObj = (body) => { objects.push(body); return objects.length; }; // 1-indexed

  const fontId = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const boldFontId = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');

  const pageIds = [];
  const contentIds = [];
  for (const pageLines of pages) {
    // Split into real pages of ~50 lines each
    const chunks = [];
    for (let i = 0; i < pageLines.length; i += 48) chunks.push(pageLines.slice(i, i + 48));
    if (chunks.length === 0) chunks.push([]);
    for (const chunk of chunks) {
      const contentId = addObj(`<< /Length ${0} >>`); // placeholder, replaced below
      contentIds.push({ id: contentId, chunk });
    }
  }
  const numPageObjs = contentIds.length;
  const firstPageObjNum = objects.length + 1;
  for (const c of contentIds) {
    const pid = addObj(`<< /Type /Page /Parent ${firstPageObjNum + numPageObjs} 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /Font << /F1 ${fontId} 0 R /F2 ${boldFontId} 0 R >> >> /Contents ${c.id} 0 R >>`);
    pageIds.push(pid);
  }
  const pagesTreeId = addObj(`<< /Type /Pages /Kids [${pageIds.map((p) => `${p} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
  const catId = addObj(`<< /Type /Catalog /Pages ${pagesTreeId} 0 R >>`);

  // Fill in content streams
  let pos = 0;
  const out = [];
  const header = '%PDF-1.4\n';
  out.push(header);
  pos = header.length;
  const offsets = [0];

  const finalObjs = [];
  for (let i = 0; i < objects.length; i++) {
    let body = objects[i];
    const c = contentIds.find((x) => x.id === i + 1);
    if (c) {
      let stream = 'BT\n';
      let y = pageH - margin;
      for (const l of c.chunk) {
        const font = l.style === 'h' ? '/F2 11 Tf' : '/F1 9 Tf';
        stream += `1 0 0 1 ${margin} ${y} Tm\n${font}\n(${pdfEscape(l.text)}) Tj\n`;
        y -= lineH;
      }
      stream += 'ET\n';
      body = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`;
    }
    const s = `${i + 1} 0 obj\n${body}\nendobj\n`;
    offsets.push(pos);
    out.push(s);
    pos += Buffer.byteLength(s);
  }
  finalObjs.length = 0;
  const xrefStart = pos;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root ${catId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.concat([Buffer.from(out.join('')), Buffer.from(xref), Buffer.from(trailer)]);
}

module.exports = { pdfEscape, wrap, createDocument, renderPdfPages };
