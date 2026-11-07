import {
  JsonValueSchema,
  ZERO_USAGE,
  isRecord,
  normalizeUsage,
  type FinishReason,
  type JsonValue,
  type ProviderProtocol,
  type StreamChunkKind,
  type TokenUsage,
} from '@cockpit/core';

import { MAX_RESPONSE_CHARS } from '../recording/text.js';
import type { SseEvent } from './parser.js';

const MAX_THINKING_CHARS = 2_000_000;
const MAX_TOOL_ARGUMENT_CHARS = 2_000_000;

export interface ParsedToolCall {
  providerToolCallId?: string;
  name: string;
  input?: JsonValue;
}

export interface CollectedResponse {
  text: string;
  thinking: string;
  usage: TokenUsage;
  finishReason?: FinishReason;
  toolCalls: ParsedToolCall[];
  model?: string;
  error?: string;
}

export interface IngestedEvent {
  kind: StreamChunkKind;
  deltaText?: string;
}

interface ToolCallAccumulator {
  id?: string;
  name: string;
  argumentsText: string;
  initialInput?: JsonValue;
  finalized: boolean;
}

function emptyCollectedResponse(): CollectedResponse {
  return {
    text: '',
    thinking: '',
    usage: { ...ZERO_USAGE },
    toolCalls: [],
  };
}

function appendLimited(current: string, addition: string, maximum: number): string {
  if (addition.length === 0 || current.length >= maximum) return current;
  const remaining = maximum - current.length;
  return current + addition.slice(0, remaining);
}

function mergeUsage(base: TokenUsage, update: TokenUsage): TokenUsage {
  return {
    inputTokens: update.inputTokens > 0 ? update.inputTokens : base.inputTokens,
    outputTokens: update.outputTokens > 0 ? update.outputTokens : base.outputTokens,
    cacheReadTokens: update.cacheReadTokens > 0 ? update.cacheReadTokens : base.cacheReadTokens,
    cacheWriteTokens: update.cacheWriteTokens > 0 ? update.cacheWriteTokens : base.cacheWriteTokens,
    reasoningTokens: update.reasoningTokens > 0 ? update.reasoningTokens : base.reasoningTokens,
  };
}

export function mapOpenAiFinishReason(value: unknown): FinishReason | undefined {
  switch (value) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    case 'error':
      return 'error';
    case null:
    case undefined:
      return undefined;
    default:
      return 'unknown';
  }
}

export function mapAnthropicFinishReason(value: unknown): FinishReason | undefined {
  switch (value) {
    case 'end_turn':
    case 'stop_sequence':
    case 'pause_turn':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    case null:
    case undefined:
      return undefined;
    default:
      return 'unknown';
  }
}

function parseJsonValue(text: string): JsonValue | undefined {
  if (text.trim().length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    const validated = JsonValueSchema.safeParse(parsed);
    return validated.success ? validated.data : text;
  } catch {
    return text;
  }
}

function contentPartText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';

  const pieces: string[] = [];
  for (const part of value) {
    if (!isRecord(part)) continue;
    const text = part['text'];
    if (typeof text === 'string') {
      pieces.push(text);
      continue;
    }
    const refusal = part['refusal'];
    if (typeof refusal === 'string') {
      pieces.push(refusal);
    }
  }
  return pieces.join('');
}

function toolCallsFromOpenAiMessage(message: Record<string, unknown>): ParsedToolCall[] {
  const rawToolCalls = message['tool_calls'];
  if (!Array.isArray(rawToolCalls)) return [];

  const calls: ParsedToolCall[] = [];
  for (const rawCall of rawToolCalls) {
    if (!isRecord(rawCall)) continue;
    const fn = isRecord(rawCall['function']) ? rawCall['function'] : undefined;
    const name = fn && typeof fn['name'] === 'string' ? fn['name'] : undefined;
    if (!name) continue;
    const id = typeof rawCall['id'] === 'string' ? rawCall['id'] : undefined;
    const argumentsValue = fn?.['arguments'];
    const input =
      typeof argumentsValue === 'string'
        ? parseJsonValue(argumentsValue)
        : argumentsValue === undefined
          ? undefined
          : JsonValueSchema.safeParse(argumentsValue).success
            ? (argumentsValue as JsonValue)
            : undefined;

    calls.push({
      ...(id ? { providerToolCallId: id } : {}),
      name,
      ...(input === undefined ? {} : { input }),
    });
  }

  return calls;
}

