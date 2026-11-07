<!--
  Keep pull requests focused. Read CONTRIBUTING.md before opening this.
  Do not include API keys, device tokens, or unredacted prompts.
-->

## Summary

<!-- What user-visible problem does this solve? One or two paragraphs. -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor (no behavior change)
- [ ] Documentation
- [ ] Build, CI, or packaging
- [ ] Security hardening

## Related issues

<!-- Closes #123 -->

## How it was tested

<!--
  List the exact commands you ran. For UI changes, include the viewport,
  keyboard path, and a screenshot when possible. For proxy changes, include the
  provider and whether the response streamed.
-->

```text
pnpm build
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
```

## Checklist

- [ ] I read [CONTRIBUTING.md](../CONTRIBUTING.md) and the relevant docs.
- [ ] The change is narrow and does not include unrelated refactors.
- [ ] New behavior has a regression test; a bug fix has a test that failed before.
- [ ] Every external boundary is validated with Zod and `any` is not used.
- [ ] SSE responses are still streamed without buffering.
- [ ] No telemetry, hosted service, or fake data outside demo mode was added.
- [ ] UI changes work with a keyboard and have accessible names and visible focus.
- [ ] I updated the README or docs for any command, route, or configuration change.
- [ ] I removed secrets and private prompt content from logs and screenshots.

## Breaking changes or limitations

<!-- Describe migrations, changed defaults, or anything a user must know. -->
