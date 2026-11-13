# Translating Pandu

Pandu ships an English source catalog and 13 draft catalogs. Drafts fall back
to English per key, so a missing string never shows a blank label or a key name.

The interface is honest about this: the appearance sheet marks every non-English
catalog as a draft until a reviewer signs it off.

## Current coverage

Measured by `pnpm --dir ui check:i18n` on 2026-11-13:

| Language | Code | Keys | Coverage | Direction |
| --- | --- | --- | --- | --- |
| English (source) | `en` | 1,199 | 100% | LTR |
| Bahasa Indonesia | `id` | 1,110 | 92.6% | LTR |
| Español | `es` | 111 | 9.3% | LTR |
| Français | `fr` | 111 | 9.3% | LTR |
| Deutsch | `de` | 111 | 9.3% | LTR |
| 日本語 | `ja` | 111 | 9.3% | LTR |
| 简体中文 | `zh` | 111 | 9.3% | LTR |
| العربية | `ar` | 111 | 9.3% | RTL |
| हिन्दी | `hi` | 111 | 9.3% | LTR |
| 한국어 | `ko` | 111 | 9.3% | LTR |
| Português (Brasil) | `pt` | 111 | 9.3% | LTR |
| Русский | `ru` | 111 | 9.3% | LTR |
| Türkçe | `tr` | 111 | 9.3% | LTR |
| Tiếng Việt | `vi` | 111 | 9.3% | LTR |

The `id` draft translates 1,110 of the 1,199 English keys, including every key a
screen references, so no catalog string falls back to English. The remaining 89
entries are not used by the interface yet; they stay in English until a screen
needs them. The 111-key drafts cover navigation, common actions, the
home/flights/inbox headings, onboarding, updates, backups, and migration
notices; everything else is still English.

`id` is still a draft. The maintainer translated it, but no native reviewer has
signed it off, so the appearance sheet keeps the `Draft, needs review` note.

Do not describe a draft as a complete translation. The release notes and README
must use the same numbers as this table.

## Where the files live

| File | Purpose |
| --- | --- |
| `ui/src/lib/i18n/catalog.ts` | English source, message types, plural selection, lazy catalog loader |
| `ui/src/lib/i18n/catalogs/<code>.ts` | One draft catalog per language |
| `ui/src/lib/i18n/i18n.svelte.ts` | Reactive `t()` and the catalog-load revision |
| `ui/src/lib/design/types.ts` | `LanguageId`, `LANGUAGES`, `RTL_LANGUAGES` |
| `ui/scripts/check-i18n.mjs` | Key, placeholder, core-string, and coverage gate |
| `docs/install/<code>.md` | Beginner install guide for that language |

English stays in the initial JavaScript bundle. Every draft catalog is a
separate lazy chunk, loaded the first time the language is selected. A failed
chunk falls back to English and never blocks the UI.

## Add a language

1. Add the code to the `LanguageId` union in `ui/src/lib/design/types.ts`.
2. Add a row to `LANGUAGES` with the native label and the note
   `Draft, needs review`. Add ` · RTL` when the script is right to left.
3. If the language is RTL, add it to `RTL_LANGUAGES`. The shell sets
   `html.dir="rtl"` and CSS logical properties mirror the layout.
4. Create `ui/src/lib/i18n/catalogs/<code>.ts`:

   ```ts
   import type { Catalog } from '../catalog';

   const xx: Catalog = {
     'nav.home': '...',
     'nav.inbox': '...',
   };

   export default xx;
   ```

5. Add the dynamic import to `CATALOG_LOADERS` in
   `ui/src/lib/i18n/catalog.ts`.
6. Add a beginner guide at `docs/install/<code>.md`, then list it in the README
   language table.
7. Run `pnpm --dir ui check:i18n`, `pnpm --dir ui check`, and
   `pnpm --dir ui test`.

The gate checks that every catalog has at least 100 keys, every core key is
present, no key is unknown, no key is duplicated, and every placeholder from
English is preserved. It prints real coverage on every run.

## Placeholders and plurals

- Keep `{name}`, `{count}`, `{path}`, `{version}`, and every other placeholder
  exactly as it appears in English. The only exception is the brand pair
  `{product}` / `{cli}`: a translation may use either one.
- Never translate a placeholder name. `{count}` is a variable, not a word.
- Counted strings may use plural forms. Use the categories your language
  actually needs. English and Spanish use `one` and `other`; Arabic uses
  `zero`, `one`, `two`, `few`, `many`, and `other`; Russian uses `one`, `few`,
  `many`, and `other`; Japanese, Korean, Turkish, and Vietnamese can provide
  only `other`.
- The UI selects the form with `Intl.PluralRules`, never with a hand-written
  `count === 1` check. Test at least 0, 1, 2, 5, and 11 where the language has
  multiple forms.

## Right-to-left

Arabic is the RTL pilot. The shell:

- sets `html.lang` and `html.dir` before first paint from the saved design or
  the `?lang=ar` override;
- uses logical CSS properties (`margin-inline-start`, `padding-inline`,
  `inset-inline-end`, `text-align: start/end`) so the rail, sheets, and cards
  mirror;
- flips the toggle knob with a `[dir='rtl']` rule.

When you add an RTL language, test the rail, top bar, appearance sheet,
settings forms, update dialog, and phone layout. Do not add a second
hand-maintained RTL stylesheet; extend the logical-property rules.

## Review standard

A translation is ready to leave draft status when:

- a native or fluent speaker has reviewed the whole catalog;
- product terms are consistent with the English guide (flight, agent, guard,
  approval, snapshot, market);
- placeholders and plural forms are correct;
- the install guide is accurate for that language;
- the appearance sheet note is changed from `Draft, needs review` to the
  reviewer-approved wording;
- `check:i18n`, the UI tests, and the Playwright language test pass.

Machine translation can be a starting point, but unreviewed text must stay
labeled as a draft.

## Useful commands

```powershell
pnpm --dir ui check:i18n
pnpm --dir ui check
pnpm --dir ui test
pnpm --dir ui exec playwright test tests/e2e/i18n.spec.ts
```

The Playwright test boots Arabic through `?lang=ar`, checks the mirrored rail,
switches to Korean, then back to English, and verifies the lazy catalogs load.
