import { ProviderIdSchema, type AgentInfo } from '@cockpit/core';

const AGENT_PATTERNS: ReadonlyArray<{ pattern: RegExp; name: string }> = [
  { pattern: /claude[-\s]?code/i, name: 'Claude Code' },
  { pattern: /opencode/i, name: 'OpenCode' },
  { pattern: /codex/i, name: 'Codex' },
  { pattern: /cursor/i, name: 'Cursor' },
  { pattern: /cline/i, name: 'Cline' },
  { pattern: /roo[-\s]?code/i, name: 'Roo Code' },
  { pattern: /aider/i, name: 'Aider' },
  { pattern: /continue/i, name: 'Continue' },
  { pattern: /windsurf/i, name: 'Windsurf' },
  { pattern: /gemini[-\s]?cli/i, name: 'Gemini CLI' },
  { pattern: /goose/i, name: 'Goose' },
  { pattern: /zed/i, name: 'Zed' },
];

export function detectAgent(headers: Headers): AgentInfo | undefined {
  const explicitName = headers.get('x-cockpit-agent-name')?.trim();
  const explicitVersion = headers.get('x-cockpit-agent-version')?.trim();
  const userAgent = headers.get('user-agent')?.trim();

  if (explicitName) {
    return {
      name: explicitName.slice(0, 100),
      ...(explicitVersion ? { version: explicitVersion.slice(0, 100) } : {}),
      ...(userAgent ? { userAgent: userAgent.slice(0, 500) } : {}),
      detectedFrom: 'headers',
    };
  }

  if (!userAgent) return undefined;
  for (const candidate of AGENT_PATTERNS) {
    if (!candidate.pattern.test(userAgent)) continue;
    return {
      name: candidate.name,
      userAgent: userAgent.slice(0, 500),
      detectedFrom: 'headers',
    };
  }

  return undefined;
}

export function providerOverride(headers: Headers): string | undefined {
  const value = headers.get('x-cockpit-provider')?.trim().toLowerCase();
  if (!value) return undefined;
  const parsed = ProviderIdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
