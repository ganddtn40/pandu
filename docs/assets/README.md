# Screenshots and demo assets

Phase 4 added screenshots at 1440×900 and 390×844 for both themes, plus the
`/glass-preview` captures. Phase 11 added the Windows desktop and NSIS installer
captures under `docs/screenshots/`. Phase 12 added the README header, hero, and
gallery under `docs/screenshots/readme/`; a demo GIF is still open.

Rules:

- Capture the real app, never a mockup presented as the app.
- Keep each screenshot under 500 KB.
- Do not reuse the 0.1.0 amber terminal screenshots from `legacy/docs/assets/`.
- Include light and dark versions where the README shows both.
- The Playwright visual suite (`ui/tests/e2e/visual.spec.ts`) is the generator;
  the `README captures` block writes the hero and gallery images, and the rest
  of the suite writes the phase history. Both record the exact browser and
  viewport for every capture.
- The README header icon is a copy of `ui/public/icons/icon-192.png`. Keep it in
  sync when the app icon changes.
