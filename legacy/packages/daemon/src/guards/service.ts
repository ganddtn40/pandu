import {
  tokenSimilarity,
  type ApprovalDecision,
  type GuardAction,
  type GuardEvent,
  type GuardEventListQuery,
  type GuardRule,
  type GuardRuleConfig,
  type GuardRuleInput,
  type GuardRulePatch,
  type JsonObject,
  type JsonValue,
  type ProviderProtocol,
  type SecretScanResponse,
} from '@cockpit/core';

import type { LiveEventBus } from '../live/bus.js';
import type { Logger } from '../logger.js';
import { extractLatestUserMessage, extractRequestMetadata } from '../proxy/request-meta.js';
import { parseJsonBody, truncateText } from '../recording/text.js';
import type { Store } from '../store/store.js';
import { ApprovalBroker } from './approval.js';
import { BUILTIN_GUARD_RULES } from './builtin.js';
import { GuardEventRecorder } from './events.js';
import { SecretScanner, type SecretScanHit } from './secrets.js';

export class GuardServiceError extends Error {
  readonly status: number;
  readonly code: 'bad_request' | 'not_found' | 'conflict' | 'forbidden';

  constructor(status: number, code: GuardServiceError['code'], message: string) {
    super(message);
    this.name = 'GuardServiceError';
    this.status = status;
    this.code = code;
  }
}

export interface GuardRequestInput {
  sessionId: string;
  protocol: ProviderProtocol;
  method: string;
  path: string;
  headers: Readonly<Record<string, string>>;
  bodyText: string;
}

export interface GuardRequestResult {
  allowed: boolean;
  status?: number;
  code?: 'guard_blocked';
  message?: string;
  events: GuardEvent[];
}

export interface GuardStepInput {
  sessionId: string;
  stepId: string;
  protocol: ProviderProtocol;
  path: string;
  responseStatus: number;
  responseText?: string;
  responseThinking?: string;
  toolCalls: ReadonlyArray<{ name: string; input?: JsonValue }>;
}

export interface GuardServiceOptions {
  store: Store;
  bus: LiveEventBus;
  logger: Logger;
  approvalTimeoutMs: number;
  broker?: ApprovalBroker;
}

const ACTION_RANK: Readonly<Record<GuardAction, number>> = {
  allow: 0,
  warn: 1,
  redact: 2,
  pause: 3,
  block: 4,
};

function strongestAction(actions: readonly GuardAction[]): GuardAction {
  return actions.reduce<GuardAction>(
    (strongest, action) => (ACTION_RANK[action] > ACTION_RANK[strongest] ? action : strongest),
    'allow',
  );
}

function statusForAction(action: GuardAction): GuardEvent['status'] {
  if (action === 'pause') return 'pending';
  if (action === 'block') return 'blocked';
  if (action === 'redact') return 'redacted';
  return 'warned';
}

function severityForAction(action: GuardAction): GuardEvent['severity'] {
  if (action === 'pause' || action === 'block') return 'critical';
  if (action === 'redact') return 'high';
  return 'medium';
}

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 60);
  const end = Math.min(text.length, index + length + 60);
  return truncateText(text.slice(start, end), 500);
}

function configFor(rule: GuardRule): GuardRuleConfig {
  const config = rule.config;
  const result: GuardRuleConfig = {};
  if (Array.isArray(config['patterns'])) {
    result.patterns = config['patterns'].filter((item): item is string => typeof item === 'string');
  }
  if (Array.isArray(config['terms'])) {
    result.terms = config['terms'].filter((item): item is string => typeof item === 'string');
  }
  if (Array.isArray(config['hosts'])) {
    result.hosts = config['hosts'].filter((item): item is string => typeof item === 'string');
  }
  if (typeof config['threshold'] === 'number') result.threshold = config['threshold'];
  if (typeof config['minOccurrences'] === 'number') {
    result.minOccurrences = Math.max(1, Math.trunc(config['minOccurrences']));
  }
  if (typeof config['window'] === 'number')
    result.window = Math.max(1, Math.trunc(config['window']));
  if (typeof config['flags'] === 'string') result.flags = config['flags'];
  return result;
}

function compilePattern(pattern: string, flags: string): RegExp | undefined {
  try {
    return new RegExp(pattern, flags.includes('g') ? flags : `${flags}g`);
  } catch {
    return undefined;
  }
}

