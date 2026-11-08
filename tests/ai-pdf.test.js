'use strict';
// PDF export tests for the AI intelligence report.
//
// The PDF is generated from stored ai_reports rows, which this file writes
// directly. That keeps the tests on the formatter itself (what appears on the
// page, what is labelled, what is refused) and spends no AI quota.

process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.DATABASE_FILE = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'shield-ai-pdf-')) + '/test.db';
process.env.AUTH_RATE_LIMIT = '1000';
process.env.COOKIE_SECURE = 'false';
process.env.AUTH_REQUIRE_EMAIL_VERIFICATION = 'false';
process.env.AI_PROVIDER = 'mock';
process.env.AI_API_KEY = '';
process.env.GROQ_API_KEY = '';
process.env.AI_ANALYSE_RATE_LIMIT = '1000';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');

const { server } = require('../src/server');
const db = require('../src/db/index');
const store = require('../src/ai/store');
const { newId, utcNow } = require('../src/util');
const { renderAiReportPdf } = require('../src/pdf/ai-report-pdf');
const crypto = require('node:crypto');

let BASE = null;
async function ready() {
  if (BASE) return;
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  server.unref();
  BASE = `http://127.0.0.1:${server.address().port}/api`;
}

function client() {
  let cookie = null;
  return {
    async req(method, path, body) {
      await ready();
      const res = await fetch(BASE + path, {
        method,
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(cookie ? { cookie } : {})
        },
        body: body ? JSON.stringify(body) : undefined
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      // Decide by the response type, not the URL: an error for a .pdf path comes
      // back as JSON and the test has to be able to read it.
      const buf = Buffer.from(await res.arrayBuffer());
      const type = res.headers.get('content-type') || '';
      if (type.includes('application/pdf')) {
        return { status: res.status, buf, headers: res.headers, text: buf.toString('latin1') };
      }
      const text = buf.toString('utf8');
      let data = null;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, data, headers: res.headers };
    }
  };
}

// Pulls the visible text back out of the PDF content streams.
function pdfText(raw) {
  const out = [];
  const re = /\(((?:\\.|[^()\\])*)\)\s*Tj/g;
  let m;
  while ((m = re.exec(raw))) {
    out.push(m[1].replace(/\\([()\\])/g, '$1'));
  }
  return out.join('\n');
}

async function signup(email, workspaceName) {
  const c = client();
  const res = await c.req('POST', '/auth/signup', { email, password: 'longpassword1', workspace_name: workspaceName });
  assert.equal(res.status, 201, `signup failed: ${JSON.stringify(res.data)}`);
  return { client: c, wsId: res.data.workspace.id };
}

