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

- `npm test`: 321 tests, 295 pass, 0 fail, 26 skipped.
- `npm run build` (root, as Render runs it): succeeds; lazy `Aurora` chunk emitted.
- Real scan end to end in a browser: signup → add site → add comparison →
  scan runs → report → history → competitors → settings → logout. Wikipedia
  vs its mobile mirror: 625 pages compared, 123 findings.
- `/app/history` and `/app/privacy` survive a hard refresh; no horizontal overflow
  at 390 px; slide-out menu opens and closes.
- `GET /reports/export.pdf` → 200 `application/pdf`. AI endpoints answer honestly
  (no report invented) when the provider is paused or unconfigured.

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
