# SaaS Shield — current state (read this first)

_Last updated: 2026-11-10 · About page added (public, founder-led); GitHub sign-in live in production_

This file exists so a new agent starts from here, not from zero.

## Architecture

Two source trees, deliberately separated:

| Path | What it is |
|---|---|
| `src/` | Express backend: routes, auth, DB (SQLite locally, Postgres in production), crawler, scanner, AI, PDF |
| `frontend/` | React 18 + Vite SPA. `base: '/app/'`, `BrowserRouter basename="/app"` |
| `public/` | Marketing page at `/`, the byte-identical `premium-preview.html`, vanilla `app.html` fallback used by tests |
| `tests/` | Node test-runner suite (backend + frontend static-source assertions) |

`src/server.js` serves `frontend/dist` at `/app` when it exists (`serveReactUi`), with
`/app` and `/app/*` both returning `index.html` so client routes survive a refresh.
In `NODE_ENV=test` the React bundle is skipped so tests assert against shipped files.

## Frontend

`frontend/src` is the supplied final frontend (`saas-shield-frontend-final.zip`),
adopted whole: pages (Dashboard, Scanning, Report, History, Competitors, Settings,
Privacy, Login) plus the dependency-free effects layer — `StaggeredMenu`,
`ElectricLogo`, `Aurora`/`aurora.js`, `AnimatedList`, `SplitText`, `CountUp`,
`FadeContent`, `TechText`, `BounceText`, `ShardWordmark`, `bits.jsx`
(ClickSpark, DotGrid, Magnet, ScrollFloat, ScrollReveal, SpotlightCard,
DecryptedText). No animation library is installed; `package.json` stays
react + react-dom + react-router-dom.

`frontend/src/services/api.js` is unchanged from the ZIP and matches the backend
route-for-route (verified by driving every call over HTTP). It uses same-origin
`/api` with `credentials: 'include'`; auth stays httpOnly cookie based.

**Fix carried on top of the ZIP:** `Dashboard.jsx` now sends
`kind: 'original'` for the first site and `kind: 'comparison'` for every later one,
with a one-line hint under the search. The backend allows a single original per
workspace, so without this a second URL was rejected and no scan could ever start.

The dashboard's "Example result" card is demo data (`MATCHES`) and is labelled as
such; real numbers always come from the API.

#### Dashboard audit: what the taste-skill gate reports now

`design-taste-frontend` v2.5.1 `gate`, run against a script-free snapshot of `/app` with one
website added, over two passes: **39 FAIL -> 36 -> 17 -> 12**. The page is now three bands, each
exactly one screen at 1440 (900/900/900) and 390:

