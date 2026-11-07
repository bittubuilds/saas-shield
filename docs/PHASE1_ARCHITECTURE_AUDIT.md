# Phase 1 — Architecture Audit

Audit of the real implementation at `main` @ `01232c6a` (plus the unmerged `feat/credits-mvp` @ `ef625d9`).
Everything below was read from the code, not from the README. Where something is unknown it says so.

## 1. Repository shape

```
src/                 Express backend (~28 modules)
src/routes/          11 route modules (auth, website, scan, result, report, workspace,
                     monitor, alert, internal, webhook, discover)
src/db/              index.js (adapter), sqlite-backend.js, pg-backend.js + pg-worker.js,
                     migrations.js (1..7 on main, 8 on the credits branch), dialect.js
public/              app.html shell + app.<hash>.js bundle (82 KB), index.html landing,
                     sw.js, manifest, brand assets
tests/               13 files; measured now: 126 passing on main, 149 on feat/credits-mvp
docs/                DEPLOYMENT, DATABASE-MIGRATION, RESEND-SETUP, design-review/
Dockerfile, render.yaml, e2e-smoke.js, package.json (no runtime deps beyond express)
```

Runtime dependencies are deliberately thin: Express plus the platform's own `node:sqlite` and an
optional `pg`. No AI SDK, no Playwright, no ORM, no queue library.

## 2. Backend architecture

- **Entry**: `src/server.js` — Express app, cookie sessions, static `public/`, route mounting under
  `/api`, `/api/health`, in-process scheduler bootstrap, graceful shutdown.
- **Database adapter**: one synchronous-looking API (`db.prepare(sql).get/all/run`, `db.exec`) over
  two engines. SQLite runs in-process. PostgreSQL runs through a worker thread with
  SharedArrayBuffer synchronously bridged, so application code is identical for both.
  `run()` returns `{changes}` = `rowCount` on PostgreSQL. Migrations are one shared array of
  `{version, name, sql}` and are applied inside `BEGIN/COMMIT` per migration.
- **No generic transaction helper.** Only migrations use `BEGIN/COMMIT`. Application-level atomicity
  is achieved with single conditional statements (`INSERT … SELECT … WHERE NOT EXISTS`,
  guarded `UPDATE`). This is a real constraint for anything needing multi-table writes.
- **Background work**: `src/scheduler.js` runs an interval tick (default 300 s, env-tunable) guarded
  by a `job_locks` table with TTL, so two instances cannot tick at once. There is no external queue;
  crawls and scans run as in-process async jobs (`scanner.running` map). `CRON_SECRET` enables an
  external trigger for sleep-prone free hosting.
- **Recovery**: `src/scan-recovery.js` marks stale `queued|running` scans failed after
  `SCAN_STALE_AFTER_MINUTES` (15), keeping the row and reason. On the credits branch it also
  recovers orphan reservations. `monitor.js` has its own stale-check path.

## 3. Frontend architecture

Single-page vanilla JS bundle (`public/app.5b15f5fa.js`, 82 KB) against a static shell. No framework,
no build step in the repo (the bundle is committed). Views referenced in the bundle: Dashboard,
Websites, Findings, Scans, Monitoring, Changelog, Alerts, Settings. PWA service worker present.
This is a small, fast UI, but it is a hand-written bundle, so UI work is done by editing a built
artifact rather than sources.

## 4. API surface

`/api/auth/*` (signup, signin, signout, verify, config, Google OAuth), `/api/me`,
`/api/workspaces/:id` (summary, rename, members), `/api/workspaces/:id/websites` (CRUD, portrait,
monitor toggle, initial-scan status), `/api/workspaces/:id/scans` (create, list, cancel, retry),
`/api/workspaces/:id/results` (list, update status), `/api/workspaces/:id/reports` (build, HTML,
PDF export), `/api/workspaces/:id/discover`, `/api/workspaces/:id/monitor*`, `/api/workspaces/:id/alerts*`,
`/api/internal/*` (cron), `/api/webhooks/resend`.

Authorization pattern is consistent: `requireAuth` → `requireWorkspace()` (membership lookup) →
optional `requireAdminRole`. Tests cover cross-workspace denial on the newest routes.

