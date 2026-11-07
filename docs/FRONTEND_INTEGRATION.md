# Phase 1 — React frontend / backend integration

Source: `saas-shield-frontend/` (uploaded zip, integrated copy).
Backend: this repository, `feat/db-durability`.

## What changed

| File | Change |
| --- | --- |
| `vite.config.js` | `/api` dev proxy to `http://localhost:3000` (`SAAS_SHIELD_API` overrides). Cookie sessions are same-origin only, so this is required, not cosmetic. |
| `index.html` | Removed the Google Fonts links; the backend CSP is `font-src 'self'`, so they were blocked when served by Express. |
| `src/services/api.js` | Rewritten against the real contract. Every path is `/api/workspaces/:id/...`; errors read `.error`; `no_report` (404) returns `null` instead of throwing; `describeInitialScan()` maps the polling payload to the view. |
| `src/App.jsx` | Session gate: `/api/auth/me` on load, `/login` when signed out, error screen when the API is unreachable. |
| `src/pages/Login.jsx` | New sign in / create account form (`/api/auth/signin`, `/api/auth/signup`). |
| `src/components/Layout.jsx` | Menu reduced to routes that exist; Logout wired to `POST /api/auth/signout`; account line shows workspace and email. |
| `src/pages/Dashboard.jsx` | `POST /websites {url, kind:'original'}` → `{website, initial_scan}`; lists existing websites; rejects private hosts client-side (server also rejects them). |
| `src/pages/Scanning.jsx` | Polls `GET /websites/:id/initial-scan` every 2s, stops on `done`, handles `failed`/`cancelled`, cancel and retry actions. |
| `src/pages/Report.jsx` | `GET /scans/:id` + `GET /scans/:id/ai` + `GET /scans/:id/ai/report`; `no_report` state with "Run analysis" (`POST /scans/:id/ai`); PDF via `/ai/report.pdf` with `?version=`; findings list from `/results?scan_id=`. |
| `src/pages/History.jsx` | `GET /scans` → rows linking to reports. |
| `src/styles.css` | Additive only: form rows, auth card, muted text, inline select. No existing rule changed; palette untouched. |

## Contract verified against the running backend

`node /tmp/contract.mjs` against a fresh SQLite instance:

```
signup            201
signin            200  keys=user,workspace
me                200  cookie=yes workspace=wsp_…
create website    201  website.id=yes initial_scan.mode=needs_comparison
initial-scan      200  has website.url=true scan=null done=false findings_total=0
scans list        200  key=scans:true n=0
results           200  total=0 has_more=false results=true
competitors       200  key=competitors
isolation         404  error="Workspace not found."
no-cookie         401
```

## Build

`npm install` (65 packages) → `npx vite build` → success, 50 modules,
`dist/assets/index-B8O1gBDL.js` 200.74 kB (65.43 kB gzip).

## Not yet done (needs its own pass)

- Browser run of the integrated app against a live backend (only the build and the
  raw contract are verified; the JSX has not been exercised in a browser yet).
- Competitors, discovery, screenshots and findings-review screens.
- Production hosting decision (serve `dist/` from Express at `/app` with
  `base:'/app/'` + `basename`, or host separately behind the same origin).
- The React app is not in the repo; moving it in is a product decision.