let seedSeq = 0;
function seedScan(workspaceId) {
  seedSeq += 1;
  const now = utcNow();
  const origId = newId('web');
  const compId = newId('web');
  db.prepare('INSERT INTO websites (id, workspace_id, submitted_url, normalized_domain, kind, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(origId, workspaceId, `https://mine${seedSeq}.test/`, `mine${seedSeq}.test`, 'original', now, now);
  db.prepare('INSERT INTO websites (id, workspace_id, submitted_url, normalized_domain, kind, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(compId, workspaceId, `https://acme${seedSeq}.test/`, `acme${seedSeq}.test`, 'comparison', now, now);
  const scanId = newId('scn');
  db.prepare(`INSERT INTO scans (id, workspace_id, original_website_id, comparison_website_id, status, params, created_at)
              VALUES (?,?,?,?,?, '{}', ?)`).run(scanId, workspaceId, origId, compId, 'completed', now);
  return { scanId, compId };
}

function finding(overrides) {
  return {
    kind: 'feature',
    statement: 'Tracks keyword rankings',
    detail: null,
    claim: 'explicit',
    confidence: 'high',
    evidence_ids: ['ev_1'],
    ...overrides
  };
}

function fullBody({ acme = 'acme.test', other = 'rival.test' } = {}) {
  return {
    executive_summary: 'Two SEO tools were compared from their own pricing and feature pages.',
    competitors: [
      {
        competitor_id: 'cmp_1',
        name: acme,
        domain: `${acme}`,
        findings: [
          finding({ kind: 'overview', statement: 'Acme is an SEO platform for startups', detail: 'Captured from the home page.' }),
          finding({ kind: 'feature', statement: 'Tracks keyword rankings', claim: 'explicit', confidence: 'high', evidence_ids: ['ev_1', 'ev_2'] }),
          finding({ kind: 'feature', statement: 'Likely built for agencies too', claim: 'inferred', confidence: 'low', evidence_ids: ['ev_3'] }),
          finding({ kind: 'pricing', statement: 'A Pro plan is shown at $29 per month', claim: 'explicit', confidence: 'high', evidence_ids: ['ev_4'] }),
          finding({ kind: 'positioning', statement: 'Positions itself as SEO without busywork', claim: 'explicit', confidence: 'medium', evidence_ids: ['ev_5'] }),
          finding({ kind: 'differentiator', statement: 'Alerts on ranking drops', claim: 'explicit', confidence: 'medium', evidence_ids: ['ev_6'] })
        ],
        sources: [`https://${acme}/pricing`, `https://${acme}/features`]
      },
      {
        competitor_id: 'cmp_2',
        name: other,
        domain: `${other}`,
        findings: [finding({ kind: 'feature', statement: 'Offers a public API', claim: 'explicit', confidence: 'medium', evidence_ids: ['ev_7'] })],
        sources: [`https://${other}/`]
      }
    ],
    comparison: {
      common_features: [{ feature: 'Keyword tracking', competitors: [acme, other] }],
      unique_features: [{ feature: 'Alerts on ranking drops', competitor: acme }]
    },
    gaps: [{ gap: 'No competitor documents a free tier', evidence: ['ev_4'], confidence: 'medium' }],
    swot: [
      { bucket: 'strength', point: 'Explicit pricing page', competitor: acme, confidence: 'high' },
      { bucket: 'opportunity', point: 'Free tier gap', competitor: null, confidence: 'low' }
    ],
    recommendations: [{
      recommendation: 'Ship a documented free tier',
      reason: 'No compared competitor shows a free plan on its pricing page',
      supporting_competitors: [acme],
      confidence: 'medium',
      limitations: 'Only two competitors were compared'
    }],
    coverage: { competitors_analysed: 2, competitors_without_findings: [], stages_expected: ['overview', 'features', 'pricing', 'positioning'], limitation: null },
    provider: 'mock',
    model: 'mock-1',
    analysis_version: 1,
    prompt_version: 'p1',
    generated_at: '2026-11-07T06:00:00.000Z'
  };
}

function saveReport(workspaceId, scanId, body, overrides = {}) {
  return store.saveReport({
    workspaceId,
    scanId,
    provider: overrides.provider || 'mock',
    model: overrides.model || 'mock-1',
    // analysis_version is an INTEGER column. SQLite accepted the old string
    // fixture silently; PostgreSQL rejects it, so the fixture says what the schema says.
    analysisVersion: overrides.analysisVersion || 1,
    competitors: (body.competitors || []).map((c) => ({ id: c.competitor_id, name: c.name, domain: c.domain })),
    evidenceSnapshot: { findings: ['aif_1', 'aif_2'], pages: ['ai_ev1', 'ai_ev2'] },
    body
  });
}

let owner;
let stranger;
before(async () => {
  owner = await signup('pdf-owner@example.test', 'PDF Owner');
  stranger = await signup('pdf-stranger@example.test', 'PDF Stranger');
});

test('the AI PDF export requires a session and workspace membership', async () => {
  const { scanId } = seedScan(owner.wsId);
  const anon = client();
  const res = await anon.req('GET', `/workspaces/${owner.wsId}/scans/${scanId}/ai/report.pdf`);
  assert.equal(res.status, 401);

  saveReport(owner.wsId, scanId, fullBody());
  const crossed = await stranger.client.req('GET', `/workspaces/${owner.wsId}/scans/${scanId}/ai/report.pdf`);
  assert.equal(crossed.status, 404, 'another workspace must not export this report');
});

test('a scan with no report returns a state, not an empty PDF', async () => {
  const { scanId } = seedScan(owner.wsId);
  const res = await owner.client.req('GET', `/workspaces/${owner.wsId}/scans/${scanId}/ai/report.pdf`);
  assert.equal(res.status, 404);
  assert.equal(res.data.code, 'no_report');
  assert.ok(res.data.state, 'the response says which state the analysis is in');
  assert.equal(res.text, undefined, 'no PDF body on a missing report');
});

test('the full report exports every required section with provenance', async () => {
  const { scanId } = seedScan(owner.wsId);
  saveReport(owner.wsId, scanId, fullBody());
  const res = await owner.client.req('GET', `/workspaces/${owner.wsId}/scans/${scanId}/ai/report.pdf`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/pdf/);
  assert.ok(res.buf.subarray(0, 5).toString() === '%PDF-', 'valid PDF header');

  const text = pdfText(res.text);
  for (const heading of [
    '1. Executive summary', '2. Competitor overview', '3. Feature comparison', '4. Pricing comparison',
    '5. Positioning comparison', '6. Competitive gaps', '7. SWOT-style findings', '8. Actionable opportunities',
    '9. Evidence and sources', '10. Confidence and limitations'
  ]) {
    assert.ok(text.includes(heading), `missing section: ${heading}`);
  }

  assert.ok(text.includes('Two SEO tools were compared'), 'executive summary text present');
  assert.ok(text.includes('Report version: 1'), 'report version recorded');
  assert.ok(text.includes('mock/mock-1') || (text.includes('mock') && text.includes('mock-1')), 'provider and model recorded');
  assert.ok(text.includes('Analysis version: 1'), 'analysis version recorded');
  assert.ok(text.includes('Evidence snapshot: 2 findings and 2 evidence records'), 'evidence snapshot recorded');

  // evidence references and source URLs
  assert.ok(text.includes('ev_1, ev_2'), 'finding cites its evidence ids');
  assert.ok(text.includes('https://acme.test/pricing'), 'source URL is printed');
  assert.ok(text.includes('Evidence ids:'), 'evidence id list per competitor');

  // verified facts versus inferences are distinguished on the page
  assert.ok(text.includes('FACT (stated on the page)'), 'explicit findings are labelled fact');
  assert.ok(text.includes('INFERENCE (not stated outright)'), 'inferred findings are labelled inference');
  assert.ok(text.includes('Likely built for agencies too'), 'the inference text is present');
  assert.ok(text.includes('confidence: high') && text.includes('confidence: low'), 'confidence is printed');
});

test('missing sections are stated, never filled in', () => {
  const pdf = renderAiReportPdf({
    workspaceName: 'Empty',
    scanId: 'scn_empty',
    report: {
      version: 1,
      status: 'completed',
      provider: 'mock',
      model: 'mock-1',
      analysis_version: 'an1',
      created_at: '2026-11-07T06:00:00.000Z',
      evidence_snapshot: { findings: [], pages: [] },
      body: { competitors: [], comparison: {}, gaps: [], swot: [], recommendations: [], coverage: {} }
    },
    history: []
  });
  const text = pdfText(pdf.toString('latin1'));
  assert.ok(text.includes('Not available: the synthesis step produced no executive summary'), 'no invented summary');
  assert.ok(text.includes('No competitors were analysed in this report'));
  assert.ok(text.includes('None identified from the collected evidence'), 'no invented features');
  assert.ok(text.includes('No pricing evidence was collected for this scan'), 'no invented pricing');
  assert.ok(text.includes('No gaps were identified from the collected evidence'));
  assert.ok(text.includes('No recommendations were produced for this report'));
  assert.ok(text.includes('none supported by the evidence'));
  assert.equal(/\$\d/.test(text), false, 'no price appears anywhere in an empty report');
});

test('a partially analysed report is labelled partial and keeps the unknown explicit', () => {
  const body = fullBody();
  body.coverage.competitors_without_findings = ['rival.test'];
  body.coverage.limitation = 'Some competitors produced no findings. Their absence is not evidence of missing capability.';
  body.competitors = body.competitors.filter((c) => c.name === 'acme.test');
  const pdf = renderAiReportPdf({
    workspaceName: 'Partial',
    scanId: 'scn_partial',
    report: { version: 3, status: 'completed', provider: 'mock', model: 'mock-1', analysis_version: 'an1', created_at: '2026-11-07T06:00:00.000Z', evidence_snapshot: { findings: ['a'], pages: ['b'] }, body },
    history: []
  });
  const text = pdfText(pdf.toString('latin1'));
  assert.ok(text.includes('Partial coverage'), 'partial runs are called out');
  assert.ok(text.includes('1 competitor(s) produced no findings: rival.test'));
  assert.ok(text.includes('is not evidence that they lack the capability'));
  assert.ok(text.includes('Coverage note:'), 'the synthesis limitation is carried over');
});

test('pricing is shown only where evidence exists, and never for the other competitor', () => {
  const body = fullBody();
  // remove all pricing findings
  body.competitors[0].findings = body.competitors[0].findings.filter((f) => f.kind !== 'pricing');
  body.competitors[1].findings = body.competitors[1].findings.filter((f) => f.kind !== 'pricing');
  const pdf = renderAiReportPdf({
    workspaceName: 'NoPricing',
    scanId: 'scn_pricing',
    report: { version: 1, status: 'completed', provider: 'mock', model: 'mock-1', analysis_version: 'an1', created_at: '2026-11-07T06:00:00.000Z', evidence_snapshot: { findings: [], pages: [] }, body },
    history: []
  });
  const text = pdfText(pdf.toString('latin1'));
  assert.ok(text.includes('No pricing evidence was collected for this scan, so no prices are shown.'));
  assert.ok(text.includes('Prices are never inferred from another competitor and never estimated.'));
  assert.equal(/\$\d/.test(text), false, 'no price is invented');
});

test('pricing for one competitor does not leak onto the other', () => {
  const body = fullBody();
  body.competitors[1].findings = body.competitors[1].findings.filter((f) => f.kind !== 'pricing');
  const pdf = renderAiReportPdf({
    workspaceName: 'Mixed',
    scanId: 'scn_mixed',
    report: { version: 1, status: 'completed', provider: 'mock', model: 'mock-1', analysis_version: 'an1', created_at: '2026-11-07T06:00:00.000Z', evidence_snapshot: { findings: [], pages: [] }, body },
    history: []
  });
  const text = pdfText(pdf.toString('latin1'));
  assert.ok(text.includes('A Pro plan is shown at $29 per month'), 'collected price is printed for acme');
  assert.ok(text.includes('No pricing evidence collected for this competitor. Price unknown.'), 'the other competitor is marked unknown');
  assert.equal((text.match(/\$\d/g) || []).length, 1, 'exactly one price appears in the document');
});

test('historical versions stay exportable after a newer report is generated', async () => {
  const { scanId } = seedScan(owner.wsId);
  const v1Body = fullBody();
  v1Body.executive_summary = 'VERSION ONE SUMMARY';
  const v1 = saveReport(owner.wsId, scanId, v1Body);
  const v2Body = fullBody();
  v2Body.executive_summary = 'VERSION TWO SUMMARY';
  const v2 = saveReport(owner.wsId, scanId, v2Body);
  assert.equal(v2.version, 2);

  const latest = await owner.client.req('GET', `/workspaces/${owner.wsId}/scans/${scanId}/ai/report.pdf`);
  assert.ok(pdfText(latest.text).includes('VERSION TWO SUMMARY'));
  assert.equal(pdfText(latest.text).includes('VERSION ONE SUMMARY'), false);

  const old = await owner.client.req('GET', `/workspaces/${owner.wsId}/scans/${scanId}/ai/report.pdf?version=${v1.version}`);
  assert.equal(old.status, 200);
  const oldText = pdfText(old.text);
  assert.ok(oldText.includes('VERSION ONE SUMMARY'), 'the old version still exports its own content');
  assert.ok(oldText.includes('Report history'), 'history is listed when more than one version exists');
  assert.ok(oldText.includes('v2 |'), 'newer versions are listed');

  // both rows still exist: exporting did not rewrite history
  const history = store.reportHistory({ workspaceId: owner.wsId, scanId });
  assert.equal(history.length, 2);

  const missing = await owner.client.req('GET', `/workspaces/${owner.wsId}/scans/${scanId}/ai/report.pdf?version=99`);
  assert.equal(missing.status, 404);
  const bad = await owner.client.req('GET', `/workspaces/${owner.wsId}/scans/${scanId}/ai/report.pdf?version=abc`);
  assert.equal(bad.status, 400);
});

test('untrusted page text cannot break out of the PDF content stream', () => {
  const body = fullBody();
  body.competitors[0].findings[0].statement = 'Acme says ) Tj 0 0 Td (injected and \\ backslash and caf\u00e9 \u2014 dash';
  const pdf = renderAiReportPdf({
    workspaceName: 'Injection',
    scanId: 'scn_inject',
    report: { version: 1, status: 'completed', provider: 'mock', model: 'mock-1', analysis_version: 'an1', created_at: '2026-11-07T06:00:00.000Z', evidence_snapshot: { findings: [], pages: [] }, body },
    history: []
  });
  const raw = pdf.toString('latin1');
  assert.ok(raw.startsWith('%PDF-1.4'));
  assert.ok(raw.includes('\\) Tj 0 0 Td \\(injected'), 'parentheses are escaped, not left as operators');
  assert.ok(raw.includes('caf?'), 'non-ASCII is transliterated, not emitted raw');
  // the document still parses back to text with our own extractor
  assert.ok(pdfText(raw).includes('injected'));
});

test('the deterministic report export is unchanged by sharing the PDF engine', async () => {
  const res = await owner.client.req('GET', `/workspaces/${owner.wsId}/reports/export.pdf`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/pdf/);
  assert.ok(res.buf.subarray(0, 5).toString() === '%PDF-');
  assert.ok(pdfText(res.text).includes('SaaS Shield - Potential Content Similarity Report'));
  assert.ok(pdfText(res.text).includes('Methodology'));
});

test('the deterministic PDF output is byte-for-byte what it was before the engine extraction', () => {
  // Golden hash captured from the pre-refactor renderer. If the shared engine ever
  // changes the deterministic report, this fails instead of silently shifting
  // every exported PDF a customer already has.
  const { renderPdf } = require('../src/routes/report-routes');
  const fixture = {
    workspace: { name: 'Parity Workspace' },
    generated_at: '2026-11-07T06:00:00.000Z',
    findings_count: 1,
    methodology: ['M1', 'M2'],
    limitations: ['L1'],
    findings: [{
      original_url: 'https://a.test/x',
      comparison_url: 'https://b.test/y',
      match_type: 'exact',
      status: 'new',
      similarity: { jaccard_score: '0.91', cosine_score: '0.88' },
      first_observed_at: 't1',
      last_observed_at: 't2',
      evidence: { captured_at: 't3', capture_status: 'captured', original_hash: 'aaaaaaaaaaaaaaaaaaaa', comparison_hash: 'bbbbbbbbbbbbbbbbbbbb', screenshot_ref: null },
      passages: [{ word_count: 12, original_text: 'hello (world) test', comparison_text: 'dash - cafe' }]
    }]
  };
  const pdf = renderPdf(fixture);
  assert.equal(pdf.length, 2108, 'page layout unchanged');
  assert.equal(
    crypto.createHash('sha256').update(pdf).digest('hex'),
    '44d75c2e31de0a74b97e9eb27661a5cbb60bc32520a4c40d1f69cd24c4a9456d'
  );
});
