import { isRecord, type JsonValue } from '@cockpit/core';

import { MAX_PROMPT_CHARS, truncateText } from '../recording/text.js';

export interface RequestMetadata {
  model?: string;
  stream: boolean;
  systemPrompt?: string;
  promptText?: string;
}

function contentToText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const pieces: string[] = [];
    for (const part of value) {
      if (typeof part === 'string') {
        pieces.push(part);
        continue;
      }
      if (!isRecord(part)) continue;
      if (typeof part['text'] === 'string') {
        pieces.push(part['text']);
        continue;
      }
      if (typeof part['content'] === 'string') {
        pieces.push(part['content']);
        continue;
      }
      if (part['type'] === 'image' || part['type'] === 'image_url') {
        pieces.push('[image]');
      }
    }
    return pieces.join('\n');
  }
  if (isRecord(value) && typeof value['text'] === 'string') {
    return value['text'];
  }
  return '';
}

function joinBlocks(blocks: string[], maximum: number): string | undefined {
  const nonEmpty = blocks.filter((block) => block.trim().length > 0);
  if (nonEmpty.length === 0) return undefined;
  return truncateText(nonEmpty.join('\n\n'), maximum);
}

function collectOpenAiChat(body: Record<string, unknown>): RequestMetadata {
  const result: RequestMetadata = {
    stream: body['stream'] === true,
  };
  const model = body['model'];
  if (typeof model === 'string' && model.trim().length > 0) result.model = model.trim();

  const systemBlocks: string[] = [];
  const promptBlocks: string[] = [];
  const messages = body['messages'];
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!isRecord(message)) continue;
      const role = typeof message['role'] === 'string' ? message['role'] : 'user';
      const text = contentToText(message['content']);
      if (text.length === 0) continue;
      if (role === 'system' || role === 'developer') {
        systemBlocks.push(text);
      } else {
        promptBlocks.push(`${role}: ${text}`);
      }
    }
  }

  const systemPrompt = joinBlocks(systemBlocks, MAX_PROMPT_CHARS);
  const promptText = joinBlocks(promptBlocks, MAX_PROMPT_CHARS);
  return {
    ...result,
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    ...(promptText === undefined ? {} : { promptText }),
  };
}

function collectOpenAiResponses(body: Record<string, unknown>): RequestMetadata {
  const result: RequestMetadata = {
    stream: body['stream'] === true,
  };
  const model = body['model'];
  if (typeof model === 'string' && model.trim().length > 0) result.model = model.trim();

  const systemBlocks: string[] = [];
  const promptBlocks: string[] = [];

  const instructions = body['instructions'];
  if (typeof instructions === 'string') {
    systemBlocks.push(instructions);
  } else {
    const rendered = contentToText(instructions);
    if (rendered.length > 0) systemBlocks.push(rendered);
  }

  const input = body['input'];
  if (typeof input === 'string') {
    promptBlocks.push(input);
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === 'string') {
        promptBlocks.push(item);
        continue;
      }
      if (!isRecord(item)) continue;
      const role = typeof item['role'] === 'string' ? item['role'] : undefined;
      const text = contentToText(item['content']);
      if (text.length > 0) {
        if (role === 'system' || role === 'developer') {
          systemBlocks.push(text);
        } else {
          promptBlocks.push(role ? `${role}: ${text}` : text);
        }
        continue;
      }
      if (typeof item['output'] === 'string') {
        promptBlocks.push(`tool: ${item['output']}`);
      }
    }
  }

  const messages = body['messages'];
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!isRecord(message)) continue;
      const role = typeof message['role'] === 'string' ? message['role'] : 'user';
      const text = contentToText(message['content']);
      if (text.length === 0) continue;
      if (role === 'system' || role === 'developer') {
        systemBlocks.push(text);
      } else {
        promptBlocks.push(`${role}: ${text}`);
      }
    }
  }

  const systemPrompt = joinBlocks(systemBlocks, MAX_PROMPT_CHARS);
  const promptText = joinBlocks(promptBlocks, MAX_PROMPT_CHARS);
  return {
    ...result,
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    ...(promptText === undefined ? {} : { promptText }),
  };
}

function collectAnthropic(body: Record<string, unknown>): RequestMetadata {
  const result: RequestMetadata = {
    stream: body['stream'] === true,
  };
  const model = body['model'];
  if (typeof model === 'string' && model.trim().length > 0) result.model = model.trim();

  const systemBlocks: string[] = [];
  const promptBlocks: string[] = [];

  const system = body['system'];
  if (typeof system === 'string') {
    systemBlocks.push(system);
  } else if (Array.isArray(system)) {
    const rendered = contentToText(system);
    if (rendered.length > 0) systemBlocks.push(rendered);
  }

  const messages = body['messages'];
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!isRecord(message)) continue;
      const role = typeof message['role'] === 'string' ? message['role'] : 'user';
      const text = contentToText(message['content']);
      if (text.length === 0) continue;
      promptBlocks.push(`${role}: ${text}`);
    }
  }

  const systemPrompt = joinBlocks(systemBlocks, MAX_PROMPT_CHARS);
  const promptText = joinBlocks(promptBlocks, MAX_PROMPT_CHARS);
  return {
    ...result,
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    ...(promptText === undefined ? {} : { promptText }),
  };
}

function lastUserMessage(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message)) continue;
    if (message['role'] !== 'user') continue;
    const text = contentToText(message['content']);
    if (text.trim().length > 0) return truncateText(text, MAX_PROMPT_CHARS);
  }
  return undefined;
}

/**
 * Loop detection needs the newest instruction, not the whole growing history.
 * Sending every prior turn through similarity would make unrelated follow-ups
 * look identical because the transcript prefix is shared.
 */
export function extractLatestUserMessage(
  protocol: 'openai' | 'anthropic',
  path: string,
  body: JsonValue | undefined,
): string | undefined {
  if (!isRecord(body)) return undefined;

  if (protocol === 'anthropic') {
    return lastUserMessage(body['messages']);
  }

  const fromMessages = lastUserMessage(body['messages']);
  if (fromMessages) return fromMessages;

  if (path.includes('/responses') || body['object'] === 'response') {
    const input = body['input'];
    if (typeof input === 'string' && input.trim().length > 0) {
      return truncateText(input, MAX_PROMPT_CHARS);
    }
    return lastUserMessage(input);
  }

  return undefined;
}

export function extractRequestMetadata(
  protocol: 'openai' | 'anthropic',
  path: string,
  body: JsonValue | undefined,
): RequestMetadata {
  if (!isRecord(body)) {
    return { stream: false };
  }

  if (protocol === 'anthropic') {
    return collectAnthropic(body);
  }
  if (path.includes('/responses') || body['object'] === 'response') {
    return collectOpenAiResponses(body);
  }
  return collectOpenAiChat(body);
}
