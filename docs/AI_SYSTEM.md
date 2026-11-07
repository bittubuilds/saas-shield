# AI system

Phase 5 introduces the AI intelligence engine. It reads evidence the crawler
already stored and produces cited findings plus a versioned report. It is
strictly additive: the deterministic similarity engine, the existing report
route and the PDF export are unchanged.

**Scope note.** Phase 4 (screenshots and visual evidence) is not implemented in
this repository. There is no browser automation and no `screenshots` table, so
this engine analyses page **text** evidence only. Nothing here claims visual
analysis, and the existing report already states that visual similarity is not
measured.

## 1. Provider and model

| Item | Value |
| --- | --- |
| Provider | Groq (`AI_PROVIDER=groq`), OpenAI-compatible HTTP API |
| Model | `openai/gpt-oss-120b` (`AI_MODEL`) |
| Endpoint | `https://api.groq.com/openai/v1/chat/completions` |
| Auth | `Authorization: Bearer $AI_API_KEY` (server-side only) |
| Free-tier limits (verified 2026-11-07) | 30 requests/min, 1,000 requests/day, 8,000 tokens/min, 200,000 tokens/day |

Limits were read from Groq's published rate-limit documentation on 2026-11-07,
not assumed. They are free-tier figures and can change; re-check before relying
on them for capacity planning. The 8,000 tokens-per-minute ceiling is why every
request carries one page (~4,000 characters) rather than a whole crawl.

No paid provider is configured anywhere. `AI_PROVIDER=mock` exists for tests and
never touches the network.

## 2. Environment variables

All optional. With no `AI_API_KEY` the app boots normally, `/api/.../ai` returns
`503 not_configured`, and scans plus deterministic reports keep working.

| Variable | Default | Meaning |
| --- | --- | --- |
| `AI_PROVIDER` | `groq` | `groq` or `mock` |
| `AI_MODEL` | `openai/gpt-oss-120b` | model id sent to the provider |
| `AI_API_KEY` | unset | server-side key; never returned by any route or written to logs |
| `AI_BASE_URL` | Groq v1 base | override for a compatible endpoint |
| `AI_TIMEOUT_MS` | `45000` | per-request timeout (aborted client-side) |
| `AI_MAX_RETRIES` | `2` | retries for transient failures only |
| `AI_MAX_OUTPUT_TOKENS` | `1400` | caps completion size |
| `AI_MIN_PAGE_CHARS` | `80` | pages thinner than this are not evidence |
| `AI_MAX_COMPETITORS` | `6` | competitors analysed per scan |
| `AI_MAX_PAGES` | `3` | evidence pages per competitor |
| `AI_MAX_REQUESTS_PER_SCAN` | `40` | hard request ceiling per scan |
| `AI_MAX_REQUESTS_PER_DAY` | `200` | per-workspace daily ceiling across scans |
| `AI_MAX_ATTEMPTS` | `3` | attempts per stage before it stays failed |

## 3. Pipeline

```
pages (evidence already in the DB)
  -> evidence selection (per competitor, pricing/features/home first)
  -> input hash (evidence ids + content hashes + analysis version + prompt version)
  -> unchanged? stop. finished stage? stop.
  -> provider call (one page-batch per stage)
  -> strict schema validation (uncited findings dropped)
  -> ai_findings (each row cites evidence ids and source URLs)
  -> ai_analyses status/attempts/tokens
  -> cross-competitor synthesis -> ai_reports (versioned, append-only)
```

Four per-competitor stages: `overview`, `features`, `pricing`, `positioning`.
Synthesis runs once per scan over stored findings only, so the comparison can
never know more than the evidence did.

### Incrementality

`input_hash = sha256(stage, analysisVersion, promptVersion, sorted(pageId:contentHash))`.

A stage whose hash matches a completed analysis is skipped with status
`unchanged` and costs nothing. New page content produces a new hash, hence a new
analysis row, hence fresh findings. Old findings are retained: the report is a
record of what was true when it ran, and deleting it would make history
unreproducible.

### Storage

| Table | Purpose |
| --- | --- |
| `ai_analyses` | one row per (competitor, stage, input hash, analysis version): status, attempts, tokens, error |
| `ai_findings` | claims with `claim` level (`explicit` / `inferred` / `unverified`), confidence, evidence ids, source URLs |
| `ai_usage` | requests and tokens per scan per day, for cap enforcement |
| `ai_reports` | immutable report versions per scan |

Statuses: `pending`, `running`, `completed`, `failed`, `paused`. The route maps
them to `not_started`, `running`, `paused`, `failed`, `analysed`, `completed`.

## 4. Output schemas

Defined in `src/ai/schema.js` and validated field by field. The model's JSON is a
proposal; only validated, cited content is written.

