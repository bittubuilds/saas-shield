# SaaS Shield

SaaS Shield helps startup founders discover **potential copying of their public website content** and collect evidence of similarities for human review.

> **Honest scope:** SaaS Shield compares content you explicitly register (your site and comparison URLs). It does **not** continuously monitor the whole internet, and a similarity score is **not** a probability of infringement. Findings are labeled "potential match" and always shown with their source text so a human can judge them.

## What works (tested)

- **Auth & workspaces** — email/password sign-up with scrypt hashing, **email verification** (single-use hashed tokens, 24h expiry, resend limits, no account enumeration, legacy accounts grandfathered), optional **Google sign-in** (server-side `id_token` validation with nonce and PKCE), HttpOnly session cookies, automatic workspace creation, membership roles (owner/admin/member), server-enforced workspace isolation.
- **Website registration** — add one original site plus any number of comparison sites; URL validation and normalization, duplicates rejected, pause/resume/delete.
- **Crawler** — real HTTP fetching with SSRF protection (private/loopback/link-local/metadata IPv4+IPv6 blocked, DNS revalidation, redirect revalidation, port restrictions), robots.txt respect, timeouts, size caps, page/depth limits, polite pacing, identifying User-Agent.
- **Similarity engine** — deterministic n-gram shingle Jaccard + per-pair TF-IDF cosine + longest shared passages + structural comparison, with boilerplate filtering. A verdict (`verbatim_passage`, `copied_passage`, `high_shingle_overlap`, `distributed_overlap`, `shared_conventions`, `no_evidence`) explains what was found; a cosine-only overlap is explicitly *not* treated as copying. Scores are reproducible and derived only from fetched content.
- **Scans** — one scan per (original, comparison) pair, live status, findings deduplicated across scans with first/last observed timestamps.
- **Evidence & review** — per-finding evidence records: excerpts, SHA-256 content hashes, UTC capture timestamps, review status workflow (new → in_review → confirmed/dismissed) with audit history. Screenshot status is reported honestly (no browser screenshot engine in this build).
- **Exports** — JSON and PDF reports with methodology and limitations sections.
- **Dashboard** — real database-backed counts only; no fabricated metrics.

### Change monitoring, changelog and alerts

- **Monitored pages** — per competitor: homepage, pricing, signup and custom pages, each with its own last snapshot and schedule. Pages are discovered from internal links on the first fetch, then re-fetched on a frequency you choose (1h–1w).
- **Baseline snapshots** — the first successful fetch of a page becomes its baseline (`is_baseline=1`, final URL, redirect chain, capture status). No baseline means no change can be reported: the page shows "no baseline" instead of inventing a delta.
- **Change detection** — normalised comparison of text, headings, sections, links, CTAs, images, forms and structured pricing. Volatile values (ISO timestamps, hex/UUID identifiers, counters like "1,482 users online", cache busters, copyright years) are normalised away so they cannot raise an alert.
- **Pricing extraction** — plan name, amount, currency, billing interval and limits are parsed per plan and compared plan-by-plan ("Pro: USD 29 → USD 39 per month"). When parsing confidence is low the change is recorded as a general page-content change instead of a fabricated price.
- **Changelog** — every difference is stored with category, previous/current value, human summary, significance, confidence, evidence JSON and links to both snapshots; paginated, filterable by website/category/review state, and reviewable (open → acknowledged / dismissed). Dismissals survive re-detection of the same evidence.
- **Alerts** — one alert per unique change (deduplicated by evidence key), immediate email above a configurable severity, bounded retry ladder, delivery status and error recorded per recipient. Recipients must have a confirmed email address.
- **Weekly digest** — per-workspace day/hour, listing competitors, changes by category and a link to every changelog entry. Empty periods are skipped unless explicitly opted in; a period is never sent twice.

## Email verification

New accounts must confirm their address (`AUTH_REQUIRE_EMAIL_VERIFICATION=true`, the default).

1. `POST /api/auth/signup` creates the account with `email_verified_at = NULL`, issues a single-use token (SHA-256 hash stored only) and returns a generic message — never whether the address already existed.
2. The confirmation email contains a 6-digit code and a magic link (`/api/auth/verify?token=...`).
3. `GET /api/auth/verify` (link) or `POST /api/auth/verify` (code) confirms the address, marks the token used, and starts a session.
4. Expired, reused, superseded and tampered tokens are rejected with a specific reason (`expired`, `used`, `invalidated`, `invalid`) shown on `/app#/verify-failed`.

Rate limits: 5 resends/hour per address plus a per-IP limit. Code entry locks out after 10 wrong attempts. Passwords are scrypt-hashed; verification tokens and passwords are never logged.

**Accounts created before verification existed** are grandfathered by migration 2 (`email_verified_source='migration'`) so nobody is locked out. Set `AUTH_GRANDFATHER_EXISTING=false` to require re-verification instead.

### Email provider configuration

Nothing is sent until a provider is configured, and the app says so instead of pretending:

