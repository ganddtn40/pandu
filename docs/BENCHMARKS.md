# Benchmarks

Measured numbers for the packaged app, not estimates. Every table below comes
from a script in this repository and can be reproduced with the commands in
[Reproducing](#reproducing). The report files are generated locally and are not
committed.

Last measured: 2026-11-12.

## Test machine

| Item | Value |
| --- | --- |
| OS | Windows 11 Home 10.0.26200 |
| CPU | AMD Ryzen 5 6600H, 6 cores / 12 threads, 3.3 GHz base |
| Memory | 16 GB |
| WebView2 runtime | 157.0.4341.46 |
| Build | `0.2.0`, release profile, `custom-protocol` feature enabled |
| Node | 24.21.0 |

These numbers are specific to this machine. Compare them with the budgets and
with each other, not with a different laptop.

## Artifact sizes

| Artifact | Size |
| --- | --- |
| `pandu.exe` (CLI) | 9.31 MB |
| `Pandu.exe` (desktop shell, unpacked) | 12.98 MB |
| `Pandu_0.2.0_x64-setup.exe` (NSIS) | 5.10 MB |
| `Pandu_0.2.0_x64_en-US.msi` | 6.93 MB |
| `pandu-0.2.0-x86_64-pc-windows-msvc-portable.zip` | 6.19 MB |
| Android APK | not built yet; Phase 11b is pending |

The CLI budget is 12 MB. The APK budget is 15 MB and remains unmeasured until
the Android build is verified.

## Web UI payload

`pnpm --dir ui size` reads Vite's real manifest, follows static imports from
each entry point, and measures gzip bytes. Dynamic route chunks are measured
separately so a lazy route cannot hide behind the initial budget.

| Check | Budget | Actual | Result |
| --- | --- | --- | --- |
| Initial host JS | 90 KB | 78.98 KB | pass |
| Initial companion JS | 80 KB | 70.88 KB | pass |
| Largest async chunk | 25 KB | 18.67 KB (`SettingsScreen`) | pass |
| Largest shared chunk | 70 KB | 62.21 KB (`widgets.svelte`) | pass |
| Total JS | 200 KB | 163.34 KB | pass |
| CSS | 30 KB | 20.24 KB | pass |

The per-chunk gate is part of `pnpm --dir ui build` and runs in CI after the
build. A chunk that grows past its budget fails the build instead of silently
shipping.

## Whole-app idle resources

The measurement sums the working set of the Rust process that hosts the daemon
and every descendant, including every `msedgewebview2.exe` process. It samples
at most once per second for 60 seconds after a 3 second settle; the PowerShell
CIM query takes a few hundred milliseconds, so a 60-second window yields about
47 samples. CPU is the change in user plus kernel time over the sampling window
divided by wall time, expressed as a percentage of one core. Time to interactive
is measured over the WebView2 debugging protocol from process spawn to the first
interactive frame (`data-app-ready-at`, set after two animation frames).

| Scenario | Flights | Route | Daemon ready | Time to interactive | Avg working set | Peak | Avg core | Avg WebView2 | Idle CPU | Samples |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Empty database | 0 | `/` | 112 ms | 814 ms | 396.9 MB | 403.8 MB | 32.5 MB | 364.4 MB | 0.64% | 47 |
| Home with 500 flights | 500 | `/` | 54 ms | 545 ms | 399.2 MB | 405.4 MB | 34.8 MB | 364.4 MB | 0.90% | 47 |
| Flights list with 500 flights | 500 | `/flights` | 54 ms | 540 ms | 426.6 MB | 440.9 MB | 35.0 MB | 391.6 MB | 1.09% | 47 |

What the numbers mean:

- **The recorder is small; Chromium is not.** The Rust process that hosts the
  daemon stays around 33–35 MB. Almost all of the whole-app figure is WebView2.
  The idle-RAM budget of 40 MB applies to the recorder, not to Chromium.
- **The sum is not unique memory.** Windows working set counts shared pages in
  every process that maps them, so summing the tree double-counts shared
  libraries. The figure is an upper bound for "what Task Manager would show",
  not a private-bytes measurement.
- **500 flights add about 2 MB on Home and 27 MB on the list.** The list keeps
  rendered rows and their derived state; Home only reads aggregates.
- **Idle CPU is below 1.2% of one core in every scenario.** This is a laptop
  with other background work; treat the third significant digit as noise.
- **Time to interactive is under one second.** It includes daemon startup,
  WebView2 creation, the first paint, and two animation frames. The empty
  database is slower because the first run creates the schema and runs the
  first-run checks.

### Budgets

| Check | Budget | Actual | Result |
| --- | --- | --- | --- |
| CLI binary | < 12 MB | 9.31 MB | pass |
| Core idle RAM | < 40 MB | 34.8 MB | pass |
| Daemon ready | < 300 ms | 54 ms | pass |
| Android APK | < 15 MB | not built | not measured |

## Uninstall hygiene

The uninstaller must remove machine state and keep user data unless the user
explicitly chooses to delete it. This was tested with the real NSIS installer,
not by reading the script.

Test sequence:

1. Remove dev-only artifacts (`HKCU\Software\Classes\pandu`, the vendor key, and
   an old test install) so the baseline is clean.
2. `node app/scripts/uninstall-check.mjs --phase before` recorded zero
   installation artifacts and `C:\Users\galih\.pandu` present.
3. Run `Pandu_0.2.0_x64-setup.exe /S`. The installer created:
   - `%LOCALAPPDATA%\Pandu\Pandu.exe` and `uninstall.exe`
   - `HKCU\Software\Classes\pandu` pointing at the installed executable
   - `HKCU\Software\Pandu contributors\Pandu` with the install location
   - `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Pandu`
   - `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Pandu.lnk`
   - `%USERPROFILE%\Desktop\Pandu.lnk`
4. Run `%LOCALAPPDATA%\Pandu\uninstall.exe /S`.
5. `node app/scripts/uninstall-check.mjs --phase after --baseline dist/uninstall-baseline.json`
   reported **PASS**: no protocol handler, Start Menu entry, desktop shortcut,
   scheduled task, service, autostart value, uninstall entry, install directory,
   or vendor registry key remained. `C:\Users\galih\.pandu` remained.

One fix came out of this test. Tauri's NSIS template only deletes
`HKCU\Software\<publisher>\<product>` when the user also selects "delete
application data". A silent uninstall therefore left the install-location key
behind. `app/src-tauri/installer/hooks.nsh` now removes that key in
`NSIS_HOOK_POSTUNINSTALL`, and `app/scripts/uninstall-check.mjs` checks vendor
keys as well as the protocol handler, shortcuts, tasks, services, autostart
values, uninstall entries, and install directories.

Known limits: the interactive "Delete that folder as well?" prompt was not
automated. Silent uninstalls always keep data, and that is the path tested here.
The prompt only appears in the interactive uninstaller. The MSI uninstaller was
not exercised; only the NSIS per-user installer was tested. The MSI is a
per-machine install and is covered by the post-release check in
[`RELEASING.md`](RELEASING.md#6-post-release-checks).

## What is not measured

- **Android.** No APK has been built or measured. The 15 MB budget is open until
  Phase 11b completes. Android remains experimental.
- **macOS, Linux, and iOS.** No builds exist, so there is nothing to measure.
- **GPU and battery.** The WebGL2 glass engine is measured only through total
  working set and CPU. No GPU timer or battery drain test exists.
- **Long soaks.** The longest run is 60 seconds. A multi-hour leak test is not
  part of this report.
- **Very large histories.** 500 flights is the largest seeded database. 10,000
  flights and multi-gigabyte histories are untested.
- **Proxy p99 latency.** The proxy forwards bytes and records a copy, but this
  report does not measure added latency under load.
- **Signed builds.** The measured binaries are unsigned. Authenticode signing
  changes the file bytes, not the runtime behavior, but no signed build has been
  benchmarked.

## Reproducing

From the repository root on Windows:

```powershell
# 1. Build the UI, then the desktop shell with the embedded assets.
pnpm --dir ui build
cargo build --release --features custom-protocol --locked --manifest-path app/src-tauri/Cargo.toml

# 2. Measure artifact sizes and run all three scenarios for 60 seconds each.
node app/scripts/resources.mjs --seconds 60
```

`cargo build --release` without `--features custom-protocol` produces a dev-mode
binary that loads `http://127.0.0.1:5174` instead of the embedded UI. The
benchmark needs the embedded build. `pnpm --dir app exec tauri build` enables
the feature automatically.

The script writes `dist/resource-report.json` and `dist/resource-report.md`.
It launches the app with a throwaway `PANDU_HOME`, `PANDU_PORT=0`,
`PANDU_SMOKE_ORIGIN`, notifications and log watching disabled, and a free
WebView2 debugging port. The 500-flight database is seeded into the throwaway
SQLite file through the production schema. The developer database is never
touched.

To check the uninstaller:

```powershell
node app/scripts/uninstall-check.mjs --phase before
# install, then uninstall with /S
node app/scripts/uninstall-check.mjs --phase after --baseline dist/uninstall-baseline.json
```

The check only reads state. It never deletes anything.