interface TextMatch {
  field: string;
  excerpt: string;
  value: string;
}

function matchRule(rule: GuardRule, texts: ReadonlyArray<[string, string]>): TextMatch[] {
  const config = configFor(rule);
  const matches: TextMatch[] = [];
  const seen = new Set<string>();

  const push = (field: string, excerpt: string, value: string): void => {
    const key = `${field}\u0000${excerpt}`;
    if (seen.has(key)) return;
    seen.add(key);
    matches.push({ field, excerpt, value });
  };

  for (const [field, text] of texts) {
    if (text.length === 0) continue;

    for (const pattern of config.patterns ?? []) {
      const regex = compilePattern(pattern, config.flags ?? 'i');
      if (!regex) continue;
      for (let match = regex.exec(text); match !== null; match = regex.exec(text)) {
        const value = match[0];
        if (value.length === 0) {
          regex.lastIndex += 1;
          continue;
        }
        push(field, excerptAround(text, match.index, value.length), value);
        if (matches.length >= 8) return matches;
      }
    }

    const lower = text.toLowerCase();
    for (const term of config.terms ?? []) {
      const index = lower.indexOf(term.toLowerCase());
      if (index === -1) continue;
      push(field, excerptAround(text, index, term.length), term);
      if (matches.length >= 8) return matches;
    }

    for (const host of config.hosts ?? []) {
      const index = lower.indexOf(host.toLowerCase());
      if (index === -1) continue;
      push(field, excerptAround(text, index, host.length), host);
      if (matches.length >= 8) return matches;
    }
  }

  return matches;
}

function latestUserFromPromptText(promptText: string): string {
  const blocks = promptText.split('\n\n');
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]?.trim();
    if (!block) continue;
    const match = /^(?:user|human):\s*([\s\S]+)$/i.exec(block);
    if (match?.[1]) return match[1].trim();
  }
  return promptText.trim();
}

export class GuardService {
  readonly #store: Store;
  readonly #logger: Logger;
  readonly #approvalTimeoutMs: number;
  readonly #broker: ApprovalBroker;
  readonly #events: GuardEventRecorder;
  readonly #secrets: SecretScanner;
  readonly #loopWarnings = new Map<string, number>();
  readonly #scanTimers = new Map<string, NodeJS.Timeout>();

