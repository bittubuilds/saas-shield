# SaaS Shield — current state (read this first)

_Last updated: 2026-11-09 · split sign-in deployed to production, security suite re-run and verified live_

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

### Sign-in page: split layout (React Bits Pro "Auth 2", rebuilt on our tokens)

`frontend/src/pages/Login.jsx` is a two-pane split: form left, brand panel right.
Class names are ours (`.auth-split`, `.auth-pane`, `.auth-aside`) and live at the
bottom of `frontend/src/styles.css` under a marked section; no rule above them was
changed. Details and the licence/CLI reasoning: `docs/REACTBITS-AUTH-2.md`.

- Google button is real: it reads `/api/auth/config` and stays disabled with a
  plain note while `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` are missing. It never
  offers a method the deployment cannot honour.
- `?oauth_error=<reason>` from the Google callback renders as readable text.
  `src/routes/auth-routes.js` now redirects failures to `/app/login?oauth_error=...`
  and successes to `/app/` — the old `#/signin` and `#/dashboard` targets never
  matched the path-based router, so error messages were silently dropped.
- 50/50 split at ≥900 px (form capped at 400 px), single column below with the
  brand panel hidden. Checked at 1440, 1024, 768 and 390 px, no horizontal overflow.
- Auth behaviour unchanged: httpOnly cookie sign-in, instant-mode signup fallback,
  `.field-error` for errors, `.muted role="status"` for notices, spinner while busy.

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
2. Google sign-in and SERPER discovery are still unconfigured in production.
3. `SERPER_API_KEY` unset on Render, so auto-discovery stays unavailable and the UI
   says so instead of pretending.
4. Google OAuth coded but not configured (`google_oauth_configured: false`).
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
- `4….` production verification record (this edit)

## Useful commands

```bash
npm test                                    # full suite
npm run build                               # backend + frontend production build
(cd frontend && npx vite build)             # frontend only
DATABASE_FILE=./data/dev.db PORT=3000 NODE_ENV=development node src/server.js
sha256sum public/premium-preview.html       # must stay 77b79f5c…
```
