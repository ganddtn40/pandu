# Pandu UI

Svelte 5 + TypeScript + Vite. No heavy UI or animation libraries. The glass
renderer is custom WebGL2 code in `src/glass`.

> **Status:** Phases 4B and 5 are complete. The five tabs read real daemon data
> over HTTP and WebSocket, first run opens a three-step tour, and the i18n
> catalogs are in place (English complete, drafts fall back per key).

## Design direction

Design v2 is a graphite bento dashboard, not a pure-glass demo:

- Matte cards with 1 px hairlines, 20–28 px radii, large light numerals, thin
  charts, and one accent.
- A left icon rail and a floating glass top bar on desktop; a floating glass tab
  pill and action button on phone.
- Floating sheets, modals, toasts, and phone navigation are the only glass
  chrome. Working cards stay matte by default.
- Themes: Dark (default), Light, Frost. Default accent: warm orange `#FF7A2F`.
  Presets: Orange, Cream, Blue, Green, Violet, Silver, Mono.
- Surface styles: Bento Matte, Liquid Glass, Hybrid (default).
- Five tabs: Home, Inbox, Flights, Market, Settings. A global quick prompt opens
  from `Ctrl/Cmd+K`.

Banned: amber-on-black, monospace uppercase labels, serif display fonts, hero
marketing headlines, grid/radar decoration, sharp corners, and more than one
accent colour per theme.

## Daemon data

`src/lib/api/` is a typed client plus a reactive store:

- `client.ts` resolves the daemon base URL (`window.__panduDaemonUrl`, then
  `http://127.0.0.1:4319` on dev/preview ports, else same origin) and wraps
  every route the UI uses, including `/api/snapshots/{id}`.
- `daemon.svelte.ts` polls sessions, guards, adapters, and settings, keeps a
  WebSocket to `/api/live` with reconnect, and exposes `liveEvents`,
  `pendingGuards()`, and guard decisions.
- `types.ts` mirrors the daemon JSON, including replay summaries, stream
  chunks, snapshot details, and file changes.

Screens never invent data. Empty, loading, offline, and error states are
explicit. Demo rows appear only when `health.demoMode` is true, and every demo
surface is labeled with a `Demo` badge or chip.

- **Home** — live flight, today's spend, token ring, guard count, adapters.
- **Inbox** — pending approvals with evidence and Approve/Deny, plus resolved
  decisions.
- **Flights** — list with status filters and search, `?session=<id>` deep links,
  recorded output, live chunks that arrive after load, timeline scrubber and
  replay, step details, and lazy snapshot diffs.
- **Market** — an honest "not open yet" state with the trust policy; the
  registry ships later.
- **Settings** — appearance, language, adapters with install state and
  copyable run commands, demo seeding, privacy, platform support, daemon info,
  and the tour replay.

First run redirects to `/welcome` until `pandu.onboarded` is set; Settings can
replay the tour. `/glass-preview` is development-only and resolves to Home in a
production build.

## i18n

`src/lib/i18n/catalog.ts` holds the catalogs and the pure `translate` helper;
`i18n.svelte.ts` re-exports it and adds the reactive `t()`. English is the
source of truth. Draft languages fall back per key, so a missing translation
never renders a blank label. Placeholders use `{name}` and are interpolated
only when the variable exists.

## Appearance

Settings → Appearance is a live customization sheet:

- Theme, surface style, accent, corner radius (Sharp/Soft/Round), density
  (Compact/Comfortable/Spacious)
- Font (System/Inter/Mono for code) and font size
- Glass intensity, blur, and refraction
- Wallpaper: procedural, your image, or none
- Card borders, motion (Full/Reduced/Off), Performance mode, language

Preferences persist per device under `pandu.design`; the wallpaper image uses
`pandu.wallpaperImage`. Legacy theme/performance keys migrate automatically.
Themes export as `pandu-theme.json` (`pandu.theme`, version 1), import with
validation, and share through a `?share=` link. Theme files never execute code,
and wallpaper images and Performance mode are never exported.

## Glass engine

`src/glass` renders the wallpaper and every `[data-glass]` element in one
full-screen WebGL2 pass:

- SDF squircle geometry with edge refraction from the SDF gradient
- Frost from a pre-blurred quarter-resolution wallpaper texture
- Chromatic aberration on the rim
- Top-left specular rim light with pointer parallax
- Inner shadow, accent tint, theme-aware scrim and vignette
- Surface layer filtering: matte draws no shapes, hybrid draws floats only,
  glass draws cards and floats
- ResizeObserver + rAF geometry sync, on-demand rendering, 16-shape cap on
  desktop and 12 on phones/low-end devices, 60 fps desktop / 30 fps mobile,
  paused when hidden

Fallbacks: no WebGL2 or `?glass=off` → CSS `backdrop-filter`; matte surface or
Performance mode → CSS matte surfaces with WebGL paused; `prefers-reduced-
transparency` → CSS glass without backdrop blur; `prefers-reduced-motion` →
static. The engine keeps an idle WebGL context so switching back is instant.

Overlay sheets, the quick prompt, toasts, and the phone tab bar use CSS glass
over an opaque `--sheet-bg`; the canvas sits below their scrims.

## Budgets

- Initial host JavaScript < 90 KB gzip (current build: 78.98 KB). The remote
  shell is a separate 70.88 KB gzip entry that loads only on a remote origin.
- Lazy route and overlay chunks < 25 KB gzip each; total JavaScript < 200 KB
  (current build: 163.34 KB).
- CSS: 134.8 KB raw, 20.24 KB gzip
- The size gate reads Vite's manifest and runs in CI after every build
- No layout shift from font loading
- 44 px minimum touch targets
- Contrast ≥ 4.5:1 for text over every surface and accent pair
- Keyboard navigation and visible focus rings on every interactive element
- Zero idle canvas redraws

## Commands

```powershell
pnpm install
pnpm dev
pnpm build
pnpm check
pnpm test
pnpm exec playwright test
```

Screenshots from the visual suite land in `../docs/screenshots/phase*/`.
`pnpm test` currently runs 20 files / 143 tests. The Playwright suite runs 59
tests across desktop (1440×900) and phone (390×844, plus 360×640) in Dark,
Light, and Frost, covering real daemon data, demo labels, first-run onboarding,
Inbox decisions, flight replay and deep links, lazy snapshot diffs, live
WebSocket output, appearance persistence, theme import/export/share, wallpaper
storage, widget editing, glass budgets, focus rings, and touch targets. It
starts disposable demo (`4321`) and live (`4322`) daemons itself.