  constructor(options: GuardServiceOptions) {
    this.#store = options.store;
    this.#logger = options.logger;
    this.#approvalTimeoutMs = options.approvalTimeoutMs;
    this.#broker = options.broker ?? new ApprovalBroker();
    this.#events = new GuardEventRecorder({
      store: options.store,
      bus: options.bus,
      logger: options.logger,
    });
    this.#secrets = new SecretScanner({
      store: options.store,
      actionFor: (type) => this.#actionForSecret(type),
    });
    this.seedBuiltins();
  }

  seedBuiltins(): void {
    for (const rule of BUILTIN_GUARD_RULES) {
      if (this.#store.getGuardRule(rule.id)) continue;
      try {
        this.#store.createGuardRule({ ...rule, source: 'builtin' });
      } catch (error) {
        this.#logger.warn('Cockpit could not seed a built-in guard rule', {
          ruleId: rule.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  listRules(): GuardRule[] {
    return this.#store.listGuardRules();
  }

  createRule(input: GuardRuleInput): GuardRule {
    return this.#store.createGuardRule({ ...input, source: 'user' });
  }

  updateRule(id: string, patch: GuardRulePatch): GuardRule {
    const rule = this.#store.getGuardRule(id);
    if (!rule) throw new GuardServiceError(404, 'not_found', 'The guard rule was not found.');
    if (rule.source === 'builtin' && patch.kind !== undefined && patch.kind !== rule.kind) {
      throw new GuardServiceError(
        409,
        'conflict',
        'A built-in rule cannot change kind. Create a custom rule instead.',
      );
    }
    const updated = this.#store.updateGuardRule(id, patch);
    if (!updated) throw new GuardServiceError(404, 'not_found', 'The guard rule was not found.');
    return updated;
  }

  deleteRule(id: string): void {
    const rule = this.#store.getGuardRule(id);
    if (!rule) throw new GuardServiceError(404, 'not_found', 'The guard rule was not found.');
    if (rule.source === 'builtin') {
      throw new GuardServiceError(409, 'conflict', 'Built-in guard rules cannot be deleted.');
    }
    this.#store.deleteGuardRule(id);
  }

  listEvents(query: GuardEventListQuery): GuardEvent[] {
    return this.#store.listGuardEvents(query);
  }

  pending(sessionId?: string): GuardEvent[] {
    return this.#store.listPendingGuardEvents(sessionId);
  }

  resolveEvent(eventId: string, decision: ApprovalDecision): GuardEvent {
    const event = this.#store.getGuardEvent(eventId);
    if (!event) throw new GuardServiceError(404, 'not_found', 'The guard event was not found.');
    if (event.status !== 'pending') {
      throw new GuardServiceError(409, 'conflict', 'The guard event is no longer pending.');
    }

    const status = decision.decision === 'approve' ? 'approved' : 'denied';
    const updated = this.#events.resolve(
      eventId,
      { status, resolvedAt: new Date() },
      {
        actor: decision.actor ?? decision.channel,
        ...(decision.note ? { note: decision.note } : {}),
      },
    );
    if (!updated) throw new GuardServiceError(404, 'not_found', 'The guard event was not found.');
    this.#broker.resolve(eventId, decision.decision);
    return updated;
  }

  async evaluateRequest(input: GuardRequestInput): Promise<GuardRequestResult> {
    const pending = this.#store.listPendingGuardEvents(input.sessionId);
    if (pending.length > 0) {
      return {
        allowed: false,
        status: 403,
        code: 'guard_blocked',
        message: `Cockpit is holding this session until an approval is resolved: ${pending[0]?.title ?? 'pending guard event'}.`,
        events: [],
      };
    }

    const rules = this.#store.listGuardRules().filter((rule) => rule.enabled);
    const parsed = parseJsonBody(input.bodyText);
    const metadata = extractRequestMetadata(input.protocol, input.path, parsed.value);
    const latestUser =
      extractLatestUserMessage(input.protocol, input.path, parsed.value) ??
      metadata.promptText ??
      '';

    const events: GuardEvent[] = [];

    const secretHits = [
      ...this.#secrets.scanHeaders(input.headers, 'request_headers'),
      ...this.#secrets.scanText(input.bodyText, 'request_body'),
    ];
    events.push(...this.#recordSecretHits(input.sessionId, undefined, secretHits, 'request'));

    const texts: Array<[string, string]> = [
      ['prompt', latestUser],
      ['body', parsed.text],
    ];

    for (const rule of rules) {
      if (rule.kind === 'secret' || rule.kind === 'loop' || rule.kind === 'budget') continue;
      const matches = matchRule(rule, texts);
      if (matches.length === 0) continue;
      events.push(...this.#recordMatches(input.sessionId, undefined, rule, matches, 'request'));
    }

    events.push(...this.#detectLoop(input.sessionId, latestUser, rules));

    const pauseEvents = events.filter((event) => event.action === 'pause');
    for (const event of pauseEvents) {
      const outcome = await this.#broker.waitFor(event.id, this.#approvalTimeoutMs);
      const current = this.#store.getGuardEvent(event.id);
      if (current?.status === 'pending') {
        this.#events.resolve(
          event.id,
          {
            status:
              outcome === 'approved' ? 'approved' : outcome === 'denied' ? 'denied' : 'expired',
            resolvedAt: new Date(),
          },
          {
            actor: 'cockpit',
            ...(outcome === 'expired' ? { note: 'The approval window elapsed.' } : {}),
          },
        );
      }
      if (outcome !== 'approved') {
        return {
          allowed: false,
          status: 403,
          code: 'guard_blocked',
          message:
            outcome === 'denied'
              ? `Cockpit blocked this request: ${event.title}.`
              : `Cockpit blocked this request because the approval window elapsed: ${event.title}.`,
          events: this.#refreshEvents(events),
        };
      }
    }

    const action = strongestAction(events.map((event) => event.action));
    if (action === 'block') {
      return {
        allowed: false,
        status: 403,
        code: 'guard_blocked',
        message: `Cockpit blocked this request: ${events[0]?.title ?? 'guard rule'}.`,
        events: this.#refreshEvents(events),
      };
    }

    return { allowed: true, events: this.#refreshEvents(events) };
  }

  evaluateStep(input: GuardStepInput): GuardEvent[] {
    const events: GuardEvent[] = [];
    const rules = this.#store.listGuardRules().filter((rule) => rule.enabled);

    const secretHits: SecretScanHit[] = [
      ...this.#secrets.scanText(input.responseText ?? '', 'response_body'),
      ...this.#secrets.scanText(input.responseThinking ?? '', 'response_body'),
    ];
    for (const call of input.toolCalls) {
      secretHits.push(
        ...this.#secrets.scanText(JSON.stringify(call.input ?? null), 'response_body'),
      );
    }
    events.push(...this.#recordSecretHits(input.sessionId, input.stepId, secretHits, 'response'));

    const texts: Array<[string, string]> = [];
    for (const call of input.toolCalls) {
      texts.push([`tool:${call.name}`, JSON.stringify(call.input ?? null)]);
    }

    for (const rule of rules) {
      if (rule.kind === 'secret' || rule.kind === 'loop' || rule.kind === 'budget') continue;
      const matches = matchRule(rule, texts);
      if (matches.length === 0) continue;
      events.push(...this.#recordMatches(input.sessionId, input.stepId, rule, matches, 'response'));
    }

    return events;
  }

  scanSession(sessionId: string): SecretScanResponse {
    const session = this.#store.getSession(sessionId);
    if (!session) throw new GuardServiceError(404, 'not_found', 'The session was not found.');

    const findings = this.#secrets.scanSession(sessionId);
    this.#store.deleteSecretScanEvents(sessionId);

    const events = findings.map((finding) =>
      this.#events.record({
        sessionId,
        ruleId: `secret-scan:${finding.type}`,
        kind: 'secret',
        action: finding.action,
        severity: severityForAction(finding.action),
        // A historical rescan must never open an approval gate: the request it
        // refers to has already happened.
        status: finding.action === 'redact' ? 'redacted' : 'warned',
        title: `Secret scan: ${finding.type}`,
        description: 'A rescan of stored session data found a secret pattern.',
        evidence: [{ field: finding.location, excerpt: finding.preview }],
        metadata: {
          source: 'scan',
          secretType: finding.type,
          location: finding.location,
          confidence: finding.confidence,
        },
      }),
    );

    return {
      sessionId,
      scannedAt: new Date().toISOString(),
      findings,
      events,
      filesExamined: this.#store.listSteps(sessionId, 1_000_000).length,
    };
  }

  /**
   * Snapshots arrive in bursts. Debouncing the rescan keeps a long session from
   * rescanning every stored step after each tool call.
   */
  scheduleScan(sessionId: string, delayMs = 500): void {
    const existing = this.#scanTimers.get(sessionId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(
      () => {
        this.#scanTimers.delete(sessionId);
        try {
          this.scanSession(sessionId);
        } catch (error) {
          this.#logger.warn('Cockpit could not rescan a session for secrets', error);
        }
      },
      Math.max(1, delayMs),
    );
    timer.unref();
    this.#scanTimers.set(sessionId, timer);
  }

  close(): void {
    for (const timer of this.#scanTimers.values()) clearTimeout(timer);
    this.#scanTimers.clear();
    this.#broker.clear();
  }

  #refreshEvents(events: GuardEvent[]): GuardEvent[] {
    return events.map((event) => this.#store.getGuardEvent(event.id) ?? event);
  }

  #actionForSecret(type: string): GuardAction {
    for (const rule of this.#store.listGuardRules()) {
      if (!rule.enabled || rule.kind !== 'secret') continue;
      const config = configFor(rule);
      if (config.patterns?.includes(type)) return rule.action;
    }
    return 'warn';
  }

  #recordSecretHits(
    sessionId: string,
    stepId: string | undefined,
    hits: readonly SecretScanHit[],
    source: 'request' | 'response',
  ): GuardEvent[] {
    if (hits.length === 0) return [];
    const rules = this.#store
      .listGuardRules()
      .filter((rule) => rule.enabled && rule.kind === 'secret');
    const grouped = new Map<string, { hit: SecretScanHit; count: number }>();

    // A secret that lives in a long system prompt would otherwise raise an
    // event on every turn. Pause and block rules always re-raise so the gate
    // can never be bypassed by an earlier decision.
    const surfaced = new Set<string>();
    for (const event of this.#store.listGuardEvents({ sessionId, kind: 'secret', limit: 500 })) {
      const secretType = event.metadata?.['secretType'];
      const location = event.metadata?.['location'];
      if (typeof secretType === 'string' && typeof location === 'string') {
        surfaced.add(`${event.stepId ?? 'request'}\u0000${secretType}\u0000${location}`);
      }
    }

    for (const hit of hits) {
      const key = `${hit.type}\u0000${hit.location}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        grouped.set(key, { hit, count: 1 });
      }
    }

    const events: GuardEvent[] = [];
    for (const { hit, count } of grouped.values()) {
      const rule = rules.find((candidate) => configFor(candidate).patterns?.includes(hit.type));
      if (!rule) continue;

      const surfacedKey = `${stepId ?? 'request'}\u0000${hit.type}\u0000${hit.location}`;
      if (rule.action !== 'pause' && rule.action !== 'block' && surfaced.has(surfacedKey)) {
        continue;
      }
      surfaced.add(surfacedKey);

      events.push(
        this.#events.record({
          sessionId,
          ...(stepId ? { stepId } : {}),
          ruleId: `secret-scan:${hit.type}`,
          kind: 'secret',
          action: rule.action,
          severity: rule.severity,
          status: statusForAction(rule.action),
          title: `${rule.name}: ${hit.label}`,
          description:
            rule.action === 'pause'
              ? 'A high-risk secret is about to leave the machine. Approve to send it, or deny to keep it local.'
              : 'A recognizable secret pattern was found. Cockpit redacts the value before storage.',
          evidence: [{ field: hit.location, excerpt: hit.preview }],
          metadata: {
            guardRuleId: rule.id,
            source,
            secretType: hit.type,
            location: hit.location,
            occurrences: count,
            confidence: hit.confidence,
          },
        }),
      );
    }
    return events;
  }

  #recordMatches(
    sessionId: string,
    stepId: string | undefined,
    rule: GuardRule,
    matches: readonly TextMatch[],
    source: 'request' | 'response',
  ): GuardEvent[] {
    const first = matches[0];
    if (!first) return [];
    return [
      this.#events.record({
        sessionId,
        ...(stepId ? { stepId } : {}),
        ruleId: rule.id,
        kind: rule.kind,
        action: rule.action,
        severity: rule.severity,
        status: statusForAction(rule.action),
        title: rule.name,
        description: rule.description,
        ...(rule.kind === 'dangerous_command' ? { command: first.value } : {}),
        evidence: matches.map((match) => ({
          field: match.field,
          excerpt: match.excerpt,
        })),
        metadata: {
          source,
          matchCount: matches.length,
        },
      }),
    ];
  }

  #detectLoop(sessionId: string, latestUser: string, rules: readonly GuardRule[]): GuardEvent[] {
    const normalized = latestUser.trim();
    if (normalized.length < 20) return [];

    const loopRule = rules.find((rule) => rule.kind === 'loop');
    if (!loopRule) return [];
    const config = configFor(loopRule);
    const threshold = config.threshold ?? 0.9;
    const minOccurrences = config.minOccurrences ?? 3;
    const window = config.window ?? 10;

    const key = `${sessionId}:${normalized.slice(0, 160).toLowerCase()}`;
    const lastWarned = this.#loopWarnings.get(key);
    if (lastWarned !== undefined && Date.now() - lastWarned < 5 * 60_000) return [];

    const recent = this.#store
      .listRecentPromptTexts(sessionId, window)
      .map((prompt) => latestUserFromPromptText(prompt))
      .filter((prompt) => prompt.length >= 20);

    let similar = 0;
    let best = 0;
    for (const prompt of recent) {
      const score = tokenSimilarity(normalized, prompt);
      if (score > best) best = score;
      if (score >= threshold) similar += 1;
    }

    if (similar + 1 < minOccurrences) return [];
    this.#loopWarnings.set(key, Date.now());

    return [
      this.#events.record({
        sessionId,
        ruleId: loopRule.id,
        kind: 'loop',
        action: loopRule.action,
        severity: loopRule.severity,
        status: statusForAction(loopRule.action),
        title: loopRule.name,
        description: `A near-identical instruction has been sent ${similar + 1} times in this session.`,
        evidence: [{ field: 'prompt', excerpt: truncateText(normalized, 500) }],
        metadata: {
          source: 'request',
          similarity: Math.round(best * 1000) / 1000,
          occurrences: similar + 1,
          threshold,
        },
      }),
    ];
  }
}

export function guardEventMetadata(event: GuardEvent): JsonObject {
  return event.metadata ?? {};
}
