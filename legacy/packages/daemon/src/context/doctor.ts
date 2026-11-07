import {
  ContextSnapshotDetailResponseSchema,
  SessionContextResponseSchema,
  estimateJsonTokens,
  estimateTokens,
  isRecord,
  resolveContextWindow,
  type CapturedStep,
  type ContextInsight,
  type ContextInsightSeverity,
  type ContextInsightType,
  type ContextSegment,
  type ContextSnapshot,
  type JsonValue,
} from '@cockpit/core';

import type { Logger } from '../logger.js';
import type { ContextInsightInput, ContextSegmentInput, Store } from '../store/store.js';

const PREVIEW_CHARS = 240;
const MAX_SEGMENTS = 200;
const LARGE_TOOL_OUTPUT_TOKENS = 4_000;
const LARGE_TOOL_OUTPUT_SHARE = 25;
const HISTORY_BLOAT_TOKENS = 20_000;
const HISTORY_BLOAT_SHARE = 50;
const COMPACTION_SHARE = 80;

export interface ContextCaptureInput {
  sessionId: string;
  stepId: string;
  provider?: string;
  model?: string;
  body?: JsonValue;
  systemPrompt?: string;
  promptText?: string;
  measuredAt?: Date;
}

export interface StepContextCapture {
  capture(input: ContextCaptureInput): ContextSnapshot;
}

export interface ContextAnalysis {
  totalTokens: number;
  contextWindow?: number;
  segments: ContextSegmentInput[];
  insights: ContextInsightInput[];
}

export interface ContextDoctorOptions {
  store: Store;
  logger: Logger;
}

interface PendingSegment extends ContextSegmentInput {
  rawText: string;
}

const SEVERITY_RANK: Readonly<Record<ContextInsightSeverity, number>> = {
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

function clip(text: string, maximum: number): string {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  return singleLine.length > maximum ? `${singleLine.slice(0, maximum - 1)}…` : singleLine;
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part;
        if (!isRecord(part)) return '';
        if (typeof part['text'] === 'string') return part['text'];
        if (typeof part['content'] === 'string') return part['content'];
        if (part['type'] === 'image' || part['type'] === 'image_url') return '[image]';
        if (part['type'] === 'tool_result') return contentText(part['content']);
        return '';
      })
      .filter((part) => part.length > 0)
      .join('\n');
  }
  if (isRecord(value) && typeof value['text'] === 'string') return value['text'];
  return '';
}