function toolCallsFromAnthropicContent(content: unknown[]): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  for (const block of content) {
    if (!isRecord(block) || block['type'] !== 'tool_use') continue;
    const name = block['name'];
    if (typeof name !== 'string' || name.length === 0) continue;
    const id = typeof block['id'] === 'string' ? block['id'] : undefined;
    const inputValidated = JsonValueSchema.safeParse(block['input']);
    calls.push({
      ...(id ? { providerToolCallId: id } : {}),
      name,
      ...(inputValidated.success ? { input: inputValidated.data } : {}),
    });
  }
  return calls;
}

function toolCallsFromOpenAiOutput(output: unknown): ParsedToolCall[] {
  if (!Array.isArray(output)) return [];

  const calls: ParsedToolCall[] = [];
  for (const item of output) {
    if (!isRecord(item) || item['type'] !== 'function_call') continue;
    const name = item['name'];
    if (typeof name !== 'string' || name.length === 0) continue;
    const id = typeof item['call_id'] === 'string' ? item['call_id'] : undefined;
    const args = item['arguments'];
    const input =
      typeof args === 'string'
        ? parseJsonValue(args)
        : args === undefined
          ? undefined
          : JsonValueSchema.safeParse(args).success
            ? (args as JsonValue)
            : undefined;
    calls.push({
      ...(id ? { providerToolCallId: id } : {}),
      name,
      ...(input === undefined ? {} : { input }),
    });
  }
  return calls;
}

function outputTextFromOpenAiOutput(output: unknown): string {
  if (!Array.isArray(output)) return '';
  const pieces: string[] = [];
  for (const item of output) {
    if (!isRecord(item) || item['type'] !== 'message') continue;
    pieces.push(contentPartText(item['content']));
  }
  return pieces.join('');
}

function reasoningFromOpenAiOutput(output: unknown): string {
  if (!Array.isArray(output)) return '';
  const pieces: string[] = [];
  for (const item of output) {
    if (!isRecord(item) || item['type'] !== 'reasoning') continue;
    const summary = item['summary'];
    if (!Array.isArray(summary)) continue;
    for (const part of summary) {
      if (isRecord(part) && typeof part['text'] === 'string') {
        pieces.push(part['text']);
      }
    }
  }
  return pieces.join('\n');
}

export class ProtocolCollector {
  readonly #protocol: ProviderProtocol;
  readonly #responsesMode: boolean;
  readonly #toolCalls = new Map<string, ToolCallAccumulator>();
  #text = '';
  #thinking = '';
  #usage: TokenUsage = { ...ZERO_USAGE };
  #finishReason: FinishReason | undefined;
  #model: string | undefined;
  #error: string | undefined;
  #fallbackText = '';
  #fallbackThinking = '';

  constructor(protocol: ProviderProtocol, path: string) {
    this.#protocol = protocol;
    this.#responsesMode = protocol === 'openai' && path.includes('/responses');
  }

  ingest(event: SseEvent): IngestedEvent {
    if (event.data.trim() === '[DONE]') {
      return { kind: 'done' };
    }
    if (event.data.trim().length === 0) {
      return { kind: 'event' };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return { kind: 'event' };
    }
    if (!isRecord(payload)) {
      return { kind: 'event' };
    }

    if (this.#protocol === 'anthropic') {
      return this.#ingestAnthropic(payload, event.event);
    }

    const type = typeof payload['type'] === 'string' ? payload['type'] : undefined;
    if (this.#responsesMode || type?.startsWith('response.') === true) {
      return this.#ingestOpenAiResponses(payload, type);
    }
    return this.#ingestOpenAiChat(payload);
  }

