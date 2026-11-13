# Screenshots and demo assets

The screenshot set covers the shipped UI at 1440×900 and 390×844 for both
themes, the `/glass-preview` captures, the Windows desktop and NSIS installer
captures under `docs/screenshots/`, and the Android companion. The README
header, hero, and gallery live under `docs/screenshots/readme/`; a demo GIF is
still open.

Rules:

- Capture the real app, never a mockup presented as the app.
- Keep each screenshot under 500 KB.
- Do not reuse the 0.1.0 amber terminal screenshots from `legacy/docs/assets/`.
- Include light and dark versions where the README shows both.
- The Playwright visual suite (`ui/tests/e2e/visual.spec.ts`) is the generator;
  the `README captures` block writes the hero and gallery images, and the rest
  of the suite writes the per-screen capture sets. Both record the exact browser
  and viewport for every capture.
- The README header icon is a copy of `ui/public/icons/icon-192.png`. Keep it in
  sync when the app icon changes.
