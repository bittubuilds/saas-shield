# Phase 0 — Repository and frontend baseline

Captured: 7 November 2026, before any change in this phase.

## Git

- Branch: `feat/db-durability`
- HEAD: `cf53813 feat(intel): Phase 4 screenshot capture with pluggable storage`
- Remote branches present locally: `audit-fix`, `docs/phase1-audit`, `feat/credits-mvp`,
  `feat/db-diagnostic`, `feat/db-durability` (current)
- Working tree: 27 entries, all preserved. Modified: `src/ai/store.js`,
  `src/ai/synthesize.js`, `src/competitor/store.js`, `src/db/migrations.js`,
  `src/discover.js`, `src/routes/ai-routes.js`, `tests/ai*.test.js`,
  `tests/postgres.integration.test.js`, `public/{app.html,index.html,sw.js}`.
  Untracked: `tests/e2e-integration.test.js`, `tests/frontend-render.test.js`,
  `tests/ribbons.test.js`, `tests/shatter.test.js`, `docs/FRONTEND.md`,
  `docs/REACTBITS.md`, hashed assets under `public/`, `reports/`.
- No commit, push, merge or deploy was performed.

## Frontend source located

`incoming_files/e72332501_saas-shield-frontend.zip` → integrated copy at
`saas-shield-frontend/` in the conversation workspace (React 18 + Vite 5 +
react-router-dom 6). The repository's own UI is the vanilla `public/app.*` bundle;
the React app is not in the repo yet, by design.

## Previous audit report

`SAAS_SHIELD_COMPLETE_AUDIT_REPORT.pdf` does not exist anywhere in the workspace
(searched `push-repo/`, the conversation root and every subdirectory). The closest
artefact is `saas-shield-chat-transcript-2026-11-07.pdf` (a transcript, not an
audit). Findings below were therefore re-derived from the code, not inherited.

## Status

**Implemented and verified by tests**
- Auth: signup, signin, signout, `/api/auth/me`, session cookies, email verification
  paths, Google start/callback (config-gated).
- Websites with one-shot initial scan (`POST /websites` → `{website, initial_scan}`,
  `GET /websites/:id/initial-scan`), pause/resume, duplicate and self-comparison guards.
- Manual scans: create (two ids, 409 on active pair), list, get, cancel, retry.
- Crawler with sitemap seeding, page classification, results with filters and
  pagination (`total`, `has_more`, `limit`, `offset`).
- Evidence versioning and freshness, deep competitor crawl, feature and pricing
  extraction, screenshot capture with pluggable storage.
- AI: incremental analysis, schema validation, evidence citation checks, synthesis
  with `input_hash` idempotency, historical report versions, deterministic JSON/PDF
  export and AI report PDF.
- Workspace isolation: non-member workspace → 404, cross-workspace scan → 404.

**Partially implemented**
- Discovery: works only with a configured search provider. Unconfigured (as in this
  environment) `POST /websites` returns `initial_scan.mode = needs_comparison`.
- AI provider: Groq integration is code-complete, never executed against the live
  provider in this repo (no approval given, no key exercised).
- Screenshots: capture is real; visual analysis is a declared placeholder; local
  storage is not durable on an ephemeral host.

**Missing**
- Frontend consumers for competitors, discovery, screenshots, findings review and
  report versions (React app now covers reports, history, PDF, findings list).
- Any protection module (Module 1) — no code exists yet.
- `SAAS_SHIELD_COMPLETE_AUDIT_REPORT.pdf`.

**Broken / unverified**
- Whole-suite run: 299 tests, 293 pass, 2 fail, 4 skipped. Both failures are in
  `tests/e2e-integration.test.js` steps 11-12 and 13-15; the same file passes 10/10
  when run alone. Reproduced independently this session.
- PostgreSQL whole-suite isolation (documented earlier, unchanged).
- Real-provider AI call, Neon over 5432 from this sandbox, Render runtime.
