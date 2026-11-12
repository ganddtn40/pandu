# Pandu design system

Status: Phase 4B (Design v2) complete. This document is the source of truth for
the visual language, design tokens, appearance settings, theme file format, and
the accessibility and performance rules that gate UI work.

The UI is a Svelte 5 app in `ui/`. Design tokens live in `ui/src/app.css`; the
appearance engine lives in `ui/src/lib/design/`; the glass renderer lives in
`ui/src/glass/`.

## 1. Principles

1. **Calm before decoration.** Dark graphite bento dashboards, matte cards, and
   one accent. The interface should feel like a quiet instrument, not a
   marketing page.
2. **Information first.** Large light numerals, thin charts, and generous
   spacing. Status is communicated with a small glow and a label, never with a
   second palette.
3. **Depth only where it means something.** Floating layers — the top bar,
   sheets, toasts, modals, and phone navigation — may be glass. Working cards
   stay matte by default so text is always readable.
4. **Customization without a theme language.** Every appearance option is a
   bounded, validated enum or number. Themes are data, never code.
5. **Small and fast.** No heavy UI, animation, or icon libraries. The glass
   engine renders on demand and idles at zero redraws.

## 2. Information architecture

Five primary tabs, no more:

| Tab | Route | Purpose |
| --- | --- | --- |
| Home | `/` | Live flight, spend, tokens, guard state, bento widgets |
| Inbox | `/inbox` | Approvals and alerts that need a decision |
| Flights | `/flights` | Recorded sessions, replay, step inspection |
| Market | `/market` | Adapters, themes, and future registry items |
| Settings | `/settings` | Agents, appearance, privacy, updates, about |

Global layers:

- **Quick prompt** — `Ctrl/Cmd+K`, or the Home action / phone action button.
  Available from any tab.
- **Appearance sheet** — Settings → Appearance. Live preview while open.

Secondary routes: `/welcome` (first-run preview), `/glass-preview` (internal
rendering lab). Aliases `/home` and `/approvals` redirect to `/` and `/inbox`.

The old 0.1.0 screens fold into this IA: Overview and Analytics → Home;
Sessions, Replay, and Session detail → Flights; Guards and Trust → Home state,
Inbox, and flight badges; Pair, Settings, and Doctor → Settings and onboarding.
Arena, Journal, Plugins, Project Brain, Handoff, Understanding Debt, Context
Doctor, and Provenance remain deferred.

## 3. Visual language

### Surfaces

| Surface style | Cards | Floating layers | Use |
| --- | --- | --- | --- |
| Bento Matte | Solid graphite/paper, 1 px hairline | Solid strong card colour | Lowest GPU cost, maximum legibility |
| Liquid Glass | Refracting glass | Refracting glass | Showcase mode; all glass shapes |
| Hybrid (default) | Matte with hairline | Glass | Matte working cards, glass chrome |

- Cards use `data-glass-layer="card"`, chrome uses `data-glass-layer="float"`.
- The glass engine only draws the layers the current surface style allows:
  matte draws none, hybrid draws floats, glass draws cards and floats.
- Card corners stay within 20–28 px at the default radius. Radii scale with the
  Sharp / Soft / Round preference.
- Cards use a 1 px hairline (`--hairline`) and a subtle inset top highlight.
  No heavy drop shadows on working surfaces.
- Floating layers use a stronger shadow (`--shadow`) and may blur what is
  behind them.

### Themes

| Theme | Character |
| --- | --- |
| Dark (default) | Graphite `#0a0c0f`, near-black panels, light text |
| Light | Warm paper `#eeebe4`, ink text |
| Frost | Cool blue-white `#e7eef5`, ink text |

Dark is the default. Light and Frost share the "light" shader treatment; only
Dark uses the smoked, near-black glass tint.

### Accents

One accent per theme, default warm orange `#FF7A2F`. Presets: Orange, Cream,
Blue, Green, Violet, Silver, Mono. Green and red remain reserved for status, so
the accent presets avoid a green/red that could be mistaken for state.

Every accent declares:

