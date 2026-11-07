import { describe, expect, it } from 'vitest';

import {
  ProtocolCollector,
  collectNonStreamResponse,
  mapAnthropicFinishReason,
  mapOpenAiFinishReason,
  type IngestedEvent,
} from '../src/sse/collector.js';
import { SseParser, type SseEvent } from '../src/sse/parser.js';

function dataEvent(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function namedEvent(name: string, payload: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function parseAll(text: string): SseEvent[] {
  const parser = new SseParser();
  return [...parser.feed(Buffer.from(text, 'utf8')), ...parser.end()];
}

function ingestAll(collector: ProtocolCollector, text: string): IngestedEvent[] {
  return parseAll(text).map((event) => collector.ingest(event));
}

describe('SseParser', () => {
  it('parses events split across arbitrary chunk boundaries', () => {
    const parser = new SseParser();

    expect(parser.feed(Buffer.from('event: message_start\r\ndata: {"type":"mes'))).toEqual([]);
    const events = parser.feed(Buffer.from('sage_start"}\r\n\r\ndata: [DONE]\n\n'));

    expect(events).toHaveLength(2);
    expect(events[0]?.event).toBe('message_start');
    expect(events[0]?.data).toBe('{"type":"message_start"}');
    expect(events[0]?.raw).toBe('event: message_start\r\ndata: {"type":"message_start"}');
    expect(events[1]?.data).toBe('[DONE]');
  });

  it('joins multi-line data and ignores comments', () => {
    const events = parseAll(': keepalive\ndata: first\ndata: second\n\n');
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe('first\nsecond');
  });

  it('emits a trailing event without a final blank line', () => {
    const parser = new SseParser();
    const events = parser.feed(Buffer.from('data: tail'));
    expect(events).toEqual([]);
    expect(parser.end().map((event) => event.data)).toEqual(['tail']);
  });

  it('preserves id and retry fields', () => {
    const events = parseAll('id: 42\nretry: 1500\ndata: value\n\n');
    expect(events[0]?.id).toBe('42');
    expect(events[0]?.retry).toBe(1500);
    expect(events[0]?.data).toBe('value');
  });
});

describe('ProtocolCollector OpenAI chat', () => {
  it('collects text, usage, model, and finish reason from a stream', () => {
    const collector = new ProtocolCollector('openai', '/v1/chat/completions');
    const kinds = ingestAll(
      collector,
      [
        dataEvent({
          id: 'chatcmpl-1',
          object: 'chat.completion.chunk',
          model: 'gpt-4o-mini',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' } }],
        }),
        dataEvent({
          id: 'chatcmpl-1',
          model: 'gpt-4o-mini',
          choices: [{ index: 0, delta: { content: 'lo' } }],
        }),
        dataEvent({
          id: 'chatcmpl-1',
          model: 'gpt-4o-mini',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        }),
        dataEvent({
          id: 'chatcmpl-1',
          model: 'gpt-4o-mini',
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        }),
        'data: [DONE]\n\n',
      ].join(''),
    );

    expect(kinds.map((kind) => kind.kind)).toEqual(['text', 'text', 'event', 'usage', 'done']);
    expect(collector.snapshot()).toEqual({
      text: 'Hello',
      thinking: '',
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
      finishReason: 'stop',
      toolCalls: [],
      model: 'gpt-4o-mini',
    });
  });

  it('accumulates streamed tool call arguments', () => {
    const collector = new ProtocolCollector('openai', '/v1/chat/completions');
    const argumentsJson = JSON.stringify({ path: 'src/a.ts' });

    ingestAll(
      collector,
      [
        dataEvent({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'read_file', arguments: '' },
                  },
                ],
              },
            },
          ],
        }),
        dataEvent({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: 0, function: { arguments: argumentsJson } }],
              },
            },
          ],
        }),
        dataEvent({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
        'data: [DONE]\n\n',
      ].join(''),
    );

    expect(collector.snapshot().toolCalls).toEqual([
      {
        providerToolCallId: 'call_1',
        name: 'read_file',
        input: { path: 'src/a.ts' },
      },
    ]);
    expect(collector.snapshot().finishReason).toBe('tool_calls');
  });

  it('surfaces an upstream error event', () => {
    const collector = new ProtocolCollector('openai', '/v1/chat/completions');
    ingestAll(collector, dataEvent({ error: { message: 'invalid api key' } }));

    const snapshot = collector.snapshot();
    expect(snapshot.error).toBe('invalid api key');
    expect(snapshot.finishReason).toBe('error');
  });
});

