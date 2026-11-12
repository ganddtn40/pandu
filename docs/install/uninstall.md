# Uninstall Pandu and verify the cleanup

Pandu keeps the application and your data in different places. Uninstalling the
app removes only the files and registrations it created; your flights, settings,
snapshots, backups, and paired devices stay in `%USERPROFILE%\.pandu` unless
you explicitly choose to delete them.

This guide covers the Windows desktop app. For the Android companion, see
[android.md](android.md#update-and-uninstall).

## What the uninstaller removes

For the NSIS per-user install (`Pandu_<version>_x64-setup.exe`):

- The application files under `%LOCALAPPDATA%\Pandu`.
- The Start Menu shortcut and the desktop shortcut.
- The `pandu://` protocol handler registered for the current user.
- The uninstall entry in **Settings > Apps > Installed apps**.
- The install-location key under `HKCU\Software\Pandu contributors`.
- The optional autostart value, if you enabled **Start Pandu with Windows**.

It does **not** remove:

- `%USERPROFILE%\.pandu` (your data), unless you answer **Yes** to the
  uninstaller's question.
- A scheduled task or a Windows service. Pandu installs neither.
- Anything under another user's profile.

Silent uninstalls (`/S`) always keep the data folder.

The MSI is a per-machine install. It has no data-deletion question; delete
`%USERPROFILE%\.pandu` manually only if you want the data gone. The NSIS test
below does not exercise the MSI; the post-release checklist does. The portable zip
has no uninstaller: quit Pandu from the tray, delete the folder you extracted,
and delete the data folder separately if you want it gone.

## Uninstall by hand

1. Quit Pandu from the tray. Closing the window only hides it.
2. Open **Settings > Apps > Installed apps**, find **Pandu**, and choose
   **Uninstall**.
3. Answer the data question. The default is **No**.
4. If you chose **No** and later want the data gone, delete
   `%USERPROFILE%\.pandu` yourself. This cannot be undone.

## Verify the cleanup

`app/scripts/uninstall-check.mjs` reads the registry, Start Menu and desktop
shortcuts, scheduled tasks, services, autostart values, uninstall entries,
install directories, and vendor registry keys. It never deletes anything. It is
the same check the release checklist uses.

Run it on Windows before and after the uninstall:

```powershell
# Before: record what the installer created.
node app/scripts/uninstall-check.mjs --phase before --expect-installed

# Uninstall through Settings, or silently:
#   & "$env:LOCALAPPDATA\Pandu\uninstall.exe" /S

# After: fail if anything survived, and confirm the data folder remains.
node app/scripts/uninstall-check.mjs --phase after --baseline dist/uninstall-baseline.json
```

A passing run prints:

```text
Pandu uninstall check (after)
  data directory: C:\Users\<you>\.pandu (present)
  expected data: present
  no protocol handler, Start Menu or desktop shortcut, task, service, autostart, uninstall entry, install directory, or vendor registry key remains
  result: PASS
```

If the uninstaller was explicitly told to delete the data, add
`--allow-data-deleted`. Use `--json` for a machine-readable report.

The check fails when any of these survives:

- a `pandu` protocol handler under `HKCU` or `HKLM`;
- a Start Menu or desktop shortcut whose name contains `Pandu`;
- a scheduled task or service whose name or path contains `Pandu`;
- an autostart value under either `Run` key;
- an uninstall registry entry with a Pandu display name or publisher;
- an install directory under `%LOCALAPPDATA%`, `%ProgramFiles%`, or
  `%ProgramFiles(x86)%`;
- a vendor registry key under `HKCU\Software`, `HKLM\Software`, or
  `HKLM\Software\WOW6432Node` whose name contains `Pandu`.

A failed check is a bug. Capture the JSON report and open an issue with the
`pandu report` diagnostics. Do not delete the leftover registry keys by hand
until the report is captured.

## Real test result

The NSIS installer was installed silently to the default per-user location,
the uninstaller was run silently, and the check was executed before and after
on Windows 11. The test caught a leftover install-location key under
`HKCU\Software\Pandu contributors`, which the uninstaller now removes. The
final run passed with no leftover protocol handler, shortcut, task, service,
autostart value, uninstall entry, install directory, or vendor registry key, and
it kept `%USERPROFILE%\.pandu`, as designed. The result is recorded in
[`../BENCHMARKS.md`](../BENCHMARKS.md#uninstall-hygiene) with the exact commands.

The interactive "Delete that folder as well?" prompt is not automated; silent
uninstalls always keep the data folder and that is the path tested here.