- `--accent` — fill/base
- `--accent-strong` — pressed or high-emphasis fill
- `--accent-ink` — accent-coloured text on a normal surface
- `--accent-soft` — tinted background
- `--accent-contrast` — text drawn on an accent fill

All 21 theme × accent pairs are declared explicitly in CSS and mirrored in
`ui/src/lib/design/accents.ts`. `ui/tests/unit/contrast.test.ts` asserts the two
stay in lockstep.

### Typography

- System UI stack first; bundled Inter variable Latin subset as fallback.
- Sentence case everywhere. No monospace uppercase labels.
- Tabular figures for numerals.
- Large stat numerals (44 px desktop) with light weight.
- Code, terminal output, and keyboard hints may use mono; the "Mono for code"
  font option changes only code, never UI labels.
- Font size is a 0.85–1.3 multiplier over the 14 px base.

### Motion

- Full: springs, parallax, sheet transitions.
- Reduced: no parallax; transitions shortened.
- Off: no transitions.
- The OS `prefers-reduced-motion` preference is honoured independently of the
  stored setting.

### Banned

- Amber-on-black terminal styling.
- Monospace uppercase labels.
- Serif display type.
- Hero marketing headlines.
- Radar or grid decoration.
- Sharp corners on primary surfaces.
- More than one accent colour per theme.
- Glass on top of glass without a readable backing.

## 4. Design tokens

Tokens are CSS custom properties on `<html>`, switched by data attributes set
before first paint by `ui/index.html`:

```
data-theme        dark | light | frost
data-surface      matte | glass | hybrid
data-accent       orange | cream | blue | green | violet | silver | mono
data-radius       sharp | soft | round
data-density      compact | comfortable | spacious
data-font         system | inter | mono
data-motion       full | reduced | off
data-borders      on | off
data-wallpaper    procedural | image | none
data-performance  on | off
```

Core token groups:

| Group | Examples |
| --- | --- |
| Background | `--bg`, `--bg-deep`, `--panel-bg`, `--sheet-bg` |
| Cards | `--card-bg`, `--card-bg-strong`, `--card-surface`, `--card-border` |
| Floats | `--glass-bg`, `--glass-border`, `--float-surface`, `--float-border` |
| Text | `--text`, `--text-soft`, `--text-faint`, `--selected-text` |
| Lines | `--hairline`, `--hairline-soft`, `--hairline-strong` |
| Status | `--success`, `--danger`, `--warn` plus soft variants |
| Accent | `--accent`, `--accent-strong`, `--accent-ink`, `--accent-soft`, `--accent-contrast` |
| Radius | `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius-xl`, `--radius-pill` |
| Density | `--pad-card`, `--gap-card`, `--gap-section`, `--pad-panel` |
| Glass | `--glass-blur-px`, `--glass-intensity`, `--glass-refraction` |

Radius presets:

| Preset | sm | md | lg (cards) | xl (sheets) |
| --- | --- | --- | --- | --- |
| Sharp | 8 | 12 | 20 | 24 |
| Soft (default) | 12 | 18 | 24 | 30 |
| Round | 16 | 22 | 28 | 36 |

Density presets:

| Preset | Card pad | Card gap | Section gap | Panel pad |
| --- | --- | --- | --- | --- |
| Compact | 16 | 10 | 16 | 24 |
| Comfortable (default) | 20 | 14 | 22 | 28 |
| Spacious | 26 | 18 | 28 | 34 |

## 5. Appearance customization

Settings → Appearance opens a sheet with an instant live preview. Every control
writes to `designState`, which updates the `<html>` data attributes, the CSS
tokens, and the glass uniforms without a reload.

Controls:

- **Theme** — Dark, Light, Frost.
- **Surface style** — Bento Matte, Liquid Glass, Hybrid.
- **Accent colour** — seven presets with swatches.
- **Corner radius** — Sharp, Soft, Round.
- **Density** — Compact, Comfortable, Spacious.
- **Font** — System, Inter, Mono for code; font size slider 0.85–1.3.
- **Glass** — intensity, blur, and refraction sliders (0–100). Disabled with a
  note when the surface style is Matte.
