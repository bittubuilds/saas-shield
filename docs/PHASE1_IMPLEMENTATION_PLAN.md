# Phase 1 — Implementation Plan

Sequenced plan to turn the audited codebase into the Phase 1 product, without rewriting what works.
Order is driven by dependency, not by what is most visible.

## Guiding constraints

- Keep the existing crawler, similarity engine, auth, workspace isolation, credits branch and report
  exporter. They are tested and honest. Extend, do not replace.
- Free-first: no paid AI, no paid search beyond the existing free tier, no paid infra.
- Every AI claim must carry evidence references; the UI must never show a claim it cannot source.
- No milestone ships with fabricated data or a silently swallowed failure.

---

## Milestone 2 — Data integrity and durability (blocking)

**Why first**: without durable storage every later milestone is theatre.

1. Switch production to PostgreSQL (the adapter already supports it and was verified on PG 15).
   Document the migration path for the existing SQLite file and provide an export/import script.
2. If a free Postgres is unavailable, require a Render disk and pin an absolute
   `DATABASE_FILE` path; document the free-tier limitation honestly.
3. Add a backup job: daily logical dump to object storage or an encrypted download the owner can
   fetch; document restore, and run one restore drill before claiming backups exist.
4. Decide the fate of the committed `data/saas-shield.db` (tracked or not) and stop shipping DB files.
5. Add `db.transaction()` to the adapter only if a milestone provably needs multi-statement writes;
   otherwise keep the single-statement discipline that already works on both engines.

**Exit test**: restart the service, all data still present; restore from backup into a scratch DB and
compare row counts.

---

## Milestone 3 — Competitor model and discovery intelligence

**Schema (migration 9, additive)**
`competitors(id, workspace_id, website_id, domain, url, product_name, description, category,
competitor_type ∈ direct|indirect|alternative|niche, discovery_source, relevance_score,
verification_status, first_seen_at, last_seen_at)`
`discovery_candidates(id, discovery_id, competitor_id, query, rank, source_url, raw_snippet, score)`

**Work**
1. Move "competitor" from "a comparison website row" into a first-class entity; keep `websites` as the
   crawl target it already is and link the two.
