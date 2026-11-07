# Evidence Versioning, Freshness and Incremental Analysis

How SaaS Shield keeps a competitor's evidence honest over time, and how that
evidence drives the AI engine without spending a model call on unchanged data.

Collection itself is described in [COMPETITOR_INTELLIGENCE.md](./COMPETITOR_INTELLIGENCE.md);
the engine's prompts and trust boundary are in [AI_SYSTEM.md](./AI_SYSTEM.md).
This document covers what sits between them.

## A. Evidence versioning

Table: `competitor_evidence` (migration 11 adds the versioning columns).
Code: `src/competitor/evidence-versions.js`.

Evidence is a **version chain per identity**, where identity is one competitor
plus one evidence type plus one field:

```
competitor cmp_123, evidence_type=pricing_plan, field=plan:starter
  v1  "Starter - $29 per month, 3 seats"   observed 06:00  superseded_by v2
  v2  "Starter - $39 per month, 5 seats"   observed 09:00  current
```

### Stable content hashing

`normaliseExcerpt()` applies Unicode NFC, strips zero-width and soft-hyphen
characters, collapses whitespace, trims, and lowercases. `contentHash()` is
SHA-256 truncated to 40 characters over that normalised text.

Consequences, all pinned by tests:

* `"Starter - $29"`, `" STARTER -  $29 "`, and `"Starter - $29\u200B"` hash the
  same, so re-indentation or a different HTML wrapper is not a content change.
* `"$29"` to `"$39"`, or a seat count changing, hashes differently, so it is a
  new version.
* The hash is over content only. The source URL is stored beside it, not inside
  it, so the same claim seen on a second page is still the same claim.

### Duplicate detection

A row is unique on `(competitor_id, identity_key, content_hash_norm)`.
Recording content that already exists is a duplicate:

* no new row is inserted;
* `observations` is incremented and `last_seen_at` moves to now;
* if the source URL differs, the result reports `source_changed: true` and the
  stored `source_url` keeps its original value (a version describes content; the
  first place we saw it stays the record of where it came from);
* content that was superseded and later returns reports `duplicate_superseded`
  and does **not** reopen the old version or create a third one.

### New version when content changes

When the content hash is new for that identity:

1. The current version is closed: `superseded_at` and `superseded_by` are set.
2. A new row is inserted with `version = previous + 1`.

Nothing else on the previous row is touched. If the insert fails because another
writer won the race, the loser restores the previous row's open state and reports
a duplicate, so a failed write can never leave two current versions.

### Historical observations are preserved

Every version keeps its own `excerpt`, `source_url`, `observed_at`, `confidence`
and `verification_status`. `historyFor()` returns the chain oldest first, and the
API at `GET /api/workspaces/:w/competitors/:c/evidence/history` exposes it.

### Timestamps

| column | meaning |
| --- | --- |
| `observed_at` | when this exact content was first recorded |
| `last_seen_at` | when it was most recently seen again |
| `collected_at` | when the collection run stored the row (unchanged legacy field) |
| `superseded_at` / `superseded_by` | when and by which version it was replaced |

Rows written before migration 11 keep their content and get `observed_at` and
`last_seen_at` backfilled from `collected_at`, with `version` NULL: they are
history, not a version, and they never block a new chain.

## B. Evidence freshness

Code: `src/competitor/freshness.js`.

| state | rule |
| --- | --- |
| `never_collected` | no successful page fetch has ever stored content for this competitor |
| `unavailable` | the most recent attempt did not succeed (error, robots block, empty page) |
| `changed` | current evidence exists that the latest **completed** analysis never consumed, or the competitor was never analysed |
| `stale` | the last successful fetch is older than `EVIDENCE_FRESH_TTL_HOURS` (default 168h) |
| `fresh` | last successful fetch is inside the window and nothing is unseen |

Priority is that order, because each state answers a different question: can we
see it at all, is the latest look clean, is the analysis behind, is the data old.

Only `completed` analyses count as having consumed evidence. A paused or failed
run has read nothing it can vouch for.

`freshnessFor()` returns the state, a human-readable `reason`, `last_success_at`,
`last_attempt_at`, `last_analysis_at`, `unseen_evidence`, `recrawl_due_at`, and a
per-URL `pages[]` breakdown.

### Avoiding unnecessary recrawls

