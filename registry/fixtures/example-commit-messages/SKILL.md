---
name: example-commit-messages
description: Draft a clear Conventional Commits message from a diff.
---

# Commit Message Coach

Use this skill when the user asks for a commit message.

1. Read the staged diff.
2. Summarize the intent, not the file list.
3. Return a Conventional Commits subject line under 72 characters, then a
   short body that explains why the change exists.

Do not run git commands that change the repository. Do not rewrite history.
