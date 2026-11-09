# Design port: premium preview → working app

_Updated 2026-11-09 · code commit `f84ed3c`_

## Source of truth

`public/premium-preview.html` is the user-supplied, approved design. It is a
self-contained React build with **no `/api` calls** (`fetch(` 0, `/api/` 0), so it
renders the design but cannot sign in or scan.

Rules for this work, unchanged from the handoff:

- The preview file is **not edited**. Verify with
  `sha256sum public/premium-preview.html`
  → `77b79f5cb949509f35a016db4c2ab256419308bf10fae2dd902ef33a87b8dcc5`.
- The functional app at `/app` stays the product. The port moves design into
  `frontend/src`; it does not replace the app with a static page.
- Existing routes, API calls, auth, database logic and shipped components stay.

## What was ported (`f84ed3c`)

| Preview element | Where it now lives | Notes |
|---|---|---|
| Floating transparent header, logo + `Menu` toggle with the plus/x rotation | `components/Layout.jsx`, `.topbar` / `.menu-toggle` | Replaces the bordered bar and its dead `Features/Pricing/About/Docs` anchors |
| Side menu: colour slabs sweep in, light panel follows, numbered route list | `components/Layout.jsx`, `.drawer*` | Real routes only; Escape and route change close it, body scroll locks, panel is `inert` while closed |
| Hero aurora glow | `.aurora` (CSS gradients + drift) | Canvas version approximated in CSS, no new dependency |
| Logo stage above the wordmark | `.hero .stage-logo` | Uses the shipped `logo.png` with a breathing glow instead of the preview's canvas lightning |
| `SAAS SHIELD` shatter wordmark | `components/ShatterWordmark.jsx` (already shipped) | Kept as-is, now sized to the preview's stage |
| `Catch copycats. Keep the proof.` split-letter tagline | `components/SplitTagline.jsx`, `.split-tag` | Staggered rise-in, whole sentence as the accessible name |
| Pill search field | `.hero .search` | Was an 18 px rectangle after the taste pass; 999 px pill again |
| "Example result / 3 matches found" panel | `components/ExampleResult.jsx`, `.scan-report` | Only shown when the workspace has no websites, and always labelled as an example |
| Dotted grid behind the content | `.below::before` | CSS radial-gradient dots, masked out toward the footer |
| Feature cards with a pointer-tracked spotlight | `.grid .card.spot`, `trackSpot()` | Keeps the existing 2 px lift and glass icons |
| Section label "Powerful Features" and bar-less headings | `pages/Dashboard.jsx` | Copy now matches the preview |

## Not ported yet (deliberate, sized)

1. **Electric logo canvas** — the preview draws lightning arcs over the mark. The
   port uses the real asset plus a glow; a canvas version is optional polish.
2. **Aurora canvas / click spark / alist glide** — canvas flourishes. The aurora is
   approximated in CSS; the click spark and the dragging result list are not ported.
3. **Section-heading letter reveal** (`sf` / `sfl` letters) — the preview flips each
   letter of a heading in. Headings currently use a plain fade.
4. **Inner pages** (Report, Scanning, History, Competitors, Settings, Privacy, Login)
   still use the pre-port language: 16 px cards, bordered panels, `bar` headings.
   They should inherit the reduced radius/shadow scale and the light-panel drawer
   once the dashboard is signed off.
5. **Hero copy variants** — the preview's tagline is ported, the lead paragraph keeps
   the product copy that already existed.

## How to verify

```bash
(cd frontend && npx vite build)                      # must pass
DATABASE_FILE=./data/dev.db PORT=3000 NODE_ENV=development node src/server.js
# open http://127.0.0.1:3000/app, sign up (instant mode with no mail provider)
```

Checks that were run for `f84ed3c` in a real browser at 1440×1000 and 390×844:

- no horizontal overflow on either width;
- hero child order: aurora → silk → ribbon → logo stage → wordmark → tagline →
  lead → search → example result;
- drawer opens to `transform: none`, 560 px wide, white panel over the scrim,
  `body.overflow = hidden`, and closes back to a full-width translate on Escape;
- example result renders 660 px wide on desktop, 326 px on mobile;
- `npm test` → 321 tests, 295 pass, 0 fail, 26 skipped.
