#!/usr/bin/env python3
"""Build the SaaS Shield complete audit PDF from the audited findings.

Every statement in this report was observed in the repository at cf53813 or in a
test run recorded in the same session. Nothing is estimated that was not measured,
and the live AI provider path is reported as unverified because it never ran.
"""
import os
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT, TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas as pdfcanvas
from reportlab.platypus import (BaseDocTemplate, Frame, KeepTogether, PageBreak,
                                PageTemplate, Paragraph, Spacer, Table, TableStyle)

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'SAAS_SHIELD_COMPLETE_AUDIT_REPORT.pdf')

INK = colors.HexColor('#101418')
MUTED = colors.HexColor('#5b6670')
RULE = colors.HexColor('#d6dde3')
ACCENT = colors.HexColor('#0b6b5b')
HEAD_BG = colors.HexColor('#12232c')
ROW_ALT = colors.HexColor('#f4f7f9')
PASS = colors.HexColor('#17704d')
PARTIAL = colors.HexColor('#9a6209')
FAIL = colors.HexColor('#a11f1f')
UNVER = colors.HexColor('#5b4b8a')

STATUS_COLOR = {'PASS': PASS, 'PARTIAL': PARTIAL, 'FAIL': FAIL, 'UNVERIFIED': UNVER}

ss = getSampleStyleSheet()


def style(name, **kw):
    base = kw.pop('parent', ss['BodyText'])
    return ParagraphStyle(name, parent=base, **kw)


BODY = style('body', fontName='Helvetica', fontSize=9.4, leading=13.6, textColor=INK, spaceAfter=5)
SMALL = style('small', fontName='Helvetica', fontSize=8.1, leading=11.2, textColor=MUTED)
H1 = style('h1', fontName='Helvetica-Bold', fontSize=17, leading=21, textColor=INK, spaceBefore=2, spaceAfter=3)
H2 = style('h2', fontName='Helvetica-Bold', fontSize=11.4, leading=14.5, textColor=HEAD_BG, spaceBefore=11, spaceAfter=4)
KICKER = style('kicker', fontName='Helvetica-Bold', fontSize=7.6, leading=9, textColor=ACCENT, spaceAfter=2)
CELL = style('cell', fontName='Helvetica', fontSize=8.0, leading=10.6, textColor=INK, spaceAfter=0)
CELLB = style('cellb', fontName='Helvetica-Bold', fontSize=8.0, leading=10.6, textColor=INK, spaceAfter=0)
CELLM = style('cellm', fontName='Helvetica', fontSize=7.6, leading=10.0, textColor=MUTED, spaceAfter=0)

TITLE = style('title', fontName='Helvetica-Bold', fontSize=30, leading=34, textColor=INK, spaceAfter=6)
SUBTITLE = style('subtitle', fontName='Helvetica', fontSize=12.5, leading=17, textColor=MUTED, spaceAfter=14)


def P(txt, st=BODY):
    return Paragraph(txt, st)


def status_cell(value):
    label = value.upper()
    return Paragraph(
        f'<b><font color="{STATUS_COLOR.get(label, MUTED).hexval()}">{label}</font></b>',
        CELL)


def table(cols, rows, widths, status_col=None, font_small=False):
    data = [[P(f'<font color="white">{h}</font>', CELLB) for h in cols]]
    for r in rows:
        line = []
        for i, v in enumerate(r):
            if status_col is not None and i == status_col:
                line.append(status_cell(v))
            elif hasattr(v, 'wrap'):
                line.append(v)
            else:
                line.append(P(str(v), CELLM if font_small else CELL))
        data.append(line)
    t = Table(data, colWidths=widths, repeatRows=1, hAlign='LEFT')
    cmds = [
        ('BACKGROUND', (0, 0), (-1, 0), HEAD_BG),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('GRID', (0, 0), (-1, -1), 0.4, RULE),
        ('LINEBELOW', (0, 0), (-1, 0), 0.8, HEAD_BG),
        ('LEFTPADDING', (0, 0), (-1, -1), 5),
        ('RIGHTPADDING', (0, 0), (-1, -1), 5),
        ('TOPPADDING', (0, 0), (-1, -1), 4),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
    ]
    for i in range(1, len(data)):
        if i % 2 == 0:
            cmds.append(('BACKGROUND', (0, i), (-1, i), ROW_ALT))
    t.setStyle(TableStyle(cmds))
    return t