`shouldRecollect()` returns `true` only for `never_collected`, `unavailable` and
`stale`. It returns `false` for `changed`, with the reason "evidence already
collected; only the analysis is behind": fetching again would cost a request and
change nothing, because the new evidence is already in the database and only the
analysis is out of date.

## C. Incremental AI integration

Code: `src/ai/evidence-source.js`, with the engine in `src/ai/engine.js`.

### What the engine reads

`collectEvidence()` builds one packet per competitor:

| kind | source | citable ref |
| --- | --- | --- |
| `competitor_page` | `competitor_pages` (Phase 4 deep crawl, text only) | page id |
| `page` | `pages` (original-site crawl, fallback) | page id |
| `feature` | current `competitor_features` | feature id |
| `plan` | current `competitor_plans` | plan id |
| `pricing` | `competitor_pricing` summary | `cpricing_<competitor>` |

Collected Phase 4 pages are preferred over the older crawl; the crawl is only
used when a competitor has no collected pages yet. `prompts.js` renders the
structured rows as their own block with their own citable ids, so the model no
longer has to re-derive a price it can simply cite (prompt version 4).

### What triggers reanalysis

Each stage's input hash covers the page ids and content hashes plus a
**per-stage fingerprint** of the structured evidence:

| stage | fingerprint covers |
| --- | --- |
| `pricing` | pages + plans + pricing summary |
| `features` | pages + features |
| `overview`, `positioning` | pages + features + plans + pricing |

So a price change re-runs the pricing stage and leaves the feature stage
untouched, and unchanged evidence produces an unchanged hash, which returns
`status: 'unchanged'` with no model call. A duplicate sighting is not a change,
so it triggers nothing.

### Historical analyses

`ai_analyses` rows are never replaced. A changed evidence set creates a new row
for that stage, and the previous row keeps its findings. `ai_analysis_evidence`
records exactly which evidence and content hashes each analysis consumed, so
"what changed since the last analysis" is a query rather than an inference, and
an old analysis can be read back with the evidence it rested on.

`GET /api/workspaces/:w/competitors/:c/ai/analyses` returns the history with each
run's evidence and finding count.

### Evidence references are validated

The model's citations are kept by the schema and then checked against the refs
that were actually supplied:

* no citation at all: the stage's citable evidence is attributed, as before;
* a citation that names a forged id or another workspace's row: every id is
  filtered out, the surviving list is empty, and the finding is dropped;
* `filterValidRefs()` additionally rejects a direct `cev_` citation unless that
  evidence row belongs to this workspace and competitor.

### Workspace ownership

Every read in `evidence-source.js` and `evidence-versions.js` names the workspace
id, and a competitor in another workspace is indistinguishable from a missing
one (404 on the routes). Tests cover a foreign workspace reading nothing and
citations to a foreign plan being rejected.

### Interrupted jobs and duplicate jobs

Unchanged from the existing engine, and now covered by tests over this evidence:

* a `running` stage older than the stale window is adopted and completed in
  place, same row id;
* a live stage cannot be claimed twice, so a second concurrent run reports
  `in_progress` and the provider is called once;
* `attempts`, the per-scan cap and the daily cap behave exactly as before, and a
  cap refusal still pauses rather than spends.

## Tests

| file | covers |
| --- | --- |
| `tests/evidence-versioning.test.js` | hashing stability, duplicates, versions, history, fingerprints, all five freshness states, recrawl advice, API and isolation |
| `tests/ai-incremental.test.js` | structured evidence in prompts, Phase 4 preference, no-op on unchanged, duplicate sightings, changed pricing re-runs only pricing, invalid and foreign citations, resumption, concurrent claims, quota, history API |

## Known limitations

1. Hashing is over normalised text, so a purely cosmetic edit (a reworded
   sentence that means the same thing) is still a version. That is deliberate:
   detecting semantic equivalence would need a model, and this layer must stay
   deterministic.
2. `freshnessFor()` is computed per competitor, not per evidence field; the
   per-URL detail is available but a single stale page marks the competitor
   stale, which is the conservative direction.
3. Freshness thresholds are one global TTL. Per-page-type tuning is a config
   change, not a new mechanism, if it is ever needed.
4. The pricing summary is a derived row, so its fingerprint covers the summary
   values, not every underlying plan field.
