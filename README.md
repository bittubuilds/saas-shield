# SaaS Shield

SaaS Shield helps startup founders discover **potential copying of their public website content** and collect evidence of similarities for human review.

> **Honest scope:** SaaS Shield compares content you explicitly register (your site and comparison URLs). It does **not** continuously monitor the whole internet, and a similarity score is **not** a probability of infringement. Findings are labeled "potential match" and always shown with their source text so a human can judge them.

## What works (tested)

- **Auth & workspaces** — email/password sign-up with scrypt hashing, HttpOnly session cookies, automatic workspace creation, membership roles (owner/admin/member), server-enforced workspace isolation.
- **Website registration** — add one original site plus any number of comparison sites; URL validation and normalization, duplicates rejected, pause/resume/delete.
- **Crawler** — real HTTP fetching with SSRF protection (private/loopback/link-local/metadata IPv4+IPv6 blocked, DNS revalidation, redirect revalidation, port restrictions), robots.txt respect, timeouts, size caps, page/depth limits, polite pacing, identifying User-Agent.
- **Similarity engine** — deterministic n-gram shingle Jaccard + TF-IDF cosine with boilerplate filtering and exact-passage extraction. Scores are reproducible and derived only from fetched content.
- **Scans** — one scan per (original, comparison) pair, live status, findings deduplicated across scans with first/last observed timestamps.
- **Evidence & review** — per-finding evidence records: excerpts, SHA-256 content hashes, UTC capture timestamps, review status workflow (new → in_review → confirmed/dismissed) with audit history. Screenshot status is reported honestly (no browser screenshot engine in this build).
- **Exports** — JSON and PDF reports with methodology and limitations sections.
- **Dashboard** — real database-backed counts only; no fabricated metrics.

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