## 5. Authentication and identity

- Session cookies (`shield_session`), server-side session rows, `SESSION_TTL_HOURS`, `COOKIE_SECURE`,
  `COOKIE_SAME_SITE`. Passwords hashed with `scrypt` (`hashPassword`/`verifyPassword`).
- Email verification machinery exists and is tested (`verify.js`, `email_verification_tokens`,
  `users.email_verified_at/source`, `authmode.js`). Mode is derived from whether mail can reach real
  users. **Live `/api/auth/config` reports `auth_mode: instant`, `email_reachable: false`** because
  Resend still sends from `onboarding@resend.dev`, which only delivers to the owner. Verification is
  therefore built but dormant.
- Google OAuth is coded, not configured in production.

## 6. Database schema (main, migrations 1–7)

26 tables: `users, workspaces, memberships, websites, pages, scans, results, passages, evidence,
review_events, audit_events, sessions, email_verification_tokens, oauth_accounts, auth_events,
monitored_pages, snapshots, changes, alerts, alert_deliveries, digests, notification_settings,
job_locks, app_meta, discoveries, email_outbox`.

Relevant shapes: `scans(original_website_id, comparison_website_id, status ∈ queued|running|completed|failed|cancelled, params, pages_compared, findings, error, started_at, finished_at)`;
`pages(website_id, url, canonical_url, title, text_content, content_hash, http_status, fetched_at)`;
`results(match_type, jaccard_score, tfidf..., original_url, comparison_url, status)` per detected similarity;
`evidence(result_id, original_excerpt, comparison_excerpt, hashes, screenshot_ref nullable, captured_at)`.

Credits branch adds migration 8: `user_credits`, `scan_jobs`, `credit_ledger`, plus `scans.job_id`
and `discoveries.job_id`.

**There is no competitor entity.** A "competitor" is currently just a `websites` row with
`kind='comparison'`. There is no product name, category, relevance score, verification status,
description or per-competitor profile anywhere in the schema.

## 7. Discovery (existing)

`src/discover.js`:
- Builds queries from the original site's own sentences (`pickSearchSentences`, `MAX_QUERIES`).
- Calls `src/search.js` → Serper only. Key from `SERPER_API_KEY` or `/etc/secrets/SERPER_API_KEY`.
  Without a key it throws `SearchUnavailableError`; nothing is fabricated. Comment states keyless
  engines are anti-bot blocked from datacenter IPs. Serper free tier: 2,500 queries/month.
- `filterResultHosts()` de-duplicates by host and caps at `MAX_SITES = 6`.
- Registers each surviving host as a `comparison` website and queues one scan per host.
- Persists a `discoveries` row with `provider, queries, found_hosts, created_scan_count, status`.

**Gaps vs. the Phase 1 requirement**: no product/category identification, no relevance ranking
(only host de-duplication and first-6 capping), no indirect/alternative-competitor reasoning, no
stored discovery evidence per candidate (only an aggregate `found_hosts` string), no verification
status, and no per-candidate metadata.

## 8. Crawler and collection (existing)

`src/crawler.js` + `src/ssrf.js` + `src/sitemap.js` + `src/extract.js`:
- SSRF-hardened: URL validation, DNS resolution checks, private/reserved IPv4+IPv6 blocking,
  redirect revalidation on every hop, `SHIELD_ALLOW_PRIVATE_IPS` opt-out for local tests only.
- robots.txt respected (`CRAWL_RESPECT_ROBOTS`), sitemap seeding including `<sitemapindex>` and
  nested children (added on the one-time-scan branch), page cap 25, depth 2, response byte cap,
  per-host delay, per-request timeout 10 s.
- Extraction is readable-text + links + basic structure. **No page classification, no
  features/pricing/positioning extraction in the scan path.** `src/pricing.js` does honest
  regex-based plan extraction, but it is wired into `monitor.js` (change detection), not into the
  competitor scan pipeline.

## 9. Similarity engine (existing, good)