2. Relevance scoring: deterministic first (host overlap with category keywords, page title/description
   similarity to the user's own positioning, presence of pricing/features pages), AI-assisted later.
   Score, keep the reason, store it, show it. Never silently drop a candidate: store it with a low score.
3. Category / product identification for the user's own site from its homepage + meta + pricing page
   (deterministic extraction first; AI refines in Milestone 5).
4. Deduplicate by registrable domain, not raw host; handle subdomains and redirects.
5. Discovery evidence per candidate: query used, rank, snippet hash, source URL.
6. Surface per-candidate status in the API so the UI can show why something was included or rejected.

**Exit test**: fixture sites with known competitors; assert ranking order, dedupe, and that a
non-competitor (e.g. a blog post about the category) is scored low rather than discarded.

---

## Milestone 4 — Page classification and structured evidence

1. `page_kind` classifier (rules first): home, pricing, features, about, docs, changelog, compare,
   blog, legal, other. Signals: URL tokens, headings, presence of price tokens, schema.org types.
2. Structured extractors over classified pages: features (list sections), pricing (extend the existing
   `pricing.js`), positioning/value props (hero copy), audience, integrations, CTA, announcements.
   Every extracted item stores `source_url`, `excerpt`, `content_hash`, `confidence`.
3. Wire the scan pipeline to persist these as `evidence` rows with a `kind` discriminator, instead of
   only pairwise similarity evidence. Keep similarity results untouched.
4. Evidence quality gates: reject pages that are nav/boilerplate-only, mark JS-rendered thin pages as
   `insufficient_content` rather than analysing an empty page.

**Exit test**: fixture competitor with pricing/features pages produces structured rows with excerpts
and hashes; an empty SPA page is marked insufficient, not analysed.

---

## Milestone 5 — Screenshots

1. Playwright (free, open source) as an optional dependency behind `SCREENSHOTS_ENABLED`.
2. Capture homepage, pricing, features, primary landing; store file + metadata row
   (`screenshots(id, page_id, path, bytes, sha256, captured_at, status, error)`).
3. Skip capture when `content_hash` unchanged; cap count and total bytes per scan
   (`SCREENSHOT_MAX_PAGES`, `SCREENSHOT_MAX_BYTES`); delete oldest beyond the cap.
4. If Playwright is unavailable, the scan continues, `visual_evidence: unavailable` is recorded, and
   the report says so. No visual-similarity claims.

**Exit test**: capture on a fixture, dedupe on second run, failure path marks unavailable and the
scan still completes.

---

## Milestone 6 — AI layer (free-first, provider-agnostic)

1. `src/ai/provider.js` interface: `analyzeEvidence`, `analyzeCompetitor`, `compareCompetitors`,
   `generateFinalReport`; plus `health()` and `usage()`.
2. First adapter: an OpenAI-compatible free-tier endpoint (Groq / Cerebras / OpenRouter free models),
   chosen at runtime by `AI_PROVIDER` + `AI_MODEL`, key server-side only. A second adapter for a local
   model stub keeps the interface honest.
3. Guardrails: strict JSON schema validation, bounded retries with backoff, timeout, per-run request
   and token budget, response cache keyed by evidence hash, refusal to emit a claim without evidence
   IDs, and prompt-injection isolation (crawled text is data, never instructions; system prompt is
   fixed and the model is told page content is untrusted).
4. Incremental analysis: analyse per competitor as evidence lands, persist
   `ai_analyses(id, competitor_id, evidence_ids, model, provider, prompt_version, output_json,
   tokens, status, error, created_at)`; resume by skipping evidence hashes already analysed.
5. Quota exhausted → job pauses in `waiting_for_ai`, evidence preserved, no fake output, clear UI state.

**Exit test**: mocked provider happy path, invalid JSON rejection, injection attempt rejected,
quota exhaustion pauses without data loss, resume completes.

---

## Milestone 7 — Cross-competitor synthesis and the intelligence report

1. Aggregate structured findings per competitor into a comparison matrix; compute common/rare/missing
   features, pricing spread, positioning clusters — deterministically where possible.
2. Final synthesis builds the 17 sections from the accumulated rows, batching summaries so context
   limits are respected and no competitor is dropped; record which evidence IDs fed the synthesis.
3. Every recommendation carries: observation, evidence references, why it matters, action, confidence,
   and what remains unverified.
4. Report persisted as a versioned row (`reports` table), not regenerated per view; export HTML/PDF
   using the existing renderer.
5. Fact vs inference vs recommendation is a field, not a writing style.

**Exit test**: end-to-end fixture with three competitors produces all 17 sections, each recommendation
resolvable to evidence rows; a section with insufficient evidence says so.

---

## Milestone 8 — UI integration

1. Scan state machine surfaced: `pending → discovering → crawling → analysing → synthesizing →
   completed | partial | failed | paused(AI)`. States come from DB rows, never a timer.
2. Competitors list with relevance and type; competitor profile with evidence + screenshots.
3. Feature/pricing comparison view and the report view with evidence drill-down.
4. Credit counter (from the merged credits branch) and paused-AI banner with retry.
5. Keep the existing dark visual direction; no redesign.

**Exit test**: a real scan walked end-to-end in the browser at each state, with no fabricated numbers.

---

## Milestone 9 — Hardening

Security: security headers/CSP, CSRF review, dependency audit, error-leak review, per-host crawl
politeness, AI prompt-injection regression tests, IDOR sweep across every new route.
Performance: measure first (query timings on the new tables, crawl wall-clock, AI request counts),
then index and cache. No speculative optimisation.

## Milestone 10 — QA and release readiness

Full E2E, failure-injection suite (provider down, quota out, crawl timeout, restart mid-analysis),
database restore drill, and an honest readiness verdict. Production release stays manual.

---

## Cross-cutting rules for every milestone

- New tables are additive migrations; never rewrite an applied migration.
- Every new route goes through `requireAuth` + `requireWorkspace`; add an isolation test.
- Every AI output is data, never trusted, always schema-checked.
- Any degraded capability is reported in the UI and the report, never hidden.
- `npm test` must stay green; new behaviour ships with tests, not with promises.

## What this plan deliberately does not do

No payments, no plans, no premium gating, no paid AI or proxies, no legal automation, no chatbot,
no multi-agent simulation, no SEO tools, no UI redesign beyond what the new data requires.
