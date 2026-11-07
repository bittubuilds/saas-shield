# SaaS Shield — execution batch report (7 Nov 2026, 18:00 IST)

Branch `feat/db-durability`, HEAD `cf53813`. Nothing committed, pushed, merged or
deployed. All 27 uncommitted entries preserved (now 31 with the new docs).

## 1. Full-suite failures (Task 1)

**Result:** intermittent, not cross-file contamination.

Evidence:
- Run 1 (before any change): 299 tests, 293 pass, 2 fail (e2e steps 11-12 and 13-15).
- Run 2 (unchanged tree): 299 tests, **295 pass, 0 fail**, 4 skipped.
- `tests/e2e-integration.test.js` alone: 10/10, seven consecutive times, including
  once with 2x CPU oversubscription.

Ruled out: `node --test` runs each file in its own child process; the e2e file sets
its own `mkdtemp` `DATABASE_FILE` and its own `PORT=0`, so env vars, workspace rows
and database state cannot leak between files. The failing assertion
(`findings were produced`) sat after a *successful* `POST …/ai` that reported
`ok: true`, so the request path was healthy.

Not yet definitively established: why the analysis returned zero findings in that
one run. The remaining suspects, in order, are (a) evidence rows whose
`observed_at` lands in the same millisecond as the analysis cutoff used by
`unseenEvidence()` (`src/competitor/freshness.js:60`, strict `>`) and
`observedSince()` (`src/competitor/evidence-versions.js:171`), which silently
excludes them, and (b) the screenshot step's memory storage under CPU starvation
producing a packet without visuals.

No assertion was weakened, no test skipped, no delay added. A fix should make the
analysis select evidence by version state (`analysed_at` per evidence row) instead
of a wall-clock cut-off; that is a schema-plus-engine change and needs its own
batch, since changing `>` to `>=` naively would re-analyse unchanged evidence.

## 2. PostgreSQL full suite (Task 2)

Run: fresh database `suite_iso` on local PostgreSQL 15, `DATABASE_URL` set,
`npm test`.

```
tests 303   pass 292   fail 10   skip 1
```

All 10 failures are SQLite-**file**-backend suites asserting file properties, not
data contamination:

- `a restore brings deleted rows back`
- `a sqlite file inside the application image is reported as not durable`
- `a truncated snapshot fails verification instead of restoring silently`
- `sqlite --swap restore parks WAL sidecars and brings the snapshot back`
- `sqlite backup captures a consistent snapshot and verifies`
- `data written by one process is readable by a different process`
- `migrations are idempotent across restarts`
- `two processes migrating the same sqlite file at once both succeed`
- `stale scan recovery still runs after a restart`
- `due checks only run pages whose next_check_at has passed, bounded per tick`

Diagnosis: these tests (and the two restart tests) assert against a database *file*,
so pointing the whole suite at PostgreSQL is unsupported by construction, exactly as
recorded earlier. The correct isolation is by backend, not by schema: run the
PG-capable suites against `TEST_DATABASE_URL` (as `tests/postgres.integration.test.js`
and `tests/db-durability.test.js` already do) and the durability suites against a
temp SQLite file. Declaring the 10 as SQLite-only in the harness would turn them
green under PG but would also hide them if a real regression appeared, so that is
proposed, not applied.

## 3. Browser verification (Task 3)

Real Chromium (Playwright) against the built React app served by `vite` with the
`/api` proxy, and a fresh backend DB.

| Check | Result |
| --- | --- |
| Redirect to `/login` when signed out | pass |
| Signup | pass (lands on `/`) |
| Session persists across reload | pass |
| Website onboarding (`POST /websites`) | pass (navigates to `/scan/:id`) |
| Initial scan screen renders stages + payload | pass |
| Missing scan id on `/report/…` | pass ("Scan not found", retry present) |
| Logout | pass (back to `/login`) |
| Login again | pass |
| Workspace isolation (2nd account) | pass (foreign workspace → 404, no foreign sites) |
| Dashboard lists the created site | **fail → fixed** |

**Defects found and fixed:**

1. **Infinite polling.** With no search provider configured the initial-scan payload
   is `{scan: null, discovery: null, comparison.available: false}` and `done: false`,
   so `Scanning.jsx` polled forever and never explained why. Added
   `needsComparison` to `describeInitialScan()` and a terminal branch: the loop stops
   and the panel says no comparison site is available. Re-verified:
   `message: true, pollsWhileWaiting: 0`.
2. **Website rows rendered blank.** `Dashboard.jsx` printed `s.submitted_url`, but the
   API serializer (`serializeSite` in `src/routes/website-routes.js`) exposes `url`
   and `domain`. Every row had an empty title. Fixed to `s.url || s.domain`.
3. **Remote fonts blocked by CSP.** `index.html` loaded Google Fonts while the backend
   sends `font-src 'self'`; tags removed.

Not exercised in the browser: cancel/retry (needs a scan that is actually running,
which needs a comparison site), competitor display, AI report rendering with a real
report, PDF download. Those need either a second site plus a live crawl or an AI key.

## 4. Repository readiness (Task 4)

