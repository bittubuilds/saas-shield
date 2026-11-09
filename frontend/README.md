# SaaS Shield — Frontend (React + Vite)

## Run
```
npm install
cp .env.example .env     # set VITE_API_BASE_URL
npm run dev              # http://localhost:5173
npm run build
```

## Routes
`/` Dashboard · `/scan/:scanId` Scanning · `/report/:scanId` Report · `/history` Reports/History

## Structure
- `src/services/api.js` — the ONLY file that calls the backend (endpoint map, normalizers, errors)
- `src/components/` — Layout (header + footer), StaggeredMenu (header menu), Aurora (hero background), AnimatedList (example scan card), SplitText / CountUp / FadeContent, ElectricLogo, TechText (wordmark), Icon, Status (loading/error/empty)
- `src/pages/` — Dashboard, Scanning, Report, History
- `src/styles.css` — design tokens + all styles

## Backend contract (ASSUMED — verify and edit `ENDPOINTS` / normalizers in api.js)
| Purpose | Assumed request | Expected response |
|---|---|---|
| Start scan | `POST /scans` `{url}` | `{id}` |
| Scan status | `GET /scans/:id` | `{id, url, status, progress (0-100), message?, error?}` |
| Results | `GET /scans/:id/results` | raw (not yet consumed by UI) |
| Report | `GET /reports/:id` | `{id, url, scannedAt, competitors, findings, screenshots, metrics?: [{label,value}], insights?: [{title,description}]}` |
| PDF | `GET /reports/:id/pdf` | `application/pdf` blob |
| History | `GET /reports` | array or `{items: []}` of report objects |

`status` values: `queued | crawling | capturing | generating | completed | failed`.
Auth is assumed to be cookie-based (`credentials: 'include'`); enable CORS with credentials on the backend. No secrets live in the frontend.
If the backend sends no `progress`, the ring shows "—" and the bar is indeterminate (nothing is fabricated).

## Known gaps
- Settings, Help & Support, Account, Logout are visible in the menu but disabled: no routes or auth contract exist yet.
- No preview/mock data is included; without `VITE_API_BASE_URL` pages show a clear configuration error.
- Nav links (Features/Pricing/About/Docs) are anchors only.

## UI notes
- All effects are dependency-free (no gsap, no ogl, no framer-motion): `package.json` has only react, react-dom and react-router-dom.
- `vite.config.js` sets `base: '/app/'`. If you host the frontend at the site root, change it to `'/'`.
- Header menu items come from the `MENU` array in `src/components/Layout.jsx`; edit labels/links there. Panel colours: `colors`, `accentColor`, `panelBg`, `panelText` props on `<StaggeredMenu>`.
- Hero background: `<Aurora>` in `Dashboard.jsx` (tune `AURORA_STOPS`, `amplitude`, `speed`). The older silk waves (`SilkBackground.jsx`, `silk.js`) are kept but unused.
- The "Example result" card on the dashboard is demo data (`MATCHES` in `Dashboard.jsx`), not a real scan.
- Everything respects `prefers-reduced-motion`, and the hover-only effects have touch fallbacks.
