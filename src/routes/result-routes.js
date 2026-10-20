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
    const site = db.prepare('SELECT normalized_domain FROM websites WHERE id=? AND workspace_id=?').get(q.website_id, req.workspace.id);
    if (!site) return res.status(400).json({ error: 'Unknown website filter.' });
    sql += ` AND (r.original_url LIKE ? ESCAPE '\\' OR r.comparison_url LIKE ? ESCAPE '\\')`;
    const like = `%${dbLike(site.normalized_domain)}%`;
    args.push(like, like);
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
  sql += ' ORDER BY r.jaccard_score DESC, r.last_observed_at DESC LIMIT ? OFFSET ?';
  args.push(Math.min(Number(q.limit) || 100, 200), Math.max(Number(q.offset) || 0, 0));

  const rows = db.prepare(sql).all(...args);
  res.json({
    results: rows.map((r) => ({
      id: r.id,
      scan_id: r.scan_id,
      original_url: r.original_url,
      comparison_url: r.comparison_url,
      match_type: r.match_type,
      jaccard_score: r.jaccard_score,
      cosine_score: r.cosine_score,
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

function dbLike(s) {
  return String(s).replace(/[\\%_]/g, (m) => '\\' + m);
}

module.exports = router;