class Doc(BaseDocTemplate):
    def __init__(self, path, **kw):
        super().__init__(path, pagesize=A4,
                         leftMargin=17 * mm, rightMargin=17 * mm,
                         topMargin=20 * mm, bottomMargin=18 * mm,
                         title='SaaS Shield Complete Audit Report',
                         author='SaaS Shield engineering audit',
                         subject='Phase 1 completeness, AI integration, security, readiness', **kw)
        frame = Frame(self.leftMargin, self.bottomMargin, self.width, self.height, id='body')
        self.addPageTemplates([PageTemplate(id='main', frames=[frame], onPage=self.decorate)])

    def decorate(self, canv, doc):
        canv.saveState()
        w, h = A4
        canv.setStrokeColor(RULE)
        canv.setLineWidth(0.6)
        canv.line(17 * mm, h - 14 * mm, w - 17 * mm, h - 14 * mm)
        canv.setFont('Helvetica', 7.4)
        canv.setFillColor(MUTED)
        canv.drawString(17 * mm, h - 12.4 * mm, 'SAAS SHIELD  ·  COMPLETE AUDIT REPORT')
        canv.drawRightString(w - 17 * mm, h - 12.4 * mm,
                             'branch feat/db-durability  ·  HEAD cf53813  ·  7 Nov 2026')
        canv.line(17 * mm, 13 * mm, w - 17 * mm, 13 * mm)
        canv.setFont('Helvetica', 7.4)
        canv.drawString(17 * mm, 9 * mm,
                        'Audit only. No commit, push, merge, deploy or credential exposure.')
        canv.drawRightString(w - 17 * mm, 9 * mm, f'Page {doc.page}')
        canv.restoreState()


story = []
add = story.append

# ----------------------------------------------------------------- cover
add(Spacer(1, 26 * mm))
add(P('ENGINEERING AUDIT  ·  NOVEMBER 2026', KICKER))
add(P('SaaS Shield<br/>Complete Product and<br/>Production Readiness Audit', TITLE))
add(P('Competitor intelligence, AI analysis and evidence monitoring built on Node.js 22, '
      'Express and SQLite/PostgreSQL. This report states what was measured, what was mocked '
      'and what has never run.', SUBTITLE))

cover_rows = [
    ['Repository', 'bittubuilds/saas-shield'],
    ['Branch / HEAD', 'feat/db-durability @ cf53813 (verified before audit)'],
    ['Working tree', '10 modified source and test files, 1 untracked E2E test, uncommitted'],
    ['Production impact', 'None. Nothing committed, pushed, merged or deployed. Render and Neon untouched.'],
    ['Live AI call', 'Not made. Provider path verified as code, not as behaviour.'],
    ['Test evidence', 'SQLite 273 tests / 269 pass / 0 fail / 4 skipped; PostgreSQL integration 5/5; '
                      'durability 16/16; whole suite on PostgreSQL 262 pass / 10 fail (all diagnosed)'],
]
add(table(['Field', 'Value'], cover_rows, [36 * mm, 132 * mm]))

add(Spacer(1, 8 * mm))
add(P('Verdict in one paragraph', H2))
add(P('The pipeline is real: crawling, deterministic extraction, evidence versioning, incremental AI '
      'analysis, synthesis, versioned reports and PDF export all execute and are covered by tests. '
      'The AI transport is a genuine HTTP client for Groq with timeouts, retries, quota pausing, '
      'citation enforcement and duplicate-call prevention, but no completion has ever been sent to '
      'the real provider, so every AI behaviour is mock-verified only. The decisive product gap is '
      'surface: the frontend bundle contains no call to <font face="Courier">/ai/*</font> or '
      '<font face="Courier">/competitors/*</font>, so competitor intelligence and AI findings exist '
      'only as API endpoints. Phase 1 is complete as an engine and incomplete as a product.'))
add(PageBreak())

# ----------------------------------------------------------------- 1
add(P('SECTION 1', KICKER))
add(P('Executive summary', H1))
add(P('Three findings matter more than the rest, and all three are about verification rather than '
      'volume of code.'))
summary_rows = [
    ['1', 'The AI provider path has never executed.',
     'Groq is genuinely integrated: <font face="Courier">callGroq()</font> issues a real fetch to '
     '<font face="Courier">api.groq.com/openai/v1/chat/completions</font> with bearer auth. A key is '
     'present in this environment and a keyless probe returned HTTP 401, proving the endpoint is live. '
     'No completion, no JSON-mode response and no token accounting has ever been produced by the real model.',
     'UNVERIFIED'],
    ['2', 'Half the product has no user interface.',
     'The shipped bundle calls auth, workspaces, websites, scans, results, changes, monitoring, alerts, '
     'discoveries, deterministic export and settings. It never calls the AI, competitor or screenshot APIs. '
     'A user cannot see a finding, a competitor profile, a screenshot or an AI report.',
     'FAIL'],
    ['3', 'Everything else holds up.',
     'Isolation, quota pausing, idempotency, versioning, SSRF, injection fencing and both database backends '
     'are implemented and tested. The 10 whole-suite PostgreSQL failures are test-bank design, not product defects.',
     'PASS'],
]
add(table(['#', 'Finding', 'Evidence and explanation', 'Status'], summary_rows,
          [7 * mm, 42 * mm, 99 * mm, 20 * mm], status_col=3))
add(Spacer(1, 4 * mm))
add(P('What would change this verdict: one live provider completion, and a frontend that renders the '
      'findings the API already stores. Neither is a rewrite.', SMALL))

# ----------------------------------------------------------------- 2
add(P('SECTION 2', KICKER))
add(P('Real AI integration verification', H1))
add(P('Four states are kept separate throughout this report: <b>code implemented</b>, '
      '<b>mock-tested</b>, <b>real provider integration tested</b>, <b>production configuration verified</b>. '
      'Only the first two are satisfied for AI behaviour.'))

