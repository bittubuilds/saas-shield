# React Bits Pro components

Two React Bits Pro effects are ported here, both requested as `shadcn add` installs
that could not run in this repository:

- [Interference Ribbons](#interference-ribbons), the hero backdrop
- [Shatter Type](#shatter-type), the hero headline

## Why the shadcn install could not run here

The reasons below apply to every Pro component, not just the first one.

### Interference Ribbons

Requested: the React Bits Pro component ["Interference Ribbons"](https://pro.reactbits.dev/docs/components/interference-ribbons),
a ribbon of fine glowing wires drifting and twisting, installed with
`npx shadcn@latest add @reactbits-starter/interference-ribbons-tw`.

### Three blockers, all environmental:

1. **No React project.** The shadcn CLI writes a React component plus a utility
   file into an app that has React, Tailwind and a `components.json`. SaaS Shield's
   frontend is plain ES2020 served straight from `public/`: no React, no Tailwind,
   no `postcss`, no `components.json` anywhere in the repository. There is nothing
   for the CLI to write into, and a component it did write would never compile.
2. **No license key.** The Pro registry is behind a paid license sent as
   `Authorization: Bearer $REACTBITS_LICENSE_KEY`. No such secret or environment
   variable exists in this workspace, so the registry request would be rejected.
3. **No registry configured.** `components.json` is what declares
   `@reactbits-starter` and its auth header. Creating one without a key would only
   turn a clear "no key" into a confusing 401 during the add.

So steps 1 and 2 of the request are not possible in this repo as it stands, and no
`components.json` was invented to look like they were. What step 3 asked for, the
effect adapted to this project's content and design tokens, is implemented.

## What was built instead

`public/ribbons.<hash>.js`, a dependency-free canvas 2D port of the same effect,
mounted as the dashboard hero background:

- `window.InterferenceRibbons.mount(element, options)` draws the ribbon into
  `element` and returns `{ canvas, pulse, resize, destroy }`.
- `window.InterferenceRibbons.autoMount()` mounts every `[data-ribbons]` host,
  reading options from `data-ribbons-*` attributes.
- `unmountAll()` is called before the shell is replaced, so the frame loop never
  outlives its DOM.

The layer lives at `.hero-ribbons` in the hero section, behind the heading and the
URL field, faded with a radial mask and clipped by `overflow: hidden` on the hero.
Colours come from the project tokens (`#7c5cff` accent to `#d46bff`), not from the
component's own defaults.

### Props

The documented props are all present with the same meaning. Defaults differ only
where noted.

| Prop | Here | Pro default |
| --- | --- | --- |
| `colors` | `['#7c5cff', '#d46bff']` | `['#6B3CFF', '#D46BFF']` |
| `backgroundColor` | `'transparent'` | `'#0A0A0A'` |
| `wires` | `56` | `64` |
| `lineWidth` | `1.4` | `1.6` |
| `ribbonWidth` | `0.26` | `0.24` |
| `amplitude` | `0.62` | `0.6` |
| `waveLength` | `1` | `1` |
| `angle` | `34` | `42` |
| `twist` | `1.7` | `1.6` |
| `curl` | `0.25` | `0.25` |
| `depth` | `0.65` | `0.65` |
| `stripes` | `2.2` | `2.2` |
| `colorFlow` | `0.04` | `0.04` |
| `glow` | `0.5` | `0.45` |
| `intensity` | `1` | `1` |
| `speed` | `0.7` | `0.7` |
| `spin` | `0.35` | `0.35` |
| `interactive`, `hoverPulses`, `clickPulse` | `true` | `true` |
| `pulseSpeed` | `1.1` | `1.1` |
| `pulseStrength` | `1` | `1` |
| `hoverBoost` | `1` | `1` |
| `paused` | `false` | `false` |
| `quality` | `0.85` | `1` |

`mode` (`auto` / `glow` / `ink`), `ref.pulse()` and `children` exist in the Pro
component only: this is a dark-only theme with no light surface to switch to, the
pulse is exposed as a method on the returned handle, and content sits as a sibling
in the hero rather than as a child of the background.

### Other deviations, stated plainly

- Colours blend in sRGB, not OKLab. The band still cycles between the two tokens;
  the midpoint is slightly less perceptually even.
- Glow is one blur pass over a second canvas, not per-strand shadows. Visually the
  same haze, a fraction of the cost with 56 strands.
- On screens under 720px the strand count is capped at 26 and the layer is shorter,
  so a phone is not rendering 56 polylines at 2x DPR.

### Behaviour that is not decoration

- **Reduced motion:** `prefers-reduced-motion: reduce` gets one still frame and no
  animation loop. Verified in Chromium: two captures 700ms apart are byte-identical.
- **Offscreen and hidden:** `IntersectionObserver` and `visibilitychange` stop the
  loop, so a scrolled-away hero costs nothing.
- **No dead element:** if a 2D context is unavailable the mount returns a handle
  with `canvas: null` and appends nothing.
- **DPR cap 2, quality 0.85:** roughly 0.43 megapixels of drawing at 1440px.

## Verification

- `tests/ribbons.test.js` (7 tests): asset shipped and loaded before `app.js`,
  API surface, defaults, graceful no-canvas path, missing host, reduced-motion
  detection, and that the hero markup plus mount/teardown calls are present.
- Chromium, live server: canvas 1085x400, 46,847 lit pixels (~11%), 255 max alpha,
  frames differ over time, mobile 366x272 with zero horizontal overflow, canvas
  removed after navigating away, no console errors.

## If this becomes a React app

Add the registry to `components.json` using the exact URL from
<https://pro.reactbits.dev/docs/installation>, with the header
`"Authorization": "Bearer ${REACTBITS_LICENSE_KEY}"`, store the key as a secret,
then run `npx shadcn@latest add @reactbits-starter/interference-ribbons-tw`. The
component drops into the same hero position; the layer markup here
(`.hero-ribbons`) is the structure to replace, and the token values above are what
to pass as props.


## Shatter Type

Requested: ["Shatter Type"](https://pro.reactbits.dev/docs/components/shatter-type),
a headline cut into glass shards that assemble, crack under the cursor and shatter
on click, installed with
`npx shadcn@latest add @reactbits-starter/shatter-type-tw`. Blocked by the same
three conditions: no React project, no `components.json`, no license key.

### What was built

`public/shatter.<hash>.js`, a DOM implementation: the headline is replaced by a
grid of irregular quads (shared jittered vertices, so the pieces tile exactly),
each one its own element with a `clip-path` polygon and a copy of the headline
markup inside. Transforms and the burst use the Web Animations API.

Mounted on the dashboard `<h1 class="hero-title">` via `data-shatter`. It also
mounts any element carrying `data-shatter`, with options in `data-shatter-*`
attributes.

### Behaviour

- **Assemble:** shards start scattered and rotated, then condense into the
  headline with a staggered spring easing (`intro: 'assemble'`; `drop`, `fade` and
  `none` are also implemented).
- **Crack under the cursor:** shards within `crackRadius` push apart a few pixels
  along the vector away from the pointer and brighten. The gaps close as the
  pointer leaves, at `heal` speed.
- **Shatter on click:** shards within the radius burst outward, tumble, hang for
  `reassemble` seconds, then fly back and flash as they lock in. Shards just
  outside the radius only crack.
- **Never text-destroying:** the original markup stays in the box at zero opacity
  (`.shatter-base`), so layout width and height hold and screen readers read the
  real headline once. The shard layer is `aria-hidden`. Text inside shards is a
  visual copy, so selection and find-in-page still hit the real copy.

### Props

Same names and meaning as the Pro component. Differences are marked.

| Prop | Here | Pro default |
| --- | --- | --- |
| `shardSize` | `0.09` | `0.09` |
| `irregularity` | `0.6` | `0.6` |
| `crack`, `crackRadius`, `heal` | `0.6`, `0.5`, `0.9` | same |
| `shatterRadius`, `force`, `spin`, `depth`, `gravity` | `0.55`, `1`, `1`, `1`, `0` | same |
| `reassemble`, `stiffness`, `glint` | `1.1`, `0.55`, `0.8` | same |
| `intro`, `introDuration` | `'assemble'`, `1.6` | same |
| `autoplay`, `autoplayInterval` | `false`, `4` | same |
| `interactive`, `paused` | `true`, `false` | same |
| `colors`, `accentColor` | text colour plus `--accent` from CSS | `["currentColor","currentColor"]`, `#7B5CFF` |
| `ref.shatter()/assemble()` | returned on the mount handle | same |
| `children`, `quality` | not implemented | content above the headline, render scale |

Two honest notes: shard count is derived from the headline box and capped at 36
(9 by 4) rather than following `shardSize` down to single-pixel pieces, and the
crack reach is widened (`x2.6`, and `x3.4` for the burst) because a 36-shard mesh
over a two-line hero needs a bigger radius than per-letter triangles do.

### Verification

- `tests/shatter.test.js` (9 tests): asset order, API surface and defaults, shard
  polygons, readable copy preserved and `aria-hidden` on the layer only, exact
  restore on destroy, safe behaviour with no WAAPI, reduced motion inert,
  idempotent `autoMount`, missing host, and the hero wiring.
- Chromium, live server: 36 shards tiling a 460px headline, same box height as the
  base copy, hover cracks 6 shards, click burst moves 12, everything returns to
  `opacity: 1` with no transforms after reassembly, 36 shards on a 390px viewport
  with zero overflow, reduced motion shows no animation and no movement, and no
  console errors.
