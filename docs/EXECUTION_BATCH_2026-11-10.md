# SaaS Shield — execution batch report (10 Nov 2026)

Branch `main`, HEAD `944c8b3` before this file. Code unchanged by this batch: it records
what shipped earlier today, the state of the tree, and the security review that was run
against it.

## 1. What shipped today

| Area | Commit | State |
|---|---|---|
| Docs centre | `7a86f35` | `/app/docs` and `/app/docs/:slug`, 7 sections, 35 articles, body-text search, scroll-spy TOC, off-canvas drawer under 860px. Linked from the menu, both footers and the sign-in page. |
| Settings rework | `cee0af2` | Two-band console layout, live `listWebsites()` and `listScans()` data, `counter-rolls` moment vendored for the stat row. |
| Docs polish | `540b256` | 16px body at 58ch measure, 11.5px labels, lazy-loaded docs route (22.9kB out of the dashboard bundle), skip link, listbox roles on the search combobox, mobile drawer tab order fixed. |
| Security-audit skill | local only | Cloudflare's `security-audit` skill installed in the agent workspace with a wrapper for its validators. Not part of this repository. |

Verification at HEAD: `npm test` 308 pass, 26 skipped, 0 fail. No horizontal overflow at
390px, 768px, 1024px and 1440px across docs, login, dashboard and settings. Live check
against the Render deployment returns a healthy database and working OAuth.

## 2. Tree state

- Tracked files: clean. Nothing was modified by this batch.
- Untracked: three screenshot PNGs at the repository root (`docs-how-it-works.png`,
  `docs-phone.png`, `docs-reading.png`). They are review artefacts, not build inputs, and
  are deliberately not committed.

## 3. Security review (source only, 10 Nov 2026)

A six-phase source-only review was run against `944c8b3` using the Cloudflare
`security-audit` skill. Scope: nine units covering authentication, tenant scoping,
outbound fetch, report rendering, model prompts, machine endpoints, deployment
configuration, data lifecycle and availability.

- Nine units: five produced candidates, two were reviewed clean, two are explicitly
  incomplete (prompt construction and webhook signature verification).
- Eleven records: ten needing a runtime observation to close, one disproved and recorded
  as such.
- Nothing was executed: no target code was run and no request was sent to the live
  service. Every record is therefore source-reasoned and carries its own unresolved fact
  and validation plan.

The detailed report contains exploitation steps and is deliberately **not** committed
here: this repository is public. It is held in the agent workspace
(`security-audit-run-1/`: `REPORT.md`, `FINDINGS-DETAIL.md`, `NEEDS-VALIDATION.md`,
`coverage-ledger.json`, `findings.json`). Make the repository private first if the report
should live in version control.

Broad shape of what was found, without repro detail:

1. Two workspace-scoped admin actions dispatch process-wide work, so one tenant's request
   performs work and sends mail for other tenants.
2. One router is mounted without an authentication middleware and depends on a guard that
   dereferences the session user, so authentication there is accidental rather than
   enforced.
3. The screenshot path filters subresources by hostname string only, while the crawling
   path uses the DNS-aware guard.
4. The crawl page budget counts stored rows rather than requests issued.
5. Account deletion leaves AI analysis tables behind, because those tables declare
   `workspace_id` without a foreign key.
6. The unauthenticated health endpoint returns the SQLite file path.
7. `TRUST_PROXY_HOPS` defaults to one, which makes every address-keyed rate limiter
   spoofable on a directly exposed deployment.

What held up under review: scrypt with per-password salt and timing-safe comparison,
hashed session tokens, HMAC-signed OAuth state with nonce, JWKS and PKCE verification,
refusal to link an unverified local account, full SSRF validation on every redirect hop,
constant-time cron secret comparison that fails closed, no stack traces in error
responses, no `innerHTML` in the frontend, and a PDF writer that emits no actions.

## 4. Conversation log

Kept short and in the owner's own register, since this section exists to preserve context
across sessions rather than to document behaviour.

- *"Use impeccable skill on docs page"* — the docs centre was reviewed and polished:
  reading measure, label size, focus order, combobox roles, lazy route split.
- *"ise bhi add karo"* — Cloudflare's `security-audit` skill was installed in the agent
  workspace with a wrapper for its validators; upstream suites pass 65/65 locally.
- *"Ha"* — approval to run that audit against this repository. Run performed, reports
  produced, nothing changed in the tree.
- Standing constraint that shaped the batch: start from the existing code, do not rebuild,
  preserve existing features, routes, API integrations and database logic, keep
  documentation updated, never touch secrets unnecessarily.

## 5. Open items

- Decide whether the audit report should be committed (requires the repository to be
  private first).
- Close the two incomplete units: prompt construction in `src/ai/prompts.js`, and webhook
  signature verification in `src/routes/webhook-routes.js`.
- `SERPER_API_KEY` is still unset on Render, so discovery stays disabled in production.