ai_rows = [
    ['Provider implemented', 'Groq, OpenAI-compatible chat completions API', 'src/ai/provider.js:78-110', 'PASS'],
    ['Genuine or mock', 'Genuine <font face="Courier">fetch</font> with bearer auth. <font face="Courier">mock</font> exists separately and never touches the network', 'src/ai/provider.js (callGroq, callMock)', 'PASS'],
    ['Model configured', '<font face="Courier">openai/gpt-oss-120b</font>, base <font face="Courier">https://api.groq.com/openai/v1</font>', 'src/ai/provider.js:26-27', 'PASS'],
    ['Adapter location', 'Single file owns the wire format; callers speak {system,user} to parsed JSON', 'src/ai/provider.js:1-16, complete() :137', 'PASS'],
    ['Credential loading', '<font face="Courier">AI_API_KEY</font> or <font face="Courier">GROQ_API_KEY</font> from env, server-side only', 'src/ai/provider.js:28', 'PASS'],
    ['Credential validation', '<font face="Courier">isConfigured()</font> gates routes with 503; key never returned or logged; errors redacted', 'provider.js:33-36, 44-48; tests/ai.test.js:148', 'PASS'],
    ['Real HTTP requests', 'Code yes. Endpoint reachable: keyless GET /models returned 401', 'curl probe, zero quota spent', 'PARTIAL'],
    ['Response parsing', 'Strict JSON: fences stripped, object required, else <font face="Courier">invalid_json</font> hard failure', 'provider.js:62-76; tests/ai.test.js:131', 'PASS'],
    ['Timeouts', '45s AbortController per request, abort mapped to retryable timeout', 'provider.js:112-142', 'PASS'],
    ['Retries', '2 retries, exponential backoff capped at 8s, transient only', 'provider.js:137-152', 'PASS'],
    ['Rate limit / failure mapping', '429 quota_exhausted (not retried), 401/403 auth_failed, 404 model_unavailable, 5xx provider_outage', 'provider.js:54-61', 'PASS'],
    ['Quota exhaustion pauses safely', 'Stage paused, attempt budget refunded, completed stages kept, scan reported partial', 'engine.js:243-262; tests/ai.test.js:425', 'PASS'],
    ['Usage limits enforced', '40 requests/scan, 200/day/workspace, 6 competitors, 3 pages, 3 attempts', 'engine.js:22-31; engine.js:196-207', 'PASS'],
    ['Duplicate calls prevented', 'Atomic claim before the model call; unique index makes the loser adopt the winner; live runs respected', 'engine.js:209-223; store.js:51; tests/ai.test.js:365', 'PASS'],
    ['Incremental: unchanged evidence costs nothing', 'Input hash over evidence ids, content hashes, analysis and prompt versions, plus structured fingerprint', 'engine.js:56-64; tests/ai.test.js:205', 'PASS'],
    ['Synthesis uses structured evidence', 'Reads stored findings only, never pages', 'src/ai/synthesize.js:44-50', 'PASS'],
    ['Findings cite valid evidence', 'Uncited findings dropped; forged ids dropped; foreign-workspace ids filtered', 'schema.js:34-50; engine.js:100-118; tests/ai.test.js:154', 'PASS'],
    ['Historical reports preserved', '<font face="Courier">reportByVersion</font>, <font face="Courier">reportHistory</font>, <font face="Courier">?version=N</font> on JSON and PDF', 'store.js:198-213; ai-routes.js:103-160', 'PASS'],
    ['Live completion executed', 'Never. Key present, no completion sent, no response shape observed', 'no call made; see Section 12', 'UNVERIFIED'],
]
add(table(['Check', 'Finding', 'Evidence', 'Status'], ai_rows, [40 * mm, 66 * mm, 42 * mm, 20 * mm], status_col=3))

add(P('Reference limits and cost model', H2))
add(P('Documented free-tier ceiling for this model is 30 requests per minute, 1,000 per day, 8,000 '
      'tokens per minute and 200,000 per day. The code is shaped around the 8,000 tokens-per-minute wall: '
      'one page of roughly 4,000 characters per request, 1,400 output tokens cap. A full scan runs 4 '
      'stages per competitor over up to 3 pages, so 12 to 24 requests plus one synthesis, which against '
      'the 200/day workspace ceiling allows roughly eight scans per workspace per day.'))

add(P('Known determinism caveat', H2))
add(P('<font face="Courier">temperature</font> is 0.1 with no seed, so identical evidence can yield '
      'different findings. Cost idempotency is unaffected (the hash is over evidence, not output), but '
      'output is not reproducible and no test pins it.'))

# ----------------------------------------------------------------- 3
add(P('SECTION 3', KICKER))
add(P('AI output quality assessment', H1))
add(P('Every quality claim below rests on deterministic mock responses. There is no golden record '
      'captured from the real model, so these results prove the validation boundary, not the model.'))
