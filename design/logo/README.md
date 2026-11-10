# Pandu logo

The mark is a graphite squircle with a compass ring and a single warm-orange
position light. It reads as a control instrument, not a radar: one ring, one
needle, one live point.

## Files

| File | Use |
| --- | --- |
| `pandu-mark.svg` | Primary mark on dark or photographic backgrounds. |
| `pandu-mark-light.svg` | Paper/silver shell for light backgrounds. |
| `pandu-mark-mono.svg` | Single-color mark; inherits `currentColor`. |
| `pandu-wordmark.svg` | Mark plus the Pandu wordmark. Text inherits `currentColor`. |

`ui/public/logo.svg` is the favicon and must stay in sync with
`pandu-mark.svg`.

## Palette

| Token | Value |
| --- | --- |
| Shell dark | `#3a424d → #1a1f26 → #0b0e12` |
| Shell light | `#ffffff → #f0eee9 → #d7d2c8` |
| Ring | white/silver, or graphite on light |
| Accent | `#ff7a2f` (`#ffb27a → #ff6a1a` gradient) |

The accent is the default Pandu orange. Do not recolor the mark to another
accent preset; the in-app accent engine themes the interface, not the logo.

## Usage

- Minimum size: 24 px for the mark, 120 px wide for the wordmark.
- Clear space: at least 25% of the mark width on every side.
- Keep the squircle intact. Do not crop it, add a second ring, or place the
  mark on a busy area without the dark or light shell variant.
- On light surfaces use `pandu-mark-light.svg` or the mono mark.
- Do not stretch, outline, rotate, or add glow beyond the built-in accent.

## Regenerating PNGs

The SVGs are the source of truth. PNGs are generated and ignored by git.

```sh
pnpm --dir ui install
node design/logo/export.mjs
```

Outputs land in `design/logo/png/`: 512/1024 px marks, 192/512 px PWA icons,
light and mono marks, and a 1600 px wordmark. The exporter renders through
Playwright and embeds the local Inter variable font for the wordmark.
