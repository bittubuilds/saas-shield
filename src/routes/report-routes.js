'use strict';
const express = require('express');
const db = require('../db/index');
const config = require('../config');
const { requireAuth, requireWorkspace, audit } = require('../auth');

const router = express.Router();
router.use(requireAuth);

function safeJson(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

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
    const signals = safeJson(r.signals, {});
    const passages = db.prepare('SELECT original_text, comparison_text, word_count, score FROM passages WHERE result_id=? ORDER BY word_count DESC LIMIT 5').all(r.id);
    const evidence = db.prepare('SELECT * FROM evidence WHERE result_id=?').get(r.id);
    return {
      id: r.id,
      status: r.status,
      match_type: r.match_type,
      similarity: {
        jaccard_score: r.jaccard_score,
        cosine_score: r.cosine_score,
        structural_score: r.structural_score,
        verdict: signals.verdict || null,
        verdict_explanation: signals.verdict_explanation || null,
        signals,
        limitations: safeJson(r.limitations, []),
        method: signals.method || 'word-shingle Jaccard (k=5, k=3) + pair-wise TF-IDF cosine + longest common word passages'
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
      'Similarity is computed deterministically: 5-word and 3-word shingle Jaccard overlap, pair-wise TF-IDF cosine similarity, and extraction of the longest shared word passages.',
      'A cosine-only agreement is not treated as a finding unless short-phrase overlap also clears a floor. This prevents ordinary shared industry vocabulary from being reported as copying.',
      'Structural similarity (headings, sections, links, calls to action, images, form fields) is reported separately. Shared layout conventions produce high structural scores between unrelated sites and are not evidence of copying.',
      'Scores measure textual overlap between two public pages. A "potential match" means the system observed substantial shared text. It does NOT prove ownership, intent, or legal infringement.'
    ],
    limitations: [
      'Only pages accessible without login were analyzed.',
      'Screenshots are not captured in this build; evidence is the stored text excerpt and its SHA-256 content hash at capture time.',
      'Pages change over time; re-fetching a URL may produce different content.',
      'Generic phrases common in many websites can overlap without any copying.',
      'Visual similarity (screenshots, fonts, rendered layout) is not measured in this build.'
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
// PDF export. The writer now lives in src/pdf/engine.js so the AI report export
// can share it. The deterministic output is unchanged: same lines, same order,
// same 48-line page splitting, same byte layout.
// ---------------------------------------------------------------------------
const { createDocument, renderPdfPages } = require('../pdf/engine');

function renderPdf(report) {
  const doc = createDocument();
  const push = (text, style) => doc.push(text, style);

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
  return renderPdfPages(doc.finish());
}

module.exports = router;
// exported for the PDF byte-parity test
module.exports.renderPdf = renderPdf;