  snapshot(): CollectedResponse {
    const text = this.#text.length > 0 ? this.#text : this.#fallbackText;
    const thinking = this.#thinking.length > 0 ? this.#thinking : this.#fallbackThinking;
    return {
      text,
      thinking,
      usage: this.#usage,
      toolCalls: this.#finalizeToolCalls(),
      ...(this.#finishReason === undefined ? {} : { finishReason: this.#finishReason }),
      ...(this.#model === undefined ? {} : { model: this.#model }),
      ...(this.#error === undefined ? {} : { error: this.#error }),
    };
  }

  #recordUsage(raw: unknown): void {
    this.#usage = mergeUsage(
      this.#usage,
      normalizeUsage(raw, this.#protocol === 'anthropic' ? 'anthropic' : 'openai'),
    );
  }

  #recordToolCallChunk(key: string, call: Record<string, unknown>, delta: string): void {
    let accumulator = this.#toolCalls.get(key);
    if (!accumulator) {
      accumulator = { name: '', argumentsText: '', finalized: false };
      this.#toolCalls.set(key, accumulator);
    }

    const id = typeof call['id'] === 'string' ? call['id'] : undefined;
    if (id) accumulator.id = id;

    const fn = isRecord(call['function']) ? call['function'] : undefined;
    const name = fn && typeof fn['name'] === 'string' ? fn['name'] : undefined;
    if (name) accumulator.name = name;

    const args = fn?.['arguments'];
    if (typeof args === 'string') {
      accumulator.argumentsText = appendLimited(
        accumulator.argumentsText,
        args,
        MAX_TOOL_ARGUMENT_CHARS,
      );
    } else if (isRecord(args)) {
      accumulator.initialInput = args as JsonValue;
    }

    if (delta.length > 0) {
      accumulator.argumentsText = appendLimited(
        accumulator.argumentsText,
        delta,
        MAX_TOOL_ARGUMENT_CHARS,
      );
    }
  }

  #ingestOpenAiChat(payload: Record<string, unknown>): IngestedEvent {
    if (isRecord(payload['error'])) {
      const message = payload['error']['message'];
      this.#error = typeof message === 'string' ? message : JSON.stringify(payload['error']);
      this.#finishReason = 'error';
      return { kind: 'event' };
    }

    if (typeof payload['model'] === 'string') {
      this.#model = payload['model'];
    }
    if (payload['usage'] !== undefined) {
      this.#recordUsage(payload['usage']);
    }

    let textDelta = '';
    let thinkingDelta = '';
    let sawToolCall = false;

    const choices = payload['choices'];
    if (Array.isArray(choices)) {
      for (const choice of choices) {
        if (!isRecord(choice)) continue;
        const delta = isRecord(choice['delta'])
          ? choice['delta']
          : isRecord(choice['message'])
            ? choice['message']
            : undefined;
        if (delta) {
          const content = delta['content'];
          if (typeof content === 'string') {
            textDelta = appendLimited(textDelta, content, MAX_RESPONSE_CHARS);
          } else if (Array.isArray(content)) {
            textDelta = appendLimited(textDelta, contentPartText(content), MAX_RESPONSE_CHARS);
          }

          const reasoning = delta['reasoning_content'] ?? delta['reasoning'];
          if (typeof reasoning === 'string') {
            thinkingDelta = appendLimited(thinkingDelta, reasoning, MAX_THINKING_CHARS);
          }

          const toolCalls = delta['tool_calls'];
          if (Array.isArray(toolCalls)) {
            for (const [fallbackIndex, rawCall] of toolCalls.entries()) {
              if (!isRecord(rawCall)) continue;
              const index = typeof rawCall['index'] === 'number' ? rawCall['index'] : fallbackIndex;
              this.#recordToolCallChunk(`chat:${index}`, rawCall, '');
              sawToolCall = true;
            }
          }

          const legacyFunction = delta['function_call'];
          if (isRecord(legacyFunction)) {
            const name = legacyFunction['name'];
            const args = legacyFunction['arguments'];
            const key = 'chat:legacy';
            let accumulator = this.#toolCalls.get(key);
            if (!accumulator) {
              accumulator = { name: '', argumentsText: '', finalized: false };
              this.#toolCalls.set(key, accumulator);
            }
            if (typeof name === 'string') accumulator.name = name;
            if (typeof args === 'string') {
              accumulator.argumentsText = appendLimited(
                accumulator.argumentsText,
                args,
                MAX_TOOL_ARGUMENT_CHARS,
              );
            }
            sawToolCall = true;
          }
        }

        if (typeof choice['finish_reason'] === 'string') {
          this.#finishReason = mapOpenAiFinishReason(choice['finish_reason']);
        }
      }
    }

    this.#text = appendLimited(this.#text, textDelta, MAX_RESPONSE_CHARS);
    this.#thinking = appendLimited(this.#thinking, thinkingDelta, MAX_THINKING_CHARS);

    if (textDelta.length > 0) {
      return { kind: 'text', deltaText: textDelta };
    }
    if (thinkingDelta.length > 0) {
      return { kind: 'thinking', deltaText: thinkingDelta };
    }
    if (sawToolCall) {
      return { kind: 'tool_call' };
    }
    if (payload['usage'] !== undefined) {
      return { kind: 'usage' };
    }
    return { kind: 'event' };
  }

