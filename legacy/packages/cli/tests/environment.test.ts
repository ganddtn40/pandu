import { describe, expect, it } from 'vitest';
import { PROXY_KEY_SENTINEL } from '@cockpit/daemon';

import { buildAgentEnvironment } from '../src/environment.js';

describe('buildAgentEnvironment', () => {
  it('points OpenAI and Anthropic clients at the explicit session', () => {
    const result = buildAgentEnvironment({
      baseUrl: 'http://127.0.0.1:4317/',
      sessionId: '11111111-1111-4111-8111-111111111111',
      sourceEnv: {},
    });

    expect(result.openaiBaseUrl).toBe(
      'http://127.0.0.1:4317/s/11111111-1111-4111-8111-111111111111/openai/v1',
    );
    expect(result.anthropicBaseUrl).toBe(
      'http://127.0.0.1:4317/s/11111111-1111-4111-8111-111111111111/anthropic',
    );
    expect(result.env).toMatchObject({
      COCKPIT_SESSION_ID: '11111111-1111-4111-8111-111111111111',
      COCKPIT_BASE_URL: 'http://127.0.0.1:4317',
      OPENAI_BASE_URL: result.openaiBaseUrl,
      OPENAI_API_BASE: result.openaiBaseUrl,
      ANTHROPIC_BASE_URL: result.anthropicBaseUrl,
      OPENAI_API_KEY: PROXY_KEY_SENTINEL,
      ANTHROPIC_API_KEY: PROXY_KEY_SENTINEL,
    });
  });

  it('preserves real provider credentials and unrelated variables', () => {
    const result = buildAgentEnvironment({
      baseUrl: 'http://127.0.0.1:4317',
      sessionId: '22222222-2222-4222-8222-222222222222',
      sourceEnv: {
        OPENAI_API_KEY: 'sk-real-openai',
        ANTHROPIC_AUTH_TOKEN: 'real-anthropic-token',
        PATH: 'preserved',
      },
    });

    expect(result.env['OPENAI_API_KEY']).toBe('sk-real-openai');
    expect(result.env['ANTHROPIC_AUTH_TOKEN']).toBe('real-anthropic-token');
    expect(result.env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(result.env['PATH']).toBe('preserved');
  });

  it('treats blank credentials as missing', () => {
    const result = buildAgentEnvironment({
      baseUrl: 'http://127.0.0.1:4317',
      sessionId: '33333333-3333-4333-8333-333333333333',
      sourceEnv: {
        OPENAI_API_KEY: '   ',
        ANTHROPIC_API_KEY: '',
      },
    });

    expect(result.env['OPENAI_API_KEY']).toBe(PROXY_KEY_SENTINEL);
    expect(result.env['ANTHROPIC_API_KEY']).toBe(PROXY_KEY_SENTINEL);
  });

  it('does not mutate the source environment', () => {
    const source: NodeJS.ProcessEnv = { OPENAI_API_KEY: 'sk-real-openai' };
    buildAgentEnvironment({
      baseUrl: 'http://127.0.0.1:4317',
      sessionId: '44444444-4444-4444-8444-444444444444',
      sourceEnv: source,
    });

    expect(source).toEqual({ OPENAI_API_KEY: 'sk-real-openai' });
  });
});
