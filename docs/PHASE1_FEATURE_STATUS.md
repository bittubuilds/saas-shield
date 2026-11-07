# Phase 1 — Feature Status

Classification of every major capability against the Phase 1 product vision, at
`main` @ `01232c6a` (+ `feat/credits-mvp` @ `ef625d9` unmerged).

Legend: **Working** (implemented and covered by passing tests) · **Partially working** (real but
incomplete or limited) · **Broken** (implemented and failing) · **Missing** (not implemented) ·
**Needs verification** (believed implemented, not proven by test or live check).

## A. Foundation

| Feature | Status | Evidence / limit |
|---|---|---|
| User accounts, sessions, password hashing | Working | auth tests green; scrypt; signed cookie |
| Workspace isolation and membership roles | Working | `requireWorkspace`, cross-workspace denial tests |
| Google OAuth | Partially working | coded, not configured in production |
| Email verification | Partially working | machinery + tests exist; forced off because Resend test sender reaches owner only |
| Password reset | Missing | no route |
| Audit trail (`audit_events`, `auth_events`) | Working | written on auth, scan, workspace actions |
| Rate limiting | Partially working | auth + scan-create limiters exist; per-process memory only |
| Credits / usage limits | Partially working | complete on `feat/credits-mvp`, **not merged**; production unlimited |
| Durable production database | Broken for production use | Render free plan, no disk, SQLite file → data lost on redeploy |
| PostgreSQL support | Working (tested) | migrations + concurrency verified on real PG 15; not the deployed default |
| Migrations | Working | 1–7 on main, additive, ordered, tested |

## B. Website intake

| Feature | Status | Evidence / limit |
|---|---|---|
| Add website, URL validation | Working | `website-routes`, SSRF validation, tests |
| Duplicate website detection (URL normalisation) | Working | scheme/www/query/slash variants tested (409) |
| One scan per website (free tier) | Working | atomic claim + recovery, tested |
| Automatic scan on add | Working | `initialscan.js`; requires a competitor or search provider |
| Website pause/resume | Working | status field respected by scan/discovery |

## C. Discovery

| Feature | Status | Evidence / limit |
|---|---|---|
| Search provider integration (Serper, free tier) | Working when key configured | key present in production; `SEARCH_UNAVAILABLE` error otherwise |
| Query generation from own site copy | Working | `pickSearchSentences`, `MAX_QUERIES` |
| Competitor discovery run + persistence | Partially working | creates `websites(kind=comparison)` + scans; `discoveries` row |
| Duplicate domain removal | Working | host-based dedupe |
| Product / business-category identification | Missing | no implementation |
| Relevance ranking of candidates | Missing | first-6 by appearance, no scoring |
| Indirect / alternative competitor detection | Missing | no reasoning layer |
| Per-candidate metadata (product name, description, category, verification) | Missing | no columns, no competitor entity |
| Discovery evidence storage per candidate | Missing | only aggregate `found_hosts` |
| Manual competitor add | Working | optional path, does not block auto flow |

## D. Collection

| Feature | Status | Evidence / limit |
|---|---|---|
| Crawler (homepage + links) | Working | depth 2, 25 pages, delays |
| Sitemap support incl. indexes/nested | Working | added and tested on one-time-scan branch |
| robots.txt respect | Working | env toggle, tested |
| SSRF protection (private IPs, redirects, IPv6) | Working | `ssrf.js` + security tests |
| Response size / timeout caps | Working | `CRAWL_MAX_RESPONSE_BYTES`, 10 s default |
| Page classification (pricing/features/about/docs) | Missing | no classifier in scan path |
| Structured extraction (features, pricing, positioning, CTA, audience) | Partially working | `pricing.js` exists but is wired to monitor, not scans |
| JavaScript-rendered pages | Missing | no browser engine → those pages yield thin text |
| Screenshot capture | Missing | explicitly "not captured in this build" in code and reports |
| Visual similarity | Missing | explicitly not measured |
| Anti-bot / rate-limit handling | Partially working | delays + errors recorded; no backoff strategy per host |