- **Wallpaper** — procedural, your image, or none. An uploaded image is
  downscaled to a maximum edge of 1920 px, stored as a JPEG data URL under
  `pandu.wallpaperImage`, and never exported in a theme file.
- **Card borders** — on/off.
- **Motion** — Full, Reduced, Off.
- **Performance mode** — pauses WebGL and uses CSS surfaces; no reload.
- **Language** — English plus six draft language preferences; the translation
  catalogs land in Phase 5.

Preferences are per-device. They persist in `localStorage` under
`pandu.design`; the wallpaper image uses its own key. The legacy keys
`pandu.theme`, `pandu.performance`, and `pandu.glassPattern` are migrated
automatically when the new key is absent. URL overrides
(`?theme=`, `?surface=`, `?accent=`, `?radius=`, `?density=`, `?font=`,
`?fontScale=`, `?motion=`, `?borders=`, `?wallpaper=`, `?lang=`, `?perf=1`,
`?glass=off`, and `?share=`) take precedence for that load only.

## 6. Theme JSON

Themes are versioned JSON. Export writes `pandu-theme.json`; import validates
the file before applying anything; share encodes the same object in a `?share=`
URL. Imported themes are never executed — the parser only reads known fields,
rejects unknown enum values, clamps numbers to their allowed ranges, and ignores
unknown keys for forward compatibility.

```json
{
  "schema": "pandu.theme",
  "version": 1,
  "theme": "dark",
  "surface": "hybrid",
  "accent": "orange",
  "radius": "soft",
  "density": "comfortable",
  "font": "system",
  "fontScale": 1,
  "glass": { "intensity": 55, "blur": 55, "refraction": 55 },
  "wallpaper": "procedural",
  "borders": true,
  "motion": "full",
  "language": "en"
}
```

Rules:

- `schema` must be `pandu.theme`; `version` must be an integer this build
  supports (currently 1).
- Files are limited to 32 KB of text.
- `wallpaper` may be `procedural`, `image`, or `none`. A shared `image` theme
  falls back to `procedural` when the importing device has no local image.
- Performance mode and the wallpaper image are device-local and are never
  exported or imported.
- Invalid files fail with a plain-language error; nothing is applied.

Implementation: `ui/src/lib/design/theme-json.ts`. Tests:
`ui/tests/unit/theme-json.test.ts`.

## 7. Glass engine

`ui/src/glass/` is one custom WebGL2 renderer. It draws the wallpaper and up to
16 SDF squircle glass shapes in a single full-screen pass:

- Procedural wallpaper, flat field, user image, or checker test pattern.
- Pre-blurred quarter-resolution wallpaper texture for frost.
- Edge refraction from the SDF gradient, chromatic aberration on the rim.
- Top-left specular rim light with pointer parallax.
- Accent tint, inner shadow, saturation lift, theme-aware scrim and vignette.
- Shape styles differ by depth (1–3) and by theme (light/frost vs dark).
- Inner content is clipped to its nearest `[data-glass]` ancestor.

Rendering is on demand: a geometry sync runs only when the DOM changes, the
canvas redraws only when a uniform, shape, theme, wallpaper, or size changes,
and the loop pauses while the page is hidden. `window.__panduGlassStats`
exposes `{ mode, shapes, fps, redrawsPerSecond, redrawsTotal }`; the idle gate
asserts `redrawsTotal` does not change over three seconds.

Fallbacks, all without a reload where possible:

| Condition | Result |
| --- | --- |
| Matte surface | WebGL paused, CSS matte surfaces |
| Performance mode | WebGL paused, CSS fallback |
| `?glass=off` | CSS fallback for the session |
| `prefers-reduced-transparency` | CSS glass without backdrop blur |
| No WebGL2 / init failure | CSS fallback |
| Motion off | No parallax or transitions |

The engine keeps an idle WebGL context so switching back to a glass surface or
turning Performance mode off is instant.

