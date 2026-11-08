# Frontend

The interface is plain ES2020 in a single hashed file, `public/app.<hash>.js`, with
`public/styles.<hash>.css`. There is no bundler, no framework and no build step:
the browser loads exactly what is in `public/`. That is deliberate, it keeps the
deployable surface to three files and keeps the frontend honest about what it can
reach.

Two files hold it:

| File | Role |
| --- | --- |
| `public/app.html` | Shell document: `#root`, `#toasts`, links the two hashed assets |
| `public/app.<hash>.js` | Router, views, API calls, all rendering |
| `public/styles.<hash>.css` | Design tokens, components, responsive rules |
| `public/ribbons.<hash>.js` | Interference Ribbons canvas layer for the hero |
| `public/shatter.<hash>.js` | Shatter Type headline for the hero |
| `public/sw.js` | Offline shell; lists the hashed assets and a cache name |

`public/index.html` is the separate marketing page. It shares the stylesheet.

## The three screens

`#/dashboard` → `#/scan/:websiteId` → `#/report/:websiteId`

### 1. Dashboard

`dashboardV2()` in the script. Hero, one URL field, four feature cards, real
counts underneath.

- The URL is checked in the browser by `parseUserUrl()` and again by the server,
  which is what actually decides. Rejected in the browser: empty input, no dot in
  the host, non-http(s) schemes, embedded credentials, loopback and RFC1918
  addresses, `.local` and `.internal` names.
- Submitting sends `POST /workspaces/:w/websites` with `kind: 'original'` and
  `auto_scan: true`. The server registers the site and starts the one-time scan in
  the same request, so there is no second call to make.
- On `201` the app navigates to `#/scan/<website.id>`.
- On `409` (site already registered, or the workspace already has its original
  site) it looks the site up in `GET /websites` and goes to that site's scan
  instead of showing a dead end. Only when no match exists does the message
  surface.
- Counts come from `GET /workspaces/:w/dashboard`. Recent rows come from
  `GET /workspaces/:w/scans`. If either call fails the hero still renders and the
  scan still works; the summary is the only thing missing.

### 2. Scan progress

`scanProgressView()` renders, `pollScanProgress()` updates every 2.5s from
`GET /workspaces/:w/websites/:id/initial-scan`. Nothing on this screen is timed or
invented.

Stage states are derived from the payload:

| Stage | Done when | Otherwise |
| --- | --- | --- |
| Website Added | always, the scan was created for this site | n/a |
| Crawling Pages | `website.pages_discovered > 0` and `crawl_status !== 'crawling'` | `active`, or `failed` with `crawl_error` |
| Capturing Screenshots | capability reports a working browser and the scan completed | `unavailable` with the reason, or `pending` |
| Generating Report | `scan.status === 'completed'` | `active` / `pending` / `failed` |

The percentage is the weight of completed stages over the stages this deployment
actually runs (25 added, 40 crawl, 10 screenshots when a browser exists, 25
report). Screenshots drop out of the denominator when the capability endpoint says
there is no browser, so the bar can reach 100% without implying a screenshot that
never happened. It is labelled "of the stages this deployment runs" for that
reason.

Completion is the backend's word: the redirect to the report happens only when
`scan.status === 'completed'`. `failed` and `cancelled` stop the polling, quote
`scan.error` and offer the real retry, `POST /scans/:id/retry`. A null scan with a
`next_step` keeps polling, which covers a scan that was interrupted and is being
recovered server-side.

The in-place re-render during polling replaces `#main` only, so a click already in
flight is not destroyed.

### 3. Report

`reportView()` reads four endpoints in parallel:

| Data | Source |
| --- | --- |
| Website, scan, findings total, competitor count | `GET /websites/:id/initial-scan` |
| Key findings | `GET /results?scan_id=<scan>&limit=6` |
| AI report state | `GET /scans/:scanId/ai` |
| Screenshot availability | `GET /screenshots/capability` |

- Metrics show competitors compared, potential findings, pages compared and
  screenshot availability. "Competitors compared" counts registered sites from the
  initial-scan payload, not discovered competitor rows, which are a different
  thing.