  #toolAccumulatorForKey(key: string): ToolCallAccumulator {
    let accumulator = this.#toolCalls.get(key);
    if (!accumulator) {
      accumulator = { name: '', argumentsText: '', finalized: false };
      this.#toolCalls.set(key, accumulator);
    }
    return accumulator;
  }

  #ingestOpenAiResponses(
    payload: Record<string, unknown>,
    type: string | undefined,
  ): IngestedEvent {
    if (type === 'error' || type === 'response.failed') {
      const error = isRecord(payload['error'])
        ? payload['error']['message']
        : isRecord(payload['response']) && isRecord(payload['response']['error'])
          ? payload['response']['error']['message']
          : undefined;
      this.#error = typeof error === 'string' ? error : 'Upstream response failed';
      this.#finishReason = 'error';
      return { kind: 'event' };
    }

    if (type === 'response.created' && isRecord(payload['response'])) {
      const model = payload['response']['model'];
      if (typeof model === 'string') this.#model = model;
      return { kind: 'event' };
    }

    if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
      const delta = payload['delta'];
      if (typeof delta === 'string') {
        this.#text = appendLimited(this.#text, delta, MAX_RESPONSE_CHARS);
        return { kind: 'text', deltaText: delta };
      }
      return { kind: 'event' };
    }

    if (
      type === 'response.reasoning_summary_text.delta' ||
      type === 'response.reasoning_text.delta'
    ) {
      const delta = payload['delta'];
      if (typeof delta === 'string') {
        this.#thinking = appendLimited(this.#thinking, delta, MAX_THINKING_CHARS);
        return { kind: 'thinking', deltaText: delta };
      }
      return { kind: 'event' };
    }

    if (type === 'response.output_item.added') {
      const item = payload['item'];
      if (isRecord(item) && item['type'] === 'function_call') {
        const key = String(payload['item_id'] ?? item['call_id'] ?? payload['output_index'] ?? '0');
        const accumulator = this.#toolAccumulatorForKey(key);
        if (typeof item['call_id'] === 'string') accumulator.id = item['call_id'];
        if (typeof item['name'] === 'string') accumulator.name = item['name'];
        if (typeof item['arguments'] === 'string' && item['arguments'].length > 0) {
          const parsedInput = parseJsonValue(item['arguments']);
          if (parsedInput !== undefined) accumulator.initialInput = parsedInput;
        }
        return { kind: 'tool_call' };
      }
      return { kind: 'event' };
    }

    if (
      type === 'response.function_call_arguments.delta' ||
      type === 'response.function_call_arguments.done'
    ) {
      const key = String(
        payload['item_id'] ?? payload['call_id'] ?? payload['output_index'] ?? '0',
      );
      const accumulator = this.#toolAccumulatorForKey(key);
      const delta = payload['delta'];
      if (typeof delta === 'string') {
        accumulator.argumentsText = appendLimited(
          accumulator.argumentsText,
          delta,
          MAX_TOOL_ARGUMENT_CHARS,
        );
      }
      const args = payload['arguments'];
      if (typeof args === 'string') {
        accumulator.argumentsText = args;
      }
      return { kind: 'tool_call' };
    }

    if (type === 'response.output_item.done') {
      const item = payload['item'];
      if (isRecord(item) && item['type'] === 'function_call') {
        const key = String(item['call_id'] ?? payload['item_id'] ?? payload['output_index'] ?? '0');
        const accumulator = this.#toolAccumulatorForKey(key);
        if (typeof item['call_id'] === 'string') accumulator.id = item['call_id'];
        if (typeof item['name'] === 'string') accumulator.name = item['name'];
        if (typeof item['arguments'] === 'string') {
          accumulator.argumentsText = item['arguments'];
        }
        return { kind: 'tool_call' };
      }
      return { kind: 'event' };
    }

    if (type === 'response.output_text.done') {
      const text = payload['text'];
      if (typeof text === 'string' && this.#text.length === 0) {
        this.#fallbackText = text;
      }
      return { kind: 'event' };
    }

    if (type === 'response.completed' || type === 'response.incomplete') {
      const response = isRecord(payload['response']) ? payload['response'] : undefined;
      if (!response) {
        this.#finishReason = type === 'response.incomplete' ? 'length' : 'stop';
        return { kind: 'done' };
      }

      if (typeof response['model'] === 'string') this.#model = response['model'];
      if (response['usage'] !== undefined) this.#recordUsage(response['usage']);

      const output = response['output'];
      const outputToolCalls = toolCallsFromOpenAiOutput(output);
      for (const call of outputToolCalls) {
        const key = `output:${call.providerToolCallId ?? call.name}`;
        const accumulator = this.#toolAccumulatorForKey(key);
        if (call.providerToolCallId) accumulator.id = call.providerToolCallId;
        accumulator.name = call.name;
        if (call.input !== undefined) accumulator.initialInput = call.input;
        accumulator.argumentsText = '';
      }

      this.#fallbackText = appendLimited(
        this.#fallbackText,
        outputTextFromOpenAiOutput(output),
        MAX_RESPONSE_CHARS,
      );
      this.#fallbackThinking = appendLimited(
        this.#fallbackThinking,
        reasoningFromOpenAiOutput(output),
        MAX_THINKING_CHARS,
      );

      if (type === 'response.incomplete') {
        this.#finishReason = 'length';
      } else if (this.#toolCalls.size > 0) {
        this.#finishReason = 'tool_calls';
      } else {
        this.#finishReason = 'stop';
      }
      return { kind: 'done' };
    }

    return { kind: 'event' };
  }

  #ingestAnthropic(payload: Record<string, unknown>, eventName: string | undefined): IngestedEvent {
    const type = typeof payload['type'] === 'string' ? payload['type'] : (eventName ?? 'unknown');

    if (type === 'error') {
      const error = isRecord(payload['error']) ? payload['error']['message'] : undefined;
      this.#error = typeof error === 'string' ? error : 'Anthropic stream error';
      this.#finishReason = 'error';
      return { kind: 'event' };
    }

    if (type === 'message_start') {
      const message = isRecord(payload['message']) ? payload['message'] : undefined;
      if (message) {
        if (typeof message['model'] === 'string') this.#model = message['model'];
        if (message['usage'] !== undefined) this.#recordUsage(message['usage']);
      }
      return { kind: 'event' };
    }

    if (type === 'content_block_start') {
      const index = typeof payload['index'] === 'number' ? payload['index'] : 0;
      const block = isRecord(payload['content_block']) ? payload['content_block'] : undefined;
      if (!block) return { kind: 'event' };

      if (block['type'] === 'tool_use') {
        const accumulator = this.#toolAccumulatorForKey(`anthropic:${index}`);
        if (typeof block['id'] === 'string') accumulator.id = block['id'];
        if (typeof block['name'] === 'string') accumulator.name = block['name'];
        const initial = JsonValueSchema.safeParse(block['input']);
        if (initial.success) accumulator.initialInput = initial.data;
        return { kind: 'tool_call' };
      }

      if (
        block['type'] === 'text' &&
        typeof block['text'] === 'string' &&
        block['text'].length > 0
      ) {
        this.#text = appendLimited(this.#text, block['text'], MAX_RESPONSE_CHARS);
        return { kind: 'text', deltaText: block['text'] };
      }
      if (
        block['type'] === 'thinking' &&
        typeof block['thinking'] === 'string' &&
        block['thinking'].length > 0
      ) {
        this.#thinking = appendLimited(this.#thinking, block['thinking'], MAX_THINKING_CHARS);
        return { kind: 'thinking', deltaText: block['thinking'] };
      }
      return { kind: 'event' };
    }

    if (type === 'content_block_delta') {
      const index = typeof payload['index'] === 'number' ? payload['index'] : 0;
      const delta = isRecord(payload['delta']) ? payload['delta'] : undefined;
      if (!delta) return { kind: 'event' };

      const deltaType = delta['type'];
      if (deltaType === 'text_delta' && typeof delta['text'] === 'string') {
        this.#text = appendLimited(this.#text, delta['text'], MAX_RESPONSE_CHARS);
        return { kind: 'text', deltaText: delta['text'] };
      }
      if (deltaType === 'thinking_delta' && typeof delta['thinking'] === 'string') {
        this.#thinking = appendLimited(this.#thinking, delta['thinking'], MAX_THINKING_CHARS);
        return { kind: 'thinking', deltaText: delta['thinking'] };
      }
      if (deltaType === 'input_json_delta' && typeof delta['partial_json'] === 'string') {
        const accumulator = this.#toolAccumulatorForKey(`anthropic:${index}`);
        accumulator.argumentsText = appendLimited(
          accumulator.argumentsText,
          delta['partial_json'],
          MAX_TOOL_ARGUMENT_CHARS,
        );
        return { kind: 'tool_call' };
      }
      return { kind: 'event' };
    }

    if (type === 'content_block_stop') {
      return { kind: 'event' };
    }

    if (type === 'message_delta') {
      const delta = isRecord(payload['delta']) ? payload['delta'] : undefined;
      if (delta && typeof delta['stop_reason'] === 'string') {
        this.#finishReason = mapAnthropicFinishReason(delta['stop_reason']);
      }
      if (payload['usage'] !== undefined) this.#recordUsage(payload['usage']);
      return { kind: 'usage' };
    }

    if (type === 'message_stop') {
      return { kind: 'done' };
    }

    return { kind: 'event' };
  }

  #finalizeToolCalls(): ParsedToolCall[] {
    const result: ParsedToolCall[] = [];

    for (const accumulator of this.#toolCalls.values()) {
      if (accumulator.finalized) continue;
      accumulator.finalized = true;
      if (accumulator.name.trim().length === 0) continue;

      const parsedArguments = parseJsonValue(accumulator.argumentsText);
      const input = parsedArguments !== undefined ? parsedArguments : accumulator.initialInput;

      result.push({
        ...(accumulator.id ? { providerToolCallId: accumulator.id } : {}),
        name: accumulator.name,
        ...(input === undefined ? {} : { input }),
      });
    }

    return result;
  }
}

