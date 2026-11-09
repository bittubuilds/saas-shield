# SaaS Shield — current state (read this first)

_Last updated: 2026-11-09 16:05 IST · main @ f84ed3c (design port) · nothing uncommitted_

This file exists so a new agent starts from here, not from zero. Everything below is
committed; `main` auto-deploys on Render.

## Where things live

| Surface | URL | What it is |
|---|---|---|
| `/` | saas-shield.onrender.com | One-line redirect to `/app` (functional app) |
| `/app` | saas-shield.onrender.com/app | The working React product: signup/login, add site, scan, findings, PDF report, history, competitors, privacy, settings |
| `/premium-preview.html` | …/premium-preview.html | The user-supplied design file, served **byte-identical** (sha256 77b79f5cb949…) |
| API | `/api/health` | Reports backend, migration version, table count, durability |

## What is already built and deployed

- Privacy Policy at `/privacy`, footer link in the app shell.
- Settings at `/settings`, delete account behind typed `DELETE` + hold-to-confirm;
  `DELETE /api/auth/account` deletes the user, memberships and any workspace where
  they are the sole member, keeps `audit_events` with `user_id` nulled.
- Hold-to-confirm (`frontend/src/components/HoldButton.jsx`) on Remove website and
  Delete account.
- SAAS SHIELD wordmark with the real Shatter Type port
  (`frontend/public/shatter.c824b1d1.js` + `ShatterWordmark.jsx`).
- Design port of the approved preview, first pass (`f84ed3c`, see
  `docs/DESIGN-PORT.md`): floating header with the Menu toggle, sliding side menu
  with colour slabs, hero aurora + logo stage + split tagline + pill search +
  example-result panel, dotted grid, spotlight feature cards, "Powerful Features".
- Logo loads from `import.meta.env.BASE_URL + 'logo.png'`.

## Verified state of the tree

- `npm test` at `f84ed3c`: 321 tests, **295 pass, 0 fail, 26 skipped**.
  One network-dependent test failed once and passed on re-run; treat the suite as
  green but not hermetic.
- `cd frontend && npx vite build` passes (25.6 kB CSS / 214.8 kB JS).
- Browser checks at 1440×1000 and 390×844: no horizontal overflow, drawer opens and
  closes correctly, example result 660 px / 326 px wide.

## Known gaps, in priority order

1. **Finish the design port on the inner pages** (`docs/DESIGN-PORT.md` § Not ported
   yet): Report, Scanning, History, Competitors, Settings, Privacy, Login still use
   the pre-port card/heading language. The preview only defined the dashboard, so
   these need a judgement call, not a copy.
2. Preview flourishes still missing: electric-logo canvas, click spark, result-list
   glide, heading letter reveal.
3. `SERPER_API_KEY` not set on Render, so competitor discovery stays manual/limited.
4. Google OAuth coded but not configured (`google_oauth_configured: false`).
5. Pushing from an agent sandbox needs a live GitHub token; the stored one was
   rejected (401) on 2026-11-09, so work was committed locally and must be pushed
   after the owner reconnects GitHub.

## Useful commands

```bash
npm test                                   # full suite (SQLite)
node --test tests/app.test.js              # fastest smoke test
(cd frontend && npx vite build)            # must pass before any push
DATABASE_FILE=./data/dev.db PORT=3000 NODE_ENV=development node src/server.js
sha256sum public/premium-preview.html      # must stay 77b79f5c…
```