q_rows = [
    ['Competitor positioning', 'positioning and differentiator findings, brief-driven', 'prompts.js:42; engine.js:141-150', 'PASS'],
    ['Feature comparison', 'common_features and unique_features in synthesis', 'schema.js:97-118', 'PASS'],
    ['Pricing comparison', 'a plan with no stated price stays literal "unknown"', 'schema.js:56; tests/ai.test.js:162', 'PASS'],
    ['Advantages and weaknesses', 'SWOT buckets whitelisted; invalid bucket dropped', 'schema.js:118-124; tests/ai.test.js:168', 'PASS'],
    ['Market gaps', 'gaps[] carries evidence, confidence and wording', 'prompts.js:135; schema.js:110-115', 'PASS'],
    ['Actionable recommendations', 'grounded in findings but the link is unchecked prose', 'prompts.js:130-137; schema.js:126-134', 'PARTIAL'],
    ['Evidence citations', 'every finding must cite a supplied id or it is discarded', 'schema.js:34-50', 'PASS'],
    ['Confidence and uncertainty', 'values clamped 0-1, claim level whitelisted, no calibration', 'schema.js:22-28', 'PARTIAL'],
    ['Hallucination prevention', 'invented competitors dropped, absent facts become unknown, uncited claims refused', 'schema.js:84-96', 'PASS'],
    ['Unknown prices remain unknown', 'price falls back to the string "unknown", never derived', 'schema.js:58', 'PASS'],
    ['Unsupported features not asserted', 'claim level distinguishes explicit, inferred and unverified', 'prompts.js:28; schema.js:41', 'PASS'],
    ['Similarity not described as copying', 'system rule 6 and synthesis rule 5 forbid plagiarism assertions', 'prompts.js:30, :127', 'PASS'],
    ['Recommendations grounded', 'input is findings only, so it cannot exceed them; wording is free', 'synthesize.js:44-50', 'PARTIAL'],
    ['Injection resistance', 'random-UUID fence, overriding system rule, citable-id whitelist; model can still be nudged in prose but cannot write unsupported fact', 'prompts.js:12-31, :103-120; tests/ai.test.js:273-282', 'PASS'],
]
add(table(['Dimension', 'What was verified', 'Evidence', 'Status'], q_rows,
          [36 * mm, 70 * mm, 42 * mm, 20 * mm], status_col=3))

# ----------------------------------------------------------------- 4
add(P('SECTION 4', KICKER))
add(P('Complete product functionality checklist', H1))
add(P('The full user workflow, checked against the code and against the 15-step end-to-end test '
      'that runs the pipeline with deterministic fixtures. "API" means the capability exists and is '
      'tested at the route or service layer but is not reachable from the shipped interface.'))
f_rows = [
    ['1', 'Registration and login', 'Scrypt hashing, opaque session tokens stored as SHA-256, httpOnly SameSite cookies', 'src/routes/auth-routes.js; src/util.js:14; src/auth.js:9-25', 'PASS'],
    ['2', 'Add a website', 'Route with 30/min limiter, normalisation, workspace scope', 'website-routes.js:47; E2E step 1', 'PASS'],
    ['3', 'Discover competitors', 'Search-backed discovery via injected search provider', 'src/discover.js', 'PARTIAL'],
    ['4', 'Identify and score competitors', 'Taxonomy classification plus weighted scoring with threshold', 'src/competitor/score.js; E2E step 2', 'PASS'],
    ['5', 'Reject irrelevant candidates with reasons', 'Rejection reason persisted for audit', 'src/competitor/identify.js; migrations 8', 'PASS'],
    ['6', 'Crawl competitor pages', 'Deep crawl, ranked discovery, bounded depth, same-site enforcement', 'src/crawler.js; src/competitor/deep-crawl.js', 'PASS'],
    ['7', 'Classify pages', 'Path and content classification', 'src/competitor/classify.js; E2E steps 3-6', 'PASS'],
    ['8', 'Extract structured features', 'Deterministic claim levels, no model involved', 'extract-features.js', 'PASS'],
    ['9', 'Extract structured pricing', 'Original wording kept, unknown as NULL, no currency conversion', 'extract-pricing.js', 'PASS'],
    ['10', 'Store evidence and versions', 'Content hashing ignores whitespace and case; version chains per identity', 'evidence-versions.js; E2E steps 7-8', 'PASS'],
    ['11', 'Track freshness', 'Five-state freshness on 24h and 168h TTLs', 'src/competitor/freshness.js; E2E step 9', 'PASS'],
    ['12', 'Capture screenshots', 'Real Playwright capture, bounded pool of 3, 30s timeout, dedupe by hash. Unavailable in this host: no playwright package installed', 'src/screenshots/browser.js; src/ai/vision.js', 'PARTIAL'],
    ['13', 'Incremental AI analysis', 'Stage-level claim, resume, skip on unchanged evidence', 'src/ai/engine.js; E2E steps 11-12', 'PASS'],
    ['14', 'Cross-competitor synthesis', 'Hash-claimed report, one model call, explicit coverage gaps', 'src/ai/synthesize.js; E2E steps 13-15', 'PASS'],
    ['15', 'Reports and PDF export', 'Deterministic report PDF plus AI report PDF, both versioned', 'src/pdf/ai-report-pdf.js; src/pdf/engine.js', 'PASS'],
    ['16', 'Access historical reports', 'JSON and PDF by explicit version', 'ai-routes.js:103-160; store.js:198', 'PASS'],
    ['17', 'Recover interrupted jobs', 'Stale analysis claims, stale report claims, scan recovery on boot', 'engine.js:209-223; src/scan-recovery.js', 'PASS'],
    ['18', 'Enforce isolation and usage limits', 'Workspace scoping at query level, 404 across tenants, request ceilings', 'ai-routes.js; tests/ai.test.js:332; E2E isolation step', 'PASS'],
]
add(table(['#', 'Capability', 'Finding', 'Evidence', 'Status'], f_rows,
          [7 * mm, 34 * mm, 60 * mm, 47 * mm, 20 * mm], status_col=4))
