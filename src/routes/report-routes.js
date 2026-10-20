'use strict';
const express = require('express');
const db = require('../db');
const config = require('../config');
const { requireAuth, requireWorkspace, audit } = require('../auth');

const router = express.Router();
router.use(requireAuth);

// Collect report data for one result or a whole workspace (filtered).
function buildReport(wsId, resultId) {
  let rows;
  if (resultId) {
    rows = db.prepare('SELECT * FROM results WHERE id=? AND workspace_id=?').all(resultId, wsId);
    if (rows.length === 0) return null;
  } else {
    rows = db.prepare(`SELECT * FROM results WHERE workspace_id=? AND status != 'dismissed'
                       ORDER BY jaccard_score DESC LIMIT 500`).all(wsId);
  }
  const findings = rows.map((r) => {
    const passages = db.prepare('SELECT original_text, comparison_text, word_count, score FROM passages WHERE result_id=? ORDER BY word_count DESC LIMIT 5').all(r.id);
    const evidence = db.prepare('SELECT * FROM evidence WHERE result_id=?').get(r.id);
    return {
      id: r.id,
      status: r.status,
      match_type: r.match_type,
      similarity: {
        jaccard_score: r.jaccard_score,
        cosine_score: r.cosine_score,
        method: 'word-shingle Jaccard (k=5) + TF-IDF cosine + longest common word passages'
      },
      original_url: r.original_url,
      comparison_url: r.comparison_url,
      first_observed_at: r.first_observed_at,
      last_observed_at: r.last_observed_at,
      evidence: evidence ? {
        capture_status: evidence.capture_status,
        captured_at: evidence.captured_at,
        original_hash: evidence.original_hash,
        comparison_hash: evidence.comparison_hash,
        screenshot_ref: evidence.screenshot_ref,
        original_excerpt: evidence.original_excerpt,
        comparison_excerpt: evidence.comparison_excerpt
      } : null,
      passages: passages.map((p) => ({
        word_count: p.word_count,
        original_text: p.original_text,
        comparison_text: p.comparison_text,
        passage_score: p.score
      }))
    };
  });
  const ws = db.prepare('SELECT * FROM workspaces WHERE id=?').get(wsId);
  return {
    generated_at: new Date().toISOString(),
    product: 'SaaS Shield',
    workspace: ws ? { id: ws.id, name: ws.name } : null,
    methodology: [
      'Content is fetched from the public URLs listed. Readable text is extracted, normalizing whitespace and Unicode, and removing common boilerplate (navigation, headers, footers, cookie notices) plus words that repeat across nearly all pages of the same site.',
      'Similarity is computed deterministically: 5-word shingle Jaccard overlap, TF-IDF cosine similarity across the scanned corpus, and extraction of the longest shared word passages.',
      'Scores measure textual overlap between two public pages. A "potential match" means the system observed substantial shared text. It does NOT prove ownership, intent, or legal infringement.'
    ],
    limitations: [
      'Only pages accessible without login were analyzed.',
      'Screenshots are not captured in this build; evidence is the stored text excerpt and its SHA-256 content hash at capture time.',
      'Pages change over time; re-fetching a URL may produce different content.',
      'Generic phrases common in many websites can overlap without any copying.'
    ],
    findings_count: findings.length,
    findings
  };
}

// JSON export
router.get('/workspaces/:workspaceId/reports/export', requireWorkspace(), (req, res) => {
  const report = buildReport(req.workspace.id, req.query.result_id || null);
  if (report === null) return res.status(404).json({ error: 'Result not found.' });
  res.attachment(`saas-shield-report-${Date.now()}.json`);
  res.type('application/json').send(JSON.stringify(report, null, 2));
  audit(req.workspace.id, req.user.id, 'report.exported', { format: 'json', result_id: req.query.result_id || null });
});

// PDF export (minimal dependency-free PDF writer, sanitized text only)
router.get('/workspaces/:workspaceId/reports/export.pdf', requireWorkspace(), (req, res) => {
  const report = buildReport(req.workspace.id, req.query.result_id || null);
  if (report === null) return res.status(404).json({ error: 'Result not found.' });
  const pdf = renderPdf(report);
  res.attachment(`saas-shield-report-${Date.now()}.pdf`);
  res.type('application/pdf').send(pdf);
  audit(req.workspace.id, req.user.id, 'report.exported', { format: 'pdf', result_id: req.query.result_id || null });
});

// ---------------------------------------------------------------------------
// Minimal PDF 1.4 writer: plain Helvetica text, wrapped lines, multipage.
// All content is flattened to Latin-safe text (no active content possible).
// ---------------------------------------------------------------------------
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

function renderPdf(report) {
  const pageW = 595, pageH = 842, margin = 56, lineH = 13;
  const maxW = 92; // chars per line at 9pt Helvetica
  const pages = [];
  let lines = [];

  const push = (text, style) => {
    const wrapped = wrap(text, style === 'h' ? 70 : maxW);
    for (const l of wrapped) lines.push({ text: l, style: style || 'n' });
  };
  const newPage = () => { pages.push(lines); lines = []; };

  push('SaaS Shield - Potential Content Similarity Report', 'h');
  push(`Workspace: ${report.workspace ? report.workspace.name : '(deleted)'}`);
  push(`Generated: ${report.generated_at} (UTC)`);
  push(`Findings included: ${report.findings_count}`);
  push('', 'n');
  push('Methodology', 'h');
  report.methodology.forEach((m) => push(m));
  push('', 'n');
  push('Limitations', 'h');
  report.limitations.forEach((m) => push(m));
  push('', 'n');
  push('Findings', 'h');
  if (report.findings_count === 0) push('No findings to report.');

  for (const f of report.findings) {
    push('', 'n');
    push(`Potential match: ${f.original_url}`, 'h');
    push(`Comparison page: ${f.comparison_url}`);
    push(`Type: ${f.match_type} | Jaccard: ${f.similarity.jaccard_score} | TF-IDF cosine: ${f.similarity.cosine_score} | Review status: ${f.status}`);
    push(`First observed: ${f.first_observed_at} | Last observed: ${f.last_observed_at}`);
    if (f.evidence) {
      push(`Evidence captured: ${f.evidence.captured_at} (status: ${f.evidence.capture_status}). Content hashes: original ${f.evidence.original_hash.slice(0, 12)}..., comparison ${f.evidence.comparison_hash.slice(0, 12)}...`);
      push(`Screenshot: ${f.evidence.screenshot_ref || 'not captured in this build'}`);
    }
    f.passages.forEach((p, i) => {
      push('', 'n');
      push(`Shared passage ${i + 1} (${p.word_count} words):`, 'h');
      push(`Original: "${p.original_text.slice(0, 600)}${p.original_text.length > 600 ? '...' : ''}"`);
      push(`Comparison: "${p.comparison_text.slice(0, 600)}${p.comparison_text.length > 600 ? '...' : ''}"`);
    });
  }
  push('', 'n');
  push('This report records what the system observed on public pages. It does not independently prove ownership, intent, or legal infringement.', 'n');
  pages.push(lines);

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
  const pagesId = objects.length + pages.length + 1; // computed after loop, fix below
  // Simpler: allocate page objects now
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

  // We must emit objects in order with correct content streams.
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
  const xrefStart = pos;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root ${catId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.concat([Buffer.from(out.join('')), Buffer.from(xref), Buffer.from(trailer)]);
}

module.exports = router;
