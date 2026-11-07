'use strict';
// AI intelligence API. Every route is workspace-scoped by requireWorkspace,
// which rejects a workspace the session user is not a member of.

const express = require('express');
const db = require('../db/index');
const provider = require('../ai/provider');
const engine = require('../ai/engine');
const synth = require('../ai/synthesize');
const store = require('../ai/store');
const { renderAiReportPdf } = require('../pdf/ai-report-pdf');
const { rateLimit } = require('../auth');

const router = express.Router();
// Default stays 6 runs per minute per IP; the ceiling is read at request time so
// an operator can tune it without a code change, and tests can isolate it.
const analyseLimiter = (req, res, next) => rateLimit({
  limit: Number(process.env.AI_ANALYSE_RATE_LIMIT || 6),
  windowMs: 60 * 1000,
  bucket: 'ai-analyse'
})(req, res, next);

function scanInWorkspace(workspaceId, scanId) {
  return db.prepare('SELECT * FROM scans WHERE id=? AND workspace_id=?').get(scanId, workspaceId);
}

function statusPayload({ workspaceId, scanId }) {
  const analyses = store.analysesFor({ workspaceId, scanId });
  const counts = analyses.reduce((acc, a) => {
    acc[a.status] = (acc[a.status] || 0) + 1;
    return acc;
  }, {});
  const report = store.latestReport({ workspaceId, scanId });
  const status = !analyses.length ? 'not_started'
    : counts.paused ? 'paused'
      : counts.failed && !counts.completed ? 'failed'
        : counts.running || counts.pending ? 'running'
          : report ? 'completed' : 'analysed';
  return {
    ok: true,
    scan_id: scanId,
    status,
    provider: provider.config().provider,
    model: provider.config().model,
    ai_configured: provider.isConfigured(),
    counts,
    requests_used: store.requestsForScan(scanId),
    limits: engine.limits(),
    report: report ? { id: report.id, version: report.version, created_at: report.created_at } : null
  };
}

router.get('/workspaces/:workspaceId/scans/:scanId/ai', requireWorkspaceRoute(), (req, res) => {
  const workspaceId = req.workspace.id;
  if (!scanInWorkspace(workspaceId, req.params.scanId)) return res.status(404).json({ error: 'Scan not found.' });
  res.json(statusPayload({ workspaceId, scanId: req.params.scanId }));
});

router.post('/workspaces/:workspaceId/scans/:scanId/ai', requireWorkspaceRoute(), analyseLimiter, async (req, res) => {
  const workspaceId = req.workspace.id;
  const scanId = req.params.scanId;
  const scan = scanInWorkspace(workspaceId, scanId);
  if (!scan) return res.status(404).json({ error: 'Scan not found.' });
  if (!provider.isConfigured()) {
    return res.status(503).json({ error: 'AI analysis is not configured on this server.', code: 'not_configured' });
  }
  // Analysing half-crawled evidence would produce confident claims about pages
  // that were never read, so only a finished scan can be analysed.
  if (scan.status !== 'completed') {
    return res.status(409).json({ error: 'The scan has not finished yet.', code: 'scan_not_completed', scan_status: scan.status });
  }
  try {
    const result = await engine.runScanAI({ workspaceId, scanId });
    if (result.busy) {
      return res.status(409).json({
        error: 'Analysis is already running for this scan.',
        code: 'analysis_in_progress',
        status: statusPayload({ workspaceId, scanId })
      });
    }
    if (!result.ok) return res.status(409).json(result);
    if (!result.paused && result.canSynthesize) {
      const report = await synth.synthesize({ workspaceId, scanId });
      return res.json({ ...result, synthesis: report.ok ? { report_id: report.report_id, version: report.version } : report, status: statusPayload({ workspaceId, scanId }) });
    }
    res.json({ ...result, status: statusPayload({ workspaceId, scanId }) });
  } catch (e) {
    res.status(502).json({ error: 'AI analysis failed.', code: e.code || 'provider_error' });
  }
});

router.get('/workspaces/:workspaceId/scans/:scanId/ai/findings', requireWorkspaceRoute(), (req, res) => {
  const workspaceId = req.workspace.id;
  if (!scanInWorkspace(workspaceId, req.params.scanId)) return res.status(404).json({ error: 'Scan not found.' });
  const findings = store.findingsFor({ workspaceId, scanId: req.params.scanId });
  res.json({ findings, count: findings.length });
});

router.get('/workspaces/:workspaceId/scans/:scanId/ai/report', requireWorkspaceRoute(), (req, res) => {
  const workspaceId = req.workspace.id;
  if (!scanInWorkspace(workspaceId, req.params.scanId)) return res.status(404).json({ error: 'Scan not found.' });
  const report = store.latestReport({ workspaceId, scanId: req.params.scanId });
  if (!report) return res.status(404).json({ error: 'No AI report yet.', code: 'no_report' });
  res.json({ report, history: store.reportHistory({ workspaceId, scanId: req.params.scanId }) });
});

// PDF export of the AI report. Defaults to the newest version; ?version=N exports
// a specific stored one so an old report can be reproduced after newer runs.
router.get('/workspaces/:workspaceId/scans/:scanId/ai/report.pdf', requireWorkspaceRoute(), (req, res) => {
  const workspaceId = req.workspace.id;
  const scanId = req.params.scanId;
  if (!scanInWorkspace(workspaceId, scanId)) return res.status(404).json({ error: 'Scan not found.' });

  let report;
  if (req.query.version !== undefined) {
    if (!/^\d+$/.test(String(req.query.version))) return res.status(400).json({ error: 'version must be a positive integer.' });
    report = store.reportByVersion({ workspaceId, scanId, version: req.query.version });
    if (!report) return res.status(404).json({ error: 'Report version not found.', code: 'no_report' });
  } else {
    report = store.latestReport({ workspaceId, scanId });
    // No report is a state, not an empty document: the client shows "analysis
    // pending" from this response rather than downloading a blank PDF.
    if (!report) {
      const status = statusPayload({ workspaceId, scanId });
      return res.status(404).json({ error: 'No AI report yet.', code: 'no_report', state: status.status, counts: status.counts });
    }
  }

  const workspace = db.prepare('SELECT name FROM workspaces WHERE id=?').get(workspaceId);
  const pdf = renderAiReportPdf({
    workspaceName: workspace ? workspace.name : null,
    scanId,
    report,
    history: store.reportHistory({ workspaceId, scanId })
  });

  res.attachment(`saas-shield-ai-report-v${report.version}-${Date.now()}.pdf`);
  res.type('application/pdf').send(pdf);
});

// Lazy require avoids a circular dependency: auth.js loads routes indirectly.
function requireWorkspaceRoute() {
  return require('./_workspace-guard');
}

module.exports = router;