function formatTokens(tokens: number): string {
  return Math.round(tokens)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function extractPath(text: string): string | undefined {
  const match =
    /(?:^|[\s"'`])(?:file|path|filepath|file_path|target_file)\s*[:=]\s*["'`]?([A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+)/i.exec(
      text,
    );
  if (!match?.[1]) return undefined;
  return match[1].replace(/\\/g, '/');
}

function splitInstructions(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 30 && part.length <= 1000);
}

function normalizeInstruction(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_>#-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/g, '')
    .trim();
}

function directive(text: string): { polarity: 'positive' | 'negative'; body: string } | undefined {
  const normalized = normalizeInstruction(text);
  const negative = /^(?:never|do not|don't|avoid|must not|should not|please do not)\b/.test(
    normalized,
  );
  const positive = /^(?:always|must|should|please|prefer)\b/.test(normalized);
  if (!negative && !positive) return undefined;

  const body = normalized.replace(
    /^(?:never|always|do not|don't|avoid|must not|should not|please do not|please|prefer|must|should)\s+/,
    '',
  );
  if (body.length < 10) return undefined;
  return { polarity: negative ? 'negative' : 'positive', body };
}

function mergePendingSegments(segments: PendingSegment[]): PendingSegment[] {
  const merged = new Map<string, PendingSegment>();
  for (const segment of segments) {
    const key = `${segment.category}\u0000${segment.label}\u0000${segment.sourcePath ?? ''}`;
    const existing = merged.get(key);
    if (existing) {
      existing.tokens += segment.tokens;
      existing.rawText = `${existing.rawText}\n${segment.rawText}`;
      continue;
    }
    merged.set(key, { ...segment });
  }
  return [...merged.values()];
}

export class ContextDoctor implements StepContextCapture {
  readonly #store: Store;
  readonly #logger: Logger;

  constructor(options: ContextDoctorOptions) {
    this.#store = options.store;
    this.#logger = options.logger;
  }

  capture(input: ContextCaptureInput): ContextSnapshot {
    const analysis = this.analyze(input);
    return this.#store.insertContextSnapshot({
      sessionId: input.sessionId,
      stepId: input.stepId,
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.model ? { model: input.model } : {}),
      totalTokens: analysis.totalTokens,
      ...(analysis.contextWindow ? { contextWindow: analysis.contextWindow } : {}),
      ...(input.measuredAt ? { measuredAt: input.measuredAt } : {}),
      segments: analysis.segments,
      insights: analysis.insights,
    });
  }

  analyze(input: ContextCaptureInput): ContextAnalysis {
    const segments = this.#buildSegments(input);
    const totalTokens = Math.max(
      0,
      segments.reduce((total, segment) => total + segment.tokens, 0),
    );
    const withPercent = segments.map((segment) => ({
      category: segment.category,
      label: segment.label,
      tokens: segment.tokens,
      percent: totalTokens === 0 ? 0 : Math.round((segment.tokens / totalTokens) * 1000) / 10,
      ...(segment.sourcePath ? { sourcePath: segment.sourcePath } : {}),
      ...(segment.preview ? { preview: segment.preview } : {}),
    }));

    const contextWindow = resolveContextWindow(input.model);
    const insights = this.#buildInsights(input, withPercent, totalTokens, contextWindow);
    return {
      totalTokens,
      ...(contextWindow ? { contextWindow } : {}),
      segments: withPercent.slice(0, MAX_SEGMENTS),
      insights,
    };
  }

  list(sessionId: string) {
    const snapshots = this.#store.listContextSnapshots(sessionId);
    const latest = this.#store.getLatestContextSnapshot(sessionId) ?? null;
    return SessionContextResponseSchema.parse({ sessionId, snapshots, latest });
  }

  detail(snapshotId: string) {
    const snapshot = this.#store.getContextSnapshot(snapshotId);
    if (!snapshot) return undefined;
    return ContextSnapshotDetailResponseSchema.parse({
      snapshot,
      segments: this.#store.listContextSegments(snapshotId),
      insights: this.#store.listContextInsights(snapshotId),
    });
  }

  recomputeSession(sessionId: string): ContextSnapshot[] {
    this.#store.deleteContextSnapshots(sessionId);
    const steps = this.#store
      .listSteps(sessionId)
      .filter((step): step is CapturedStep & { kind: 'model' } => step.kind === 'model');

    const snapshots: ContextSnapshot[] = [];
    for (const step of steps) {
      try {
        const request = step.request;
        const analysis = this.analyze({
          sessionId,
          stepId: step.id,
          ...(step.provider ? { provider: step.provider } : {}),
          ...(step.model ? { model: step.model } : {}),
          ...(request?.body === undefined ? {} : { body: request.body }),
          ...(request?.systemPrompt ? { systemPrompt: request.systemPrompt } : {}),
          ...(request?.promptText ? { promptText: request.promptText } : {}),
          measuredAt: new Date(step.startedAt),
        });
        snapshots.push(
          this.#store.insertContextSnapshot({
            sessionId,
            stepId: step.id,
            ...(step.provider ? { provider: step.provider } : {}),
            ...(step.model ? { model: step.model } : {}),
            totalTokens: analysis.totalTokens,
            ...(analysis.contextWindow ? { contextWindow: analysis.contextWindow } : {}),
            measuredAt: new Date(step.startedAt),
            segments: analysis.segments,
            insights: analysis.insights,
          }),
        );
      } catch (error) {
        this.#logger.warn('Cockpit could not recompute a context snapshot', {
          sessionId,
          stepId: step.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return snapshots;
  }

  #buildSegments(input: ContextCaptureInput): PendingSegment[] {
    const segments: PendingSegment[] = [];
    const systemText = input.systemPrompt?.trim() ?? '';
    if (systemText.length > 0) {
      segments.push({
        category: 'system',
        label: 'System prompt',
        tokens: estimateTokens(systemText),
        percent: 0,
        preview: clip(systemText, PREVIEW_CHARS),
        rawText: systemText,
      });
    }

    const body = input.body;
    if (isRecord(body)) {
      const messages = Array.isArray(body['messages']) ? body['messages'] : [];
      messages.forEach((message, index) => {
        if (!isRecord(message)) return;
        const role = typeof message['role'] === 'string' ? message['role'] : 'other';
        const text = contentText(message['content']);
        const category =
          role === 'system'
            ? 'rules'
            : role === 'tool'
              ? 'tool_output'
              : role === 'user' || role === 'assistant'
                ? 'history'
                : 'other';
        const sourcePath = extractPath(text);

        if (text.length > 0) {
          segments.push({
            category,
            label: `${roleLabel(role)} message ${index + 1}`,
            tokens: estimateTokens(text),
            percent: 0,
            ...(sourcePath ? { sourcePath } : {}),
            preview: clip(text, PREVIEW_CHARS),
            rawText: text,
          });
        }

        if (role === 'assistant' && Array.isArray(message['tool_calls'])) {
          for (const call of message['tool_calls']) {
            if (!isRecord(call)) continue;
            const fn = isRecord(call['function']) ? call['function'] : undefined;
            const name =
              (fn && typeof fn['name'] === 'string' ? fn['name'] : undefined) ??
              (typeof call['name'] === 'string' ? call['name'] : 'tool');
            const args = fn?.['arguments'] ?? call['input'] ?? {};
            const serialized = typeof args === 'string' ? args : JSON.stringify(args);
            const toolPath = extractPath(serialized);
            segments.push({
              category: 'tool_output',
              label: `Tool call: ${name}`,
              tokens: estimateTokens(serialized),
              percent: 0,
              ...(toolPath ? { sourcePath: toolPath } : {}),
              preview: clip(serialized, PREVIEW_CHARS),
              rawText: serialized,
            });
          }
        }
      });

      const tools = body['tools'];
      if (Array.isArray(tools) && tools.length > 0) {
        const serialized = JSON.stringify(tools);
        segments.push({
          category: 'rules',
          label: 'Tool definitions',
          tokens: estimateTokens(serialized),
          percent: 0,
          preview: clip(serialized, PREVIEW_CHARS),
          rawText: serialized,
        });
      }

      const bodySystem = body['system'];
      if (!systemText && bodySystem !== undefined) {
        const text = contentText(bodySystem);
        if (text.length > 0) {
          segments.push({
            category: 'rules',
            label: 'System instructions',
            tokens: estimateTokens(text),
            percent: 0,
            preview: clip(text, PREVIEW_CHARS),
            rawText: text,
          });
        }
      }
    }

    if (segments.length === 0 && input.promptText) {
      segments.push({
        category: 'history',
        label: 'Prompt',
        tokens: estimateTokens(input.promptText),
        percent: 0,
        preview: clip(input.promptText, PREVIEW_CHARS),
        rawText: input.promptText,
      });
    }

    const merged = mergePendingSegments(segments);
    const segmentTokens = merged.reduce((total, segment) => total + segment.tokens, 0);
    const rawTokens =
      estimateJsonTokens(body ?? null) +
      (body === undefined && systemText ? estimateTokens(systemText) : 0);
    if (rawTokens > segmentTokens) {
      merged.push({
        category: 'other',
        label: 'Request overhead',
        tokens: rawTokens - segmentTokens,
        percent: 0,
        preview: 'JSON structure, metadata, and parameters not attributed to a message.',
        rawText: '',
      });
    }
    return merged;
  }

  #buildInsights(
    input: ContextCaptureInput,
    segments: readonly ContextSegmentInput[],
    totalTokens: number,
    contextWindow: number | undefined,
  ): ContextInsightInput[] {
    const insights: ContextInsightInput[] = [];
    const instructions = this.#instructionTexts(input);
    this.#addDuplicateInsights(insights, instructions);
    this.#addConflictInsights(insights, instructions);

    const toolSegments = segments
      .filter((segment) => segment.category === 'tool_output')
      .sort((a, b) => b.tokens - a.tokens);
    const largestTool = toolSegments[0];
    if (
      largestTool &&
      (largestTool.tokens >= LARGE_TOOL_OUTPUT_TOKENS ||
        (largestTool.tokens >= 2_000 && largestTool.percent >= LARGE_TOOL_OUTPUT_SHARE))
    ) {
      insights.push({
        type: 'large_tool_output',
        severity: largestTool.tokens >= 12_000 ? 'high' : 'medium',
        title: 'Large tool output in context',
        detail: `${largestTool.label} contributes ${formatTokens(largestTool.tokens)} estimated tokens (${largestTool.percent}% of this request). Trim or summarize tool results before sending them back.`,
        ...(largestTool.sourcePath ? { paths: [largestTool.sourcePath] } : {}),
        estimatedSavingsTokens: Math.round(largestTool.tokens * 0.5),
      });
    }

    const historyTokens = segments
      .filter((segment) => segment.category === 'history')
      .reduce((total, segment) => total + segment.tokens, 0);
    const historyPercent = totalTokens === 0 ? 0 : (historyTokens / totalTokens) * 100;
    if (historyTokens >= HISTORY_BLOAT_TOKENS && historyPercent >= HISTORY_BLOAT_SHARE) {
      insights.push({
        type: 'history_bloat',
        severity: historyPercent >= 70 ? 'high' : 'medium',
        title: 'Conversation history dominates the request',
        detail: `${formatTokens(historyTokens)} estimated tokens (${Math.round(historyPercent)}%) are conversation history. Summarizing earlier turns or starting a fresh session would reduce cost and stale-context risk.`,
        estimatedSavingsTokens: Math.round(historyTokens * 0.25),
      });
    }

    if (contextWindow && totalTokens >= (contextWindow * COMPACTION_SHARE) / 100) {
      const utilization = Math.round((totalTokens / contextWindow) * 1000) / 10;
      insights.push({
        type: 'compaction',
        severity: utilization >= 95 ? 'high' : 'medium',
        title: 'Context window is nearly full',
        detail: `This request uses about ${formatTokens(totalTokens)} of ${formatTokens(contextWindow)} estimated tokens (${utilization}%). Compaction or a narrower task will avoid truncation.`,
        estimatedSavingsTokens: Math.max(0, totalTokens - Math.floor(contextWindow * 0.5)),
      });
    } else if (!contextWindow && totalTokens >= 100_000) {
      insights.push({
        type: 'compaction',
        severity: 'medium',
        title: 'Very large request with an unknown context window',
        detail: `This request is about ${formatTokens(totalTokens)} estimated tokens. Cockpit does not know the model's context window, so it cannot confirm how close this is to the limit.`,
        estimatedSavingsTokens: Math.round(totalTokens * 0.25),
      });
    }

    this.#addStaleInsights(insights, input, segments);
    return insights
      .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
      .slice(0, 50);
  }

  #instructionTexts(input: ContextCaptureInput): string[] {
    const texts: string[] = [];
    if (input.systemPrompt) texts.push(input.systemPrompt);
    if (isRecord(input.body)) {
      const bodySystem = input.body['system'];
      if (bodySystem !== undefined) {
        const text = contentText(bodySystem);
        if (text) texts.push(text);
      }
    }
    return texts;
  }

  #addDuplicateInsights(insights: ContextInsightInput[], texts: readonly string[]): void {
    const counts = new Map<string, { text: string; count: number }>();
    for (const text of texts) {
      for (const sentence of splitInstructions(text)) {
        const key = normalizeInstruction(sentence);
        const existing = counts.get(key);
        if (existing) existing.count += 1;
        else counts.set(key, { text: sentence, count: 1 });
      }
    }

    let added = 0;
    for (const { text, count } of counts.values()) {
      if (count < 2 || added >= 5) continue;
      const tokens = estimateTokens(text);
      insights.push({
        type: 'duplicate_instruction',
        severity: tokens >= 100 ? 'medium' : 'low',
        title: 'Repeated instruction in context',
        detail: `The instruction "${clip(text, 180)}" appears ${count} times in system context. Removing duplicate copies keeps rules authoritative and saves tokens.`,
        estimatedSavingsTokens: tokens * (count - 1),
      });
      added += 1;
    }
  }

  #addConflictInsights(insights: ContextInsightInput[], texts: readonly string[]): void {
    const positives = new Map<string, { text: string; tokens: number }>();
    const negatives = new Map<string, { text: string; tokens: number }>();

    for (const text of texts) {
      for (const sentence of splitInstructions(text)) {
        const parsed = directive(sentence);
        if (!parsed) continue;
        const target = parsed.polarity === 'positive' ? positives : negatives;
        if (!target.has(parsed.body)) {
          target.set(parsed.body, { text: sentence, tokens: estimateTokens(sentence) });
        }
      }
    }

    let added = 0;
    for (const [body, positive] of positives) {
      const negative = negatives.get(body);
      if (!negative || added >= 5) continue;
      insights.push({
        type: 'conflicting_instruction',
        severity: 'high',
        title: 'Conflicting instructions in context',
        detail: `The same instruction is both required and forbidden: "${clip(positive.text, 160)}" conflicts with "${clip(negative.text, 160)}". Resolve the contradiction before trusting the agent's output.`,
        estimatedSavingsTokens: Math.min(positive.tokens, negative.tokens),
      });
      added += 1;
    }
  }

  #addStaleInsights(
    insights: ContextInsightInput[],
    input: ContextCaptureInput,
    segments: readonly ContextSegmentInput[],
  ): void {
    const step = this.#store.getStep(input.stepId);
    if (!step) return;
    const stepStart = new Date(step.startedAt).getTime();
    const changed = new Set<string>();
    for (const snapshot of this.#store.listSnapshots(input.sessionId)) {
      if (snapshot.stepId === input.stepId) continue;
      const snapshotStep = snapshot.stepId ? this.#store.getStep(snapshot.stepId) : undefined;
      // Compare step order rather than timestamps: a snapshot for step N is
      // captured when step N+1 starts, so its createdAt can be later than the
      // analyzed step while the changes still predate that request.
      const changedLater = snapshotStep
        ? snapshotStep.seq > step.seq
        : new Date(snapshot.createdAt).getTime() >= stepStart;
      if (!changedLater) continue;
      for (const file of this.#store.listSnapshotFileChanges(snapshot.id)) {
        changed.add(file.path);
      }
    }
    if (changed.size === 0) return;

    const seen = new Set<string>();
    let added = 0;
    for (const segment of segments) {
      if (!segment.sourcePath || !changed.has(segment.sourcePath) || seen.has(segment.sourcePath)) {
        continue;
      }
      if (added >= 5) break;
      seen.add(segment.sourcePath);
      insights.push({
        type: 'stale_file',
        severity: 'medium',
        title: 'File in context changed later',
        detail: `${segment.sourcePath} was included in this request but changed again later in the session. Re-read the current file before relying on this context.`,
        paths: [segment.sourcePath],
      });
      added += 1;
    }
  }
}

function roleLabel(role: string): string {
  if (role === 'assistant') return 'Assistant';
  if (role === 'user') return 'User';
  if (role === 'system') return 'System';
  if (role === 'tool') return 'Tool result';
  return role.charAt(0).toUpperCase() + role.slice(1);
}

export type { ContextInsight, ContextInsightType, ContextSegment };
