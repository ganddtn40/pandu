# Pandu logo

The mark is a glossy white app tile with a bold blue navigation P. The P is a
solid, rounded letterform; the white cursor cutout inside its bowl points up and
to the right. It reads as a navigation instrument, not a generic pin: one tile,
one letter, one live direction.

## Files

| File | Use |
| --- | --- |
| `pandu-mark.png` | Master raster mark (1254×1254, transparent padding). |
| `pandu-mark-flat.svg` | Flat vector mark for sizes below 28 px, favicons, and print. |
| `pandu-mark-mono.svg` | Single-colour P silhouette; inherits `currentColor`. |
| `pandu-wordmark.svg` | Flat mark plus the Pandu wordmark. Text inherits `currentColor`. |
| `android-foreground.svg` | Adaptive-icon foreground: blue P on transparent. |
| `android-monochrome.svg` | Themed-icon layer: P silhouette on transparent. |
| `icon-manifest.json` | Tauri icon input for desktop and Android. |
| `export.mjs` | Renders the PNG set and the PWA icons. |

`ui/public/logo-small.svg` is the 32 px favicon and is a scaled variant of the
same traced P path. Keep the two in sync.

## Palette

| Token | Value |
| --- | --- |
| Tile | `#ffffff` with a `#c9dcfa` hairline |
| P (flat) | `#1857d6` |
| P (glossy) | `#00208c → #2f7fe0` |
| App accent | `#2f7fe0` (Blue, the default) |

The blue matches the default in-app accent. Do not recolour the glossy mark to
another accent preset; the accent engine themes the interface, not the logo.

## Usage

- Full detail at 28 px and above; the flat vector below 28 px.
- Minimum size: 16 px for the flat mark, 120 px wide for the wordmark.
- Clear space: at least 25% of the mark width on every side.
- Keep the tile and the cursor cutout intact. Do not crop the tile, outline the
  P, rotate the mark, or add a glow beyond the built-in gloss.
- On dark or photographic surfaces use the glossy tile; on paper use the flat
  tile or the mono P.

## Regenerating PNGs

The master PNG and the SVGs are the source. PNGs are generated and ignored by
git; the PWA icons under `ui/public/icons/` are committed.

```sh
pnpm --dir ui install
node design/logo/export.mjs
```

Outputs land in `design/logo/png/`: 512/1024 px marks, 192/512 px PWA icons, a
maskable 512 px icon, flat and mono marks, and a 1600 px wordmark. The three
`icon-*.png` files are copied into `ui/public/icons/` automatically. The
exporter renders through Playwright and embeds the local Inter variable font
for the wordmark.

## Desktop and Android icons

```sh
pnpm --dir app icons
node app/scripts/check-brand.mjs
```

`app/src-tauri/icons/` is generated from `icon-manifest.json`: the glossy PNG
for desktop and iOS, the blue P for the Android adaptive foreground, and the P
silhouette for themed icons. The Android adaptive background stays white so the
white tile and the blue P match the primary mark.
