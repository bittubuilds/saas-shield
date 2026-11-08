# HANDOFF — SaaS Shield

Last updated: 8 November 2026 (post-merge)
Branch: `feat/db-durability` (merged to `main`) · `main` = `32d1af4` · Working tree: clean

This file is the entry point for any agent or developer picking the project up.
Every claim below is tagged **[verified]**, **[reported]** (stated by the owner or
visible in a past session, not reproducible here) or **[unverified]**.

---

## 1. Architecture and module boundaries

- **`src/server.js`** — Express (CommonJS, Node `>=22.5`). Mounts `/api/*` routers,
  serves the vanilla SPA from `public/` at `/app`, exposes `GET /api/health`, handles
  `SIGTERM`/`SIGINT` with `server.close()` → `db.close()` and an 8 s forced exit.
- **`src/db/`** — one shared schema for both backends:
  - `migrations.js` — 13 migrations, versions are **1-based** (`version 1` … `version 13`).
  - `migrate.js` — runner: one transaction per migration, `schema_migrations` gate
    re-checked inside the transaction, `pg_advisory_xact_lock(21842, 7)` so two
    instances starting together cannot interleave.
  - `dialect.js` — translates the shared DDL for PostgreSQL.
  - `sqlite-backend.js`, `pg-backend.js`, `pg-worker.js` (pg runs in a worker thread;
    pool `max 10`, `idleTimeoutMillis 30_000`, `connectionTimeoutMillis 10_000`).
  - `durability.js` — `DB_REQUIRE_DURABLE` gate; `backup.js` — snapshot/verify/restore.
- **Competitor Intelligence** — `src/competitor/` (`identify`, `score`, `deep-crawl`,
  `classify`, `extract-features`, `extract-pricing`, `collect`, `pipeline`,
  `evidence-versions`, `freshness`, `intel-store`, `store`) plus
  `routes/competitor-routes.js` and `routes/discover-routes.js`.
- **AI engine** — `src/ai/` (`engine`, `evidence-source`, `prompts`, `provider`,
  `schema`, `store`, `synthesize`, `vision`). Provider keys are server-side only.
- **Shield Protect (monitoring side)** — `monitor.js`, `diff.js`, `alerts.js`,
  `scheduler.js`, `scan-recovery.js`, `routes/{monitor,alert,result,report}-routes.js`, `src/pdf/`.
- **Screenshots** — `src/screenshots/` (Playwright behind a capability probe) + `src/storage/`.
- **Frontends** — `public/` is the live vanilla SPA (hashed `app.<hash>.js` /
  `styles.<hash>.css`, plus the ribbons and shatter effects). `frontend/` is the
  React 18 + Vite app, wired to the real API, **not yet served by Express**.
- **BLA is not integrated.** Evaluation only: `docs/BLA_EVALUATION.md`,
  `reports/DB_MIGRATION_AND_BLA_READINESS_AUDIT.md`.

## 2. Completed work

- Evidence freshness fix: `freshness.js` now measures "unseen" from the analysis
  `created_at` (not `finished_at`) and compares inclusively; `evidence-versions.js`
  uses `>=`. 11 regressions in `tests/evidence-versioning.test.js` (24 tests total). **[verified]**
- `tests/e2e-integration.test.js` — **10 tests / 15 numbered steps** (the numbering runs
  "13-15" inside a single test). **[verified]**
- React app: session gate, website onboarding, initial-scan polling with cancel/retry,
  AI report with `no_report` state and versioned PDF, history, competitor listing. **[verified]**
- Docs: `PHASE0_BASELINE.md`, `FRONTEND_INTEGRATION.md`, `BLA_EVALUATION.md`,
  `EXECUTION_BATCH_2026-11-07.md`, `DB_MIGRATION_AND_BLA_READINESS_AUDIT.md`. **[verified]**

## 3. Database state and connection facts

- Production Neon was inspected **read-only** on 7 Nov 2026: `schema_migrations` max **7**,
  **27 tables**. A full local SQLite after all 13 migrations has **41 tables / 82 indexes**,
  so **migrations 8-13 are unapplied in production**. **[verified]**
- The local, gitignored `.env` `DATABASE_URL` targets a **direct** Neon endpoint
  (`ep-misty-king-…`, no `-pooler`), `sslmode=require`, default port, and the pool is
  `max 10` per instance. **[verified — shape only, no value printed]**
- Render's own `DATABASE_URL` could not be read: no Render CLI, no `RENDER_API_KEY`
  (`api.render.com` returns 401). The owner reports that past Render logs showed a
  **pooled** host. That is **[reported], not verified here.** Do not assume either
  flavour without checking the Render env. If it is `-pooler` (PgBouncer), re-check
  transaction-mode behaviour before relying on session-level state.
- **"PostgreSQL backend" in the logs and a "Live" Render service do not prove working
  queries.** Observed locally: the server logged
  `[db] PostgreSQL backend: <host>:5432/neondb`, then
  `[db] PostgreSQL migration failed: database error`, then threw from `src/db/index.js`
  and exited. Backend selection is decided before any query succeeds. **[verified]**
- Startup has **no retry/backoff**: one failed connect exits the process. **[verified]**
- `GET /api/health` runs `SELECT 1` and returns 503 when the DB is unreachable, but it is
  only reachable *after* a successful boot, so it cannot report a boot-time DB failure. **[verified]**

- **The React UI is wired to `/app`** (`src/server.js`): when `frontend/dist/index.html`
  exists and `NODE_ENV != test`, Express serves the Vite build at `/app` and `/app/*`,
  else it falls back to the vanilla `public/app.html`. `render.yaml` buildCommand is
  `npm install && npm run build`. **Not deployed yet** — a deploy also runs migrations
  8-13 on boot when `DATABASE_URL` is set. **[code committed: verified locally]**

