# Screenshot Capture (Phase 4, visual evidence)

What this feature does, what it deliberately does not do, and why its images are
not durable in production.

> **Capture is not analysis.** These images are stored and described by metadata.
> No model has looked at them. Nothing in the product derives a visual claim, a
> visual similarity score or a "design" finding from a screenshot. The API reports
> `analysis.supports_image_input: false` and `tested: false` on every screenshot
> response for exactly this reason.

## 1. What gets captured

Runs at the end of competitor collection (`src/competitor/collect.js`), after text
pages are fetched and parsed, and only where a page was collected successfully.

| setting | default | meaning |
| --- | --- | --- |
| page types | `homepage`, `pricing`, `product`, `features` | one screenshot per type |
| `SHOT_MAX_PER_COMPETITOR` | 4 | hard cap per competitor per run |
| `SHOT_CONCURRENCY` | 1 | captures in flight at once |
| `SHOT_TIMEOUT_MS` | 15000 | hard per-page deadline, enforced twice |
| `SHOT_NAV_TIMEOUT_MS` | 12000 | navigation deadline |
| `SHOT_MAX_HEIGHT` | 2400 | viewport height ceiling for full-page captures |
| `SHOT_MAX_BYTES` | 2 MiB | a larger PNG is refused, not truncated |
| `SHOT_VIEWPORT_WIDTH/HEIGHT` | 1280x900 | render viewport |
| `SHOT_ENABLED` | `false` | must be switched on where a browser exists |

`blog`, `docs` and `about` pages are deliberately not captured: they say nothing
about the product, and each picture costs a render.

## 2. Stored metadata

Table `competitor_screenshots` (migration 12), one row per attempt:

| column | content |
| --- | --- |
| `competitor_id`, `workspace_id` | ownership, always both |
| `page_id` | the collected page the shot belongs to, when known |
| `url`, `page_type` | what was captured |
| `status` | `captured`, `duplicate`, `failed`, `skipped`, `unavailable` |
| `reason` | error code and message, or why it was skipped |
| `content_hash` | SHA-256 of the PNG bytes |
| `captured_at` | when the image was taken |
| `storage_provider`, `storage_key` | the storage reference |
| `bytes`, `width`, `height`, `duration_ms` | shape and cost |
| `duplicate_of` | the row holding the identical image |

Image bytes are **not** in the database. Only the reference is.

## 3. Deduplication

The hash is over the PNG bytes, so:

* the same image seen again in a later run is one stored blob: the new row is
  `duplicate` and `duplicate_of` points at the original, which keeps its reference;
* a re-render that differs by one pixel is a new image, stored separately;
* deduplication is per competitor. Two competitors with byte-identical images each
  get their own screenshot, because the image is evidence about each of them.

A partial unique index (`status = 'captured'`) guarantees at the database level
that one competitor cannot end up with two stored copies of the same image.

## 4. Failure behaviour, and why crawling is safe

Every failure mode produces a row and a message, never an exception to the caller:

| failure | recorded as |
| --- | --- |
| Playwright not installed | `unavailable`, reason names the install command |
| Chromium cannot launch (missing libs, OOM, sandbox) | `unavailable`, `SHOT_BROWSER_*` |
| page timeout | `failed`, `SHOT_TIMEOUT` |
| navigation or render error | `failed`, `SHOT_FAILED` |
| image over the byte limit | `failed`, `SHOT_TOO_LARGE` |
| storage write failure | `failed`, `STORAGE_ERROR`, no reference stored |
| database insert failure | `failed`, and the orphaned blob is deleted |
| private/internal target | `failed`, `SHOT_UNSAFE_URL` |

Three layers protect the text crawl:

1. `captureFor()` catches everything internally and returns a summary;
2. `collect.js` wraps the call in its own `try/catch`, recording
   `reason: 'capture_error'` in `screenshots` and continuing;
3. capture runs after collection and extraction are already stored, so even a
   process-level failure cannot un-collect pages.

### Resource limits

A headless Chromium is 150–400 MB resident. The defaults keep one browser per run,
one context per page, closed in a `finally`, one capture in flight, a viewport
height ceiling, a byte ceiling and two independent deadlines (adapter and pool). A
platform that cannot give a browser this much memory reports `unavailable`, which
is the correct outcome rather than an OOM kill.

## 5. Safety: the target comes from a competitor

* the URL passes `ssrf.assertSafeUrl()` before a browser is launched: scheme, port,
  DNS resolution, private and reserved ranges;
* every subresource request is filtered in a route handler: non-HTTP schemes
  aborted, private hosts aborted, media and websockets aborted;
* `data:` and `file:` are never loaded;
* `SHIELD_ALLOW_PRIVATE_IPS=true` is the only way to point this at a private host,
  and it exists for local development and smoke tests only.

Residual risk: a URL check is not a full browser sandbox. A page can still consume
CPU, mine crypto in JavaScript or render an enormous canvas within the timeout and
byte budget. Treat captured pixels as untrusted content, and never execute
anything derived from them.

