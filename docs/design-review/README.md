# Interface redesign — before / after

Captured with headless Chrome at 1440x900 (desktop) and 390x844 at 2x (mobile)
against a local instance seeded with real data: two websites, one completed
scan, four findings. No placeholder rows: every number in these screenshots comes
from `GET /api/workspaces/:id/dashboard`.

| File | Shows |
|---|---|
| `dashboard-before.png` / `dashboard-after.png` | Dashboard, desktop |
| `dashboard-after-mobile.png` | Dashboard, 390px wide |
| `signin-before.png` / `signin-after.png` | Sign-in |
| `findings-after.png` | Findings list with verdicts |

## What changed

- **Surface**: navy/indigo (`#0b0e14` / `#4f46e5`) replaced by charcoal
  (`#0a0b0c` / `#101214`) with a single electric-blue accent (`#2f6bff`). Green is
  no longer used for brand or "clean" states; it survives only as a small status
  dot on completed scans.
- **Type**: one scale (11/12.5/13.5/14/18/24/30px), tabular numerals for every
  figure, uppercase micro-labels for table headers and card titles, tighter
  tracking on headings.
- **Hierarchy**: KPI value now precedes its label, the dashboard intro sentence
  reflects real workspace state, and the page has one primary action (New scan)
  with Monitoring demoted to secondary.
- **Navigation**: eight flat links became four labelled groups (Monitor, Review,
  Scan, Settings) with a filled active state and `aria-current`.
- **Components**: 34px buttons in three weights, 36px inputs, pill badges with a
  status dot, hairline-only surfaces (no gradients, glows or glass), dashed empty
  states with a single next action, and a spinner-based loading state.
- **Mobile**: sidebar collapses to a fixed bottom bar with labels under icons,
  tables scroll horizontally, KPI grid drops to two columns, safe-area padding.