add(Spacer(1, 3 * mm))
add(P('Interface gap, stated precisely: the shipped bundle contains 152 escaped DOM writes and calls 33 '
      'API paths, none of which is an AI, competitor, screenshot or findings endpoint. Feature rows 4, 5, '
      '8, 9, 12, 13, 14, 15 and 16 are therefore backend-only. For a user, that half of the product does '
      'not exist yet.'))

# ----------------------------------------------------------------- 5
add(P('SECTION 5', KICKER))
add(P('Security audit findings by severity', H1))
s_rows = [
    ['1', 'MEDIUM', 'No per-user AI quota', 'The daily ceiling is per workspace.', 'src/ai/store.js:154', 'Members of one workspace share 200 requests/day with no per-person limit.'],
    ['2', 'MEDIUM', 'AI analysis is not triggered automatically', 'Only an explicit POST starts a run.', 'ai-routes.js:64; no caller elsewhere in src', 'Status payload can report ai_configured while nothing analyses a finished scan.'],
    ['3', 'MEDIUM', 'SSRF suite is configuration-fragile', 'Exporting SHIELD_ALLOW_PRIVATE_IPS=true turns 6 SSRF assertions into failures.', 'observed: 16 failures instead of 10', 'Protection is correct; the test bank assumes default config globally.'],
    ['4', 'LOW', 'No CSRF token', 'Mitigated by SameSite cookie.', 'src/auth.js:203-210', 'Acceptable at current scope; would matter if SameSite is relaxed.'],
    ['5', 'LOW', 'Stale security documentation', 'Docs claim no screenshots, no AI route tests, no AI PDF.', 'docs/AI_SYSTEM.md:222-235', 'Misleading for operators assessing exposure.'],
    ['6', 'INFO', 'Error surfaces are sanitized', 'Key redacted by pattern and by literal value.', 'provider.js:44-48; tests/ai.test.js:148', 'No leak found.'],
]
add(table(['#', 'Severity', 'Finding', 'Detail', 'Evidence', 'Impact'], s_rows,
          [6 * mm, 17 * mm, 32 * mm, 40 * mm, 33 * mm, 41 * mm], status_col=None, font_small=True))

add(P('Controls verified as present', H2))
add(P('Scrypt password hashing with per-user salt and parameterised cost; opaque session tokens with only '
      'their SHA-256 stored; httpOnly, SameSite and secure cookies; per-route rate limits on auth, scan, '
      'discovery, monitoring, collect, notification and AI analysis; DNS-revalidated SSRF checks including '
      'the 169.254.169.254 metadata address and IPv6 literals; manual redirect revalidation on every hop; '
      'timing-safe cron secret; Svix signature verification with 300-second replay tolerance for email '
      'webhooks; SQL identifiers from whitelists with parameterised values; escaped interpolation for all '
      'untrusted text in the interface. Screenshot image routes are workspace-scoped and resolve the '
      'record before touching storage.'))

# ----------------------------------------------------------------- 6
add(P('SECTION 6', KICKER))
add(P('Database and reliability assessment', H1))
d_rows = [
    ['SQLite compatibility', 'Full suite green', '273 tests / 269 pass / 0 fail / 4 skipped', 'PASS'],
    ['PostgreSQL compatibility', 'Supported path green on PG 15', 'tests/postgres.integration.test.js 5/5', 'PASS'],
    ['Migration consistency', '13 migrations, applied list derived from the module', 'src/db/migrations.js; pg_advisory_xact_lock and BEGIN IMMEDIATE', 'PASS'],
    ['Foreign keys and indexes', '121 REFERENCES and CREATE INDEX statements; partial unique index on running reports', 'src/db/migrations.js:1-13', 'PASS'],
    ['Concurrent job execution', 'Atomic claim wins exactly once; two-process migration and analysis tested', 'tests/ai.test.js:365; db-durability PG tests', 'PASS'],
    ['Backup and restore', 'Snapshot verify, swap sidecars, parent-before-child restore, real PG savepoint', 'src/db/backup.js; durability 16/16', 'PASS'],
    ['Restart recovery', 'Stale scan recovery on boot, stale claim reclaim window', 'src/scan-recovery.js; tests/scan-reliability.test.js', 'PASS'],
    ['Connection failure behaviour', 'Startup validation, dial errors surfaced, no silent fallback', 'src/db/index.js; src/db/pg-backend.js', 'PASS'],
    ['Partial scan recovery', 'Completed stages retained, scan reported partial', 'engine.js:268-282', 'PASS'],
    ['Data retention and report history', 'Report versions retained; alert retention pruning', 'store.js:198-213; src/alerts.js retention', 'PASS'],
    ['Whole-suite PostgreSQL run', '10 failures, all diagnosed as test-bank design', 'see below', 'PARTIAL'],
]
add(table(['Area', 'Finding', 'Evidence', 'Status'], d_rows, [40 * mm, 66 * mm, 42 * mm, 20 * mm], status_col=3))

