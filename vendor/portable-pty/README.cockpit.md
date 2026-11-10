# Vendored `portable-pty`

This directory is a copy of [`portable-pty` 0.9.0](https://crates.io/crates/portable-pty/0.9.0),
patched by Cockpit and wired in through `[patch.crates-io]` in the workspace
`Cargo.toml`.

## Why it is vendored

Cockpit runs every agent inside its own pseudo-terminal. An interrupt from the
session API must reach exactly one agent, as the byte `0x03`, and must never be
delivered as a console control event: a console event can be broadcast to a
process group and kill the daemon, the CLI, or a sibling session.

Two upstream behaviours get in the way:

1. `CreateProcessW` is called without `CREATE_NEW_PROCESS_GROUP`, so the agent
   shares the host console's process group.
2. There is no way to ask the crate for a different process-creation flag.

## The patch

`src/win/psuedocon.rs` adds `CREATE_NEW_PROCESS_GROUP` to the `CreateProcessW`
flags in `PsuedoCon::spawn_command`.

Per Microsoft's documentation, a process created with `CREATE_NEW_PROCESS_GROUP`
has Ctrl+C disabled: the group is not signalled by `GenerateConsoleCtrlEvent`
with `CTRL_C_EVENT`, and the child is not a member of the host's group. That is
the contract Cockpit wants — interrupts are input bytes, never signals.

`PSEUDOCONSOLE_WIN32_INPUT_MODE` is intentionally kept as upstream sets it.
The pseudoconsole still accepts plain VT input, so a single `0x03` byte written
to the PTY is what a terminal would send.

This is the only behavioural change. Keep it that way when refreshing the
vendor copy; see `git diff` against the crate source to confirm.

## Upstream status

The change has not been proposed upstream. If upstream grows a
process-group-isolation option, drop this directory and the
`[patch.crates-io]` entry, then set the flag through that option.

## Licence

Unchanged from upstream: MIT. See `LICENSE.md`.
