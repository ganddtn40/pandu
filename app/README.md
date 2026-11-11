# Pandu app

Tauri 2 shell for the Windows desktop app and the Android companion. Both use
the same Svelte UI from `ui/`; the daemon stays in `crates/` and is embedded,
not reimplemented.

- **Windows desktop:** one executable embeds the daemon and the bundled UI. It
  starts the daemon in-process, or attaches to a compatible `pandu serve` that
  already owns the data directory. Closing the window hides it to the tray.
- **Android:** a companion viewer and approval surface. It pairs with a daemon
  on the user's computer using a QR code or short code. It never records locally
  and never stores agent credentials.

This directory is a detached Cargo workspace so the desktop toolchain (Tauri,
WebView2, Android) cannot change the root daemon gates.

## Build

```powershell
pnpm --dir ui build
pnpm --dir app install
pnpm --dir app exec tauri dev
pnpm --dir app exec tauri build --bundles nsis msi
```

The Windows installer is per-user and needs no administrator. The MSI is for
managed, per-machine deployment.

## Android

```powershell
node app/scripts/android-init.mjs
node app/scripts/android-build.mjs
```

`android-init.mjs` creates `src-tauri/gen/android` and applies the companion's
manifest and network hardening. `android-build.mjs` builds the unsigned APK and
signs it only when the CI keystore variables are present.

## Docs

- `docs/install/en.md` — beginner install and first run
- `docs/install/android.md` — companion setup and Tailscale
- `docs/install/pwa.md` — install the UI as a PWA
- `docs/RELEASING.md` — release gates, signing, and artifacts
- `packaging/README.md` — packaging, channels, and checksums