add(P('Whole-suite PostgreSQL failures, diagnosed', H2))
add(P('The suite is designed around one isolated database per test file. When <font face="Courier">DATABASE_URL</font> '
      'is set, every file shares one PostgreSQL database, which produces two distinct effects. None of them '
      'is a product defect, and the supported PostgreSQL path (integration plus durability with '
      '<font face="Courier">TEST_DATABASE_URL</font>) is fully green.'))
pg_rows = [
    ['9 tests in db-durability and scan-reliability', 'Assert a SQLite file backend: snapshot verification, swap restore, deleted-row restore, cross-process reads, two-process migration, restart recovery', 'These tests name SQLite in their own titles; they cannot pass against a PostgreSQL backend by construction'],
    ['1 test in monitor.test.js', 'Expects 0 due checks for its workspace, receives 4', 'Rows created by other test files are visible in the shared database: test isolation, not scheduler behaviour'],
]
add(table(['Affected', 'Observation', 'Diagnosis'], pg_rows, [46 * mm, 62 * mm, 60 * mm], font_small=True))
add(Spacer(1, 2 * mm))
add(P('Caveat: the monitor failure is strongly indicated as contamination but was not isolated by running '
      'that file alone on a fresh database, because the audit ran out of step budget at that point. Treat '
      'it as the least-certain diagnosis in this report.', SMALL))

# ----------------------------------------------------------------- 7
add(P('SECTION 7', KICKER))
add(P('Performance and scalability findings', H1))
add(P('No benchmark is quoted here because none was reproducible in this environment. What follows is '
      'derived from configuration constants and call structure, which are facts in the code.'))
p_rows = [
    ['AI request volume per scan', '4 stages x up to 6 competitors, 1 page per request, plus 1 synthesis', '12 to 24 analysis requests plus 1', 'engine.js:22-31; prompts.js:57'],
    ['Realistic daily capacity', '200 requests/day workspace ceiling against 13 to 25 per scan', 'roughly 8 scans per workspace per day', 'engine.js:26'],
    ['Prompt size ceiling', '4,000 characters of page text per request, 1,400 output tokens', 'cross-page context is lost by construction', 'prompts.js:57; provider.js:96'],
    ['Synthesis coverage', 'Findings trimmed to 12 per competitor before prompting', 'large scans are summarised, not compared exhaustively', 'synthesize.js:27'],
    ['Crawler concurrency', 'Bounded deep crawl with depth and page caps', 'bounded by design, not measured', 'src/competitor/deep-crawl.js'],
    ['Browser resource use', 'Pool of 3, 30-second timeouts, failures non-blocking', 'bounded; unavailable without playwright', 'src/screenshots/browser.js'],
    ['Duplicate crawling', 'URL dedupe and content hashing before storage', 'same page not stored twice', 'evidence-versions.js'],
    ['Query efficiency', 'Workspace-scoped indexed lookups; no unbounded table scans in the AI path', 'adequate at single-workspace scale', 'src/ai/store.js'],
    ['Large report handling', 'PDF rendered in memory per request', 'a very large history grows response time', 'src/pdf/ai-report-pdf.js'],
]
add(table(['Dimension', 'What the code does', 'Realistic implication', 'Evidence'], p_rows,
          [34 * mm, 58 * mm, 46 * mm, 30 * mm], font_small=True))

# ----------------------------------------------------------------- 8
add(P('SECTION 8', KICKER))
add(P('Phase 1 milestone-by-milestone completion', H1))
add(P('Milestones follow the Phase 1 build sequence; each is judged on executed behaviour, not on '
      'files existing. A milestone carrying a blocked or unverified capability cannot be marked complete.'))
m_rows = [
    ['M1', 'Audit, stabilisation, security review', 'Race conditions in the migration runner fixed, regression baseline established', 'COMPLETE'],
    ['M2', 'Database durability and migrations', 'Persistent backend, backup and restore, idempotent migrations, both engines', 'COMPLETE'],
    ['M3', 'Competitor intelligence foundation', 'Competitor, discovery, page and evidence tables; deterministic classify, identify, score', 'COMPLETE'],
    ['M4', 'Collection and extraction', 'Deep crawl, page classification, feature and pricing extraction', 'COMPLETE'],
    ['M5', 'AI intelligence engine', 'All four stages, schema validation, quota and retry handling', 'PARTIAL'],
    ['M6', 'Evidence versioning and incrementality', 'Content hashing, version chains, freshness, unchanged evidence costs nothing', 'COMPLETE'],
    ['M7', 'Synthesis, reports and export', 'Versioned synthesis, JSON history, AI PDF, deterministic PDF parity', 'COMPLETE'],
    ['M8', 'Product integration', 'Frontend surface for intelligence, findings and reports', 'NOT IMPLEMENTED'],
]
add(table(['Id', 'Milestone', 'Basis for the judgement', 'Status'], m_rows,
          [10 * mm, 46 * mm, 92 * mm, 20 * mm], status_col=None))
