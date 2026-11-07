'use strict';
// AI report -> PDF.
//
// This is a pure formatter over a stored ai_reports row: it reads what the
// pipeline already decided and never adds a claim of its own. Three rules drive
// the layout:
//   1. every statement keeps its provenance label (fact / inference / unverified),
//      its confidence and the evidence ids it was validated against;
//   2. a missing section says it is missing instead of being smoothed over;
//   3. no number, price or competitor is ever produced here - if the evidence was
//      not collected, the section states that plainly.
const { createDocument, renderPdfPages } = require('./engine');

const CLAIM_LABEL = {
  explicit: 'FACT (stated on the page)',
  inferred: 'INFERENCE (not stated outright)',
  unverified: 'UNVERIFIED (not confirmed by evidence)'
};

const KIND_LABEL = {
  overview: 'Overview',
  feature: 'Capability',
  pricing: 'Pricing',
  positioning: 'Positioning',
  differentiator: 'Differentiator'
};

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function claimLabel(claim) {
  return CLAIM_LABEL[String(claim || '').toLowerCase()] || 'UNCLASSIFIED';
}

function findingLine(f) {
  const label = claimLabel(f.claim);
  const conf = f.confidence ? `confidence: ${f.confidence}` : 'confidence: not stated';
  const ids = asArray(f.evidence_ids);
  const ev = ids.length ? `evidence: ${ids.join(', ')}` : 'evidence: none recorded';
  return `${label} | ${conf} | ${ev}`;
}

function pricingFindings(competitor) {
  return (competitor.findings || []).filter((f) => String(f.kind).toLowerCase() === 'pricing');
}

