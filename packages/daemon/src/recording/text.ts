import { JsonValueSchema, type JsonValue } from '@cockpit/core';

export const MAX_PROMPT_CHARS = 2_000_000;
export const MAX_RESPONSE_CHARS = 20_000_000;
export const MAX_STREAM_DATA_CHARS = 1_000_000;
export const MAX_STREAM_DELTA_CHARS = 200_000;

export function truncateText(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return value.slice(0, maximum);
}

export interface ParsedJsonBody {
  value?: JsonValue;
  text: string;
  isJson: boolean;
}

export function parseJsonBody(text: string): ParsedJsonBody {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { text: '', isJson: false };
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    const validated = JsonValueSchema.safeParse(parsed);
    if (validated.success) {
      return { value: validated.data, text, isJson: true };
    }
  } catch {
    // Fall through: many providers accept non-JSON bodies, and the proxy must
    // still forward them untouched.
  }

  return { text, isJson: false };
}

export function stringifyForStorage(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}