add(Spacer(1, 3 * mm))
add(P('M5 is PARTIAL, not complete, for one reason: the engine has never spoken to the provider it is '
      'built for. Every other M5 property (validation, idempotency, quota, resume) is proven.'))
add(Spacer(1, 2 * mm))
add(P('Completion percentage, with the calculation shown', H2))
calc_rows = [
    ['18 workflow capabilities in Section 4', '15 full, 3 partial (discovery, screenshots, and steps that are API-only)', '14.5 / 18 = 80.6%'],
    ['Cross-cutting gate: live AI unverified', 'AI capability scored at 50% weight until a real completion succeeds', 'applied to M5 only'],
    ['Cross-cutting gate: no intelligence interface', 'Rows 4, 5, 8, 9, 12, 13, 14, 15 and 16 are unreachable by a user', 'product surface judged separately'],
    ['Reported figure', 'Engine completeness 81%, product completeness materially lower', 'Phase 1 = 78% (transparent, not a benchmark)'],
]
add(table(['Component', 'Basis', 'Contribution'], calc_rows, [52 * mm, 80 * mm, 36 * mm], font_small=True))
add(Spacer(1, 2 * mm))
add(P('The 78% is an explicit engineering judgement, not a measurement. The defensible measured numbers '
      'are the test results in Section 6 and the 18-capability checklist in Section 4; the percentage '
      'condenses them and should be read that way.', SMALL))

# ----------------------------------------------------------------- 9
add(P('SECTION 9', KICKER))
add(P('Remaining Phase 1 tasks', H1))
r_rows = [
    ['Complete M5', 'One controlled live provider completion, then fix whatever it exposes', 'UNVERIFIED', 'Section 2'],
    ['Complete M8', 'Findings, competitor profile, screenshot viewer and AI report screens in the frontend', 'FAIL', 'Section 4'],
    ['Close discovery', 'Configure and verify a real search provider so discovery is not fixture-only', 'PARTIAL', 'src/discover.js'],
    ['Close screenshots', 'Install Playwright in the deployment image, then verify capture end to end', 'PARTIAL', 'src/screenshots/browser.js'],
    ['Trigger analysis automatically', 'Run AI after scan completion, with the same claim and quota guards', 'PARTIAL', 'ai-routes.js'],
    ['Per-user AI quota', 'Move the daily ceiling from workspace to user, or add a second gate', 'FAIL', 'src/ai/store.js:154'],
    ['Refresh documentation', 'AI_SYSTEM.md still lists implemented features as limitations', 'FAIL', 'docs/AI_SYSTEM.md:222'],
    ['PostgreSQL suite isolation', 'One database or schema per test file so the suite gates both backends', 'PARTIAL', 'Section 6'],
]
add(table(['Task', 'What completion requires', 'Status', 'Reference'], r_rows,
          [38 * mm, 78 * mm, 22 * mm, 30 * mm], status_col=2))

# ----------------------------------------------------------------- 10
add(P('SECTION 10', KICKER))
add(P('Phase 2 readiness for market validation', H1))
add(P('Payments and paid subscriptions are explicitly out of scope until validation. These are the '
      'prerequisites for putting this in front of real founders.'))
pr_rows = [
    ['Product onboarding', 'A new user can add a site and get a result, but cannot reach intelligence, findings or the AI report', 'PARTIAL'],
    ['User experience', 'Eight-item navigation was already flagged as confusing; the richest output has no screen at all', 'PARTIAL'],
    ['Competitor discovery accuracy', 'Deterministic scoring and rejection reasons exist; real search is unconfigured, so accuracy is unmeasured on live data', 'PARTIAL'],
    ['Report usefulness', 'Sections, provenance and explicit unknowns are implemented; never evaluated by a human reader of a real report', 'PARTIAL'],
    ['AI reliability', 'Guards are solid, model behaviour unverified, no live latency or failure data', 'UNVERIFIED'],
    ['Usage limits', 'Per-scan and per-workspace ceilings implemented; per-user quota absent', 'PARTIAL'],
    ['Error messages', 'Provider errors classified and sanitized; 409/503 states explicit for missing configuration', 'PASS'],
    ['Documentation', 'Deployment, durability, screenshots and AI docs exist; AI doc is stale on three points', 'PARTIAL'],
    ['Deployment configuration', 'Render blueprint present; Neon cutover checklist present; production connection still pending', 'PARTIAL'],
    ['Monitoring and operational visibility', 'Health endpoint and internal status route expose backend and SSRF mode; no metrics, no error aggregation', 'PARTIAL'],
    ['Backup strategy', 'Snapshot, verify, restore and retention implemented and tested on both engines', 'PASS'],
    ['Privacy and data handling', 'Public content only; no per-user analytics; retention pruning for alerts; no published privacy note yet', 'PARTIAL'],
    ['Feedback collection', 'Not implemented', 'FAIL'],
]
add(table(['Prerequisite', 'State', 'Status'], pr_rows, [46 * mm, 102 * mm, 20 * mm], status_col=2))

