# React Bits Pro "Auth 2" on SaaS Shield

Requested: add the **Auth 2** block (split sign-in with OAuth buttons) from
[React Bits Pro](https://pro.reactbits.dev/docs/blocks/auth/auth-2).

## What is in the app now

The Auth 2 layout is **rebuilt on our own design system** and wired to the real
auth routes, instead of dropping the Tailwind component in:

| File | Change |
| --- | --- |
| `frontend/src/pages/Login.jsx` | Two-pane split: form on the left, brand panel on the right. Google button, "or continue with email" divider, both modes, real errors and notices. |
| `frontend/src/styles.css` | New `.auth-split` section at the bottom. Uses the existing tokens (`--violet`, `--surface`, `--border`, `--r-md`); nothing above it was touched. |
| `src/routes/auth-routes.js` | Google failure/success redirects now point at `/app/login` and `/app/` (path routing) instead of `#/signin` and `#/dashboard`, which the router never matched, so an OAuth error message used to be lost. |

Behaviour kept from the previous page: email + password sign-in, create account
with an optional name, the instant-mode fallback, `.field-error` for errors,
`.muted role="status"` for notices, spinner while busy.

New behaviour: the Google button reads `/api/auth/config` and stays disabled
with an honest note when `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` are missing,
and `?oauth_error=<reason>` from the callback is turned into a readable line.

Layout: 50/50 split from 900 px up (form column capped at 400 px), single column
below that with the brand panel hidden. Verified at 1440, 1024, 768 and 390 px
with no horizontal overflow.

## Why the CLI step was not run

`npx shadcn@latest add @reactbits-pro/auth-2` needs two things this project does
not have:

1. **A licence key.** Without it the registry answers 401:
   `https://pro.reactbits.dev/api/r/pro/auth-2.json`. Set `REACTBITS_LICENSE_KEY`
   in `frontend/.env.local` first.
2. **A shadcn project.** `frontend/` is a plain React + Vite app: no
   `components.json`, no Tailwind, no `src/components/ui`, no `@/` alias. All
   twelve pages are styled by one hand-written `frontend/src/styles.css`.
   `shadcn init` adds Tailwind v4 and injects its preflight reset globally, which
   would restyle every existing page. That is a build-level change, not a
   drop-in block, so it needs a decision before anyone runs it.

The registry config the CLI expects (verbatim, from the registry's own 401 body):

```json
{
  "registries": {
    "@reactbits-pro": {
      "url": "https://pro.reactbits.dev/api/r/pro/{name}.json",
      "headers": {
        "Authorization": "Bearer ${REACTBITS_LICENSE_KEY}"
      }
    }
  }
}
```

A copy sits in `docs/reactbits/components.json.example`.

## If you want the literal block instead

1. Put the key in `frontend/.env.local`: `REACTBITS_LICENSE_KEY=...` (never commit it).
2. Add the `registries` object above into `frontend/components.json`.
3. `npx shadcn@latest init` — Tailwind, the alias, and `lib/utils`.
4. To protect the current look, disable preflight:
   Tailwind v3 → `corePlugins: { preflight: false }` in `tailwind.config.js`.
   Tailwind v4 → do not import `tailwindcss/preflight.css` in the entry CSS.
5. `npx shadcn@latest add @reactbits-pro/auth-2`
6. Map the block's props and classes onto `signIn` / `signUp` from
   `frontend/src/services/api.js` and onto the tokens in `styles.css`, then run
   `npm test` and `npm run build` before anyone deploys.

Until a key exists, step 3 is the only path that changes anything, and it is the
step that needs approval.

## Verified

- `npm test`: 321 tests, 295 pass, 0 fail, 26 skipped.
- `cd frontend && npm run build`: clean.
- Local run on port 3100: sign-in renders split, Google button disabled with the
  note, "Create one" switches to the signup heading with the Name field, a real
  signup lands on the dashboard, 390 px hides the brand panel.