| `EMAIL_PROVIDER` | Requirements |
| --- | --- |
| *(empty)* | No delivery. Sends are recorded with `status='skipped'` and a reason; the UI shows a warning banner. |
| `resend` | `RESEND_API_KEY`, `EMAIL_FROM` (a verified sender domain) |
| `webhook` | `EMAIL_WEBHOOK_URL` (HTTPS, accepts `POST {from,to,subject,text,html}`), optional `EMAIL_WEBHOOK_TOKEN` |

For local development set `EMAIL_DEV_SINK=/tmp/mail.jsonl` to write messages to a file, and `AUTH_DEV_EXPOSE_LINK=true` to see the confirmation link in the API response (both are ignored in production).

## Google sign-in

Optional. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REDIRECT_URI` (must exactly match `https://<host>/api/auth/google/callback` in the Google Cloud console). The client secret stays on the server; the browser only ever sees a redirect.

The flow uses state + nonce + PKCE (S256) in a signed, expiring, HttpOnly cookie. The `id_token` is verified server-side: signature against Google's JWKS (unknown `kid` rejected), issuer, audience, expiry, nonce, and `email_verified`. Accounts are linked by Google `sub`. **An existing password account is only linked if its email is already verified** — otherwise linking is refused (`local_account_unverified`), because an unverified registration proves nothing about mailbox control. Password login keeps working alongside Google.

While the variables are empty, `GET /api/auth/google/start` returns `503 google_not_configured` with the missing variable names, and the UI hides the button.

## Scheduling

Monitoring and digests must run without a browser. Two supported mechanisms:

1. **External cron (recommended).** Set `CRON_SECRET` and call `POST /api/internal/cron` with header `x-cron-secret: <secret>` every 5 minutes. Without a secret the endpoint returns `503 cron_not_configured` (it is off, not open).
2. **In-process timer** (`ENABLE_INTERNAL_SCHEDULER=true`, default). Fine for a long-running VM, **not reliable on hosts that sleep or scale to zero** — the timer stops with the process. On Render's free tier use the external cron.

Both paths take the same advisory lock (`SCHEDULER_LOCK_TTL_SECONDS`), so two instances cannot double-run a tick, and each run is bounded by `MONITOR_MAX_CHECKS_PER_TICK`. The Monitoring page shows how many checks are due, and "Run due checks now" performs one real tick.

> Never claim 24/7 monitoring unless the scheduler is actually running: if the process sleeps, checks pause and the gap is visible as "Next check" in the past.

## Database migrations

Migrations run automatically on boot, in order, inside a transaction, and are recorded in `schema_migrations`:

| # | Name | Purpose |
| --- | --- | --- |
| 1 | `initial-schema` | users, workspaces, memberships, websites, pages, scans, findings, evidence, sessions, auth_events |
| 2 | `auth-verification` | `users.email_verified_at/source`, `email_verification_tokens`, `oauth_accounts`; grandfathers existing accounts |
| 3 | `change-monitoring` | `monitored_pages`, `snapshots`, `changes`, `alerts`, backlog columns on `websites` |
| 4 | `notification-delivery` | `notification_settings`, `alert_deliveries`, `digests` |
| 5 | `scheduler-and-indexes` | `locks`, hot-path indexes for due checks, change and delivery queries |

Migrations are additive (new tables/columns + indexes); no data is destroyed. Take a copy of the SQLite file before upgrading a production database.

## Tests

```bash
npm test                           # all suites
node --test tests/monitor.test.js  # one suite
```

| Suite | Covers |
| --- | --- |
| `tests/app.test.js` | registration, sign-in, workspace isolation, real scans against local fixture sites, review, exports, persistence |
| `tests/similarity.test.js` | identical/partial/unrelated pages, boilerplate, per-pair cosine regression, structure, verdicts, evidence integrity |
| `tests/monitor.test.js` | baseline, unchanged scan, volatile-value suppression, copy/pricing/plan/signup changes, duplicate suppression, failure, redirect, no-baseline, pagination, alerts |
| `tests/auth-flow.test.js` | verification (happy path, reuse, expiry, tamper, supersession, code lockout, resend limits), enumeration, password hashing, Google `id_token` validation and linking rules, OAuth state cookie, migration upgrade path |
| `tests/notifications.test.js` | missing provider, real delivery, digest content and links, one digest per period, empty periods, dismissals, retry ladder, scheduler lock, cron secret, preferences |

External services are never contacted: fixtures are local HTTP servers with mutable content, and the mail provider is the dev sink file.

## Known limitations

- **No JavaScript rendering.** Pages whose content is client-rendered (SPA shells) are reported as `no_readable_content` rather than silently "unchanged". A headless browser is not bundled.
- **Pricing extraction is heuristic.** Unusual layouts (sliders, "contact us", per-seat matrices) fall back to a general page change. Figures are always quoted from the snapshot; nothing is inferred.
- **Visual similarity is not implemented.** Structural comparison (headings, sections, links, CTAs, images, forms, layout conventions) is real; pixel or layout-render comparison is not, and the UI says so instead of implying it.
- **Similarity is evidence, not a legal conclusion.** Scores are not probabilities of infringement; shared templates and generic marketing phrasing are filtered and labelled `shared_conventions`.
- **In-process scheduling** does not survive a sleeping host; use the cron endpoint.
- **Screenshots of snapshots** are not captured (status reported honestly as unavailable).
- **Single SQLite writer.** Fine for a small team; very large crawl histories should move to Postgres.