## 6. Storage abstraction

`src/storage/index.js` exposes one interface: `put`, `get`, `delete`, `describe`,
`exists`, `stats`, plus `keyFor()` for `{workspace}/{competitor}/{sha256}.png`.

| provider | where | durable? | use |
| --- | --- | --- | --- |
| `local` (default) | `data/screenshots/` on the machine | **no** | development, a single long-lived worker |
| `memory` | process memory | **no** | tests, read-only filesystems |

`getStorage()` caches one instance per provider (and per directory), so the capture
path and the image route always share the same store.

Adding an object store later means implementing this interface. No paid provider is
configured, and none should be added without a decision to pay for it.

### ⚠️ Local and ephemeral storage is not production storage

This must stay visible to anyone reading a screenshot list, so it is not buried:

* the Render free plan has an **ephemeral filesystem**. `data/screenshots/` is a
  directory inside the container. It is lost on every deploy, every restart, every
  crash and every spin-down after idle.
* screenshots are off by default there (`SHOT_ENABLED=false`), because a free
  instance has roughly 512 MB of RAM and no room for a Chromium.
* when storage disappears, the database rows survive and keep pointing at files
  that no longer exist. The image endpoint answers `410 Gone` with a plain
  explanation and the advice to recapture, rather than a misleading `404`.
* every API response carries `durability.durable: false` and a warning string.
* nothing in this repository is a backup. If screenshots must survive a deploy, the
  requirement is durable object storage plus a retention policy, and that is a
  product decision (and a cost) that has not been made.

So: capture works, is tested and is safe to run where a browser exists. The images
are **transient** and the feature is **not** a durable visual archive.

## 7. AI integration: metadata only

Two connections exist, both metadata-level:

1. **Evidence model.** Every capture records an evidence version
   (`evidence_type = 'screenshot'`, `field = screenshot:<page_type>`) whose excerpt
   is descriptive: page type, URL, dimensions, hash prefix. It is versioned and
   freshness-tracked like any other evidence. It says what was captured, never what
   it looks like.
2. **AI packet.** `ai/evidence-source.js` attaches a `visuals[]` list and a
   `vision` capability block. The prompt renders a "SCREENSHOTS CAPTURED (metadata
   only - these images were NOT provided to you...)" section. Those ids are **not**
   citable: `allowedRefs` does not include them, so a finding cannot rest on an
   image the model never saw, and a stage fingerprint does not change because a new
   screenshot appeared (a picture does not change a text analysis).

### Why there is no visual analysis

`src/ai/vision.js` answers this in one place, and hard-codes the answer:

```js
supports_image_input: false,
implemented: false,
tested: false,
```

The configured provider (Groq) and model (`openai/gpt-oss-120b`) are used through a
text-only completion path; no image content branch exists in `src/ai/provider.js`,
and no test has ever sent an image to a model. Enabling vision means all three of:
a model that accepts image input, an image branch in the provider, and a tested
capture-to-prompt path with recorded results. Until then the API, the docs and the
prompt all say: captured, not analysed.

## 8. Running it

```sh
npm install                    # playwright is an optional dependency
npm run screenshots:install    # downloads Chromium (~130 MB)
SHOT_ENABLED=true npm start    # capture on
npm run test:screenshots       # 18 tests, no browser needed
```

Verify a real browser without touching a competitor site:

```sh
SHOT_ENABLED=true SHIELD_ALLOW_PRIVATE_IPS=true node /tmp/shot-smoke.js
```

## 9. Verified on this machine

Real Chromium (playwright 1.65.0, chrome-headless-shell 158) against a local page:

| check | result |
| --- | --- |
| adapter capability | `available: true`, playwright 1.65.0 |
| capture | 29,821-byte PNG, 800x600, 597 ms, valid PNG header |
| private target with `SHIELD_ALLOW_PRIVATE_IPS=false` | refused before launch (`UNSAFE_URL`, port not allowed) |
| non-responding server, `SHOT_TIMEOUT_MS=1500` | `SHOT_TIMEOUT` at 1,559 ms, browser closed |

The 18 automated tests use a fake provider, so CI needs no browser and no network.

## 10. Known limitations

1. Screenshots are still images of a page at one moment: no scrolling beyond
   `SHOT_MAX_HEIGHT`, no consent-banner handling, no cookie state.
2. JavaScript-heavy pages may capture before late content settles; the
   `networkidle` wait is best effort and bounded at 3 s.
3. A page that blocks headless browsers is recorded as a failure, not retried.
4. Capture cost is per page type, not per change: an unchanged page is captured
   again on the next run and deduplicated by hash, which costs a render but no new
   blob.
5. No retention or cleanup job exists for old versions or orphaned blobs yet.
6. `410 Gone` is the honest answer when an ephemeral host has lost the file, but a
   client cannot recover the image without a recapture.
