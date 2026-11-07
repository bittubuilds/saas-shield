'use strict';
// AI intelligence API. Every route is workspace-scoped by requireWorkspace,
// which rejects a workspace the session user is not a member of.

const express = require('express');
const db = require('../db/index');
const provider = require('../ai/provider');
const engine = require('../ai/engine');
const synth = require('../ai/synthesize');
const store = require('../ai/store');
const { rateLimit } = require('../auth');

const router = express.Router();
const analyseLimiter = rateLimit({ limit: 6, windowMs: 60 * 1000, bucket: 'ai-analyse' });

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
  try {
    const result = await engine.runScanAI({ workspaceId, scanId });
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

// Lazy require avoids a circular dependency: auth.js loads routes indirectly.
function requireWorkspaceRoute() {
  return require('./_workspace-guard');
}

module.exports = router;
