import { PROXY_KEY_SENTINEL } from '@cockpit/daemon';

export interface AgentEnvironmentInput {
  baseUrl: string;
  sessionId: string;
  sourceEnv?: NodeJS.ProcessEnv;
}

export interface AgentEnvironment {
  env: NodeJS.ProcessEnv;
  openaiBaseUrl: string;
  anthropicBaseUrl: string;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Point the agent at its explicit Cockpit session without discarding real
 * credentials. The proxy replaces the sentinel with a daemon-side key when one
 * is configured; when a real client key exists it is forwarded untouched.
 */
export function buildAgentEnvironment(input: AgentEnvironmentInput): AgentEnvironment {
  const env: NodeJS.ProcessEnv = { ...(input.sourceEnv ?? process.env) };
  const sessionBase = `${input.baseUrl.replace(/\/+$/, '')}/s/${input.sessionId}`;
  const openaiBaseUrl = `${sessionBase}/openai/v1`;
  const anthropicBaseUrl = `${sessionBase}/anthropic`;

  env['COCKPIT_SESSION_ID'] = input.sessionId;
  env['COCKPIT_BASE_URL'] = input.baseUrl.replace(/\/+$/, '');
  env['OPENAI_BASE_URL'] = openaiBaseUrl;
  env['OPENAI_API_BASE'] = openaiBaseUrl;
  env['ANTHROPIC_BASE_URL'] = anthropicBaseUrl;

  if (nonEmpty(env['OPENAI_API_KEY']) === undefined) {
    env['OPENAI_API_KEY'] = PROXY_KEY_SENTINEL;
  }
  if (
    nonEmpty(env['ANTHROPIC_API_KEY']) === undefined &&
    nonEmpty(env['ANTHROPIC_AUTH_TOKEN']) === undefined
  ) {
    env['ANTHROPIC_API_KEY'] = PROXY_KEY_SENTINEL;
  }

  return { env, openaiBaseUrl, anthropicBaseUrl };
}
