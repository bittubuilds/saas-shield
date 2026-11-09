# SaaS Shield — current state (read this first)

_Last updated: 2026-11-09 12:20 IST · main @ 3b94779 · nothing uncommitted_

This file exists so a new agent starts from here, not from zero. Everything below is
committed and pushed to `main`; Render auto-deploys `main`.

## Where things live

| Surface | URL | What it is |
|---|---|---|
| `/` | saas-shield.onrender.com | One-line redirect to `/app` (functional app) |
| `/app` | saas-shield.onrender.com/app | The working React product: signup/login, add site, scan, findings, PDF report, history, competitors, privacy, settings |
| `/premium-preview.html` | …/premium-preview.html | The user-supplied design file, served **byte-identical** (sha256 77b79f5cb949…) |
| API | `/api/health` | Reports backend, migration version, table count, durability |

## What is already built and deployed

- Privacy Policy page at `/privacy`, footer link in the app shell.
- Settings at `/settings`, including delete account: typed `DELETE` + hold-to-confirm;
  `DELETE /api/auth/account` requires a session, deletes user, memberships and any
  workspace where they are the sole member (cascades sites/scans), keeps `audit_events`
  with `user_id` nulled as the retention exception.
- Hold-to-confirm (`frontend/src/components/HoldButton.jsx`) on Remove website and
  Delete account; the browser confirm popup is gone.
- SAAS SHIELD wordmark with the real Shatter Type port (`frontend/public/shatter.c824b1d1.js`
  driven by `frontend/src/components/ShatterWordmark.jsx`): shards assemble, crack under
  the cursor, burst on click, 6 s auto-repeat, reduced-motion static fallback.
- Hero: purple silk + pink ribbon (`SilkBackground` twice), heading text removed,
  wordmark below the claim and the URL field.
- A taste pass (`cd3ad8e`, `41305e1`): one screen per section, one container width,
  2 px card hover lift, feature copy rewritten as the real product flow.
- Logo loads from `import.meta.env.BASE_URL + 'logo.png'` (a root-absolute `/logo.png`
  returned 404 under the `/app` mount).

## The open question (do not redo blindly)

`public/premium-preview.html` is a self-contained React build with **no `/api` calls**
(verified: `fetch(` 0, `/api/` 0). It renders the approved design but cannot sign in or
scan. The user wants the functional app to *look like* that design. That is a design
port into `frontend/src`, not a replacement of the app, and it must not alter the
supplied file (standing instruction: do not change the user-provided design files).

## Known gaps

- Design port of the premium preview into the working React app: not started.
- `SERPER_API_KEY` not set on Render, so competitor discovery stays manual/limited.
- Google OAuth coded but not configured (`google_oauth_configured: false`).
- Full test suite has not been re-run since `41305e1`; the last green full run was
  320 tests / 316 pass / 0 fail / 4 skipped at `9cc9e74`. Targeted suites
  (`tests/app.test.js`, `tests/frontend-privacy.test.js`, `tests/account-delete.test.js`)
  pass at the current head.

## Useful commands

```bash
npm test                                   # full suite (SQLite)
node --test tests/app.test.js              # fastest smoke test
(cd frontend && npx vite build)            # must pass before any push
DATABASE_FILE=./data/dev.db PORT=3000 NODE_ENV=development node src/server.js
```
