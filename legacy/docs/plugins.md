# Plugin guide

Cockpit plugins are local programs that read a recorded session and return a
JSON result. They are explicit: a plugin never runs at install time, never
intercepts live traffic, and never receives provider keys.

## Manifest

A plugin is a directory containing `cockpit-plugin.json` and an entry file:

```json
{
  "apiVersion": 1,
  "name": "todo-ratio",
  "version": "1.0.0",
  "description": "Count TODO comments introduced by AI-authored changes.",
  "kind": "analyzer",
  "entry": "index.mjs",
  "permissions": []
}
```

| Field         | Rules                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------- |
| `apiVersion`  | Must be `1`. Defaults to `1`.                                                            |
| `name`        | Lowercase letters, numbers, dots, underscores, and dashes. Must be unique.               |
| `version`     | Free-form string, up to 50 characters. Reinstalling the same name updates it.            |
| `description` | Optional, up to 2,000 characters.                                                        |
| `kind`        | `guard` or `analyzer`.                                                                   |
| `entry`       | Relative path to a file inside the plugin directory. Symlinks that escape are rejected.  |
| `permissions` | Optional labels for your own documentation. Cockpit does not grant capabilities from it. |

## Input contract

Cockpit starts `node <entry>` with the plugin directory as the working
directory, writes one JSON object to stdin, and closes stdin. The payload is
capped so a large session cannot exhaust memory:

```json
{
  "apiVersion": 1,
  "plugin": {
    "name": "todo-ratio",
    "version": "1.0.0",
    "kind": "analyzer",
    "permissions": []
  },
  "session": { "id": "...", "title": "...", "totals": { "...": "..." } },
  "steps": [
    {
      "id": "...",
      "seq": 0,
      "kind": "model",
      "status": "completed",
      "request": { "protocol": "openai", "method": "POST", "path": "/v1/chat/completions" },
      "response": { "status": 200, "finishReason": "stop", "text": "..." },
      "usage": { "inputTokens": 0, "outputTokens": 0 },
      "toolCalls": [{ "name": "edit", "status": "completed", "filePaths": ["src/a.ts"] }]
    }
  ],
  "provenance": [],
  "guardEvents": [],
  "understanding": []
}
```

Limits: 200 steps, 100 tool calls per step, 4,000 prompt characters, 20,000
response characters, 10,000 tool-input characters, 500 provenance entries, 200
guard events, and 200 understanding files. Truncated values are marked.

## Output contract

Write JSON to stdout. It is stored as the run result and shown in the dashboard:

```json
{
  "todos": 3,
  "files": ["src/api/checkout.ts"],
  "summary": "Three TODOs were introduced in the checkout change."
}
```

- Exit code `0` with valid JSON → `ok`.
- Exit code `0` with plain text → `ok`, stored as `{ "text": "..." }`.
- Non-zero exit code → `error`; stderr and stdout are captured in the run.
- More than 15 seconds → `timeout`.
- More than 1 MB on stdout → `error`.

## Example analyzer

`index.mjs`:

```js
import { readFileSync } from 'node:fs';

const payload = JSON.parse(readFileSync(0, 'utf8'));
const changedFiles = new Set(
  payload.steps.flatMap((step) => step.toolCalls.flatMap((call) => call.filePaths)),
);

process.stdout.write(
  JSON.stringify({
    changedFiles: [...changedFiles],
    stepCount: payload.steps.length,
    summary: `${payload.steps.length} steps touched ${changedFiles.size} files.`,
  }),
);
```

Install and run it:

```bash
cockpit plugins install ./todo-ratio
cockpit plugins list
cockpit plugins run <pluginId> --session <sessionId>
cockpit plugins runs <pluginId>
```

Pass `--step <stepId>` to stop the payload at a specific step. This is useful
for analyzers that answer "what did the agent know at this point?".

## Guard plugins

A `guard` plugin is an on-demand analyzer with a guard-shaped result. It does
not pause a live request. Live pauses come from guard rules in the daemon
(`builtin-*` or user rules managed on the Guards page). Use a guard plugin when
you want a repeatable audit over a finished session, for example a policy check
that must run before a handoff.

## Security model

- The plugin runs as the same operating-system user as the daemon.
- The environment is reduced to `PATH`, system variables, and temporary
  directories. Provider keys and `COCKPIT_*` secrets are not passed.
- The entry file must resolve inside the plugin directory at install time and
  at run time. Escaping symlinks are rejected.
- Output is capped and the process is killed after the timeout.
- Plugins are not a sandbox. A malicious plugin can still read files your user
  can read. Install only code you trust.

## Removing a plugin

```bash
cockpit plugins remove <pluginId>
```

Removing a plugin deletes its record and run history. It does not delete the
source directory on disk.