Proposed inclusion (source, tests, docs):
- `saas-shield-frontend/` — `src/**`, `index.html`, `package.json`,
  `package-lock.json`, `vite.config.js`, `.env.example`, `public/logo.png`,
  `public/favicon.png`. **Exclude `dist/` and `node_modules/`** (add `dist/` to
  `.gitignore`; `node_modules/` and `.env` are already ignored).
- `tests/e2e-integration.test.js`, `tests/frontend-render.test.js`,
  `tests/ribbons.test.js`, `tests/shatter.test.js`.
- `docs/PHASE0_BASELINE.md`, `docs/BLA_EVALUATION.md`, `docs/FRONTEND_INTEGRATION.md`,
  `docs/FRONTEND.md`, `docs/REACTBITS.md`.
- `public/app.ac9c77ca.js`, `public/styles.3bd0f433.css`,
  `public/ribbons.182e9afd.js`, `public/shatter.c824b1d1.js` and the deletions of the
  superseded hashed bundles (they are the live UI).
- `docs/frontend-review/` (987 KB of screenshots) — include only if you want the
  visual record; it is the largest doc directory.

Do not include: `reports/` (80 KB of generated report output), `dist/`,
`node_modules/`, `*.db`, `data/`. `.gitignore` already covers `node_modules/`,
`data/`, `.env`, `*.db`, `*.db-shm`, `*.db-wal`; it does **not** cover `dist/` or
`reports/`.

Secret scan across every changed and untracked file found one hit —
`tests/postgres.integration.test.js` contains a `postgres://` URL; it is the local
test DSN, not a credential, but it should be replaced with `TEST_DATABASE_URL`
before inclusion. No Groq key, no Neon string, no Resend key in any tracked or
staged path.

## 5. Deployment prerequisites (Task 5)

| Item | State | Requirement |
| --- | --- | --- |
| Search provider | **not configured**; discovery returns `needs_comparison` | `SEARCH_API_KEY` (+ `SEARCH_PROVIDER` if it supports more than one); without it discovery cannot run in production |
| Playwright in image | installed locally only | Render build must run `npx playwright install --with-deps chromium`; the binary is ~150 MB and is not in `node_modules` by default |
| Render memory/disk | free tier, 512 MB, ephemeral | screenshots and the 3-browser concurrency need headroom; `SHOT_STORAGE=local` loses files on deploy. Set `SHOT_STORAGE` to a durable provider or accept `durable:false` being reported by the API |
| Neon runtime | migrations applied over HTTPS; **5432 blocked from this sandbox** | Render must set `DATABASE_URL` (pooled, `sslmode=require`); connectivity from Render is still unverified |
| Backup destination | local, ephemeral | needs a durable target outside the app image |

Environment variables (names only, never values): `DATABASE_URL`, `SESSION_TTL_HOURS`,
`COOKIE_SECURE=true`, `COOKIE_SAME_SITE`, `PUBLIC_BASE_URL`, `SEARCH_API_KEY`,
`AI_PROVIDER=groq`, `AI_API_KEY`, `AI_MODEL`, `SHOT_ENABLED`, `SHOT_STORAGE`,
`SHOT_CONCURRENCY`, `RESEND_API_KEY`, `EMAIL_FROM`, `CRON_SECRET`.

## 6. Groq approval request (Task 6)

Ready to run on approval; nothing has been sent to the provider.

- Endpoint: `https://api.groq.com/openai/v1/chat/completions` (server-side only;
  `AI_PROVIDER=groq`).
- Model: whichever `AI_MODEL` resolves to in `src/ai/provider.js` (confirm before
  running; do not change it blind).
- Payload: one JSON-mode completion containing the evidence packet
  (`src/ai/evidence-source.js`) with `response_format` JSON and a bounded
  `max_tokens`.
- Estimated usage: 1 request, roughly 3-6 k input tokens (evidence packet + prompts
  from `src/ai/prompts.js`) and under 1.5 k output tokens, then a second request for
  synthesis of a similar size. About 8-12 k tokens total, two requests.
- Quota impact: negligible against the free tier; the per-scan request counter and
  the atomic `status='running'` claim already prevent accidental repeats, and
  `input_hash` prevents re-synthesis of unchanged evidence.
- Validation: response parsed by `src/ai/schema.js` (strict, rejects unknown fields),
  every citation must resolve to a stored evidence row in the workspace, and the
  resulting report is stored as version 1 with a PDF render for comparison.

Ask: approve one scan's worth (2 requests) against a synthetic workspace.

## 7. Remaining work, by release priority

1. **Evidence-cutoff flake** (this report, §1) — make analysis select unread evidence
   by version state; without it a scan can silently produce zero findings.
2. **Search provider** — discovery is dead in production without it.
3. **Neon connectivity from Render** + first real deployment (approval needed).
4. **Playwright in the deploy image** and a durable screenshot store.
5. **PostgreSQL suite split by backend** (proposal in §2) so CI has one honest green.
6. **Browser coverage for the paths this pass could not reach**: cancel/retry,
   competitors, a rendered AI report, PDF download.
7. **Commit and push** the 31-entry working tree once you have reviewed §4.
8. **BLA Phase 3 implementation** — service boundary only; blocked on RAM/disk and
   the license notice (see `docs/BLA_EVALUATION.md`).
