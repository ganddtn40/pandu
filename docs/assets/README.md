# Screenshots and demo assets

Phase 4 added screenshots at 1440×900 and 390×844 for both themes, plus the
`/glass-preview` captures. Phase 11 added the Windows desktop and NSIS installer
captures under `docs/screenshots/`. A README hero image and demo GIF are still
open.

Rules:

- Capture the real app, never a mockup presented as the app.
- Keep each screenshot under 500 KB.
- Do not reuse the 0.1.0 amber terminal screenshots from `legacy/docs/assets/`.
- Include light and dark versions where the README shows both.
- The Playwright visual suite (`ui/tests/e2e/visual.spec.ts`) is the generator;
  it records the exact browser and viewport for every capture.