describe('ProtocolCollector OpenAI Responses', () => {
  it('collects streamed output text, cached usage, and completion state', () => {
    const collector = new ProtocolCollector('openai', '/v1/responses');

    ingestAll(
      collector,
      [
        dataEvent({
          type: 'response.created',
          response: { id: 'resp_1', model: 'gpt-4.1-mini' },
        }),
        namedEvent('response.output_text.delta', {
          type: 'response.output_text.delta',
          delta: 'Hel',
        }),
        namedEvent('response.output_text.delta', {
          type: 'response.output_text.delta',
          delta: 'lo',
        }),
        namedEvent('response.completed', {
          type: 'response.completed',
          response: {
            id: 'resp_1',
            model: 'gpt-4.1-mini',
            status: 'completed',
            usage: {
              input_tokens: 7,
              output_tokens: 2,
              input_tokens_details: { cached_tokens: 2 },
            },
            output: [{ type: 'message', content: [{ type: 'text', text: 'Hello' }] }],
          },
        }),
      ].join(''),
    );

    expect(collector.snapshot()).toEqual({
      text: 'Hello',
      thinking: '',
      usage: {
        inputTokens: 5,
        outputTokens: 2,
        cacheReadTokens: 2,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
      finishReason: 'stop',
      toolCalls: [],
      model: 'gpt-4.1-mini',
    });
  });
});

describe('ProtocolCollector Anthropic', () => {
  it('collects text, thinking, tool use, usage, and stop reason', () => {
    const collector = new ProtocolCollector('anthropic', '/v1/messages');

    ingestAll(
      collector,
      [
        namedEvent('message_start', {
          type: 'message_start',
          message: {
            id: 'msg_1',
            model: 'claude-sonnet-4',
            usage: {
              input_tokens: 12,
              cache_read_input_tokens: 3,
              cache_creation_input_tokens: 1,
            },
          },
        }),
        namedEvent('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
        namedEvent('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hi' },
        }),
        namedEvent('content_block_start', {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'thinking', thinking: '' },
        }),
        namedEvent('content_block_delta', {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'thinking_delta', thinking: 'hmm' },
        }),
        namedEvent('content_block_start', {
          type: 'content_block_start',
          index: 2,
          content_block: {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'search',
            input: {},
          },
        }),
        namedEvent('content_block_delta', {
          type: 'content_block_delta',
          index: 2,
          delta: { type: 'input_json_delta', partial_json: '{"q":"x"}' },
        }),
        namedEvent('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
          usage: { output_tokens: 5 },
        }),
        namedEvent('message_stop', { type: 'message_stop' }),
      ].join(''),
    );

    expect(collector.snapshot()).toEqual({
      text: 'Hi',
      thinking: 'hmm',
      usage: {
        inputTokens: 12,
        outputTokens: 5,
        cacheReadTokens: 3,
        cacheWriteTokens: 1,
        reasoningTokens: 0,
      },
      finishReason: 'tool_calls',
      toolCalls: [
        {
          providerToolCallId: 'toolu_1',
          name: 'search',
          input: { q: 'x' },
        },
      ],
      model: 'claude-sonnet-4',
    });
  });

  it('surfaces an anthropic stream error', () => {
    const collector = new ProtocolCollector('anthropic', '/v1/messages');
    ingestAll(
      collector,
      namedEvent('error', {
        type: 'error',
        error: { type: 'overloaded_error', message: 'Overloaded' },
      }),
    );

    expect(collector.snapshot().error).toBe('Overloaded');
    expect(collector.snapshot().finishReason).toBe('error');
  });
});