`src/similarity.js` (~455+ lines) + `src/normalize.js`: shingle Jaccard, short-passage Jaccard,
TF-IDF cosine, passage containment, structural HTML similarity, boilerplate stripping. Thresholds
are env-configurable (`SIM_*`). Language is deliberately careful ("potential similarity", "shared
content patterns"); `src/routes/report-routes.js` states visual similarity is not measured. This is
a genuine asset and should be preserved, not replaced.

## 10. Report generation (existing)

`src/routes/report-routes.js`: deterministic report built from stored results/evidence with sections
Methodology, Findings, Limitations, plus HTML and PDF export (custom PDF writer, no dependency).
It is honest and evidence-linked but it is **not** the 17-section competitive intelligence report in
the Phase 1 spec. There is no narrative synthesis, no SWOT, no market gaps, no recommendations.

## 11. AI integrations

**None.** No provider SDK, no API key, no prompt, no model call anywhere in `src/`. The only AI-shaped
language in the codebase is the honest limitation text in reports ("not captured in this build").
Everything the product currently claims is deterministic. Any "AI" framing in the UI or landing page
is aspirational.

## 12. Credits and usage

On `feat/credits-mvp` only (not merged, so production has no limit): 3 free scan jobs per **user**,
atomic reservation via conditional `INSERT … SELECT`, append-only `credit_ledger` with
`UNIQUE(user_id, job_id, entry_type)`, settle-on-first-completion, refund on total failure or early
cancel, orphan-reservation recovery, per-IP signup cap (20/h, `SIGNUP_RATE_LIMIT`).
Verified on SQLite and on real PostgreSQL 15 including a 6-process race (3 wins of 6).

## 13. Environment and deployment

`.env.example` documents ~55 variables: server, session/cookie, auth + verification, email/Resend,
Google OAuth, scheduler/cron, alerts/digests, crawl limits, similarity thresholds, retention,
`SHIELD_ALLOW_PRIVATE_IPS` (test-only). Serper key is read from env or a Render secret file.
`render.yaml`: free plan, `npm install` / `npm start`, health check `/api/health`, **no disk**.
Default database is `data/saas-shield.db`. The file is present locally but **not tracked by git** (`git ls-files data/` is empty), so it is not shipped in the repo; it is still ephemeral on the free plan.

## 14. Tests

13 files; **126 passing on `main`, 149 on `feat/credits-mvp`** (both measured today). Coverage is strongest on auth,
SSRF/crawler security, similarity, initial scan, scan reliability, discovery and credits. There is
no test for any AI path (none exists), no screenshot test, and `postgres.integration.test.js` only
runs when `DATABASE_URL` is supplied, so default CI is SQLite-only.

## 15. Security posture

Strong where the crawler is concerned: SSRF module with dedicated tests, redirect revalidation,
response caps, robots respect, no auth bypass, workspace scoping on routes, hashed passwords,
signed session cookies, Resend webhook signature verification, rate limiters on auth and scan create.
Not verified in this audit: CSP/security headers, CSRF specifically (cookie `SameSite` is set),
dependency audit, and error-message leakage under production `NODE_ENV`.

## 16. Technical debt and risks (ranked)

1. **Ephemeral production database.** Render free + no disk + SQLite file = every redeploy destroys
   all evidence, accounts and scans. This alone blocks any production claim.
2. **Local SQLite file** in `data/` is untracked (verified), so no repo leak; the real risk is losing it on redeploy.
3. **No transaction primitive** in the adapter — every future multi-table write needs a single
   statement or a new, carefully tested capability.
4. **No competitor domain model** — the schema cannot store what the vision promises.
5. **No page classification or structured extraction in the scan path** — evidence stays raw text.
6. **Frontend is a committed build artifact** with no sources in the repo; UI changes are risky.
7. **In-process scheduler** — no durable queue; a crash loses in-flight work (recovery marks it
   failed, which is correct but not resumable).
8. **AI absence** means Phase 1's core promise is unimplemented, not partially implemented.
9. `src/monitor.js` (~980 lines) is doing change-detection work adjacent to the competitor pipeline
   and overlaps conceptually with scans; needs boundary decisions before adding AI.
