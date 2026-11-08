# Cockpit UI

Svelte 5 + TypeScript + Vite. No heavy UI or animation libraries. The glass
renderer is custom WebGL2 code in `src/glass`.

> **Status:** Phase 4B (Design v2) is complete and stops for visual approval.
> The five tabs render with sample data; Phase 5 wires them to the daemon,
> finishes onboarding, and adds the i18n catalogs.

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

## Appearance

Settings → Appearance is a live customization sheet:

- Theme, surface style, accent, corner radius (Sharp/Soft/Round), density
  (Compact/Comfortable/Spacious)
- Font (System/Inter/Mono for code) and font size
- Glass intensity, blur, and refraction
- Wallpaper: procedural, your image, or none
- Card borders, motion (Full/Reduced/Off), Performance mode, language

Preferences persist per device under `cockpit.design`; the wallpaper image uses
`cockpit.wallpaperImage`. Legacy theme/performance keys migrate automatically.
Themes export as `cockpit-theme.json` (`cockpit.theme`, version 1), import with
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
- ResizeObserver + rAF geometry sync, on-demand rendering, 16-shape cap,
  60 fps desktop / 30 fps mobile, paused when hidden

Fallbacks: no WebGL2 or `?glass=off` → CSS `backdrop-filter`; matte surface or
Performance mode → CSS matte surfaces with WebGL paused; `prefers-reduced-
transparency` → CSS glass without backdrop blur; `prefers-reduced-motion` →
static. The engine keeps an idle WebGL context so switching back is instant.

Overlay sheets, the quick prompt, toasts, and the phone tab bar use CSS glass
over an opaque `--sheet-bg`; the canvas sits below their scrims.

## Budgets

- JavaScript < 150 KB gzip (current build: ~150.0 KB, 49.6 KB gzip)
- CSS: ~50 KB, 9.7 KB gzip
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

Screenshots from the visual suite land in `../docs/screenshots/phase4b/`.
`pnpm test` currently runs 10 files / 95 tests. The Playwright suite runs 23
tests across desktop (1440×900) and phone (390×844, plus 360×640) in Dark,
Light, and Frost, covering surfaces, fallbacks, appearance persistence, theme
import/export/share, wallpaper storage, widget editing, focus rings, and touch
targets.