## E. Analysis

| Feature | Status | Evidence / limit |
|---|---|---|
| Deterministic similarity (shingle, TF-IDF, passage, structural) | Working | `similarity.js` + tests + configurable thresholds |
| Boilerplate / generic-language filtering | Working | `normalize.js`, chrome stripping |
| Evidence records with excerpts, hashes, timestamps | Working | `evidence` table populated per result |
| Incremental AI analysis | Missing | no AI at all |
| AI provider abstraction / free-tier controls | Missing | none |
| Competitor feature matrix | Missing | no schema, no extractor |
| Pricing comparison across competitors | Missing | no cross-competitor layer |
| Cross-competitor intelligence (gaps, positioning, SWOT) | Missing | none |
| Confidence and fact/inference separation | Partially working | similarity wording is careful; no AI claims exist yet to separate |

## F. Reporting

| Feature | Status | Evidence / limit |
|---|---|---|
| Deterministic findings report | Working | Methodology / Findings / Limitations, evidence-linked |
| PDF export | Working | custom renderer, no dependency |
| Report persistence | Working | rebuilt from stored rows, survives restart |
| 17-section intelligence report | Missing | no synthesis, no narrative, no recommendations |
| Executive summary / SWOT / market gaps / action plan | Missing | none |
| Evidence source appendix per recommendation | Missing | only per-finding evidence |

## G. UI

| Feature | Status | Evidence / limit |
|---|---|---|
| Dashboard, Websites, Findings, Scans, Settings | Working | single-page vanilla bundle |
| Discovery result surfaced | Working | competitor list + initial-scan status |
| Progress that reflects real state | Working | status endpoint reads DB stages, no fake percentages |
| Scan states Discovering / Analysing / Synthesizing / Partially completed | Missing | only queued/running/completed/failed/cancelled |
| Competitor profile page | Missing | no competitor entity |
| Evidence viewer, screenshot viewer | Partially / Missing | evidence shown per finding; no screenshots |
| Credit counter | Missing | API exists only on unmerged branch |
| Responsive, accessible dark UI | Working (verified visually) | design-review screenshots in `docs/` |

## H. Reliability and operations

| Feature | Status | Evidence / limit |
|---|---|---|
| Stale scan recovery | Working | tested, scheduler tick |
| Duplicate job prevention | Working | pair claim + one-active-job (branch) |
| Retry of failed scan | Working | route + tests |
| Crash mid-scan behaviour | Working | marked failed with reason, credit refund rule on branch |
| Resumable AI tasks | Missing | no AI |
| Scheduler locking (multi-instance) | Working | `job_locks` TTL |
| Health check | Working | `/api/health` |
| Backups / restore | Missing | no backup job, no documented restore drill |
| Observability (metrics, tracing) | Missing | logs only |
| Docker image | Working (built earlier) | read-only rootfs untested without Docker |

## Dependency order for closing the gaps

1. Durable database + backups → everything downstream is meaningless without it.
2. Competitor entity + discovery metadata/ranking → needed by evidence, analysis, UI.
3. Page classification + structured extraction → feeds AI with signal instead of raw text.
4. AI provider abstraction + incremental analysis → requires 1–3.
5. Screenshots → independent, can land in parallel after 3.
6. Cross-competitor synthesis + 17-section report → requires 4.
7. UI for competitors/profiles/progress → requires 2 and 6.
8. Security/performance hardening and full QA → last, against a stable pipeline.

## Honest summary

Working today: accounts, isolation, crawler with real SSRF hardening, sitemap-aware collection,
deterministic similarity with evidence, honest deterministic reports, discovery via a free-tier
search API, and scan reliability.

Missing for the vision: the entire AI layer, competitor intelligence model, page classification,
screenshots, cross-competitor analysis, the intelligence report, and durable production storage.

Nothing in the product is "AI-powered" at this commit, and the UI should not imply otherwise.
