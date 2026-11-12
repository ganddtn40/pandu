## Summary

<!-- What changes, and why? -->

## User-visible effect

<!-- What does a user see or do differently? Write "none" for internal changes. -->

## Tests

<!-- List the commands you ran and anything you could not run. -->

- [ ] `cargo fmt --all -- --check`
- [ ] `cargo clippy --workspace --all-targets -- -D warnings`
- [ ] `cargo test --workspace`
- [ ] `pnpm --dir ui check`
- [ ] `pnpm --dir ui test`
- [ ] `pnpm --dir ui check:i18n`
- [ ] `pnpm --dir ui build`
- [ ] `pnpm --dir ui exec playwright test`

## Checklist

- [ ] The proxy still forwards bytes unchanged and stays fail-open.
- [ ] Remote input is validated and state-changing routes are rate limited.
- [ ] New runtime names, paths, and ids come from `brand.json` or the UI brand module.
- [ ] Adapters are data (TOML + fixture), not hard-coded vendors.
- [ ] Registry changes follow `docs/registry/CONTRIBUTING.md`.
- [ ] Translation placeholders are unchanged and `check:i18n` passes.
- [ ] Documentation and platform claims are still honest.
- [ ] No telemetry, cloud sync, background update ping, or TLS interception was added.
- [ ] Screenshots are attached for visual changes.
- [ ] The change is focused; unrelated refactors are split out.

## Related issues

<!-- Link issues or write "none". -->
