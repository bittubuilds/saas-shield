# SaaS Shield — current state (read this first)

_Last updated: 2026-11-09 · frontend integration landed, verified locally, not yet pushed_

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

## Known gaps, in priority order

1. **Nothing is pushed.** Every commit below is local; the sandbox GitHub token
   returns 401. Production still runs `0f70001`. Reconnect GitHub, then push.
2. AI report generation pauses in this sandbox (provider error on
   `groq/openai/gpt-oss-120b`). The UI reports the real state; the provider needs
   checking on Render where the key and quota are real.
3. `SERPER_API_KEY` unset on Render, so auto-discovery stays unavailable and the UI
   says so instead of pretending.
4. Google OAuth coded but not configured (`google_oauth_configured: false`).
5. Competitors page lists collected intelligence, not the comparison websites on
   the dashboard, so it can look empty right after a scan. Copy is honest; the two
   concepts may want separating later.

## Commits added in this session

- `f84ed3c` first-pass design port (superseded by the ZIP adoption below)
- `1576484` design-port docs
- frontend adoption + comparison-kind fix + this document

## Useful commands

```bash
npm test                                    # full suite
npm run build                               # backend + frontend production build
(cd frontend && npx vite build)             # frontend only
DATABASE_FILE=./data/dev.db PORT=3000 NODE_ENV=development node src/server.js
sha256sum public/premium-preview.html       # must stay 77b79f5c…
```
