import type { GuardRuleInput } from '@cockpit/core';

export interface BuiltinGuardRule extends GuardRuleInput {
  id: string;
}

/**
 * Built-in rules are deliberately conservative. A false positive that pauses a
 * request is worse than a missed warning, so only unambiguous destructive
 * commands pause by default. Everything else warns and stays visible in the
 * flight log.
 */
export const BUILTIN_GUARD_RULES: readonly BuiltinGuardRule[] = [
  {
    id: 'builtin-secret-private-key',
    name: 'Private key in prompt',
    description:
      'Pauses when a private key block is about to leave the machine. The recorder redacts it either way.',
    kind: 'secret',
    action: 'pause',
    severity: 'critical',
    enabled: true,
    priority: 5,
    config: { patterns: ['private-key'] },
  },
  {
    id: 'builtin-secret-api-key',
    name: 'API key in prompt',
    description:
      'Warns when a recognizable provider token appears in a request. The recorder redacts the value before storage.',
    kind: 'secret',
    action: 'warn',
    severity: 'high',
    enabled: true,
    priority: 10,
    config: {
      patterns: [
        'anthropic-api-key',
        'openai-api-key',
        'github-token',
        'aws-access-key',
        'google-api-key',
        'slack-token',
        'bearer-token',
        'jwt',
      ],
    },
  },
  {
    id: 'builtin-dangerous-command',
    name: 'Destructive command',
    description:
      'Pauses when the newest instruction asks for an irreversible filesystem, database, or pipe-to-shell command.',
    kind: 'dangerous_command',
    action: 'pause',
    severity: 'critical',
    enabled: true,
    priority: 10,
    config: {
      patterns: [
        String.raw`\brm\s+-rf?\s+(?:/|~|\*|\.{1,2})(?:\s|$)`,
        String.raw`\bchmod\s+-R\s+777\b`,
        String.raw`\bmkfs(?:\.\w+)?\b`,
        String.raw`\bdd\s+if=.+\s+of=/dev/`,
        String.raw`\b(?:curl|wget)\s+[^\n|]+\|\s*(?:ba)?sh\b`,
        String.raw`\b(?:shutdown|reboot|halt)\b`,
        String.raw`\bDROP\s+(?:TABLE|DATABASE)\b`,
      ],
    },
  },
  {
    id: 'builtin-egress',
    name: 'Exfiltration endpoint',
    description:
      'Pauses when a prompt mentions a paste, webhook, or tunnel service commonly used to move data out of a workspace.',
    kind: 'egress',
    action: 'pause',
    severity: 'high',
    enabled: true,
    priority: 15,
    config: {
      hosts: [
        'pastebin.com',
        'webhook.site',
        'transfer.sh',
        'ngrok.io',
        'ngrok-free.app',
        'requestbin.net',
        'pipedream.net',
        'beeceptor.com',
        'hookbin.com',
        '0x0.st',
        'file.io',
      ],
    },
  },
  {
    id: 'builtin-git-rewrite',
    name: 'Git history rewrite',
    description: 'Warns on commands that rewrite shared history or discard uncommitted work.',
    kind: 'dangerous_command',
    action: 'warn',
    severity: 'high',
    enabled: true,
    priority: 20,
    config: {
      patterns: [
        String.raw`\bgit\s+reset\s+--hard\b`,
        String.raw`\bgit\s+clean\s+-[a-z]*f`,
        String.raw`\bgit\s+push\s+(?:--force|-f)\b`,
        String.raw`\bgit\s+branch\s+-D\b`,
        String.raw`\bgit\s+commit\s+--amend\b`,
        String.raw`\bgit\s+rebase\s+-i\b`,
        String.raw`\bgit\s+filter-branch\b`,
      ],
    },
  },
  {
    id: 'builtin-release-command',
    name: 'Release or deploy command',
    description: 'Warns before publishing a package, pushing an image, or deploying to production.',
    kind: 'dangerous_command',
    action: 'warn',
    severity: 'medium',
    enabled: true,
    priority: 30,
    config: {
      patterns: [
        String.raw`\bnpm\s+publish\b`,
        String.raw`\bpnpm\s+publish\b`,
        String.raw`\byarn\s+publish\b`,
        String.raw`\bcargo\s+publish\b`,
        String.raw`\bgh\s+release\s+create\b`,
        String.raw`\bdocker\s+push\b`,
        String.raw`\bvercel\s+--prod\b`,
        String.raw`\bnetlify\s+deploy\b`,
      ],
    },
  },
  {
    id: 'builtin-loop',
    name: 'Repeated instruction loop',
    description:
      'Warns when the same instruction is sent repeatedly without progress. Warning only: loops are often legitimate retries.',
    kind: 'loop',
    action: 'warn',
    severity: 'medium',
    enabled: true,
    priority: 50,
    config: {
      threshold: 0.9,
      minOccurrences: 3,
      window: 10,
    },
  },
];
