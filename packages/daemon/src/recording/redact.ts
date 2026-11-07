import type { JsonValue } from '@cockpit/core';

export type CaptureLocation =
  'request_headers' | 'request_body' | 'response_headers' | 'response_body';

export interface RedactionRow {
  ruleId: string;
  label: string;
  location: CaptureLocation;
  occurrences: number;
}

type MutableRedactionRow = RedactionRow;

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'x-goog-api-key',
  'azure-api-key',
  'cookie',
  'set-cookie',
  'x-amz-security-token',
]);

const SENSITIVE_KEYS = new Set([
  'authorization',
  'proxyauthorization',
  'xapikey',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'clientsecret',
  'clientid',
  'password',
  'passwd',
  'secret',
  'token',
  'privatekey',
  'sessiontoken',
  'bearertoken',
  'awsaccesskeyid',
  'awssecretaccesskey',
]);

export interface SecretPattern {
  ruleId: string;
  label: string;
  pattern: RegExp;
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    ruleId: 'anthropic-api-key',
    label: 'Anthropic API key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    ruleId: 'openai-api-key',
    label: 'OpenAI API key',
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    ruleId: 'github-token',
    label: 'GitHub token',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g,
  },
  {
    ruleId: 'aws-access-key',
    label: 'AWS access key',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    ruleId: 'google-api-key',
    label: 'Google API key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    ruleId: 'slack-token',
    label: 'Slack token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    ruleId: 'private-key',
    label: 'Private key block',
    pattern:
      /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
  {
    ruleId: 'bearer-token',
    label: 'Bearer token',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/gi,
  },
  {
    ruleId: 'jwt',
    label: 'JWT',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
];

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function keyForRow(ruleId: string, label: string, location: CaptureLocation): string {
  return `${ruleId}\u0000${label}\u0000${location}`;
}

export class RedactionCollector {
  readonly #rows = new Map<string, MutableRedactionRow>();

  record(location: CaptureLocation, ruleId: string, label: string, occurrences = 1): void {
    if (occurrences <= 0) return;
    const key = keyForRow(ruleId, label, location);
    const existing = this.#rows.get(key);
    if (existing) {
      existing.occurrences += occurrences;
      return;
    }
    this.#rows.set(key, { ruleId, label, location, occurrences });
  }

  total(location?: CaptureLocation): number {
    let total = 0;
    for (const row of this.#rows.values()) {
      if (location === undefined || row.location === location) {
        total += row.occurrences;
      }
    }
    return total;
  }

  rows(): RedactionRow[] {
    return [...this.#rows.values()].map((row) => ({ ...row }));
  }
}

function redactString(
  value: string,
  collector: RedactionCollector,
  location: CaptureLocation,
): string {
  let result = value;

  for (const rule of SECRET_PATTERNS) {
    result = result.replace(rule.pattern, () => {
      collector.record(location, rule.ruleId, rule.label);
      return `[REDACTED:${rule.label}]`;
    });
  }

  return result;
}

export function redactHeaders(
  headers: Readonly<Record<string, string>>,
  collector: RedactionCollector,
  location: CaptureLocation,
): Record<string, string> {
  const redacted: Record<string, string> = {};

  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.toLowerCase();
    if (SENSITIVE_HEADERS.has(lowerName)) {
      collector.record(location, 'sensitive-header', `Sensitive header: ${lowerName}`);
      redacted[lowerName] = '[REDACTED]';
      continue;
    }
    redacted[lowerName] = redactString(value, collector, location);
  }

  return redacted;
}

function redactObject(
  value: Record<string, JsonValue>,
  collector: RedactionCollector,
  location: CaptureLocation,
): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};

  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(normalizedKey(key))) {
      collector.record(location, 'sensitive-field', `Sensitive field: ${key}`);
      result[key] = '[REDACTED]';
      continue;
    }
    result[key] = redactJson(child, collector, location);
  }

  return result;
}

export function redactJson(
  value: JsonValue,
  collector: RedactionCollector,
  location: CaptureLocation,
): JsonValue {
  if (typeof value === 'string') {
    return redactString(value, collector, location);
  }
  if (Array.isArray(value)) {
    return value.map((child) => redactJson(child, collector, location));
  }
  if (value !== null && typeof value === 'object') {
    return redactObject(value, collector, location);
  }
  return value;
}

export function redactText(
  value: string,
  collector: RedactionCollector,
  location: CaptureLocation,
): string {
  return redactString(value, collector, location);
}
