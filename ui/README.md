# Cockpit UI

Svelte 5 + TypeScript + Vite. No heavy UI or animation libraries. The glass
renderer is custom WebGL2 code in `src/glass`.

> **Status:** Phase 4 adds the shell, glass engine, and `/glass-preview`; Phase 5
> adds the four screens, onboarding, and i18n catalogs.

## Design direction

- One large frosted panel (radius 32–40) floating over a softly blurred
  wallpaper.
- Nested matte translucent tiles (radius 24–28).
- Floating top pill bar: logo, search, Light/Dark segmented control, bell.
- Floating left icon pill on desktop; active icon is a white circle.
- Floating bottom tab pill on phone; active tab is a white pill with dark text,
  plus a circular `+`.
- Neutral monochrome glass with one accent: `#4DA3FF` for live/active. Green
  and red only for status.
- Light theme: frosted white/gray. Dark theme: smoky glass with cream
  `#F4EFD8` selected pills.
- System UI font stack with a bundled variable-font fallback, sentence case,
  tabular numbers.

Banned: amber-on-black, monospace uppercase labels, serif display fonts, hero
marketing headlines, grid/radar decoration, sharp corners.

## Glass engine

`src/glass` renders the wallpaper and every `[data-glass]` element in one
full-screen WebGL2 pass:

- SDF squircle geometry with edge refraction from the SDF gradient
- Frost from a pre-blurred quarter-resolution wallpaper texture
- Chromatic aberration on the rim
- Top-left specular rim light following pointer or device tilt
- Inner shadow, tint, saturation boost
- ResizeObserver + rAF geometry sync, on-demand rendering, 12-shape cap,
  60 fps desktop / 30 fps mobile, paused when hidden

Fallbacks: no WebGL2 → CSS `backdrop-filter: blur(24px) saturate(160%)`;
`prefers-reduced-transparency` → opaque frosted; `prefers-reduced-motion` →
static; Performance mode → CSS fallback.

## Budgets

- JavaScript < 150 KB gzip
- No layout shift from font loading
- 44 px minimum touch targets
- Contrast ≥ 4.5:1 for text over glass
- Keyboard navigation and visible focus rings on every interactive element

## Commands (available in Phase 4)

```powershell
pnpm install
pnpm dev
pnpm build
pnpm check
pnpm test
pnpm exec playwright test
```