## 3b. Deploy readiness (8 Nov, merged)
- PR #1 merged into `main` at `32d1af4` (19 commits, merge commit, no squash).
- `src/db/index.js` now retries PostgreSQL bootstrap (`DB_BOOTSTRAP_ATTEMPTS`, default 3,
  1s/2s/4s) before failing the boot; verified with an unreachable host (2 attempts, then throw).
- `render.yaml` build installs Chromium for screenshots (non-fatal) and sets the retry count.
- **Not deployed yet**: Neon still at `schema_migrations` 7 and the live `/app` still serves the
  vanilla bundles. A Render deploy will run migrations 8-13 at boot and serve the React UI.
- Still owner-only: trigger the Render deploy, set `SERPER_API_KEY`, verify the Resend domain.

## 4. Tests already run (7-8 Nov 2026)

| Command | Result |
| --- | --- |
| `npm test` (`node --test tests/*.test.js`) | 309 tests, 305 pass, 0 fail, 4 skipped (PG-only) |
| `node --test tests/db-durability.test.js` on PostgreSQL 15 via `TEST_DATABASE_URL` | 16/16 pass |
| same file on SQLite | 13 pass, 3 skipped (PG-only) |
| `node --test tests/postgres.integration.test.js` | 1/1 pass |
| `node --test tests/e2e-integration.test.js` × 3 | 10/10 each run |
| `cd frontend && npx vite build` | success, 204 kB bundle |

## 5. Pending tasks and known blockers

1. **Migrations 8-13 are unapplied in production.** Applying them needs explicit owner
   approval. Sandbox egress blocks 5432, so production migrations go over HTTPS via
   `tools/neon-migrate.js` (`@neondatabase/serverless`).
2. **Render runtime connectivity to Neon is unverified** — no Render credentials here.
3. **Backups are not durable.** `db/backup.js` defaults `DB_BACKUP_DIR` to a path next to
   the SQLite file, which is ephemeral on Render. Restore has only been proven against
   local PostgreSQL, never against Neon. **[verified code; Neon restore unverified]**
4. **No search provider configured**, so discovery resolves to `needs_comparison`; the live
   discovery path cannot be exercised end to end.
5. **Playwright browsers are not guaranteed in the deploy image**, and screenshot storage
   is ephemeral on the free tier (512 MB, no disk).
6. **Resend is still on the test sender**, so real users receive no email. **[reported]**
7. **Intermittent E2E zero-findings failure** — reproduced 1 in 30 before the freshness fix,
   0 in 30 after, and 0 in the last 3 runs. Root cause **unproven**; do not call it fixed.
8. **GitHub token rotation: remote cleaned (verified), revocation reported by the owner
   (not independently verifiable here).** The `origin` URL is now
   `https://github.com/bittubuilds/saas-shield.git` with no userinfo (`.git/config` clean).
   The exposed `gho_` OAuth token was revoked by Bittu on 8 Nov 2026 **[reported]**; an
   agent cannot confirm revocation of a token it no longer holds, so treat it as revoked
   unless a GitHub audit log says otherwise. Working credentials now come from a classic
   PAT stored as `$GITHUB_TOKEN_4` (env name is auto-suffixed), used through an ephemeral
   `credential.helper` and never written into `.git/config`.
   **[remote cleaned: verified · token revoked: reported · PAT working: verified]**

## 6. Exact next steps, in order

1. Owner approval → apply migrations 8-13 to Neon, then confirm `schema_migrations` max 13
   and 41 tables.
2. Add bounded retry/backoff around DB bootstrap and pool acquisition in `src/db/index.js`,
   with a regression test. This is the cheapest production-risk reduction available.
3. Confirm which endpoint Render actually uses (direct vs `-pooler`) and size the pool for
   the number of instances; set `DB_REQUIRE_DURABLE=true` in production.
4. Decide where `frontend/` is served from (Express static under `/app` with
   `base: '/app/'`, or root) and move the UI over without changing the design.
5. Point `DB_BACKUP_DIR` at durable storage, or document explicitly that backups do not
   survive a deploy.
6. Configure a search provider, then verify screenshot capture in the deploy image.
7. Instrument `runStage` behind `E2E_DEBUG=1` (packet size, post-validation finding count)
   and loop the suite until the zero-findings failure reproduces with evidence.
8. Only then start BLA: read `docs/BLA_EVALUATION.md` and section 9 of
   `reports/DB_MIGRATION_AND_BLA_READINESS_AUDIT.md`. BLA must run as an isolated worker
   on Node `^22.23.4 || >=24` (this repo allows `>=22.5`), never in-process.

## 7. Constraints for the next agent

- No push, merge, deploy, production migration, or production data change without explicit
  approval from Bittu. Local commits are fine when a milestone is complete.
- Never print `DATABASE_URL`, tokens, or any secret. Secrets live only in gitignored `.env`.
- Preserve both modules: Shield Protect (monitoring/alerts/reports) and Competitor Intelligence.
- Do not redesign `frontend/` or `public/`.
- One logical change per commit; no mixed commits.
- Do not claim a test passed unless it ran; the 4 skipped tests are PostgreSQL-only.

## 8. Read these first

`docs/PHASE0_BASELINE.md` → `docs/FRONTEND_INTEGRATION.md` →
`reports/DB_MIGRATION_AND_BLA_READINESS_AUDIT.md` → `docs/DEPLOYMENT.md` →
`src/db/migrations.js` → `HANDOFF.md` (this file).