## Deployment

1. `cp .env.example .env` and set at minimum `PUBLIC_BASE_URL`, `COOKIE_SECURE=true`, `DATABASE_FILE` (a persistent disk), and for real email either `EMAIL_PROVIDER=resend` + `RESEND_API_KEY` or `EMAIL_PROVIDER=webhook` + `EMAIL_WEBHOOK_URL`.
2. Keep `SHIELD_ALLOW_PRIVATE_IPS` unset/false and `AUTH_DEV_EXPOSE_LINK` unset/false in production.
3. Set `CRON_SECRET` and schedule `POST /api/internal/cron` every 5 minutes (Render Cron Job, GitHub Action, cron-job.org, or any scheduler that can send a header).
4. Point the Google console redirect URI at `https://<host>/api/auth/google/callback` if you enable Google sign-in.
5. Start the app; migrations apply automatically. Verify with:
   - `GET /api/health` → ok
   - `GET /api/auth/config` → shows whether email and Google are configured (never secrets)
   - Sign up, confirm the email, add a competitor, `POST /api/workspaces/<id>/websites/<id>/monitor`, then "Run due checks now" and confirm a changelog row after editing the competitor's page.

## Verification of the similarity report (gowthambuilds.in vs bhaveshshaha.com)

The reported "no result" was reproduced and traced to the scoring bug: corpus vectors were built once and every page pair read `vectors[0]`/`vectors[1]`, so all 35 pairs printed the same cosine score. After the fix, that pair is compared on its own evidence: 0 shared passages, 0 shared headings/links/assets, and a `shared_conventions` verdict listing what genuinely overlaps (single-column layout, one primary headline, a section list, a CTA, a form). No finding is raised, because similarity to a common portfolio layout is not evidence of copying.

## Stack

- Node.js >= 22.5 (built-in `node:sqlite`), Express, vanilla JS frontend. **Only runtime dependency: express.**
- No build step. Passwords: scrypt. Sessions: random 256-bit tokens, stored SHA-256-hashed, HttpOnly cookies.

## Setup

```bash
cp .env.example .env    # adjust values; no real secrets inside
npm install
npm start               # serves on http://localhost:3000
```

First run applies database migrations automatically. Data lives in the SQLite file at `DATABASE_FILE`.

### Tests

```bash
npm test
```

Covers: similarity engine (identical/partial/unrelated/boilerplate/malformed content), crawler security (SSRF vectors, IPv4+IPv6 private ranges, DNS rebinding, redirect revalidation, timeouts, oversized responses, robots.txt, unsupported content types), and the full application journey (auth, isolation, real scans against controlled local test sites — one with duplicated text, one unrelated — review persistence, exports, persistence across sign-in).

Latest run: **26/26 passing.**

### Controlled verification

The app tests boot two local sites: one containing a deliberately copied 100+ word passage and one with unrelated content. The scan of the copying site yields a long matched passage with hashes and timestamps; the scan of the unrelated site yields zero findings.

## Security notes

- **SSRF:** all fetches pass URL parsing + literal IP checks + live DNS resolution checks; every redirect hop is revalidated before connecting. Only ports 80/443. `SHIELD_ALLOW_PRIVATE_IPS=true` (local dev/tests only) also relaxes the port restriction so tests can use ephemeral ports.
- **Tenant isolation:** every API route requires the session's membership in the target workspace; cross-workspace access returns 404.
- **Rate limiting:** auth endpoints are rate-limited per IP.
- **XSS:** the frontend escapes all user data; API sets no user-controlled HTML.
- **Secrets:** none required; everything is env-config. Never set `SHIELD_ALLOW_PRIVATE_IPS=true` in production.
- **Retrieval of evidence:** excerpts and hashes only (no full page archives); screenshots not captured in this build — the UI says so explicitly.

## Deployment

1. Provision any Node 22+ host (or a container). Set `NODE_ENV=production`, `COOKIE_SECURE=true`, a real `PUBLIC_BASE_URL`, and a persistent volume for `DATABASE_FILE`.
2. `npm ci --omit=dev && npm start`.
3. Put the app behind an HTTPS reverse proxy (nginx/Caddy) — the app itself serves HTTP.
4. Keep the SQLite file on a persistent disk; back it up.

## Known limitations

- No internet-wide discovery: you must register comparison URLs yourself.
- No background job queue: scans run in-process; a server restart cancels running scans (they can be safely re-run).
- No screenshots of matching pages (requires a headless browser engine).
- No email delivery (password recovery/notifications not wired).
- Single-process SQLite: suitable for MVP scale, not horizontal scaling.
- The crawl is polite and bounded; very large sites are only partially fetched (page/depth caps).