export function collectNonStreamResponse(
  protocol: ProviderProtocol,
  path: string,
  body: JsonValue,
): CollectedResponse {
  if (!isRecord(body)) {
    return emptyCollectedResponse();
  }

  if (protocol === 'anthropic') {
    return collectAnthropicResponse(body);
  }
  if (path.includes('/responses') || body['object'] === 'response') {
    return collectOpenAiResponsesResponse(body);
  }
  return collectOpenAiChatResponse(body);
}

function collectOpenAiChatResponse(body: Record<string, unknown>): CollectedResponse {
  const result = emptyCollectedResponse();
  if (isRecord(body['error'])) {
    const message = body['error']['message'];
    result.error = typeof message === 'string' ? message : JSON.stringify(body['error']);
    result.finishReason = 'error';
    return result;
  }

  if (typeof body['model'] === 'string') result.model = body['model'];
  result.usage = normalizeUsage(body['usage'], 'openai');

  const choices = body['choices'];
  if (Array.isArray(choices) && choices.length > 0) {
    const choice = choices[0];
    if (isRecord(choice)) {
      const message = isRecord(choice['message']) ? choice['message'] : {};
      result.text = contentPartText(message['content']);
      const reasoning = message['reasoning_content'] ?? message['reasoning'];
      if (typeof reasoning === 'string') result.thinking = reasoning;
      result.toolCalls = toolCallsFromOpenAiMessage(message);
      const finishReason = mapOpenAiFinishReason(choice['finish_reason']);
      if (finishReason !== undefined) result.finishReason = finishReason;
    }
  }

  return result;
}