- Findings link to the existing result screen, `#/results/:id`.
- **Download Report** points at the AI PDF when a versioned AI report exists
  (`/scans/:id/ai/report.pdf?version=N`), otherwise at the deterministic export
  for the top finding (`/reports/export.pdf?result_id=...`). No scan, no button.
- **Run AI analysis** appears only when the server reports `ai_configured` and no
  report exists. It calls `POST /scans/:id/ai` on click, because that call spends
  provider quota and should never happen on page load.
- Missing states are stated, not blanked: no scan yet says so with the discovery
  status, a finished scan with no matches explains that an empty result is normal,
  and a failed scan quotes its stored error.

## Interference Ribbons and Shatter Type

The dashboard hero has two layered effects: the headline is cut into glass shards
that assemble, crack under the cursor and shatter on click (`public/shatter.<hash>.js`,
on `[data-shatter]`), over a ribbon of fine glowing wires drifting and twisting.
Tear-down order in `render()` is: unmount ribbons, unmount shatter, replace the
shell.
It is rendered by `public/ribbons.<hash>.js` into the `.hero-ribbons` layer behind
the heading and the URL field. It has its own doc, including why the React Bits
Pro package itself could not be installed and how the props map:
[REACTBITS.md](REACTBITS.md).

Two things to know when touching it: the hero has `overflow: hidden` because the
layer bleeds 10% past each side, and `render()` calls
`window.InterferenceRibbons.unmountAll()` before replacing the shell so the
animation loop never outlives its canvas.

## Menu and footer

The hamburger opens a drawer with Dashboard, Reports (`#/results`), History
(`#/scans`), Settings, Help & Support (`#/help`) and Account / Profile
(`#/account`), then Logout at the bottom. Every destination already existed except
Help and Account, which are read-only pages built from data the API already
returns; neither invents a feature.

The footer, `Bittu Builds © 2026` / `Build. Grow. Dominate.`, is rendered by the
shell and by the auth screens, so it appears on every screen without being copied
into each view.

## What is deliberately not wired

- **Pricing** is absent from the top navigation. The product has no pricing, so a
  Pricing link would be a dead end. Features, Docs and About all resolve.
- **AI analysis** needs a provider key on the server and is never started
  automatically.
- **Screenshots** need a browser in the deployment. The UI reports the capability
  instead of offering a button that would fail.
- **Competitor discovery** needs a configured search provider; when it is missing
  the report shows the discovery state it was given.
- The older screens (results, monitoring, changelog, alerts, settings, websites,
  scan detail) still exist and are reachable from the menu and from links. They
  were restyled by the new tokens but not redesigned.

## Editing an asset

Filenames are content hashes so browsers and the service worker never serve a
stale file. After changing the JS or CSS, rename the file to its new hash and
update three references: `public/app.html`, `public/index.html` and the `SHELL`
list plus `CACHE` name in `public/sw.js`. `tests/app.test.js` reads the names back
out of the HTML, so it does not need editing.

## Verification

```bash
npm test                                    # 299 tests, 295 pass, 0 fail, 4 skipped
node --test tests/frontend-render.test.js   # the 10 UI tests, needs: npm install --no-save jsdom
node --test tests/ribbons.test.js           # the 7 ribbon tests, same requirement
node --test tests/shatter.test.js           # the 9 Shatter Type tests, same requirement
```

`tests/frontend-render.test.js` loads the real `app.html` and the real script into
jsdom with a stubbed `fetch` and asserts what each screen calls and renders: shell
and footer present, six menu destinations, URL validation refusals, POST body for a
submission, the 409 recovery path, partial versus complete progress, real metric
values, the correct PDF link in both AI and deterministic cases, the no-scan and
failed-scan states, and that a failing dashboard call leaves a usable page. It
skips itself when jsdom is absent, so the suite stays runnable without it.

Screenshots in `docs/frontend-review/` come from a Chromium run against the live
server with two local fixture sites: dashboard (desktop and mobile), the menu, scan
progress mid-scan, and the report. That run also asserted zero horizontal overflow
at 1440px and 390px, the exact footer text, the accent colour, and that the mobile
top navigation collapses to the hamburger.

## Known gaps

- No browser test runs in CI; the Chromium check above was a local script.
- The empty-findings card assumes `match_type` values the API already emits; a new
  match type would render as its raw string.
- The report has no pagination for findings beyond six; View Details opens the full
  filtered list.
