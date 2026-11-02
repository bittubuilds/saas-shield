'use strict';
const express = require('express');
const db = require('../db');
const { newId, utcNow } = require('../util');
const { requireAuth, requireWorkspace, audit } = require('../auth');

const router = express.Router();
router.use(requireAuth);

// Result list with filters: website, score range, status, date
router.get('/workspaces/:workspaceId/results', requireWorkspace(), (req, res) => {
  const q = req.query;
  let sql = `SELECT r.* FROM results r WHERE r.workspace_id = ?`;
  const args = [req.workspace.id];

  if (q.website_id) {
    // Exact page ownership instead of a domain substring: a LIKE on the domain
    // also matched look-alike domains (example.com matched notexample.com).
    const site = db.prepare('SELECT id FROM websites WHERE id=? AND workspace_id=?').get(q.website_id, req.workspace.id);
    if (!site) return res.status(400).json({ error: 'Unknown website filter.' });
    sql += ` AND (r.original_page_id IN (SELECT id FROM pages WHERE website_id=?)
                OR r.comparison_page_id IN (SELECT id FROM pages WHERE website_id=?))`;
    args.push(site.id, site.id);
  }
  if (q.scan_id) {
    // Findings for one run: the UI links to a scan, but the API had no way to scope
    // the list to it, so a thin scan showed another scan's findings.
    sql += ' AND (r.scan_id = ? OR r.latest_scan_id = ?)';
    args.push(String(q.scan_id), String(q.scan_id));
  }
  if (q.status && ['new', 'in_review', 'confirmed', 'dismissed'].includes(q.status)) {
    sql += ' AND r.status = ?';
    args.push(q.status);
  }
  if (q.min_score !== undefined && q.min_score !== '') {
    const n = Number(q.min_score);
    if (Number.isFinite(n)) { sql += ' AND r.jaccard_score >= ?'; args.push(n); }
  }
  if (q.max_score !== undefined && q.max_score !== '') {
    const n = Number(q.max_score);
    if (Number.isFinite(n)) { sql += ' AND r.jaccard_score <= ?'; args.push(n); }
  }
  if (q.match_type && ['long_passage', 'partial_passage', 'phrase', 'low_similarity'].includes(q.match_type)) {
    sql += ' AND r.match_type = ?'; args.push(q.match_type);
  }
  if (q.since) {
    const d = new Date(q.since);
    if (!Number.isNaN(d.getTime())) { sql += ' AND r.last_observed_at >= ?'; args.push(d.toISOString()); }
  }
  const countSql = sql.replace('SELECT r.* FROM results r', 'SELECT COUNT(*) c FROM results r');
  const total = db.prepare(countSql).get(...args).c;

  sql += ' ORDER BY r.jaccard_score DESC, r.last_observed_at DESC LIMIT ? OFFSET ?';
  const limit = Math.min(Number(q.limit) || 100, 200);
  const offset = Math.max(Number(q.offset) || 0, 0);
  args.push(limit, offset);

  const rows = db.prepare(sql).all(...args);
  res.json({
    total,
    has_more: offset + rows.length < total,
    limit,
    offset,
    results: rows.map((r) => ({
      id: r.id,
      scan_id: r.scan_id,
      original_url: r.original_url,
      comparison_url: r.comparison_url,
      match_type: r.match_type,
      jaccard_score: r.jaccard_score,
      cosine_score: r.cosine_score,
      structural_score: r.structural_score,
      verdict: safeJson(r.signals, {}).verdict || null,
      status: r.status,
      first_observed_at: r.first_observed_at,
      last_observed_at: r.last_observed_at
    }))
  });
});

// Result detail with passages + evidence + review history
router.get('/workspaces/:workspaceId/results/:id', requireWorkspace(), (req, res) => {
  const r = db.prepare('SELECT * FROM results WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!r) return res.status(404).json({ error: 'Result not found.' });
  const passages = db.prepare('SELECT * FROM passages WHERE result_id=? ORDER BY word_count DESC').all(r.id);
  const evidence = db.prepare('SELECT * FROM evidence WHERE result_id=?').get(r.id);
  const history = db.prepare(`SELECT re.*, u.email AS user_email FROM review_events re
                              LEFT JOIN users u ON u.id = re.user_id
                              WHERE re.result_id=? ORDER BY re.created_at DESC`).all(r.id);
  res.json({
    result: {
      ...r,
      passages,
      evidence: evidence ? {
        capture_status: evidence.capture_status,
        capture_error: evidence.capture_error,
        captured_at: evidence.captured_at,
        original_hash: evidence.original_hash,
        comparison_hash: evidence.comparison_hash,
        screenshot_ref: evidence.screenshot_ref,
        original_excerpt: evidence.original_excerpt,
        comparison_excerpt: evidence.comparison_excerpt
      } : null,
      review_history: history,
      signals: safeJson(r.signals, {}),
      limitations: safeJson(r.limitations, []),
      structural_score: r.structural_score,
      verdict_explanation: safeJson(r.signals, {}).verdict_explanation ||
        'Scores measure observed overlap between two fetched public pages; they are not a legal conclusion.',
      scoring_method: 'Deterministic comparison: word-shingle Jaccard (k=5) + TF-IDF cosine over scan corpus + longest common word passages. Scores measure textual overlap only, not probability of infringement.'
    }
  });
});

// Update review status
const STATUSES = ['new', 'in_review', 'confirmed', 'dismissed'];
router.patch('/workspaces/:workspaceId/results/:id', requireWorkspace(), (req, res) => {
  const r = db.prepare('SELECT * FROM results WHERE id=? AND workspace_id=?').get(req.params.id, req.workspace.id);
  if (!r) return res.status(404).json({ error: 'Result not found.' });
  const { status, note } = req.body || {};
  if (!STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of ${STATUSES.join(', ')}` });
  }
  db.prepare('UPDATE results SET status=?, updated_at=? WHERE id=?').run(status, utcNow(), r.id);
  db.prepare(`INSERT INTO review_events (id, result_id, workspace_id, user_id, from_status, to_status, note, created_at)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(newId('rev'), r.id, req.workspace.id, req.user.id, r.status, status, note ? String(note).slice(0, 500) : null, utcNow());
  audit(req.workspace.id, req.user.id, 'result.reviewed', { result_id: r.id, from: r.status, to: status });
  res.json({ result: { id: r.id, status } });
});

function safeJson(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

module.exports = router;
