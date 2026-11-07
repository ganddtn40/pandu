# Cockpit app

Tauri 2 application for desktop and Android, built from one codebase.

- **Desktop (Windows, macOS, Linux):** embeds the Rust daemon and the embedded
  UI in a single app. No Node runtime, no separate service.
- **Android:** a companion viewer and approval surface. It pairs with a daemon
  running on the user's computer using a QR code or short code. It never records
  locally and never stores agent credentials.

Phase 6 adds the Tauri configuration, capabilities, platform icons, pairing
flow, and signed Android build instructions. Until then, `crates/` is the
source of truth for the daemon and the UI lives in `ui/`.
