import { describe, expect, it } from 'vitest';

import {
  RedactionCollector,
  redactHeaders,
  redactJson,
  redactText,
} from '../src/recording/redact.js';

describe('redaction', () => {
  it('redacts sensitive headers case-insensitively and counts occurrences', () => {
    const collector = new RedactionCollector();

    const redacted = redactHeaders(
      {
        Authorization: 'Bearer sk-real-secret',
        'X-Api-Key': 'key-value',
        Cookie: 'session=abc',
        'content-type': 'application/json',
      },
      collector,
      'request_headers',
    );

    expect(redacted).toEqual({
      authorization: '[REDACTED]',
      'x-api-key': '[REDACTED]',
      cookie: '[REDACTED]',
      'content-type': 'application/json',
    });
    expect(collector.total('request_headers')).toBe(3);
    expect(collector.rows()).toContainEqual({
      ruleId: 'sensitive-header',
      label: 'Sensitive header: authorization',
      location: 'request_headers',
      occurrences: 1,
    });
  });

  it('redacts nested sensitive fields without changing other values', () => {
    const collector = new RedactionCollector();

    const redacted = redactJson(
      {
        model: 'gpt-4o-mini',
        api_key: 'value-that-must-not-survive',
        nested: {
          password: 'hunter2',
          note: 'keep this',
        },
        messages: [{ role: 'user', content: 'hello' }],
      },
      collector,
      'request_body',
    );

    expect(redacted).toEqual({
      model: 'gpt-4o-mini',
      api_key: '[REDACTED]',
      nested: {
        password: '[REDACTED]',
        note: 'keep this',
      },
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(collector.total('request_body')).toBe(2);
  });

  it('redacts known secret patterns in free text and counts every match', () => {
    const collector = new RedactionCollector();
    const openAiKey = `sk-${'a'.repeat(32)}`;
    const anthropicKey = `sk-ant-${'b'.repeat(32)}`;

    const redacted = redactText(
      `keys: ${openAiKey} and ${anthropicKey} and ${openAiKey}`,
      collector,
      'response_body',
    );

    expect(redacted).not.toContain(openAiKey);
    expect(redacted).not.toContain(anthropicKey);
    expect(redacted).toContain('[REDACTED:OpenAI API key]');
    expect(redacted).toContain('[REDACTED:Anthropic API key]');
    expect(collector.total('response_body')).toBe(3);
  });

  it('keeps per-location totals separate', () => {
    const collector = new RedactionCollector();
    collector.record('request_headers', 'sensitive-header', 'Authorization');
    collector.record('response_headers', 'sensitive-header', 'Set-Cookie');
    collector.record('response_body', 'openai-api-key', 'OpenAI API key', 2);

    expect(collector.total('request_headers')).toBe(1);
    expect(collector.total('response_headers')).toBe(1);
    expect(collector.total('response_body')).toBe(2);
    expect(collector.total()).toBe(4);
  });
});
