import type { GuardAction, JsonValue, SecretFinding } from '@cockpit/core';

import { SECRET_PATTERNS, type CaptureLocation } from '../recording/redact.js';
import type { Store } from '../store/store.js';

export interface SecretScanHit {
  type: string;
  label: string;
  confidence: number;
  preview: string;
  location: CaptureLocation;
}

export interface SecretScannerOptions {
  store: Store;
  actionFor: (type: string) => GuardAction;
}

const CONFIDENCE: Readonly<Record<string, number>> = {
  'private-key': 0.99,
  'anthropic-api-key': 0.97,
  'openai-api-key': 0.95,
  'github-token': 0.95,
  'aws-access-key': 0.95,
  'google-api-key': 0.95,
  'slack-token': 0.9,
  jwt: 0.8,
  'bearer-token': 0.7,
};

function mask(value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes('BEGIN') && trimmed.includes('PRIVATE KEY')) {
    return '-----BEGIN PRIVATE KEY----- [redacted]';
  }
  if (trimmed.length <= 10) return '[redacted]';
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

function scanPatterns(text: string, location: CaptureLocation): SecretScanHit[] {
  if (text.length === 0) return [];
  const hits: SecretScanHit[] = [];

  for (const rule of SECRET_PATTERNS) {
    rule.pattern.lastIndex = 0;
    for (let match = rule.pattern.exec(text); match !== null; match = rule.pattern.exec(text)) {
      const value = match[0];
      if (!value) continue;
      hits.push({
        type: rule.ruleId,
        label: rule.label,
        confidence: CONFIDENCE[rule.ruleId] ?? 0.75,
        preview: mask(value),
        location,
      });
      if (hits.length >= 100) {
        rule.pattern.lastIndex = 0;
        return hits;
      }
    }
    rule.pattern.lastIndex = 0;
  }

  return hits;
}

function stringify(value: JsonValue | undefined): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

/**
 * Secret detection is intentionally deterministic and local. Nothing is sent
 * to a model, and previews are masked before they ever reach the database.
 */
export class SecretScanner {
  readonly #store: Store;
  readonly #actionFor: (type: string) => GuardAction;

  constructor(options: SecretScannerOptions) {
    this.#store = options.store;
    this.#actionFor = options.actionFor;
  }

  scanText(text: string, location: CaptureLocation): SecretScanHit[] {
    return scanPatterns(text, location);
  }

  scanHeaders(
    headers: Readonly<Record<string, string>>,
    location: CaptureLocation,
  ): SecretScanHit[] {
    const hits: SecretScanHit[] = [];
    for (const [name, value] of Object.entries(headers)) {
      hits.push(...scanPatterns(`${name}: ${value}`, location));
    }
    return hits;
  }

  scanSession(sessionId: string): SecretFinding[] {
    const findings: SecretFinding[] = [];
    const seen = new Set<string>();

    const push = (finding: SecretFinding): void => {
      const key = `${finding.type}\u0000${finding.location}\u0000${finding.preview}`;
      if (seen.has(key)) return;
      seen.add(key);
      findings.push(finding);
    };

    for (const row of this.#store.listSessionRedactions(sessionId)) {
      push({
        type: row.ruleId,
        confidence: 1,
        preview: `[redacted by Cockpit: ${row.label}]`,
        location: row.location,
        action: this.#actionFor(row.ruleId),
      });
    }

    for (const step of this.#store.listSteps(sessionId, 1_000_000)) {
      const requestTexts: Array<[string, CaptureLocation]> = [
        [step.request?.promptText ?? '', 'request_body'],
        [step.request?.systemPrompt ?? '', 'request_body'],
        [stringify(step.request?.body), 'request_body'],
      ];
      for (const [text, location] of requestTexts) {
        for (const hit of this.scanText(text, location)) {
          push({
            type: hit.type,
            confidence: hit.confidence,
            preview: hit.preview,
            location: hit.location,
            action: this.#actionFor(hit.type),
          });
        }
      }

      const responseTexts: Array<[string, CaptureLocation]> = [
        [step.response?.text ?? '', 'response_body'],
        [step.response?.thinking ?? '', 'response_body'],
      ];
      for (const [text, location] of responseTexts) {
        for (const hit of this.scanText(text, location)) {
          push({
            type: hit.type,
            confidence: hit.confidence,
            preview: hit.preview,
            location: hit.location,
            action: this.#actionFor(hit.type),
          });
        }
      }

      for (const call of this.#store.listToolCalls(step.id)) {
        for (const hit of this.scanText(stringify(call.input), 'response_body')) {
          push({
            type: hit.type,
            confidence: hit.confidence,
            preview: hit.preview,
            location: hit.location,
            action: this.#actionFor(hit.type),
          });
        }
      }
    }

    return findings;
  }
}