function collectOpenAiResponsesResponse(body: Record<string, unknown>): CollectedResponse {
  const result = emptyCollectedResponse();
  if (body['status'] === 'failed' || isRecord(body['error'])) {
    const error = isRecord(body['error']) ? body['error']['message'] : undefined;
    result.error = typeof error === 'string' ? error : 'Upstream response failed';
    result.finishReason = 'error';
  }

  if (typeof body['model'] === 'string') result.model = body['model'];
  result.usage = normalizeUsage(body['usage'], 'openai');

  const output = body['output'];
  result.text = outputTextFromOpenAiOutput(output);
  if (result.text.length === 0 && typeof body['output_text'] === 'string') {
    result.text = body['output_text'];
  }
  result.thinking = reasoningFromOpenAiOutput(output);
  result.toolCalls = toolCallsFromOpenAiOutput(output);

  if (body['status'] === 'incomplete') {
    result.finishReason = 'length';
  } else if (result.toolCalls.length > 0) {
    result.finishReason = 'tool_calls';
  } else if (body['status'] === 'completed') {
    result.finishReason = 'stop';
  }

  return result;
}

function collectAnthropicResponse(body: Record<string, unknown>): CollectedResponse {
  const result = emptyCollectedResponse();

  if (body['type'] === 'error' || isRecord(body['error'])) {
    const error = isRecord(body['error']) ? body['error']['message'] : undefined;
    result.error = typeof error === 'string' ? error : 'Anthropic request failed';
    result.finishReason = 'error';
  }

  if (typeof body['model'] === 'string') result.model = body['model'];
  result.usage = normalizeUsage(body['usage'], 'anthropic');

  const content = body['content'];
  if (Array.isArray(content)) {
    const textPieces: string[] = [];
    const thinkingPieces: string[] = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block['type'] === 'text' && typeof block['text'] === 'string') {
        textPieces.push(block['text']);
      } else if (block['type'] === 'thinking' && typeof block['thinking'] === 'string') {
        thinkingPieces.push(block['thinking']);
      }
    }
    result.text = textPieces.join('');
    result.thinking = thinkingPieces.join('');
    result.toolCalls = toolCallsFromAnthropicContent(content);
  }

  const finishReason = mapAnthropicFinishReason(body['stop_reason']);
  if (finishReason !== undefined) result.finishReason = finishReason;

  return result;
}