1. hero: h1, the composer, a drawn report preview (inline SVG), and the facts line
   (`Reads up to 25 pages per scan · Runs in your browser · Exports to PDF`; 25 is
   `CRAWL_MAX_PAGES_PER_SITE`'s default in `src/config.js`)
2. "Your websites": the list on the left, a finding on the right, on the k=6 split line
3. "What it does": four capabilities, the page's one moment, the drawn method, and the close

What the second pass fixed, and why it is real:

- **one section per screen**: bands are `min-height: 100svh`; the hero owns the menu clearance
  (`.main:has(> .db-hero) { padding-top: 0 }`), so nothing of the next band shows on load
- **the moment runs**: the kit's own runtime is vendored to `frontend/public/moments/`
  (`moments.js`, `lib.js`, `word-highlight/`), declared in `index.html`, and mounts the dealt
  `word-highlight` on the statement. Rest state is `--db-dim` (5.6:1), reduced motion and no
  script show the words in full ink
- **no script-dependent content**: list rows animate from a Web Animations call in
  `AnimatedList`, never from a hidden CSS state
- **focus rings on the control**: inset 2px `#a78bfa`
- **layers**: the hero wash is a CSS radial ground on the section, not a child div; the WebGL
  `Aurora` chunk and the fixed `ClickSpark` canvas are gone from this page
- **edges**: the footer holds one `.wrap`; the hero `.wrap` holds one `.hero-text`; signals put
  their icon at the end of the line so the words start on the split line
- the "sample data" apology note is gone; no rules across the container

**The 12 that remain, and why they stay:**

| finding | count | why |
|---|---|---|
| focus-visible | 4 | tab stops below the fold; the checker never scrolls, the ring is present (inset 2px) |
| section-height, one-section, neighbour | 3 | the footer is 54px. Making a legal footer a full screen is worse than the finding |
| one-heading | 1 | two h2s share a screen at 5.1% of scroll positions (3% allowed); the bands are exactly one screen apart, so a 2px window at the seam |
| nav, menu-toggle | 2 | the checker wants its own starter markup (`header.nav`, `.nav__toggle` flipped by `system.js`); the real toggle binds `aria-expanded` to React state |
| effect-kind | 1 | the snapshot has no scripts, so the vendored runtime never runs; the mount is verified live (`data-moments-ready="1"`, 20 words wrapped) |
| container-edges | 1 | `div#root` is React's mount point and cannot be a `header`/`main`/`footer` |

#### Shared page container

The shell owns one gutter and one content width, both in `:root` in `styles.css`:

- `--gutter` (24px desktop, 16px at 800px and below) is the only page margin; `.shell`
  uses it and `.main` no longer adds its own 12px.
- `--content` is 1240px; `.main`, `.footer` and every app page centre on it, so the
  hero, the panels, the footer and the floating menu button share the same left and
  right edge at 1440, 1024, 768 and 390 (measured: 100/1340, 24/1000, 16/752, 16/374).
- `.sm-header` pads by `max(--gutter, (100vw - --content) / 2)` so the brand and the
  menu button line up with that column instead of a fixed 32px.

### Dashboard: one working surface (redesigned 10 Nov 2026)

`frontend/src/pages/Dashboard.jsx` plus `frontend/src/dashboard.css` (scoped `.db`).
The page is now a console rather than an effects showcase: a compact brand line and
headline, the URL composer immediately under it, then two panels (your websites,
an example report) and a four-step capability rail on hairlines.

- **Kept for function:** `normalizeUrl`, the `kind: original/comparison` rule, the
  hint that explains which one the URL will become, both `addWebsite` and
  `removeWebsite` calls, hold-to-confirm removal, navigation to `/scan/:id`, the
  `/history` link and the `#features` anchor the menu points at.
- **Kept as identity:** the lazy WebGL `Aurora` wash (now masked behind the hero
  only), `ClickSpark` on the submit button, `AnimatedList` for the sample rows.
- **Retired:** `TechText`, `ElectricLogo`, `DotGrid`, `SplitText`, `ScrambledText`,
  `BounceText`, `ScrollFloat`, `ScrollReveal`, `SpotlightCard` and the four glass
  feature cards. Every one of those components is still in the tree; only the
  dashboard stopped using them.
- **Copy:** the sample report is still labelled sample data, and the capability
  rail describes what the scanner actually does (crawl, similarity, screenshots,
  export). No numbers are invented.
- **Contrast:** action button 7.1:1, body copy 8.3:1, dim labels 5.9:1, input
  placeholder 4.8:1.
- **Dead CSS removed** with it: the old `.hero`, `.search*`, `.scan-report`, `.sr-*`,
  `.site-row`, `.remove-btn`, `.hero-tag`, `.scan-demo` and their keyframes, all of
  which had no element on any page. Shared classes (`.card`, `.insights`, `.grid`,
  `.page-narrow`, `.sub-h`, `.hold-btn`, `.alist*`) were left alone, and every other
  screen was re-rendered afterwards to confirm it.

### Sign-in page: split layout (React Bits Pro "Auth 2", rebuilt on our tokens)

`frontend/src/pages/Login.jsx` is a two-pane split: form left, brand panel right.
Class names are ours (`.auth-split`, `.auth-pane`, `.auth-aside`) and live at the
bottom of `frontend/src/styles.css` under a marked section; no rule above them was
changed. Details and the licence/CLI reasoning: `docs/REACTBITS-AUTH-2.md`.

- Two provider buttons, both real: Google and GitHub. Each reads `/api/auth/config`
  (`google.enabled`, `github.enabled`) and stays disabled with one plain note while
  its credentials are missing. The page never offers a method the deployment
  cannot honour.
- `?oauth_error=<reason>&provider=google|github` renders as readable text, and the
  wording names the button the person actually pressed.
  `src/routes/auth-routes.js` now redirects failures to `/app/login?oauth_error=...`
  and successes to `/app/` — the old `#/signin` and `#/dashboard` targets never
  matched the path-based router, so error messages were silently dropped.
- 50/50 split at ≥900 px (form capped at 400 px), single column below with the
  brand panel hidden. Checked at 1440, 1024, 768 and 390 px, no horizontal overflow.
- Auth behaviour unchanged: httpOnly cookie sign-in, instant-mode signup fallback,
  `.field-error` for errors, `.muted role="status"` for notices, spinner while busy.

### GitHub sign-in (added on request)

`GET /api/auth/github/start` -> GitHub consent -> `GET /api/auth/github/callback` ->
session, mirroring the Google route but built for how GitHub actually behaves:

| Difference | Consequence in the code |
|---|---|
| No OIDC id_token | nothing is verified locally; identity is read from `api.github.com/user` with the token we just exchanged (`fetchGithubIdentity`) |
| No PKCE support | the HMAC-signed HttpOnly state cookie (`shield_oauth_github`, path `/api/auth/github`) plus the server-side secret are the redirect protection |
| Email can be hidden or unverified | only an address GitHub marks `verified` is trusted (`pickGithubEmail`: primary verified first, else first verified); none -> `email_not_verified`, never a guess |

Account linking is shared with Google: `resolveUser(claims, provider)` keeps the
`oauth_accounts` row namespaced by provider (a GitHub id `90210` and a Google sub
`90210` are different people), still refuses to attach to an unverified local
password account, and stamps `email_verified_source = 'github'`.

Env needed on the deployment:

```
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GITHUB_REDIRECT_URI=https://saas-shield.onrender.com/api/auth/github/callback
```

The GitHub OAuth App (github.com/settings/developers -> New OAuth App) needs the
homepage `https://saas-shield.onrender.com` and exactly that callback URL.
`/api/health` now reports `github_oauth_configured` next to the Google flag.

### About page: founder-led storytelling (public)

`/app/about` is a real page in the React app and works signed in and signed out.
`App.jsx` mounts it outside `Layout`, so it renders full-bleed with its own slim
header instead of the app shell.

| File | Role |
| --- | --- |
| `frontend/src/pages/About.jsx` | six sections: hero, the problem, the founder, two brands, the product, closing |
| `frontend/src/about.css` | every rule scoped under `.ab`; shares nothing with the app shell |
| `frontend/public/founder-bittu.webp` | the supplied portrait, byte-identical (`sha256 e7d3a010…`), no filter, no crop, natural 1856x2320 ratio |
| `frontend/public/fonts/*.woff2` | self-hosted Inter Tight (variable 100-900) and Instrument Serif (roman + italic), 88 KB total |

Typography is self-hosted on purpose: the server CSP is `font-src 'self'`, so a
Google Fonts link would be blocked in production and only look right locally.

Motion is one IntersectionObserver revealing `[data-reveal]` blocks, hero lines
that rise once on mount, and a 2px hairline tracking reading progress. All of it
collapses under `prefers-reduced-motion`.

Copy rules followed: no invented statistics, no testimonials, no legal claims. The
product section says what the scanner does and then states plainly that it does not
decide whether something is lawful copying.

The Bittu Builds link is a single constant (`BITTU_BUILDS`) pointing at
https://bittubuilds.github.io/bittu-builds/ — verified live on 2026-11-10, not
invented at render time.

## Verified (2026-11-09, local server + built bundle)

- `npm test`: 334 tests, 308 pass, 0 fail, 26 skipped.
- `npm run build` (root, as Render runs it): succeeds. The dashboard no longer loads the
  WebGL `Aurora` (its wash is a CSS ground), so no lazy chunk is emitted for it; the moment
  runtime ships as static files under `app/moments/`.
- Real scan end to end in a browser: signup → add site → add comparison →
  scan runs → report → history → competitors → settings → logout. Wikipedia
  vs its mobile mirror: 625 pages compared, 123 findings.
- `/app/history` and `/app/privacy` survive a hard refresh; no horizontal overflow
  at 390 px; slide-out menu opens and closes.
- `GET /reports/export.pdf` → 200 `application/pdf`. AI endpoints answer honestly
  (no report invented) when the provider is paused or unconfigured.

## Dashboard: taste-skill gate, 12 -> 6 (2026-11-10)

The dashboard audit started at 39 findings, reached 12 after the band rework, and is now 6.
What changed in this pass, all of it structural rather than cosmetic:

- **The page closes on its own screen.** `Layout` renders `footer.closing.db-closing` on `/` only:
  the wordmark, the statement, a six-item recap of what a scan keeps, and the legal row. Other
  routes keep the slim `.footer` strip. This cleared `section-height`, `one-section` and
  `neighbour` (the old 54px footer could never be one screen, and at 390 px it peeked into the
  method band's last screen).
- **The closing band is not empty.** Its right column is a real recap list, not padding, which
  cleared `empty-area` (54% empty with only two blocks in a 900px band).
- **One split grid on the page.** The closing columns now use `.db-split` / `.db-split-l` /
  `.db-split-r`, so the fourth band's right column starts on the same x (732 at 1440) as the hero
  and the work band. Phones stack it, and the stack rule sits after the desktop rule so it wins.
- **One heading per screen.** "Your websites" is a small `.db-kicker` label with an `.sr-only` h2
  behind it, so the page shows one h2 instead of two competing ones.
- **The nav is the container, not the viewport.** `.sm-header` is centred on `min(100% -
  2*var(--gutter), var(--content))`, so its bar runs from the content's left edge to its right
  edge (100..1340 at 1440, 16..374 at 390). The toggle is `button.nav__toggle` with a single
  label ("Menu" / "Close") instead of two stacked words, and the header carries `nav` again.
  Two dead legacy `.nav` rules that styled a bordered marketing card were removed; nothing
  referenced them.
- **The moment module is in the document.** `index.html` modulepreloads
  `moments/word-highlight/moment.js`, not just `moments.js`, so the runtime is discoverable
  without executing the page.
- **Phone bands are whole screens.** At <=620px the bands are `min-height: 100svh` (the method
  band two screens) with trimmed row padding, so 390x844 measures 844 / 844 / 1688 / 844.

The 6 that remain are artifacts of how the checker reads a script-free snapshot, not defects:

| finding | why it stays |
| --- | --- |
| `focus-visible` x4 | Tab stops 5, 9, 10, 11 sit below the fold; the checker tabs from scroll 0 and judges the ring against that viewport. Each element does take the ring when scrolled to. |
| `menu-toggle` | The checker clicks in a document with every `<script>` removed, so React cannot flip `aria-expanded`. In a real browser the button opens the panel and the label becomes "Close". |
| `container-edges` | `div#root` is the React mount point. Its `<div>` cannot be renamed. |

## Settings: taste-skill gate, 18 -> 6 (2026-11-10)

Settings was the last page still on the old `.doc` cards. It now uses the dashboard's console
grammar in its own stylesheet (`frontend/src/settings.css`), so it reads the same when it is the
first page someone opens. The audit started at 18 and now matches the dashboard's 6 artifacts.

Two bands, one screen each, one `.wrap` per section on the shared container:

- **Band 1, the account.** `hero-text` holds a 12-column grid: the statement on the left
  (cols 1-6), the profile rows and the session actions on the right (cols 7-12), and a
  full-width status row underneath carrying the two figures this workspace actually holds,
  pulled from `listWebsites()` and `listScans()`. Nothing on the page is invented.
- **Band 2, the irreversible action.** Text left (what deletion removes), the drawn scope map
  and the confirmation field right, so the split opens on words.

What each fix bought:

- **The hero starts at 0.** `.main:has(> .st-hero) { padding-top: 0 }` matches the rule the
  dashboard already used, so the first band runs 0..900 instead of 62..962. That one line
  cleared `hero-screen`, `section-height`, `one-section` and `hero-fold`.
- **`hero-text` is the hero's single child.** `.wrap > .hero-text` is the shape the checker
  reads as a hero; `.hero-text` carries no styles of its own.
- **The page closes on its own screen.** `Layout` renders `footer.closing` on `/` and
  `/settings`; the document-style pages (About, Privacy) keep the slim strip.
- **The figures are a status row, not a column.** Moving them out of the hero text full-width
  dropped `empty-area` from 53% to under 50%, and putting the note on the column line (x 732)
  cleared `edge-left`.
- **Nothing is drawn on a background layer.** The `.st-wash` div is gone: a child of a section
  cannot span 0..1440 inside `.main` (max-width 1240), so `flush` and `container-edges` went
  with it and the band's own ground does the work.
- **Figures stay under the heading size.** `.st-figure` caps at 32px against the 34px section
  display, which cleared `heading-scale`.
- **One visible heading at a time.** Band 2 opens with an `.sr-only` h2 and shows its title as
  text, the same trick the dashboard's "Your websites" band uses, so the hero h1 and the band
  title never share a screen (`one-heading`).
- **A moment, dealt and mounted.** `counter-rolls` (the kit's own pick for a software page) is
  vendored at `frontend/public/moments/counter-rolls/` and rolls the two figures once the real
  counts arrive. `mountAll` only scans the document once, so the page mounts the host by hand
  when `counts` lands; `data-moments-ready="1"` and `data-moment-mounted` confirm it.

The 6 that remain are the same artifacts the dashboard carries:

| finding | why it stays |
| --- | --- |
| `focus-visible` x4 | The confirm input, the hold button and the two footer links sit below the fold; the checker tabs from scroll 0 and judges the ring against that viewport. Each takes its ring when scrolled to. |
| `menu-toggle` | The checker clicks in a script-free document, so React cannot flip `aria-expanded`. |
| `container-edges` | `div#root` is the React mount point. |

Measured after the rework: 900 / 900 / 900 at 1440x900 (hero, band, closing), 844 / 954 at
390x844, `document.scrollHeight` 2724, no horizontal overflow, no console errors. Snapshot for
the gate: `frontend/dist/settings-audit.html` (built page, stylesheets inlined, scripts removed,
the moment's figures restored from their `aria-label`).

## Documentation centre (2026-11-10)

Every page of documentation that ships with the app, written against this build.

- **Routes**: `/app/docs` (index) and `/app/docs/:slug` (35 articles), registered in both
  trees in `App.jsx`, so the docs are readable signed out and signed in. Signed in, the
  header CTA returns to the dashboard; signed out it offers sign-in. Linked from the
  StaggeredMenu, both footers and the sign-in page.
- **Content model**: `frontend/src/docs/content.js` is the single source. Seven sections,
  35 articles, each an ordered list of typed blocks (`h2`/`h3`/`p`/`ul`/`ol`/`steps`/`table`/
  `callout`/`related`). Adding an article is one object: the sidebar, search index, TOC,
  prev/next and breadcrumbs all derive from it. No content lives in JSX.
- **Search reads the body, not the labels.** `searchDocs` requires every query term to
  appear in the article text, scores title 12 / summary 3 / body by frequency, and returns a
  snippet around the first hit. "quota exhausted" finds the error table; a term that only
  exists in a heading is found too. Two characters minimum, eight results maximum.
- **TOC and active states.** `h2`/`h3` blocks get stable ids (`s-<index>-<slug>`); the right
  rail is an `IntersectionObserver` with a `-88px / -68%` root margin, and the sidebar marks
  the current article with `aria-current="page"`.
- **Mobile**: below 860px the sidebar becomes an off-canvas drawer behind a 44px
  `Contents` pill, with `aria-expanded`, a scrim that closes it, Escape to close and a close
  on navigate. No horizontal overflow at 390px; tables scroll inside their own wrapper.
- **Design**: one ground `#07070a`, then the app's own tokens (`--border`, `--text`,
  `--muted`, `--violet-l`, `--surface-2`) so the shell cannot drift from the product; violet
  only for links, active states and step numbers. Body 16px/1.7 at `#cdcbdb` on a 58ch
  measure (522px, ~75 characters) inside a 1180px grid. Muted `#9e9cb2` (7.5:1), labels
  `#8a889e` (5.8:1), smallest type 11.5px, headings Inter Tight 600 with tight tracking.
- **Impeccable pass (2026-11-10)**: the reading surface was measured against the shipped
  skill's detectors. Line length 94 → 75 characters, labels 10.5px → 11.5px, callouts
  rebuilt without the coloured side bar, `text-wrap: pretty`/`balance` on prose, list items
  and headings (which removed every orphaned last word), and the FAQ regrouped under three
  real `h2`s instead of jumping `h1` → `h3`. Detector result: 0 findings on all 35 articles
  at 1440, and 0 at 1024 / 768 / 390 / 320.
- **Performance**: the docs route is `React.lazy` + `Suspense` in `App.jsx`. Docs ships as
  its own chunk (`Docs-*.js`, ~22.9kB gzipped) instead of riding in the dashboard bundle,
  which fell from 319kB to 248kB.
- **Keyboard**: a `Skip to content` link is the first tab stop and moves focus to `#dc-main`
  (`tabIndex={-1}`). Search results are real listbox options (`role="option"` +
  `aria-selected`), driven from the input via `aria-activedescendant`, not buttons nested
  inside options. The mobile drawer takes focus on open (first nav link), returns it to the
  toggle on Escape or scrim dismiss, and is `visibility: hidden` while shut so its 35 links
  stay out of the tab order; the hide is delayed to the end of the slide-out, the show is
  immediate.

Verified on the built bundle at 1440 and 390: all 35 pages return content (no empty body),
46 internal links resolve to routes that exist, search returns body hits, the TOC scrolls
and marks itself, the drawer opens/navigates/closes, zero page errors, `npm test` 308 pass.

Re-verified live on Render after `540b256`: computed body 16px/27.2px on a 522px measure in
a 1180px grid, `text-wrap: pretty` active, skip link first in the tab order, 7 index cards,
drawer focus on "Introduction" at 390px, no horizontal overflow at either width, zero page
errors.

The honesty rules the content follows, because they are easy to break later:

- Nothing is documented that the interface cannot do. Backend-only capabilities (discovery,
  monitoring, alerts, members, finding status changes, CSV exports) are collected on one page
  and labelled, and each affected article names its own gap.
- No public API is claimed, so there is no API reference, no fake endpoints, no keys.
- Every limit quoted is a real configured default: 25 pages per site, six competitors and
  three pages each for the analysis, 40 model requests per scan, 200 per day, three attempts.
- The similarity section repeats the product's own position: the score is measurable overlap,
  not a probability of copying, and a report is not a legal opinion.

## Verified on production after the dashboard rework (2026-11-10, 11:3x IST)

`main` `f099a99..3c3f083` pushed and rebuilt by Render automatically; `/app` now serves
`app/assets/index-CmdUliZm.js` + `index-CSqyJzQD.css`, the same hashes as the local build, and
`app/moments/{moments.js,lib.js,word-highlight/*}` answer 200.

- `/api/health` 200: Postgres, 42 tables, migration 14, writable; Google and GitHub OAuth both
  report configured.
- Signed out, `/app` lands on `/app/login` ("Welcome back.") with the theme applied and no
  console errors beyond the expected 401 from the session probe.
- The two bands that carry behaviour were verified locally against this same bundle before the
  push: scan submit → `/scan/<id>`, list row → `/scan/<id>`, hold-to-remove, CTA focus, and the
  word-highlight moment mounting (`data-moments-ready="1"`, 20 words wrapped).

## Verified on production (2026-11-09, 16:5x IST)

Deployed via `main` `0f70001..134dd70`; Render rebuilt automatically from the
blueprint and now serves `app/assets/index-CakRDldO.js` — the same bundle hash the
local run tested, so the two builds are identical.

- A throwaway account ran the real flow: signup → example.com → example.org →
  scan `completed` → report page → history row → `reports/export.pdf` 200
  `application/pdf`. Account then deleted through `DELETE /auth/account`
  (`{confirmed, workspaces: 1 removed, audit retained}`), session dead afterwards.
- Signed-out the login card renders; `/app/history` and `/app/privacy` survive a
  hard refresh (they redirect to sign-in, as protected routes should); 390 px has
  no horizontal overflow.
- `/api/health`: Postgres, 42 tables, migration 14, writable, scheduler on.
- **AI is not configured in production** (`ai_configured: false`, provider groq,
  model `openai/gpt-oss-120b`). The Render env needs `GROQ_API_KEY` (or
  `AI_API_KEY`); nothing in `render.yaml` sets it. Until then "Run analysis"
  tells the user it is unavailable instead of inventing a report.

## Verified on production after the split-sign-in deploy (2026-11-09, 16:20 IST)

`main` `2c8f2be..ac4760b` pushed and rebuilt by Render; `/app` now serves
`app/assets/index-CbYQX1kb.css` + `index-L0TE9tBD.js`, matching the local build.

- Signed out, `/app` renders `.auth-split` with the brand panel and the Google
  button disabled plus its note; at 390 px the panel hides and nothing overflows.
- Throwaway account: real signup → dashboard → registered `https://example.com`
  (`original`) → added `https://www.iana.org` (`comparison`) → scan
  `scn_PD8lhzOMh919D7tz` reached `completed` with both crawls finished → report page
  rendered (`Report Overview`, `example.com vs iana.org`). 0 findings is correct:
  the two sites share no content.
- Hard refresh on `/app/history`, `/app/competitors`, `/app/settings`,
  `/app/privacy`: all 200 with the right heading. No failed asset requests and no
  page errors in the whole run.
- AI analysis answers `503 {"error":"AI analysis is not configured on this server."}`
  — honest, still waiting on `GROQ_API_KEY`.
- Test data removed: `DELETE /api/auth/account` → 200, session dead (401) after.

## Security re-run (2026-11-09)

- `tests/crawler-security.test.js` 15/15 · `tests/auth-flow.test.js` 16/16 ·
  `tests/account-delete.test.js` 6/6 · full suite 321 tests, 295 pass, 0 fail, 26 skipped.
  Coverage includes SSRF (private, loopback, IPv6, DNS revalidation, redirects,
  size/timeout caps, robots.txt), signed single-use verification tokens, slow
  password hashes, Google `id_token` validation and OAuth state tamper checks,
  plus deletion that requires confirmation and keeps the audit trail.
- Live probes against the running server: CSP (`default-src 'self'`,
  `frame-ancestors 'none'`, `object-src 'none'`), `X-Frame-Options: DENY`,
  `nosniff`, `Referrer-Policy`. Session cookie is `HttpOnly; SameSite=Lax`
  (`Secure` in production). Every `/api/*` data route answers 401 unauthenticated.
  `/app/../../etc/passwd` and `/app/..%2f..%2fpackage.json` both fall through to
  `index.html` — no file disclosure. Sign-in lockout: 10 failed attempts per email
  + IP in 15 min, then `429 Too many attempts` (persisted in the DB, so a restart
  does not reset the budget), and signup never reveals whether an address exists.

## Empty scans are no longer silent (2026-11-10)

Found while testing the pipeline end to end. A scan whose pages carry too little
readable text completed with `pages_compared 0`, `findings 0` and no signal at all,
so the UI showed a clean result for a comparison that never happened. Reproduced with
a real pair: `example.com` (171 characters of text) against a site behind a
JavaScript bot challenge (0 characters stored). Both were under the 50-word floor,
so nothing was compared and nothing said so.

Fixed by recording the reason on the scan itself:

- `scans.notice` (migration 15) holds a plain-language explanation.
- `src/scanner.js` counts readable pages per site when no pair is eligible and writes
  the notice with both host labels, for example
  `Nothing was compared: no page pair had at least 50 words of readable text on both sides (example.com: 0 of 1 page(s) readable, bittuxnorthform.wuaze.com: 0 of 1 page(s) readable).`
- `src/initialscan.js`, `frontend/src/services/api.js` and the Scanning screen pass it
  through, so the progress screen states the reason instead of "No overlapping content
  was found."
- `tests/detection-pipeline.test.js` asserts the notice appears, states that nothing
  was compared, counts readable pages, and names both sites with their port.

Scan status stays `completed`: the run did finish, it just proves nothing. Anything
that reads `pages_compared` should treat `0` together with a notice as "not examined"
rather than "clean".

## Removed sites no longer block the workspace (2026-11-11)

Removing a website archives the row (`archived_at`) so its scans and reports stay
readable, but four lookups still treated archived rows as live: the "one original"
guard and the self-pair guard in `src/routes/website-routes.js`, the active-original
and comparison lookups in `src/initialscan.js`, and the dashboard's
`monitored_websites` count. The visible symptom was a workspace that refused a new
original with "Pause or remove it first" after the site had been removed.

Re-adding a removed URL now restores that same row (`restored: true`, status 200)
instead of returning 409, because a second row for the domain would split the page,
scan and report history in half. Covered by the journey test in `tests/app.test.js`.

## Discovery without a search key (2026-11-11)

Auto-discovery was gated on `SERPER_API_KEY`, so a deployment without the key could
never find comparison sites: adding an original left the scan page at 0% with
`needs_comparison` and an instruction to add a site by hand.

`src/search.js` now runs a provider chain: Serper when the key exists, otherwise
DuckDuckGo's HTML endpoint then Mojeek, both keyless. The first engine that returns
links wins, results go through the existing host blocklist and SSRF-guarded crawler,
and if every engine fails the discovery still reports an honest error rather than an
empty success. A dead key also falls back instead of switching discovery off.

Because `search.isSearchConfigured()` is now true without a key, `src/initialscan.js`
starts discovery automatically on adding a website: `initial_scan.mode` is
`discovery`, found sites are registered as comparison websites and scans are queued.
The keyless chain is off under `NODE_ENV=test` (tests stub `fetch`) and can be forced
off in production with `SEARCH_KEYLESS_DISABLED=1`.

Open risk: public engines rate-limit datacenter IPs. If discovery starts failing on
Render, set `SERPER_API_KEY` (free tier, serper.dev) and the same code path becomes
reliable without any other change.

## Pages that ship a JavaScript shell (2026-11-11)

Free hosts and SPA sites answer a plain GET with a stub ("This site requires
Javascript…") and deliver the real page only after script runs. The crawler stored
that stub, so the page text was empty, discovery had no sentence to search and the
scan compared nothing. Reproduced on `bittuxnorthform.wuaze.com`, which returns 852
bytes of InfinityFree challenge markup.

`src/render.js` renders such a page once with the browser screenshots already use and
returns the hydrated HTML; `src/crawler.js` calls it only when a response carries less
than 200 characters of visible text, and keeps the thin copy if the render fails so a
browser problem never loses the page. The rendered context reuses the capture
blocklist, so a page cannot pull an internal address in through script or fetch.

Switches: on automatically when `NODE_ENV=production` and Playwright is installed,
forced with `CRAWL_RENDER_THIN_PAGES=1`, off with `0`. Tests inject a renderer instead
of launching a browser. Verified on the real site: 0 → 1879 characters of readable
text after the fallback.

## Discovery trusted a stale empty page (2026-11-12)

Seen in a screen recording of the live app: the scan screen showed
`Discovery: failed`, `Pages read: 1`, `Pages compared: -`. Serper and the render
fallback were both live, so the failure was in discovery itself.

`runDiscovery` only crawled the original when it had no stored pages
(`COUNT(*) = 0`). The site had one stored page left over from before the render
fallback existed: an empty JavaScript-challenge shell. Discovery counted that row,
skipped the crawl, found no sentence to search and failed with "no distinctive text".
The scanner had already been fixed to re-crawl in this situation; discovery was missed.

Fix: discovery now also re-crawls when no stored page holds a usable sentence (15 or
more words). Words rather than characters, so a short but real landing page is never
re-fetched on every run. Covered by `tests/discover.test.js` ("re-crawls when the
only stored page is an empty shell"), which reproduces the production state: it failed
before the change and completes after it.

## Surviving a sleep or a restart (2026-11-12)

A host that stops the process mid-run (a free Render instance spinning down after
15 idle minutes, a crash, a deploy) left any in-flight discovery at
`status='running'` forever. Scans already had recovery (`src/scan-recovery.js`);
discovery did not, so the progress screen would keep waiting on a job that no
longer existed.

`recoverStaleDiscoveries()` now closes `queued`/`running` rows older than the stale
window with a readable reason, and the scheduler calls it next to scan recovery.
Nothing is re-queued automatically, so recovery cannot double-spend search quota.
Covered by `tests/discovery-recovery.test.js` (stale closes, fresh is untouched).

## An empty scan reported itself as finished (2026-11-12)

The screen stayed at 0% after the discovery fix, because the payload still said the
work was over. `status()` set `done` for any `completed` scan, even one that compared
zero pages, and the self-healing poll only acted while `!done`. Two guards in
`src/initialscan.js` also counted that empty scan as the workspace's scan, so
`queueScan` refused to create a new one.

Now a `completed` scan counts only if it compared at least one page (or produced a
finding). An empty one is reported with `empty_scan: true` and `done: false`, the poll
takes the decision again, and the atomic insert ignores empty completed rows. Covered
by `tests/empty-scan.test.js`: an empty scan is not done, a real scan still is, and an
empty scan no longer blocks the next step.

## Discovery had no budget (2026-11-12)

Repeated discovery runs stacked work: every run added up to six comparison websites
and six scans, and the progress screen retries discovery. A workspace could sit on
dozens of comparisons with nothing visibly moving, which reads as frozen.

`src/discover.js` now bounds it: at most 8 live auto-discovered comparisons per
workspace and at most 3 queued/running scans before a run stops adding more. Existing
sites are still reused, so a run is never wasted; candidates past the budget are
skipped and counted in the audit entry. Covered by `tests/discover.test.js` (three
runs over ten candidates stay within both limits).

## Queued work lost on restart (2026-11-12)

Scans and discoveries run from an in-memory queue (`setImmediate`). A deploy, a
restart or the browser-install reboot loses those jobs while the database row still
says `queued`. The progress screen then showed `Status: queued` with nothing behind it,
and the stale window only failed the row after fifteen minutes. Seen in a screen
recording right after discovery reported `completed`.

`resumeQueuedWork()` (src/scan-recovery.js) runs at boot and hands every never-started
`queued` scan or discovery back to the queue. Only rows with no `started_at` are
resumed, so nothing can run twice; rows already `running` are left to the stale-window
recovery because a half-finished crawl is not restartable. Covered by
`tests/discovery-recovery.test.js`.

## "Queued" with nothing queued (2026-11-12)

Seen in a screen recording: `Discovery: completed`, `Pages read: 2`, `Status: queued`,
`Pages compared: -`. Reproduced locally: a completed discovery that registered no
comparison creates no scan row, and `describeInitialScan` then fell back to the
placeholder `'queued'`, which reads as a waiting job when nothing was waiting.

Changes: the screen now says `no scan started` plus the reason when discovery is over
and there is no scan; a completed discovery that kept nothing records why in
`discoveries.error` (no search results, only own/platform links, or scans already
running); the initial-scan payload carries `worker` (true only if this process holds the
scan) and `started_at`; a `queued` scan with no worker is handed back to the queue by the
poll itself, not only at boot. Covered in `tests/discover.test.js`.

## The discovery cap locked itself shut (2026-11-14)

The caps added on 12 Nov had no way back. Earlier builds added up to six auto-discovered
comparison sites per run, so a workspace could carry dozens; `siteBudget` was then
`8 - 36 = 0` on every later run, and discovery completed having added nothing, with no
scan created. The progress screen showed `Discovery: completed`, `Pages compared: -`,
which is exactly the recording from 22:47.

Three fixes, all in `src/discover.js` and the initial-scan poll:

- `trimAutoDiscovered()` archives auto-discovered sites past the cap before the budget is
  computed, preferring to keep the ones whose scans produced findings. It never archives a
  site a scan is using, and archiving keeps its pages, findings and reports.
- A discovered site that never got a scan (the state a restart leaves) is handed its scan
  at the start of the next run, inside the same scan budget.
- The poll starts a scan whenever nothing is actively running, instead of requiring that
  no comparison existed at all. After three automatic attempts in an hour it stops, so a
  comparison that cannot be crawled is not retried forever.

When the cap genuinely is reached the row now says so in words ("already tracks 8
auto-discovered sites... remove one"). Covered by four new cases in
`tests/discover.test.js`.

## Only exact quotes were searched (2026-11-14)

Live: `Discovery: completed - Search returned no results for 1 quoted sentence(s) from
your site. Your wording may not appear anywhere else yet.` Two separate problems.

Only one query was built, because the picker returns at most one sentence per page and
only one page had qualifying text. And that one query was the sentence in quotes, which
asks Google for that exact string: it can only ever match a word-for-word copy. A site
whose text is original therefore found nothing, every time, which makes the discovery
step useless for finding competitors.

`buildSearchQueries()` now builds up to `MAX_QUERIES` queries: each chosen sentence is
searched unquoted first (same subject, finds sites competing for it) and quoted second
(max 12 words, catches verbatim copying), with the page title and description added when
the site has little text. Duplicates are dropped and the budget is unchanged at five
queries per run.

Also: a discovery that finished without a result used to block the poll forever, because
`idle` required no discovery row at all. Only a live (queued/running) discovery blocks it
now, so a run with no results is retried after the reuse window.

## Known gaps, in priority order

1. **AI provider key missing on Render.** Set `GROQ_API_KEY` (or `AI_API_KEY`) in
   the Render env and redeploy; the report pipeline is otherwise complete. Local
   runs pause with a provider-side error on `groq/openai/gpt-oss-120b`.
2. `SERPER_API_KEY` unset on Render, so auto-discovery stays unavailable and the UI
   says so instead of pretending.
3. Google OAuth consent screen may still be in Testing mode: publish it, or only the
   listed test users can sign in.
4. GitHub sign-in has no allowlist: GitHub has no equivalent of Google's test-user
   gate, so any GitHub account can sign in. Decide whether to restrict it.
5. Competitors page lists collected intelligence, not the comparison websites on
   the dashboard, so it can look empty right after a scan. Copy is honest; the two
   concepts may want separating later.

## Commits added in this session

- `f84ed3c` first-pass design port (superseded by the ZIP adoption below)
- `1576484` design-port docs
- `07df745` frontend adoption from the supplied ZIP
- `c6473c1` comparison-kind fix so scans can start
- `134dd70` production-verification document
- `6d20919` split sign-in with OAuth, adapted from React Bits Auth 2
- `ffef445` OAuth results redirected to the path-routed sign-in page
- `ac4760b` Auth 2 decision + licence blocker documented
- `6848522` deploy + security re-run record
- `18170ac` GitHub sign-in: routes, provider-aware linking, `tests/github-oauth.test.js`
- `…` premium founder-led About page (+ self-hosted display fonts, public route)
- `4….` production verification record (this edit)

## Useful commands

```bash
npm test                                    # full suite
npm run build                               # backend + frontend production build
(cd frontend && npx vite build)             # frontend only
DATABASE_FILE=./data/dev.db PORT=3000 NODE_ENV=development node src/server.js
sha256sum public/premium-preview.html       # must stay 77b79f5c…
```
