# Competitor Intelligence Collection (Phase 4)

Text-only, deterministic collection of what a competitor publicly says about its
own product and pricing. No model is called in this phase: the AI engine (Phase 5)
reads what this layer stored, and screenshots are explicitly out of scope.

## Pipeline

```
competitor (accepted candidate)
  -> rankTargets        homepage, then pricing / features / product / docs / about / blog
  -> fetchPage          secure fetch: robots.txt, SSRF check per redirect hop, timeout, byte cap
  -> competitor_pages   url + fetch status + text (bounded) + content hash + duplicate pointer
  -> extract-features   claims with claim level, confidence, source and evidence
  -> extract-pricing    plans with printed price, currency, interval and original wording
  -> competitor_pricing one row per competitor: the current pricing answer
```

Entry points:

| Layer | File |
| --- | --- |
| Target ranking and fetch outcomes | `src/competitor/deep-crawl.js` |
| Orchestration | `src/competitor/collect.js` |
| Persistence | `src/competitor/intel-store.js` |
| Feature extraction | `src/competitor/extract-features.js` |
| Pricing extraction | `src/competitor/extract-pricing.js` |

## A. Deep page discovery

Priority is deterministic: homepage first, then pricing, features, product, docs,
about, blog, with path and anchor hints only re-ordering candidates inside a type.

Bounds, all enforced in code:

* `CINT_MAX_PAGES` (default 12) fetches per competitor per run.
* `CINT_MAX_PAGES_PER_TYPE` (default 3) so a large docs tree cannot crowd out pricing.
* `CRAWL_TIMEOUT_MS`, `CRAWL_MAX_RESPONSE_BYTES`, `CRAWL_DELAY_MS` from the shared crawler config.
* Same-site only: off-site links, assets, login/checkout paths and query-noise are dropped
  before ranking; a discovery URL must stay on the competitor host or a subdomain of it.
* URL dedupe happens before ranking, so a page linked twice costs one fetch.
* A redirect is followed only while `crawler.fetchPage` revalidates each hop; if the final
  URL leaves the competitor's site the page is recorded as `blocked`, not fetched.
* Sitemap seeds widen coverage without widening the budget, and a sitemap that cannot be
  read is reported, not fatal.

Every target ends with an explicit outcome:

| status | meaning |
| --- | --- |
| `ok` | fetched, readable text stored |
| `failed` | network error, HTTP error, timeout |
| `blocked` | robots.txt disallowed, or redirected off-site |
| `skipped` | unsupported type, unsafe URL, or no readable text |

A run is `completed` when every target loaded, `partial` when some did, `failed`
when none did. `partial` is never reported as success, and the pages that loaded
stay usable.

## B. Features

Each feature row carries name, description (when the page explains it), category
(when a keyword maps), competitor id, source URL, page type, evidence id and
excerpt, timestamp, confidence and verification status.

Claim levels are kept distinct, because "documented" and "marketing" are not the
same evidence:

| level | where it comes from |
| --- | --- |
| `documented` | a documentation page |
| `marketing` | homepage, features, product or pricing page |
| `inferred` | mentioned on an about/blog page, not stated as a capability |
| `unverified` | a bare heading with no supporting sentence |

Confidence is the page-type base, scaled down for a missing explanation, a
rambling "name", or a weaker claim level, capped at 0.95.

Dedupe is by normalised identity (lowercase, punctuation stripped, trivial plurals
folded). The strongest observation wins and every other page that mentioned the
feature is stored as `feature_mention` evidence, so dedupe never erases a source.

## C. Pricing

Per plan: plan name, printed price, currency, billing interval, free plan, free
trial and duration, usage-based flag, enterprise/custom flag, stated limits,
stated features, original wording, source URL, timestamp, confidence.

The rules, which the tests pin:

* **A missing price stays unknown.** `price_value` is NULL and `price_stated` is 0.
  "Contact sales" produces `billing_interval = 'custom'`, never a number.
* **A missing price never means free.** `free_plan` is 1 only on explicit evidence
  (a Free plan, a 0 price, or "free forever" text), 0 only when a pricing page was
  read and lists plans with no free option, and NULL when no pricing page was read.
* **No currency conversion.** The printed number is stored as printed. `€`, `£`, `₹`,
  `¥`, `R$` map to their single currency; a bare `$` is recorded as the symbol with
  `currency = NULL` because it is USD/CAD/AUD/SGD and more.
* **No invented limits.** Lines are kept only when the page printed them, and the
  price line itself is never stored as a limit or a feature.
* **Starting price means the cheapest paid plan.** A free tier is a free tier, not
  a $0 starting price. Plans in different currencies are never compared: mixed
  currencies leave `starting_price_value` NULL and set `mixed_currencies`.
* **Original wording is preserved** in `original_text` and `price_display`.

## Storage and history

`competitor_features` and `competitor_plans` are append-only, unique on
`(competitor, identity_key, content_hash)`. A page that changes produces a new row
and the previous observation keeps the evidence it rested on. Reads return the
latest observation per identity; `?history=1` returns every observation.

`competitor_pricing` holds the current answer per competitor. `competitor_crawls`
holds one row per attempt with pages attempted/ok/failed and a reason, so a partial
or failed run stays visible after a retry succeeds.

Interrupted collection is recoverable: `recoverStaleCrawls` closes runs still
`running` after `CINT_STALE_AFTER_MINUTES` (default 20) as `partial` and marks
their unfetched pages `skipped` with a reason, instead of leaving them `pending`.

All queries name the workspace. A competitor in another workspace is
indistinguishable from a missing one (404).

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/workspaces/:w/competitors` | competitors with feature and plan counts |
| POST | `/api/workspaces/:w/competitors/:id/collect` | run one bounded collection (10 per 10 min) |
| GET | `/api/workspaces/:w/competitors/:id/intelligence` | pages, crawls, features, plans, pricing summary (`?history=1`) |
| GET | `/api/workspaces/:w/features` | features across competitors (`?claim_level=`) |
| GET | `/api/workspaces/:w/pricing` | per-competitor pricing summaries |

## Known limitations

1. **No screenshots.** Text evidence only; the UI must not imply visual comparison.
2. **No model in this phase.** Extraction is heuristic: a feature list is as good as a
   page's headings and lists, and a pricing table built from images yields nothing,
   which is recorded as no pricing evidence rather than a guess.
3. **One currency per competitor for a starting price.** Mixed-currency pages are
   reported as mixed instead of converted.
4. **Blog coverage is shallow** by design: a couple of posts at most, since a blog
   archive is not a product description.
5. **`$` stays ambiguous.** A page that never spells out its currency gets
   `currency = NULL`, because inferring USD from a dollar sign would be a guess.