// Renders the report body as a document of { text, style } lines.
function buildAiReportDocument({ workspaceName, scanId, report, history }) {
  const doc = createDocument();
  const body = (report && report.body) || {};
  const competitors = Array.isArray(body.competitors) ? body.competitors : [];
  const coverage = body.coverage || {};
  const missing = asArray(coverage.competitors_without_findings);
  const findingsTotal = competitors.reduce((n, c) => n + ((c.findings || []).length), 0);
  const snapshot = report && report.evidence_snapshot ? report.evidence_snapshot : {};
  const snapshotFindings = asArray(snapshot.findings).length;
  const snapshotPages = asArray(snapshot.pages).length;

  doc.push('SaaS Shield - Competitor Intelligence Report', 'h');
  doc.push(`Workspace: ${workspaceName || '(deleted)'}`);
  doc.push(`Scan: ${scanId}`);
  doc.push(`Report version: ${report ? report.version : 'unknown'} (status: ${report ? report.status : 'unknown'})`);
  doc.push(`Generated: ${(body.generated_at || (report && report.created_at) || 'unknown')} (UTC)`);
  doc.push(`Provider: ${(report && report.provider) || body.provider || 'unknown'} | Model: ${(report && report.model) || body.model || 'unknown'}`);
  doc.push(`Analysis version: ${(report && report.analysis_version) || body.analysis_version || 'unknown'} | Prompt version: ${body.prompt_version || 'unknown'}`);
  doc.push(`Competitors analysed: ${competitors.length} | Findings: ${findingsTotal} | Evidence referenced: ${snapshotFindings} findings, ${snapshotPages} evidence records`);
  doc.push('');

  doc.push('How to read this report', 'h');
  doc.push('Every statement below came from text that was actually collected from a public page. Each one carries a provenance label:');
  doc.push('- FACT: the competitor states this on its own page.');
  doc.push('- INFERENCE: a reading of the evidence that the page does not state outright. Treat as a hypothesis to check.');
  doc.push('- UNVERIFIED: the model proposed it but the evidence did not confirm it. Do not act on it as fact.');
  doc.push('Nothing in this report is a legal finding. Similarity between pages is a signal for human review, not proof of copying.');
  doc.push('');

  if (missing.length) {
    doc.push('Partial coverage', 'h');
    doc.push(`${missing.length} competitor(s) produced no findings: ${missing.join(', ')}.`);
    doc.push('Their absence from a section is not evidence that they lack the capability. It means the collected evidence did not say.');
    doc.push('');
  }

  // 1. Executive summary
  doc.push('1. Executive summary', 'h');
  if (body.executive_summary) doc.push(body.executive_summary);
  else doc.push('Not available: the synthesis step produced no executive summary for this report.');
  doc.push('');

  // 2. Competitor overview
  doc.push('2. Competitor overview', 'h');
  if (!competitors.length) {
    doc.push('No competitors were analysed in this report.');
  } else {
    for (const c of competitors) {
      doc.push(`${c.name || c.domain || c.competitor_id}${c.domain ? ` (${c.domain})` : ''}`, 'h');
      const overviews = (c.findings || []).filter((f) => ['overview', 'differentiator'].includes(String(f.kind).toLowerCase()));
      if (!overviews.length) doc.push('No overview findings. The collected pages did not support one.');
      for (const f of overviews) {
        doc.push(`- ${f.statement}`);
        if (f.detail) doc.push(`  ${f.detail}`);
        doc.push(`  ${findingLine(f)}`);
      }
      if ((c.sources || []).length) doc.push(`  Sources: ${c.sources.join(' ')}`);
    }
  }
  doc.push('');

  // 3. Feature comparison
  doc.push('3. Feature comparison', 'h');
  const common = asArray((body.comparison || {}).common_features);
  const unique = asArray((body.comparison || {}).unique_features);
  doc.push('Shared capabilities (reported for more than one competitor):', 'h');
  if (!common.length) doc.push('None identified from the collected evidence.');
  for (const f of common) doc.push(`- ${f.feature}${(f.competitors || []).length ? ` (seen at: ${(f.competitors || []).join(', ')})` : ''}`);
  doc.push('Capabilities reported for a single competitor:', 'h');
  if (!unique.length) doc.push('None identified from the collected evidence.');
  for (const f of unique) doc.push(`- ${f.feature}${f.competitor ? ` (${f.competitor})` : ''}`);
  if (!common.length && !unique.length) {
    doc.push('The evidence did not support a feature comparison for this scan.');
  }
  doc.push('');
  doc.push('Per-competitor capabilities:', 'h');
  for (const c of competitors) {
    const feats = (c.findings || []).filter((f) => String(f.kind).toLowerCase() === 'feature');
    doc.push(`${c.name || c.domain}:`, 'h');
    if (!feats.length) doc.push('  No capability findings for this competitor.');
    for (const f of feats) {
      doc.push(`  - ${f.statement}`);
      if (f.detail) doc.push(`    ${f.detail}`);
      doc.push(`    ${findingLine(f)}`);
    }
  }
  doc.push('');

  // 4. Pricing comparison
  doc.push('4. Pricing comparison', 'h');
  const anyPricing = competitors.some((c) => pricingFindings(c).length > 0);
  if (!anyPricing) {
    doc.push('No pricing evidence was collected for this scan, so no prices are shown.');
    doc.push('Prices are never inferred from another competitor and never estimated. If a plan page was not captured, the price is unknown.');
  } else {
    for (const c of competitors) {
      const rows = pricingFindings(c);
      doc.push(`${c.name || c.domain}:`, 'h');
      if (!rows.length) doc.push('  No pricing evidence collected for this competitor. Price unknown.');
      for (const f of rows) {
        doc.push(`  - ${f.statement}`);
        if (f.detail) doc.push(`    ${f.detail}`);
        doc.push(`    ${findingLine(f)}`);
      }
    }
  }
  doc.push('');

  // 5. Positioning
  doc.push('5. Positioning comparison', 'h');
  const positioning = competitors.flatMap((c) => (c.findings || [])
    .filter((f) => String(f.kind).toLowerCase() === 'positioning')
    .map((f) => ({ c, f })));
  if (!positioning.length) doc.push('No positioning findings were supported by the collected evidence.');
  for (const { c, f } of positioning) {
    doc.push(`${c.name || c.domain}:`, 'h');
    doc.push(f.statement);
    if (f.detail) doc.push(f.detail);
    doc.push(findingLine(f));
  }
  doc.push('');

  // 6. Competitive gaps
  doc.push('6. Competitive gaps', 'h');
  const gaps = asArray(body.gaps);
  if (!gaps.length) doc.push('No gaps were identified from the collected evidence.');
  for (const g of gaps) {
    doc.push(`- ${g.gap}${g.confidence ? ` (confidence: ${g.confidence})` : ''}`);
    for (const e of asArray(g.evidence)) doc.push(`  evidence: ${e}`);
  }
  doc.push('');

  // 7. SWOT-style findings
  doc.push('7. SWOT-style findings', 'h');
  const swot = asArray(body.swot);
  const buckets = [['strength', 'Strengths'], ['weakness', 'Weaknesses'], ['opportunity', 'Opportunities'], ['threat', 'Threats']];
  if (!swot.length) doc.push('No SWOT entries were supported by the collected evidence.');
  for (const [key, label] of buckets) {
    const rows = swot.filter((s) => String(s.bucket).toLowerCase() === key);
    doc.push(label, 'h');
    if (!rows.length) doc.push('  none supported by the evidence');
    for (const s of rows) {
      doc.push(`  - ${s.point}${s.competitor ? ` [${s.competitor}]` : ''}${s.confidence ? ` (confidence: ${s.confidence})` : ''}`);
    }
  }
  doc.push('');

  // 8. Opportunities / recommendations
  doc.push('8. Actionable opportunities', 'h');
  const recs = asArray(body.recommendations);
  if (!recs.length) doc.push('No recommendations were produced for this report.');
  recs.forEach((r, i) => {
    doc.push(`${i + 1}. ${r.recommendation}`, 'h');
    doc.push(`   Why: ${r.reason || 'not stated'}`);
    doc.push(`   Supported by: ${asArray(r.supporting_competitors).join(', ') || 'no competitor cited'}`);
    doc.push(`   Confidence: ${r.confidence || 'not stated'}${r.limitations ? ` | Limitation: ${r.limitations}` : ''}`);
  });
  doc.push('');

  // 9. Evidence and sources
  doc.push('9. Evidence and sources', 'h');
  doc.push(`Evidence snapshot: ${snapshotFindings} findings and ${snapshotPages} evidence records were referenced when this report was generated.`);
  for (const c of competitors) {
    const urls = asArray(c.sources);
    doc.push(`${c.name || c.domain}: ${urls.length ? urls.join(' ') : 'no source URLs recorded'}`, 'h');
    const ids = [...new Set((c.findings || []).flatMap((f) => asArray(f.evidence_ids)))];
    if (ids.length) doc.push(`  Evidence ids: ${ids.join(', ')}`);
  }
  doc.push('');

  // 10. Confidence and limitations
  doc.push('10. Confidence and limitations', 'h');
  doc.push('Confidence values are the model\'s own, bounded by how much text was collected. Low confidence means the evidence was thin.');
  doc.push('Facts describe what a page said on the day it was captured. Pages change: re-run the scan to refresh them.');
  doc.push('Inferences and recommendations are hypotheses. They are not verified facts and are not verified prices.');
  if (coverage.limitation) doc.push(`Coverage note: ${coverage.limitation}`);
  doc.push('This report does not prove ownership, intent, infringement or copying, and it makes no legal conclusion.');
  doc.push('');

  // Historical versions
  const versions = asArray(history);
  if (versions.length > 1) {
    doc.push('Report history', 'h');
    doc.push('Earlier versions are kept. This export contains the newest one only.');
    for (const v of versions) {
      doc.push(`- v${v.version} | ${v.status} | ${v.provider}/${v.model} | analysis v${v.analysis_version} | ${v.created_at}`);
    }
  }

  return doc;
}

function renderAiReportPdf(input) {
  return renderPdfPages(buildAiReportDocument(input).finish());
}

module.exports = { buildAiReportDocument, renderAiReportPdf, claimLabel };