describe('non-stream collection', () => {
  it('reads an OpenAI chat completion with tool calls and cached usage', () => {
    const collected = collectNonStreamResponse('openai', '/v1/chat/completions', {
      id: 'chatcmpl-2',
      model: 'gpt-4o',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'Using a tool.',
            tool_calls: [
              {
                id: 'call_2',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"README.md"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 40 },
      },
    });

    expect(collected.text).toBe('Using a tool.');
    expect(collected.finishReason).toBe('tool_calls');
    expect(collected.usage).toEqual({
      inputTokens: 60,
      outputTokens: 20,
      cacheReadTokens: 40,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    });
    expect(collected.toolCalls).toEqual([
      { providerToolCallId: 'call_2', name: 'read_file', input: { path: 'README.md' } },
    ]);
  });

  it('reads an OpenAI Responses object', () => {
    const collected = collectNonStreamResponse('openai', '/v1/responses', {
      id: 'resp_2',
      object: 'response',
      model: 'gpt-4.1',
      status: 'completed',
      output: [
        {
          type: 'message',
          content: [
            { type: 'output_text', text: 'Final answer' },
            { type: 'refusal', refusal: '' },
          ],
        },
        {
          type: 'function_call',
          call_id: 'call_3',
          name: 'shell',
          arguments: '{"command":"ls"}',
        },
      ],
      usage: { input_tokens: 30, output_tokens: 10 },
    });

    expect(collected.text).toBe('Final answer');
    expect(collected.finishReason).toBe('tool_calls');
    expect(collected.toolCalls).toEqual([
      { providerToolCallId: 'call_3', name: 'shell', input: { command: 'ls' } },
    ]);
  });

  it('reads an Anthropic message with thinking and tool use', () => {
    const collected = collectNonStreamResponse('anthropic', '/v1/messages', {
      id: 'msg_2',
      type: 'message',
      model: 'claude-sonnet-4',
      content: [
        { type: 'thinking', thinking: 'Consider options.' },
        { type: 'text', text: 'Done.' },
        {
          type: 'tool_use',
          id: 'toolu_2',
          name: 'edit_file',
          input: { path: 'src/index.ts' },
        },
      ],
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 50,
        output_tokens: 20,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 5,
      },
    });

    expect(collected.text).toBe('Done.');
    expect(collected.thinking).toBe('Consider options.');
    expect(collected.finishReason).toBe('tool_calls');
    expect(collected.usage).toEqual({
      inputTokens: 50,
      outputTokens: 20,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      reasoningTokens: 0,
    });
    expect(collected.toolCalls).toEqual([
      {
        providerToolCallId: 'toolu_2',
        name: 'edit_file',
        input: { path: 'src/index.ts' },
      },
    ]);
  });

  it('reports provider errors from non-stream bodies', () => {
    const openAiError = collectNonStreamResponse('openai', '/v1/chat/completions', {
      error: { message: 'quota exceeded' },
    });
    expect(openAiError.error).toBe('quota exceeded');
    expect(openAiError.finishReason).toBe('error');

    const anthropicError = collectNonStreamResponse('anthropic', '/v1/messages', {
      type: 'error',
      error: { type: 'invalid_request_error', message: 'bad request' },
    });
    expect(anthropicError.error).toBe('bad request');
    expect(anthropicError.finishReason).toBe('error');
  });
});

describe('finish reason mapping', () => {
  it('maps OpenAI finish reasons', () => {
    expect(mapOpenAiFinishReason('stop')).toBe('stop');
    expect(mapOpenAiFinishReason('length')).toBe('length');
    expect(mapOpenAiFinishReason('function_call')).toBe('tool_calls');
    expect(mapOpenAiFinishReason('content_filter')).toBe('content_filter');
    expect(mapOpenAiFinishReason('surprise')).toBe('unknown');
    expect(mapOpenAiFinishReason(undefined)).toBeUndefined();
  });

  it('maps Anthropic finish reasons', () => {
    expect(mapAnthropicFinishReason('end_turn')).toBe('stop');
    expect(mapAnthropicFinishReason('max_tokens')).toBe('length');
    expect(mapAnthropicFinishReason('tool_use')).toBe('tool_calls');
    expect(mapAnthropicFinishReason('refusal')).toBe('content_filter');
    expect(mapAnthropicFinishReason('surprise')).toBe('unknown');
    expect(mapAnthropicFinishReason(undefined)).toBeUndefined();
  });
});