* `overview` — summary, category, use_case, audience, positioning, differentiators, unknowns
* `features` — `[{name, category, statement, claim, confidence}]`
* `pricing` — `[{name, price, interval, notes, claim, confidence}]`, `has_free_tier`, `enterprise`, `model`, `unstated`
* `positioning` — value_proposition, audience, differentiators, messaging_patterns, claims_to_verify
* synthesis — executive_summary, common_features, unique_features, gaps, swot, recommendations

Rejection rules, all enforced in code:

* a finding with no evidence id that exists in the batch is **discarded**;
* a price the page does not state is stored as `unknown`, never inferred;
* synthesis items naming a competitor outside the analysed set are **dropped**;
* SWOT buckets outside strength/weakness/opportunity/threat are **dropped**;
* malformed or non-JSON output fails the stage rather than being repaired.

## 5. Prompt-injection protection

Crawled text is fenced inside `<<<BEGIN UNTRUSTED DATA <uuid>>> ... >>>` and the
system prompt states, before any content arrives, that the block is data to be
described and never instructions. Layered defence:

1. the delimiter is random per request, so content cannot close the block early;
2. the system prompt names instruction-like text as content to ignore;
3. output is schema-validated, so an injected "report X" still has to cite real
   evidence ids to be stored;
4. the model has no tools, no network access and no credentials: it cannot fetch
   URLs, read other workspaces or reach secrets;
5. evidence ids are checked against the pages actually supplied for that stage.

An injection that survives all five layers can at worst produce a misleading
*claim attached to real evidence*, which is why every finding carries its source
URL for human review.

## 6. Usage, quota and failure behaviour

* Requests are counted per scan and per workspace-day before each call.
* `429` from the provider -> `quota_exhausted` -> stage `paused`, run stops,
  completed work stays. No retry storm, no silent provider switch.
* `401/403` -> `auth_failed`; `404` -> `model_unavailable`; `5xx` and timeouts are
  retried with bounded exponential backoff (400ms, 800ms, capped at 8s).
* Missing API key -> `not_configured`, surfaced as `503` to the caller.
* Errors are sanitized: API keys and `sk-...` fragments are redacted before
  anything is logged or stored.
* A scan with failed or paused AI stages is never reported as fully analysed.

## 7. API

All routes are workspace-scoped and return `404` for a workspace the caller is
not a member of, or a scan outside it.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/workspaces/:w/scans/:s/ai` | status, counts, provider, usage, limits, report pointer |
| POST | `/api/workspaces/:w/scans/:s/ai` | run or resume analysis, then synthesize if complete (rate limited: 6/min) |
| GET | `/api/workspaces/:w/scans/:s/ai/findings` | findings with evidence ids and source URLs |
| GET | `/api/workspaces/:w/scans/:s/ai/report` | latest report plus version history |

POST is idempotent in effect: running it twice on unchanged evidence makes no
provider calls and creates no duplicate findings.

## 8. Manual provider check

The automated suite uses a local fake provider and never spends quota. To verify
a real key once, by hand:

```bash
export AI_PROVIDER=groq AI_MODEL=openai/gpt-oss-120b AI_API_KEY=*** \
       DATABASE_FILE=/tmp/manual-ai.db
node -e "
const p=require('./src/ai/provider');
p.complete({system:'Reply with JSON only.',user:'Return {\"ok\":true}'})
 .then(r=>console.log('provider:',r.provider,r.model,'tokens:',r.usage))
 .catch(e=>console.error('failed:',e.code,e.message));
"
```

Expected: `provider: groq openai/gpt-oss-120b tokens: { tokens_in: N, ... }`.
A `401` means the key is wrong; `429` means the free daily/minute limit is spent.

## 9. Known limitations

1. **No screenshots (Phase 4).** Text evidence only; visual comparisons are absent
   and the UI must not imply otherwise.
2. **One page per stage request.** Keeps requests inside the 8K TPM free tier but
   misses cross-page context (for example a feature named on one page and priced
   on another).
3. **`pricing` reads the pricing page text only.** Tiered pricing rendered client
   side by JavaScript is invisible because there is no browser renderer.
4. **Synthesis is one request.** Findings are pre-trimmed to 12 per competitor to
   stay inside the token budget; a very large scan is summarised rather than
   exhaustively compared.
5. **No HTTP-level authorization tests yet.** Workspace isolation is proven at
   the data layer (findings, reports and analyses return nothing cross-workspace);
   the route guard itself is covered by the existing auth suite, not by a
   dedicated AI route test.
6. **The AI report is not yet wired into PDF export.** The existing PDF covers the
   deterministic report only.
7. **No live-provider test in CI.** By design: tests must never consume quota.