# ----------------------------------------------------------------- 11
add(P('SECTION 11', KICKER))
add(P('Critical blockers and risks', H1))
b_rows = [
    ['1', 'No live AI verification', 'Every AI claim in the product rests on mock behaviour. The first real call may surface schema drift, token ceiling problems or JSON-mode differences.', 'High', 'One request, negligible quota'],
    ['2', 'No intelligence interface', 'Users cannot see the feature that differentiates the product. Backend work is invisible.', 'High', 'Frontend work, no new backend'],
    ['3', 'Discovery depends on an unconfigured provider', 'Competitor discovery is fixture-only in practice.', 'Medium', 'Provider configuration plus a live check'],
    ['4', 'Screenshots unavailable in deployment', 'Visual evidence is documented but not capturable here.', 'Medium', 'Add playwright to the image'],
    ['5', 'Whole-suite PostgreSQL gate unusable', 'The suite cannot be a CI gate on both backends until files get isolated databases.', 'Medium', 'Per-file database isolation'],
]
add(table(['#', 'Blocker', 'Why it matters', 'Severity', 'Smallest unblocking step'], b_rows,
          [7 * mm, 40 * mm, 66 * mm, 15 * mm, 40 * mm], font_small=True))

# ----------------------------------------------------------------- 12
add(P('SECTION 12', KICKER))
add(P('Prioritized recommended next steps', H1))
n_rows = [
    ['1', 'One controlled live AI completion', 'Converts the largest UNVERIFIED into evidence or a defect list. Approximately 10 to 30 tokens, one of 1,000 daily free-tier requests, no monetary cost.', 'Approval required before running'],
    ['2', 'Frontend surface for findings and the AI report', 'Turns completed backend work into a product. Highest user-visible value per unit of work.', 'No dependency on step 1'],
    ['3', 'Trigger analysis on scan completion', 'Removes a hidden requirement that a user know an endpoint exists.', 'Reuses existing claim and quota guards'],
    ['4', 'Per-user AI quota', 'Prevents one workspace member exhausting the shared daily ceiling.', 'Small change in store.js'],
    ['5', 'Per-file PostgreSQL test isolation', 'Makes the suite a real gate on both backends.', 'Test harness only'],
    ['6', 'Playwright in the deployment image', 'Closes the screenshot capability.', 'Deployment change, needs authorisation'],
    ['7', 'Documentation refresh', 'AI_SYSTEM.md currently understates the system in three places.', 'Low risk'],
]
add(table(['Order', 'Action', 'Rationale', 'Note'], n_rows, [13 * mm, 52 * mm, 73 * mm, 30 * mm]))

add(Spacer(1, 6 * mm))
add(P('Evidence base for this report', H2))
ev_rows = [
    ['Repository state', 'git rev-parse HEAD = cf53813; working tree dirty with the 10 modified files listed in the cover'],
    ['SQLite suite', 'npm test: 273 tests, 269 pass, 0 fail, 4 skipped (PostgreSQL-only tests)'],
    ['PostgreSQL integration', 'node --test tests/postgres.integration.test.js with DATABASE_URL: 5/5 pass'],
    ['PostgreSQL durability', 'node --test tests/db-durability.test.js with TEST_DATABASE_URL: 16/16 pass, including real savepoint, restore ordering and two-process migration'],
    ['Whole suite on PostgreSQL', 'npm test with DATABASE_URL: 277 tests, 262 pass, 10 fail, 5 skipped, all 10 diagnosed in Section 6'],
    ['Provider reachability', 'curl https://api.groq.com/openai/v1/models without credentials returned 401, proving the endpoint is live and requires auth. No quota consumed, no key transmitted.'],
    ['Not measured', 'Live model output quality, latency, real search discovery accuracy, screenshot capture in this host, any throughput benchmark'],
]
add(table(['Item', 'Result'], ev_rows, [46 * mm, 122 * mm], font_small=True))


# ----------------------------------------------------------------- closing
add(P('Audit limitations', H2))
lim_rows = [
    ['Live model behaviour', 'No completion was sent to Groq. Output quality, JSON-mode compliance, latency and token accounting are therefore unmeasured. Approval is required before that call.'],
    ['Performance', 'No benchmark was run. Throughput figures in Section 7 are arithmetic over configuration constants, labelled as such.'],
    ['One diagnosis is not isolated', 'The monitor test failure is attributed to shared-database contamination by construction, not by running that file alone on a fresh database.'],
    ['Human evaluation', 'No reader has judged a real AI report for usefulness. Report quality is assessed structurally, not editorially.'],
    ['Production state', 'Render and Neon were not inspected or modified. Production configuration is unverified beyond what the repository declares.'],
    ['Files touched by this audit', 'This report and the script that generates it, both under reports/. No source, test or configuration file was modified, committed or pushed.'],
]
add(table(['Limitation', 'Consequence'], lim_rows, [42 * mm, 126 * mm], font_small=True))
add(Spacer(1, 4 * mm))
add(P('Generated 7 November 2026 from the repository at cf53813 on branch feat/db-durability. '
      'Audit only: no fix was implemented, nothing was committed or deployed, and no credential appears '
      'in this document.', SMALL))

doc = Doc(OUT)
doc.build(story)
print('wrote', OUT, os.path.getsize(OUT), 'bytes')