Overlay layers (appearance sheet, quick prompt, toasts, phone tab bar) use CSS
glass over an opaque `--sheet-bg` instead of WebGL shapes. The canvas sits below
the scrims, so a WebGL shape cannot render on top of them; tests assert these
overlays keep a background alpha of at least 0.9.

## 8. Accessibility

- Text contrast is at least 4.5:1 over every theme surface, including the
  brightest wallpaper pool. The contrast test composites every text token over
  every surface token, and every accent fill with its contrast ink.
- Focus is always visible: 2 px accent ring with a 2 px offset, on every
  interactive element.
- Keyboard navigation: all tabs, the quick prompt (`Ctrl/Cmd+K`, `Escape`),
  sheets, segmented controls, and widget editing are reachable without a
  pointer. Focus is trapped in open dialogs and restored on close.
- Touch targets are at least 44×44 px on phone widths; Playwright audits the
  top bar, tab bar, buttons, segmented controls, text links, and toggles.
- `prefers-reduced-motion` removes parallax and shortens transitions.
- `prefers-reduced-transparency` disables backdrop blur and uses solid surfaces.
- Status is never colour-only: labels and icons accompany success, warning, and
  error states.
- Empty, loading, and error states are designed for every screen; no blank
  panels.

## 9. Performance budget

| Budget | Target |
| --- | --- |
| Initial UI JavaScript | ≤ 90 KB gzip per entry (host and companion) |
| Lazy route/overlay chunk | ≤ 25 KB gzip each |
| All UI JavaScript | ≤ 200 KB gzip |
| UI CSS | ≤ 30 KB gzip; currently ~20 KB |
| Idle canvas redraws | 0/s when nothing changes |
| Idle CPU | ~0% |
| Font loading layout shift | none (`font-display: swap`, system-first stack) |
| Glass shapes | ≤ 16 |
| Frame cap | 60 fps desktop / 30 fps mobile |
| Touch targets | ≥ 44 px |
| Text contrast | ≥ 4.5:1 |

Current build: 78.9 KB gzip initial host JavaScript, 70.9 KB initial companion
JavaScript, 163.3 KB across every chunk, and 20.2 KB gzip CSS. Every screen and
overlay is a lazy chunk; `ui/scripts/check-size.mjs` fails the build when a
budget is exceeded, so new runtime dependencies need a measured reason.

## 10. Platform support

Stated plainly so nothing unsupported is advertised:

| Platform | Status |
| --- | --- |
| Windows | Supported |
| Web (PWA) | Supported |
| Android | Experimental |
| macOS | Planned |
| iOS | Planned |
| Linux | Planned |

The UI is responsive and tested at 1440×900 and 390×844 (plus 360×640 for the
phone bottom-edge case). Android is a companion viewer/approver, not a recorder.
It stays experimental until emulator and phone verification are complete.

## 11. File map

| Path | Purpose |
| --- | --- |
| `ui/src/app.css` | Tokens, themes, surfaces, bento, sheets, responsive rules |
| `ui/src/lib/design/types.ts` | Design preference types, defaults, option lists |
| `ui/src/lib/design/accents.ts` | Accent palettes and contrast inks |
| `ui/src/lib/design/design.svelte.ts` | Live design state and DOM attribute application |
| `ui/src/lib/design/theme-json.ts` | Export, import, validation, share, migration |
| `ui/src/lib/design/wallpaper.ts` | Image downscale and local storage |
| `ui/src/lib/design/widgets.ts` | Bento widget registry and ordering |
| `ui/src/lib/AppearanceSheet.svelte` | Appearance controls |
| `ui/src/lib/HomePreview.svelte` | Bento home, drag/long-press editing |
| `ui/src/lib/QuickPrompt.svelte` | Global quick prompt |
| `ui/src/glass/` | WebGL2 wallpaper and glass renderer |
| `design/logo/` | Logo sources and export script |
| `ui/tests/unit/contrast.test.ts` | Contrast and CSS/TS parity gate |
| `ui/tests/e2e/visual.spec.ts` | Screenshots, appearance, theme, widget, phone gates |
| `docs/screenshots/phase4b/` | Design v2 reference screenshots |
