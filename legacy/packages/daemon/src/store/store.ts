import path from 'node:path';
import {
  ArenaRunSchema,
  BrainDriftEventSchema,
  BrainOutputSchema,
  BrainSourceSchema,
  BudgetPolicySchema,
  CapturedStepSchema,
  CapturedStreamChunkSchema,
  CheatAnalysisSchema,
  ComprehensionQuizSchema,
  ContextInsightSchema,
  ContextSegmentSchema,
  ContextSnapshotSchema,
  DeviceSchema,
  GuardEventSchema,
  GuardRuleSchema,
  HandoffBriefSchema,
  JournalEntrySchema,
  PluginRunSchema,
  PluginSchema,
  ProjectSchema,
  ProvenanceEntrySchema,
  ReplayFileChangeSchema,
  ReplayForkSchema,
  ReplaySnapshotSchema,
  SessionSchema,
  UnderstandingEventSchema,
  UnderstandingFileSchema,
  createId,
  type AgentInfo,
  type ArenaRun,
  type ArenaRunQuery,
  type ArenaRunStatus,
  type BrainDriftEvent,
  type BrainFormat,
  type BrainOutput,
  type BrainSource,
  type BudgetPolicy,
  type BudgetPolicyInput,
  type BudgetPolicyPatch,
  type CapturedRequest,
  type CapturedStep,
  type CapturedStreamChunk,
  type CheatAnalysis,
  type CheatFinding,
  type ComprehensionQuiz,
  type ContextInsight,
  type ContextInsightSeverity,
  type ContextInsightType,
  type ContextSegment,
  type ContextSegmentCategory,
  type ContextSnapshot,
  type Device,
  type DevicePlatform,
  type FileChangeType,
  type FinishReason,
  type GitSnapshotKind,
  type GuardAction,
  type GuardEvent,
  type GuardEventListQuery,
  type GuardEventStatus,
  type GuardRule,
  type GuardRuleInput,
  type GuardRuleKind,
  type GuardRulePatch,
  type GuardRuleSource,
  type GuardSeverity,
  type HandoffBrief,
  type JournalEntry,
  type JsonObject,
  type JsonValue,
  type LiveEvent,
  type OverviewStats,
  type Plugin,
  type PluginKind,
  type PluginRun,
  type PluginRunStatus,
  type Project,
  type ProvenanceEntry,
  type ProviderProtocol,
  type QuizQuestion,
  type ReplayFileChange,
  type ReplayFork,
  type ReplayForkStatus,
  type ReplaySnapshot,
  type Session,
  type SessionListQuery,
  type SessionSource,
  type StepKind,
  type StepStatus,
  type StreamChunkKind,
  type TokenUsage,
  type ToolCallTrace,
  type TrustGrade,
  type UnderstandingEvent,
  type UnderstandingEventType,
  type UnderstandingFile,
  type UnderstandingStatus,
} from '@cockpit/core';
import { and, asc, desc, eq, gte, isNull, like, lt, lte, ne, or, sql, type SQL } from 'drizzle-orm';

import type { CockpitDatabaseConnection } from '../db/client.js';
import * as schema from '../db/schema.js';

export class InvalidCursorError extends Error {
  constructor() {
    super('The pagination cursor is invalid.');
    this.name = 'InvalidCursorError';
  }
}

export interface CreateSessionRecordInput {
  title: string;
  source: SessionSource;
  provider?: string;
  protocol?: ProviderProtocol;
  model?: string;
  agent?: AgentInfo;
  workspacePath?: string;
  gitBranch?: string;
  gitBaseCommit?: string;
  projectId?: string;
  tags?: string[];
  metadata?: JsonObject;
  startedAt?: Date;
}

export interface TouchSessionInput {
  provider?: string;
  protocol?: ProviderProtocol;
  model?: string;
  agent?: AgentInfo;
}

export interface SessionPage {
  sessions: Session[];
  nextCursor: string | null;
}

export interface BeginStepInput {
  sessionId: string;
  parentStepId?: string;
  kind: StepKind;
  provider?: string;
  model?: string;
  request: CapturedRequest;
  metadata?: JsonObject;
  /** Demo seeding and replay import can backdate a step. */
  startedAt?: Date;
}

export interface CompleteStepInput {
  status: StepStatus;
  model?: string;
  responseStatus: number;
  responseHeaders: Record<string, string>;
  responseText?: string;
  responseThinking?: string;
  finishReason?: FinishReason;
  error?: string;
  usage: TokenUsage;
  costUsd?: number;
  costKnown: boolean;
  ttftMs?: number;
  latencyMs?: number;
  metadata?: JsonObject;
  /** Demo seeding and replay import can backdate a step. */
  endedAt?: Date;
}

export interface ToolCallRecordInput {
  providerToolCallId?: string;
  name: string;
  input?: JsonValue;
}

export interface RedactionRecordInput {
  ruleId: string;
  label: string;
  location: 'request_headers' | 'request_body' | 'response_headers' | 'response_body';
  occurrences: number;
}

export interface StreamChunkInput {
  stepId: string;
  seq: number;
  kind: StreamChunkKind;
  data: string;
  deltaText?: string;
  receivedAt: Date;
}

export interface SnapshotFileChangeInput {
  path: string;
  oldPath?: string;
  changeType: FileChangeType;
  additions: number;
  deletions: number;
  diff?: string;
  aiAuthored?: boolean;
}

export interface InsertSnapshotInput {
  sessionId: string;
  stepId?: string;
  kind: GitSnapshotKind;
  commitSha?: string;
  parentCommitSha?: string;
  branch?: string;
  worktreePath?: string;
  patch?: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  fileChanges: SnapshotFileChangeInput[];
  /** Demo seeding and replay import can backdate a snapshot. */
  createdAt?: Date;
}

export interface InsertForkInput {
  sessionId: string;
  stepId?: string;
  branch: string;
  worktreePath: string;
  baseCommit?: string;
  resumeBrief: string;
  status?: ReplayForkStatus;
}

export interface CreateGuardRuleInput extends GuardRuleInput {
  id?: string;
  source?: GuardRuleSource;
}

export interface InsertGuardEventInput {
  sessionId: string;
  stepId?: string;
  ruleId: string;
  kind: GuardRuleKind;
  action: GuardAction;
  severity: GuardSeverity;
  status: GuardEventStatus;
  title: string;
  description?: string;
  command?: string;
  evidence?: GuardEvent['evidence'];
  requestedAt?: Date;
  resolvedAt?: Date;
  resolvedBy?: string;
  resolutionNote?: string;
  metadata?: JsonObject;
}

export interface UpdateGuardEventInput {
  status?: GuardEventStatus;
  resolvedAt?: Date;
  resolvedBy?: string;
  resolutionNote?: string;
}

export interface SessionRedactionRow {
  stepId: string;
  ruleId: string;
  label: string;
  location: 'request_headers' | 'request_body' | 'response_headers' | 'response_body';
  occurrences: number;
}

export interface InsertCheatAnalysisInput {
  sessionId: string;
  stepId?: string;
  trustScore: number;
  grade: TrustGrade;
  findings: CheatFinding[];
  filesExamined: number;
  generatedAt?: Date;
}

export interface InsertProvenanceInput {
  projectId: string;
  sessionId?: string;
  stepId?: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  commitSha?: string;
  contentHash: string;
  provider?: string;
  model?: string;
  promptExcerpt?: string;
  confidence?: number;
  capturedAt?: Date;
}

export interface CreateUnderstandingFileInput {
  projectId: string;
  sessionId?: string;
  path: string;
  aiLines: number;
  reviewedLines?: number;
  status?: UnderstandingStatus;
  firstTouchedAt?: Date;
  lastTouchedAt?: Date;
  lastOpenedAt?: Date;
  acknowledgedAt?: Date;
  explanation?: string;
}

export interface UpdateUnderstandingFileInput {
  sessionId?: string;
  aiLines?: number;
  reviewedLines?: number;
  status?: UnderstandingStatus;
  lastTouchedAt?: Date;
  lastOpenedAt?: Date;
  acknowledgedAt?: Date;
  explanation?: string;
}

export interface InsertUnderstandingEventInput {
  understandingFileId: string;
  type: UnderstandingEventType;
  occurredAt?: Date;
  metadata?: Record<string, string>;
}

export interface CreateComprehensionQuizInput {
  understandingFileId: string;
  questions: QuizQuestion[];
  generatedAt?: Date;
}

export interface ContextSegmentInput {
  category: ContextSegmentCategory;
  label: string;
  tokens: number;
  percent: number;
  sourcePath?: string;
  preview?: string;
}

export interface ContextInsightInput {
  type: ContextInsightType;
  severity: ContextInsightSeverity;
  title: string;
  detail: string;
  paths?: string[];
  estimatedSavingsTokens?: number;
}

export interface InsertContextSnapshotInput {
  sessionId: string;
  stepId?: string;
  provider?: string;
  model?: string;
  totalTokens: number;
  contextWindow?: number;
  measuredAt?: Date;
  segments: ContextSegmentInput[];
  insights: ContextInsightInput[];
}

export interface UpsertBrainSourceInput {
  projectId: string;
  path: string;
  content: string;
  checksum: string;
}

export interface UpsertBrainOutputInput {
  projectId: string;
  format: BrainFormat;
  path: string;
  content: string;
  checksum: string;
  sourceChecksum: string;
}

export interface InsertBrainDriftEventInput {
  projectId: string;
  outputId: string;
  expectedChecksum: string;
  actualChecksum: string;
  detectedAt?: Date;
}

export interface InsertArenaRunInput {
  sourceSessionId?: string;
  sourceStepId?: string;
  provider: string;
  model: string;
  status: ArenaRunStatus;
  startedAt?: Date;
}

export interface UpdateArenaRunInput {
  status?: ArenaRunStatus;
  outputText?: string;
  diffText?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  costKnown?: boolean;
  latencyMs?: number;
  ttftMs?: number;
  testsPassed?: boolean;
  trustScore?: number;
  baselineCostUsd?: number;
  savingsPercent?: number;
  error?: string;
  completedAt?: Date;
}

export interface InsertHandoffBriefInput {
  sessionId: string;
  title: string;
  contentMarkdown: string;
  generatedAt?: Date;
  model?: string;
}

export interface UpsertJournalEntryInput {
  projectId?: string;
  weekStart: string;
  title: string;
  markdown: string;
}

export interface InsertPluginInput {
  name: string;
  version: string;
  description?: string;
  manifest: JsonObject;
  path: string;
  enabled?: boolean;
}

export interface UpdatePluginInput {
  version?: string;
  description?: string;
  manifest?: JsonObject;
  path?: string;
  enabled?: boolean;
}

export interface InsertPluginRunInput {
  pluginId: string;
  sessionId?: string;
  kind: PluginKind;
  status: PluginRunStatus;
  result?: JsonValue;
  error?: string;
  startedAt?: Date;
  endedAt?: Date;
}

export interface InsertPairingTokenInput {
  tokenHash: string;
  deviceNameHint?: string;
  expiresAt: Date;
}

export interface PairingTokenRecord {
  id: string;
  tokenHash: string;
  deviceNameHint?: string;
  expiresAt: Date;
  usedAt?: Date;
  createdAt: Date;
}

export interface InsertDeviceInput {
  name: string;
  platform: DevicePlatform;
  tokenHash: string;
}

interface SessionCursor {
  startedAt: string;
  id: string;
}

function iso(value: Date): string {
  return value.toISOString();
}

function encodeCursor(cursor: SessionCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): SessionCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as SessionCursor).startedAt === 'string' &&
      typeof (parsed as SessionCursor).id === 'string'
    ) {
      const candidate = parsed as SessionCursor;
      if (!Number.isNaN(Date.parse(candidate.startedAt))) return candidate;
    }
  } catch {
    // Fall through.
  }
  throw new InvalidCursorError();
}

function mapAgent(row: typeof schema.sessions.$inferSelect): AgentInfo | undefined {
  if (!row.agentName && !row.agentVersion && !row.agentUserAgent) return undefined;
  return {
    ...(row.agentName ? { name: row.agentName } : {}),
    ...(row.agentVersion ? { version: row.agentVersion } : {}),
    ...(row.agentUserAgent ? { userAgent: row.agentUserAgent } : {}),
    detectedFrom: row.agentDetectedFrom ?? 'unknown',
  };
}

function mapSession(row: typeof schema.sessions.$inferSelect): Session {
  const agent = mapAgent(row);
  return SessionSchema.parse({
    id: row.id,
    ...(row.projectId ? { projectId: row.projectId } : {}),
    title: row.title,
    source: row.source,
    status: row.status,
    ...(agent ? { agent } : {}),
    ...(row.model
      ? {
          modelRef: {
            ...(row.provider ? { provider: row.provider } : {}),
            ...(row.protocol ? { protocol: row.protocol } : {}),
            model: row.model,
          },
        }
      : {}),
    ...(row.workspacePath ? { workspacePath: row.workspacePath } : {}),
    ...(row.gitBranch ? { gitBranch: row.gitBranch } : {}),
    ...(row.gitBaseCommit ? { gitBaseCommit: row.gitBaseCommit } : {}),
    startedAt: iso(row.startedAt),
    ...(row.endedAt ? { endedAt: iso(row.endedAt) } : {}),
    ...(row.durationMs === null ? {} : { durationMs: row.durationMs }),
    totals: {
      stepCount: row.stepCount,
      modelCallCount: row.modelCallCount,
      toolCallCount: row.toolCallCount,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      reasoningTokens: row.reasoningTokens,
      totalCostUsd: row.totalCostUsd,
      unknownCostCalls: row.unknownCostCalls,
      errorCount: row.errorCount,
    },
    tags: row.tags,
    ...(row.metadata ? { metadata: row.metadata } : {}),
  });
}

function mapStep(row: typeof schema.steps.$inferSelect): CapturedStep {
  const usage: TokenUsage = {
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    reasoningTokens: row.reasoningTokens,
  };

  const request: CapturedRequest | undefined =
    row.requestProtocol && row.requestMethod && row.requestPath
      ? {
          protocol: row.requestProtocol,
          method: row.requestMethod,
          path: row.requestPath,
          ...(row.model ? { model: row.model } : {}),
          stream: row.requestStream,
          headers: row.requestHeaders ?? {},
          ...(row.requestBody === null ? {} : { body: row.requestBody }),
          ...(row.requestSystemPrompt ? { systemPrompt: row.requestSystemPrompt } : {}),
          ...(row.requestPromptText ? { promptText: row.requestPromptText } : {}),
          redactionCount: row.requestRedactionCount,
        }
      : undefined;

  const response =
    row.responseStatus === null
      ? undefined
      : {
          status: row.responseStatus,
          headers: row.responseHeaders ?? {},
          ...(row.responseFinishReason ? { finishReason: row.responseFinishReason } : {}),
          ...(row.responseText ? { text: row.responseText } : {}),
          ...(row.responseThinking ? { thinking: row.responseThinking } : {}),
          usage,
          ...(row.ttftMs === null ? {} : { ttftMs: row.ttftMs }),
          ...(row.latencyMs === null ? {} : { latencyMs: row.latencyMs }),
          ...(row.responseError ? { error: row.responseError } : {}),
        };

  return CapturedStepSchema.parse({
    id: row.id,
    sessionId: row.sessionId,
    ...(row.parentStepId ? { parentStepId: row.parentStepId } : {}),
    seq: row.seq,
    kind: row.kind,
    status: row.status,
    ...(row.provider ? { provider: row.provider } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(request ? { request } : {}),
    ...(response ? { response } : {}),
    usage,
    ...(row.costUsd === null ? {} : { costUsd: row.costUsd }),
    costKnown: row.costKnown,
    startedAt: iso(row.startedAt),
    ...(row.endedAt ? { endedAt: iso(row.endedAt) } : {}),
    ...(row.durationMs === null ? {} : { durationMs: row.durationMs }),
    ...(row.error ? { error: row.error } : {}),
    ...(row.metadata ? { metadata: row.metadata } : {}),
  });
}

function mapChunk(row: typeof schema.streamChunks.$inferSelect): CapturedStreamChunk {
  return CapturedStreamChunkSchema.parse({
    id: row.id,
    stepId: row.stepId,
    seq: row.seq,
    kind: row.kind,
    data: row.data,
    ...(row.deltaText ? { deltaText: row.deltaText } : {}),
    receivedAt: iso(row.receivedAt),
  });
}

function mapToolCall(row: typeof schema.toolCalls.$inferSelect): ToolCallTrace {
  return {
    id: row.id,
    sessionId: row.sessionId,
    ...(row.stepId ? { stepId: row.stepId } : {}),
    ...(row.providerToolCallId ? { providerToolCallId: row.providerToolCallId } : {}),
    name: row.name,
    status: row.status,
    ...(row.input === null ? {} : { input: row.input }),
    ...(row.output === null ? {} : { output: row.output }),
    ...(row.error ? { error: row.error } : {}),
    filePaths: row.filePaths,
    startedAt: iso(row.startedAt),
    ...(row.endedAt ? { endedAt: iso(row.endedAt) } : {}),
  };
}

function mapSnapshot(row: typeof schema.gitSnapshots.$inferSelect): ReplaySnapshot {
  return ReplaySnapshotSchema.parse({
    id: row.id,
    sessionId: row.sessionId,
    ...(row.stepId ? { stepId: row.stepId } : {}),
    kind: row.kind,
    ...(row.commitSha ? { commitSha: row.commitSha } : {}),
    ...(row.parentCommitSha ? { parentCommitSha: row.parentCommitSha } : {}),
    ...(row.branch ? { branch: row.branch } : {}),
    ...(row.worktreePath ? { worktreePath: row.worktreePath } : {}),
    ...(row.patch ? { patch: row.patch } : {}),
    filesChanged: row.filesChanged,
    insertions: row.insertions,
    deletions: row.deletions,
    createdAt: iso(row.createdAt),
  });
}

function mapFileChange(row: typeof schema.fileChanges.$inferSelect): ReplayFileChange {
  return ReplayFileChangeSchema.parse({
    id: row.id,
    snapshotId: row.snapshotId,
    path: row.path,
    ...(row.oldPath ? { oldPath: row.oldPath } : {}),
    changeType: row.changeType,
    additions: row.additions,
    deletions: row.deletions,
    ...(row.diff ? { diff: row.diff } : {}),
    ...(row.aiAuthored === null ? {} : { aiAuthored: row.aiAuthored }),
  });
}

function mapFork(row: typeof schema.replayForks.$inferSelect): ReplayFork {
  return ReplayForkSchema.parse({
    id: row.id,
    sessionId: row.sessionId,
    ...(row.stepId ? { stepId: row.stepId } : {}),
    branch: row.branch,
    worktreePath: row.worktreePath,
    ...(row.baseCommit ? { baseCommit: row.baseCommit } : {}),
    resumeBrief: row.resumeBrief,
    status: row.status,
    createdAt: iso(row.createdAt),
  });
}

function mapBrainSource(row: typeof schema.brainSources.$inferSelect): BrainSource {
  return BrainSourceSchema.parse({
    id: row.id,
    projectId: row.projectId,
    path: row.path,
    content: row.content,
    checksum: row.checksum,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
}

function mapBrainOutput(row: typeof schema.brainOutputs.$inferSelect): BrainOutput {
  return BrainOutputSchema.parse({
    id: row.id,
    projectId: row.projectId,
    format: row.format,
    path: row.path,
    content: row.content,
    checksum: row.checksum,
    sourceChecksum: row.sourceChecksum,
    ...(row.syncedAt ? { syncedAt: iso(row.syncedAt) } : {}),
    driftDetected: row.driftDetected,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
}

function mapBrainDriftEvent(row: typeof schema.brainDriftEvents.$inferSelect): BrainDriftEvent {
  return BrainDriftEventSchema.parse({
    id: row.id,
    projectId: row.projectId,
    outputId: row.outputId,
    detectedAt: iso(row.detectedAt),
    expectedChecksum: row.expectedChecksum,
    actualChecksum: row.actualChecksum,
    ...(row.resolvedAt ? { resolvedAt: iso(row.resolvedAt) } : {}),
  });
}

function mapArenaRun(row: typeof schema.arenaRuns.$inferSelect): ArenaRun {
  return ArenaRunSchema.parse({
    id: row.id,
    ...(row.sourceSessionId ? { sourceSessionId: row.sourceSessionId } : {}),
    ...(row.sourceStepId ? { sourceStepId: row.sourceStepId } : {}),
    provider: row.provider,
    model: row.model,
    status: row.status,
    ...(row.outputText ? { outputText: row.outputText } : {}),
    ...(row.diffText ? { diffText: row.diffText } : {}),
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    ...(row.costUsd === null ? {} : { costUsd: row.costUsd }),
    costKnown: row.costKnown,
    ...(row.latencyMs === null ? {} : { latencyMs: row.latencyMs }),
    ...(row.ttftMs === null ? {} : { ttftMs: row.ttftMs }),
    ...(row.testsPassed === null ? {} : { testsPassed: row.testsPassed }),
    ...(row.trustScore === null ? {} : { trustScore: row.trustScore }),
    ...(row.baselineCostUsd === null ? {} : { baselineCostUsd: row.baselineCostUsd }),
    ...(row.savingsPercent === null ? {} : { savingsPercent: row.savingsPercent }),
    ...(row.error ? { error: row.error } : {}),
    startedAt: iso(row.startedAt),
    ...(row.completedAt ? { completedAt: iso(row.completedAt) } : {}),
    createdAt: iso(row.createdAt),
  });
}

function mapHandoffBrief(row: typeof schema.handoffBriefs.$inferSelect): HandoffBrief {
  return HandoffBriefSchema.parse({
    id: row.id,
    sessionId: row.sessionId,
    title: row.title,
    contentMarkdown: row.contentMarkdown,
    generatedAt: iso(row.generatedAt),
    ...(row.model ? { model: row.model } : {}),
  });
}

function mapJournalEntry(row: typeof schema.journalEntries.$inferSelect): JournalEntry {
  return JournalEntrySchema.parse({
    id: row.id,
    ...(row.projectId ? { projectId: row.projectId } : {}),
    weekStart: row.weekStart,
    title: row.title,
    markdown: row.markdown,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
}

function mapPlugin(row: typeof schema.plugins.$inferSelect): Plugin {
  return PluginSchema.parse({
    id: row.id,
    name: row.name,
    version: row.version,
    ...(row.description ? { description: row.description } : {}),
    manifest: row.manifest,
    path: row.path,
    enabled: row.enabled,
    installedAt: iso(row.installedAt),
    updatedAt: iso(row.updatedAt),
  });
}

function mapPluginRun(row: typeof schema.pluginRuns.$inferSelect): PluginRun {
  return PluginRunSchema.parse({
    id: row.id,
    pluginId: row.pluginId,
    ...(row.sessionId ? { sessionId: row.sessionId } : {}),
    kind: row.kind,
    status: row.status,
    ...(row.result === null ? {} : { result: row.result }),
    ...(row.error ? { error: row.error } : {}),
    startedAt: iso(row.startedAt),
    ...(row.endedAt ? { endedAt: iso(row.endedAt) } : {}),
  });
}

function mapDevice(row: typeof schema.devices.$inferSelect): Device {
  return DeviceSchema.parse({
    id: row.id,
    name: row.name,
    platform: row.platform,
    ...(row.lastSeenAt ? { lastSeenAt: iso(row.lastSeenAt) } : {}),
    ...(row.revokedAt ? { revokedAt: iso(row.revokedAt) } : {}),
    createdAt: iso(row.createdAt),
  });
}

function mapPairingToken(row: typeof schema.pairingTokens.$inferSelect): PairingTokenRecord {
  return {
    id: row.id,
    tokenHash: row.tokenHash,
    ...(row.deviceNameHint ? { deviceNameHint: row.deviceNameHint } : {}),
    expiresAt: row.expiresAt,
    ...(row.usedAt ? { usedAt: row.usedAt } : {}),
    createdAt: row.createdAt,
  };
}

function mapGuardRule(row: typeof schema.guardRules.$inferSelect): GuardRule {
  return GuardRuleSchema.parse({
    id: row.id,
    name: row.name,
    description: row.description,
    kind: row.kind,
    action: row.action,
    severity: row.severity,
    source: row.source,
    enabled: row.enabled,
    priority: row.priority,
    config: row.config,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
}

function mapGuardEvent(row: typeof schema.guardEvents.$inferSelect): GuardEvent {
  return GuardEventSchema.parse({
    id: row.id,
    sessionId: row.sessionId,
    ...(row.stepId ? { stepId: row.stepId } : {}),
    ruleId: row.ruleId,
    kind: row.kind,
    action: row.action,
    severity: row.severity,
    status: row.status,
    title: row.title,
    description: row.description,
    ...(row.command ? { command: row.command } : {}),
    evidence: row.evidence,
    requestedAt: iso(row.requestedAt),
    ...(row.resolvedAt ? { resolvedAt: iso(row.resolvedAt) } : {}),
    ...(row.resolvedBy ? { resolvedBy: row.resolvedBy } : {}),
    ...(row.resolutionNote ? { resolutionNote: row.resolutionNote } : {}),
    ...(row.metadata ? { metadata: row.metadata } : {}),
  });
}

function mapBudgetPolicy(row: typeof schema.budgetPolicies.$inferSelect): BudgetPolicy {
  return BudgetPolicySchema.parse({
    id: row.id,
    name: row.name,
    scope: row.scope,
    period: row.period,
    ...(row.projectId ? { projectId: row.projectId } : {}),
    ...(row.sessionId ? { sessionId: row.sessionId } : {}),
    limitUsd: row.limitUsd,
    enforcement: row.enforcement,
    enabled: row.enabled,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
}

function mapCheatFinding(row: typeof schema.cheatFindings.$inferSelect): CheatFinding {
  return {
    id: row.id,
    sessionId: row.sessionId,
    ...(row.stepId ? { stepId: row.stepId } : {}),
    category: row.category,
    severity: row.severity,
    title: row.title,
    detail: row.detail,
    detector: row.detector,
    confidence: row.confidence,
    evidence: row.evidence,
    ...(row.suggestion ? { suggestion: row.suggestion } : {}),
    createdAt: iso(row.createdAt),
  };
}

function mapProject(row: typeof schema.projects.$inferSelect): Project {
  return ProjectSchema.parse({
    id: row.id,
    name: row.name,
    rootPath: row.rootPath,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    ...(row.lastOpenedAt ? { lastOpenedAt: iso(row.lastOpenedAt) } : {}),
    ...(row.metadata ? { metadata: row.metadata } : {}),
  });
}

function mapProvenanceEntry(row: typeof schema.provenanceEntries.$inferSelect): ProvenanceEntry {
  return ProvenanceEntrySchema.parse({
    id: row.id,
    projectId: row.projectId,
    ...(row.sessionId ? { sessionId: row.sessionId } : {}),
    ...(row.stepId ? { stepId: row.stepId } : {}),
    filePath: row.filePath,
    lineStart: row.lineStart,
    lineEnd: row.lineEnd,
    ...(row.commitSha ? { commitSha: row.commitSha } : {}),
    contentHash: row.contentHash,
    ...(row.provider ? { provider: row.provider } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.promptExcerpt ? { promptExcerpt: row.promptExcerpt } : {}),
    confidence: row.confidence,
    capturedAt: iso(row.capturedAt),
  });
}

function mapUnderstandingFile(
  row: typeof schema.understandingFiles.$inferSelect,
): UnderstandingFile {
  return UnderstandingFileSchema.parse({
    id: row.id,
    projectId: row.projectId,
    ...(row.sessionId ? { sessionId: row.sessionId } : {}),
    path: row.path,
    aiLines: row.aiLines,
    reviewedLines: row.reviewedLines,
    status: row.status,
    firstTouchedAt: iso(row.firstTouchedAt),
    lastTouchedAt: iso(row.lastTouchedAt),
    ...(row.lastOpenedAt ? { lastOpenedAt: iso(row.lastOpenedAt) } : {}),
    ...(row.acknowledgedAt ? { acknowledgedAt: iso(row.acknowledgedAt) } : {}),
    ...(row.explanation ? { explanation: row.explanation } : {}),
  });
}

function mapUnderstandingEvent(
  row: typeof schema.understandingEvents.$inferSelect,
): UnderstandingEvent {
  return UnderstandingEventSchema.parse({
    id: row.id,
    understandingFileId: row.understandingFileId,
    type: row.type,
    occurredAt: iso(row.occurredAt),
    metadata: row.metadata,
  });
}

function mapComprehensionQuiz(
  row: typeof schema.comprehensionQuizzes.$inferSelect,
): ComprehensionQuiz {
  return ComprehensionQuizSchema.parse({
    id: row.id,
    understandingFileId: row.understandingFileId,
    questions: row.questions,
    generatedAt: iso(row.generatedAt),
    ...(row.completedAt ? { completedAt: iso(row.completedAt) } : {}),
    ...(row.score === null ? {} : { score: row.score }),
  });
}

function contextUtilization(totalTokens: number, contextWindow: number | undefined) {
  if (!contextWindow || contextWindow <= 0) return undefined;
  return Math.round((totalTokens / contextWindow) * 1000) / 10;
}

function mapContextSnapshot(row: typeof schema.contextSnapshots.$inferSelect): ContextSnapshot {
  const utilization = contextUtilization(row.totalTokens, row.contextWindow ?? undefined);
  return ContextSnapshotSchema.parse({
    id: row.id,
    sessionId: row.sessionId,
    ...(row.stepId ? { stepId: row.stepId } : {}),
    ...(row.provider ? { provider: row.provider } : {}),
    ...(row.model ? { model: row.model } : {}),
    totalTokens: row.totalTokens,
    ...(row.contextWindow === null ? {} : { contextWindow: row.contextWindow }),
    ...(utilization === undefined ? {} : { utilizationPercent: utilization }),
    measuredAt: iso(row.measuredAt),
  });
}

function mapContextSegment(row: typeof schema.contextSegments.$inferSelect): ContextSegment {
  return ContextSegmentSchema.parse({
    id: row.id,
    snapshotId: row.snapshotId,
    category: row.category,
    label: row.label,
    tokens: row.tokens,
    percent: row.percent,
    ...(row.sourcePath ? { sourcePath: row.sourcePath } : {}),
    ...(row.preview ? { preview: row.preview } : {}),
  });
}

function mapContextInsight(row: typeof schema.contextInsights.$inferSelect): ContextInsight {
  return ContextInsightSchema.parse({
    id: row.id,
    snapshotId: row.snapshotId,
    type: row.type,
    severity: row.severity,
    title: row.title,
    detail: row.detail,
    paths: row.paths,
    ...(row.estimatedSavingsTokens === null
      ? {}
      : { estimatedSavingsTokens: row.estimatedSavingsTokens }),
  });
}

function extractFilePaths(input: JsonValue | undefined): string[] {
  if (input === undefined || input === null || typeof input !== 'object') return [];
  if (Array.isArray(input)) return [];

  const paths = new Set<string>();
  const candidateKeys = new Set([
    'path',
    'file',
    'filepath',
    'file_path',
    'filename',
    'file_name',
    'target_file',
    'targetpath',
    'target_path',
  ]);

  const visit = (value: JsonValue, depth: number): void => {
    if (depth > 4) return;
    if (typeof value === 'string') return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child, depth + 1);
      return;
    }
    if (value === null) return;

    for (const [key, child] of Object.entries(value)) {
      const normalized = key.toLowerCase();
      if (candidateKeys.has(normalized) && typeof child === 'string' && child.length > 0) {
        paths.add(path.normalize(child));
        continue;
      }
      if (normalized === 'paths' || normalized === 'files' || normalized === 'file_paths') {
        if (Array.isArray(child)) {
          for (const item of child) {
            if (typeof item === 'string' && item.length > 0) paths.add(path.normalize(item));
          }
        }
      }
    }
  };

  visit(input, 0);
  return [...paths].slice(0, 50);
}

export class Store {
  readonly #connection: CockpitDatabaseConnection;
  readonly #db;

  constructor(connection: CockpitDatabaseConnection) {
    this.#connection = connection;
    this.#db = connection.db;
  }

  close(): void {
    this.#connection.close();
  }

  ping(): boolean {
    try {
      this.#connection.raw.prepare('select 1 as ok').get();
      return true;
    } catch {
      return false;
    }
  }

  getOverviewStats(): OverviewStats {
    const row = this.#db
      .select({
        sessionCount: sql<number>`count(*)`,
        activeSessionCount: sql<number>`coalesce(sum(case when ${schema.sessions.status} = 'active' then 1 else 0 end), 0)`,
        stepCount: sql<number>`coalesce(sum(${schema.sessions.stepCount}), 0)`,
        toolCallCount: sql<number>`coalesce(sum(${schema.sessions.toolCallCount}), 0)`,
        inputTokens: sql<number>`coalesce(sum(${schema.sessions.inputTokens}), 0)`,
        outputTokens: sql<number>`coalesce(sum(${schema.sessions.outputTokens}), 0)`,
        cacheReadTokens: sql<number>`coalesce(sum(${schema.sessions.cacheReadTokens}), 0)`,
        cacheWriteTokens: sql<number>`coalesce(sum(${schema.sessions.cacheWriteTokens}), 0)`,
        totalCostUsd: sql<number>`coalesce(sum(${schema.sessions.totalCostUsd}), 0)`,
        unknownCostCalls: sql<number>`coalesce(sum(${schema.sessions.unknownCostCalls}), 0)`,
        errorCount: sql<number>`coalesce(sum(${schema.sessions.errorCount}), 0)`,
        lastSessionAt: sql<number | null>`max(${schema.sessions.startedAt})`,
      })
      .from(schema.sessions)
      .get();

    return {
      sessionCount: row?.sessionCount ?? 0,
      activeSessionCount: row?.activeSessionCount ?? 0,
      stepCount: row?.stepCount ?? 0,
      toolCallCount: row?.toolCallCount ?? 0,
      inputTokens: row?.inputTokens ?? 0,
      outputTokens: row?.outputTokens ?? 0,
      cacheReadTokens: row?.cacheReadTokens ?? 0,
      cacheWriteTokens: row?.cacheWriteTokens ?? 0,
      totalCostUsd: row?.totalCostUsd ?? 0,
      unknownCostCalls: row?.unknownCostCalls ?? 0,
      errorCount: row?.errorCount ?? 0,
      ...(row?.lastSessionAt === null || row?.lastSessionAt === undefined
        ? {}
        : { lastSessionAt: new Date(row.lastSessionAt).toISOString() }),
    };
  }

  createSession(input: CreateSessionRecordInput): Session {
    const id = createId();
    const startedAt = input.startedAt ?? new Date();
    const agent = input.agent;

    this.#db
      .insert(schema.sessions)
      .values({
        id,
        title: input.title,
        source: input.source,
        status: 'active',
        startedAt,
        tags: input.tags ?? [],
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.protocol ? { protocol: input.protocol } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(agent?.name ? { agentName: agent.name } : {}),
        ...(agent?.version ? { agentVersion: agent.version } : {}),
        ...(agent?.userAgent ? { agentUserAgent: agent.userAgent } : {}),
        ...(agent ? { agentDetectedFrom: agent.detectedFrom } : {}),
        ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
        ...(input.gitBranch ? { gitBranch: input.gitBranch } : {}),
        ...(input.gitBaseCommit ? { gitBaseCommit: input.gitBaseCommit } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      })
      .run();

    const session = this.getSession(id);
    if (!session) throw new Error('Failed to read the session that was just created.');
    return session;
  }

  getSession(id: string): Session | undefined {
    const row = this.#db.select().from(schema.sessions).where(eq(schema.sessions.id, id)).get();
    return row ? mapSession(row) : undefined;
  }

  listSessions(query: SessionListQuery): SessionPage {
    const conditions: SQL[] = [];
    if (query.projectId) conditions.push(eq(schema.sessions.projectId, query.projectId));
    if (query.status) conditions.push(eq(schema.sessions.status, query.status));
    if (query.agent) {
      conditions.push(like(schema.sessions.agentName, `%${query.agent}%`));
    }
    if (query.search) {
      const pattern = `%${query.search}%`;
      const search = or(
        like(schema.sessions.title, pattern),
        like(schema.sessions.agentName, pattern),
      );
      if (search) conditions.push(search);
    }
    if (query.from) conditions.push(gte(schema.sessions.startedAt, new Date(query.from)));
    if (query.to) conditions.push(lte(schema.sessions.startedAt, new Date(query.to)));
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      const cursorDate = new Date(cursor.startedAt);
      const pageCondition = or(
        lt(schema.sessions.startedAt, cursorDate),
        and(eq(schema.sessions.startedAt, cursorDate), lt(schema.sessions.id, cursor.id)),
      );
      if (pageCondition) conditions.push(pageCondition);
    }

    const rows = this.#db
      .select()
      .from(schema.sessions)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(schema.sessions.startedAt), desc(schema.sessions.id))
      .limit(query.limit + 1)
      .all();

    const hasMore = rows.length > query.limit;
    const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
    const sessions = pageRows.map((row) => mapSession(row));
    const last = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && last ? encodeCursor({ startedAt: iso(last.startedAt), id: last.id }) : null;

    return { sessions, nextCursor };
  }

  listActiveSessions(): Session[] {
    return this.#db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.status, 'active'))
      .orderBy(asc(schema.sessions.startedAt))
      .all()
      .map((row) => mapSession(row));
  }

  endSession(
    id: string,
    status: 'completed' | 'failed' | 'killed',
    endedAt = new Date(),
  ): Session | undefined {
    const row = this.#db.select().from(schema.sessions).where(eq(schema.sessions.id, id)).get();
    if (!row) return undefined;
    if (row.status !== 'active') return mapSession(row);

    const durationMs = Math.max(0, endedAt.getTime() - row.startedAt.getTime());
    this.#db
      .update(schema.sessions)
      .set({ status, endedAt, durationMs, updatedAt: endedAt })
      .where(eq(schema.sessions.id, id))
      .run();

    return this.getSession(id);
  }

  touchSession(id: string, input: TouchSessionInput): void {
    const patch: Partial<typeof schema.sessions.$inferInsert> = { updatedAt: new Date() };
    if (input.provider) patch.provider = input.provider;
    if (input.protocol) patch.protocol = input.protocol;
    if (input.model) patch.model = input.model;
    if (input.agent?.name) patch.agentName = input.agent.name;
    if (input.agent?.version) patch.agentVersion = input.agent.version;
    if (input.agent?.userAgent) patch.agentUserAgent = input.agent.userAgent;
    if (input.agent) patch.agentDetectedFrom = input.agent.detectedFrom;

    this.#db.update(schema.sessions).set(patch).where(eq(schema.sessions.id, id)).run();
  }

  beginStep(input: BeginStepInput): CapturedStep {
    const stepId = createId();
    const startedAt = input.startedAt ?? new Date();
    const request = input.request;

    this.#db.transaction((tx) => {
      const maxRow = tx
        .select({ maximum: sql<number | null>`max(${schema.steps.seq})` })
        .from(schema.steps)
        .where(eq(schema.steps.sessionId, input.sessionId))
        .get();
      const seq = (maxRow?.maximum ?? -1) + 1;

      tx.insert(schema.steps)
        .values({
          id: stepId,
          sessionId: input.sessionId,
          seq,
          kind: input.kind,
          status: 'running',
          startedAt,
          requestProtocol: request.protocol,
          requestMethod: request.method,
          requestPath: request.path,
          requestStream: request.stream,
          requestHeaders: request.headers,
          requestRedactionCount: request.redactionCount,
          ...(input.parentStepId ? { parentStepId: input.parentStepId } : {}),
          ...(input.provider ? { provider: input.provider } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(request.body === undefined ? {} : { requestBody: request.body }),
          ...(request.systemPrompt ? { requestSystemPrompt: request.systemPrompt } : {}),
          ...(request.promptText ? { requestPromptText: request.promptText } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        })
        .run();

      tx.update(schema.sessions)
        .set({
          stepCount: sql`${schema.sessions.stepCount} + 1`,
          modelCallCount: sql`${schema.sessions.modelCallCount} + 1`,
          ...(input.provider ? { provider: input.provider } : {}),
          ...(input.model ? { model: input.model } : {}),
          updatedAt: startedAt,
        })
        .where(eq(schema.sessions.id, input.sessionId))
        .run();
    });

    const row = this.#db.select().from(schema.steps).where(eq(schema.steps.id, stepId)).get();
    if (!row) throw new Error('Failed to read the step that was just created.');
    return mapStep(row);
  }

  completeStep(
    stepId: string,
    input: CompleteStepInput,
    toolCalls: ToolCallRecordInput[],
  ): boolean {
    const endedAt = input.endedAt ?? new Date();

    return this.#db.transaction((tx) => {
      const row = tx.select().from(schema.steps).where(eq(schema.steps.id, stepId)).get();
      if (!row || row.status !== 'running') return false;

      const durationMs = Math.max(0, endedAt.getTime() - row.startedAt.getTime());
      const metadata: JsonObject = {
        ...(row.metadata ?? {}),
        ...(input.metadata ?? {}),
      };

      tx.update(schema.steps)
        .set({
          status: input.status,
          endedAt,
          durationMs,
          responseStatus: input.responseStatus,
          responseHeaders: input.responseHeaders,
          inputTokens: input.usage.inputTokens,
          outputTokens: input.usage.outputTokens,
          cacheReadTokens: input.usage.cacheReadTokens,
          cacheWriteTokens: input.usage.cacheWriteTokens,
          reasoningTokens: input.usage.reasoningTokens,
          costKnown: input.costKnown,
          ...(input.model ? { model: input.model } : {}),
          ...(input.responseText === undefined ? {} : { responseText: input.responseText }),
          ...(input.responseThinking === undefined
            ? {}
            : { responseThinking: input.responseThinking }),
          ...(input.finishReason ? { responseFinishReason: input.finishReason } : {}),
          ...(input.error === undefined ? {} : { responseError: input.error, error: input.error }),
          ...(input.costUsd === undefined ? {} : { costUsd: input.costUsd }),
          ...(input.ttftMs === undefined ? {} : { ttftMs: input.ttftMs }),
          ...(input.latencyMs === undefined ? {} : { latencyMs: input.latencyMs }),
          ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
        })
        .where(eq(schema.steps.id, stepId))
        .run();

      for (const call of toolCalls) {
        tx.insert(schema.toolCalls)
          .values({
            id: createId(),
            sessionId: row.sessionId,
            stepId,
            name: call.name,
            status: 'completed',
            startedAt: endedAt,
            endedAt,
            filePaths: extractFilePaths(call.input),
            ...(call.providerToolCallId ? { providerToolCallId: call.providerToolCallId } : {}),
            ...(call.input === undefined ? {} : { input: call.input }),
          })
          .run();
      }

      const isError = input.status === 'failed' || input.status === 'blocked';
      tx.update(schema.sessions)
        .set({
          toolCallCount: sql`${schema.sessions.toolCallCount} + ${toolCalls.length}`,
          inputTokens: sql`${schema.sessions.inputTokens} + ${input.usage.inputTokens}`,
          outputTokens: sql`${schema.sessions.outputTokens} + ${input.usage.outputTokens}`,
          cacheReadTokens: sql`${schema.sessions.cacheReadTokens} + ${input.usage.cacheReadTokens}`,
          cacheWriteTokens: sql`${schema.sessions.cacheWriteTokens} + ${input.usage.cacheWriteTokens}`,
          reasoningTokens: sql`${schema.sessions.reasoningTokens} + ${input.usage.reasoningTokens}`,
          totalCostUsd: sql`${schema.sessions.totalCostUsd} + ${input.costUsd ?? 0}`,
          unknownCostCalls: sql`${schema.sessions.unknownCostCalls} + ${input.costKnown ? 0 : 1}`,
          errorCount: sql`${schema.sessions.errorCount} + ${isError ? 1 : 0}`,
          updatedAt: endedAt,
        })
        .where(eq(schema.sessions.id, row.sessionId))
        .run();

      return true;
    });
  }

  insertRedactions(stepId: string, redactions: RedactionRecordInput[]): void {
    if (redactions.length === 0) return;
    this.#db
      .insert(schema.redactions)
      .values(
        redactions.map((redaction) => ({
          id: createId(),
          stepId,
          ruleId: redaction.ruleId,
          label: redaction.label,
          location: redaction.location,
          occurrences: redaction.occurrences,
        })),
      )
      .run();
  }

  insertStreamChunks(chunks: StreamChunkInput[]): void {
    if (chunks.length === 0) return;
    this.#db
      .insert(schema.streamChunks)
      .values(
        chunks.map((chunk) => ({
          id: createId(),
          stepId: chunk.stepId,
          seq: chunk.seq,
          kind: chunk.kind,
          data: chunk.data,
          receivedAt: chunk.receivedAt,
          ...(chunk.deltaText === undefined ? {} : { deltaText: chunk.deltaText }),
        })),
      )
      .run();
  }

  getStep(stepId: string): CapturedStep | undefined {
    const row = this.#db.select().from(schema.steps).where(eq(schema.steps.id, stepId)).get();
    return row ? mapStep(row) : undefined;
  }

  listSteps(sessionId: string, limit = 1000): CapturedStep[] {
    return this.#db
      .select()
      .from(schema.steps)
      .where(eq(schema.steps.sessionId, sessionId))
      .orderBy(asc(schema.steps.seq))
      .limit(limit)
      .all()
      .map((row) => mapStep(row));
  }

  listStreamChunks(stepId: string): CapturedStreamChunk[] {
    return this.#db
      .select()
      .from(schema.streamChunks)
      .where(eq(schema.streamChunks.stepId, stepId))
      .orderBy(asc(schema.streamChunks.seq))
      .all()
      .map((row) => mapChunk(row));
  }

  listToolCalls(stepId: string): ToolCallTrace[] {
    return this.#db
      .select()
      .from(schema.toolCalls)
      .where(eq(schema.toolCalls.stepId, stepId))
      .orderBy(asc(schema.toolCalls.startedAt))
      .all()
      .map((row) => mapToolCall(row));
  }

  insertSnapshot(input: InsertSnapshotInput): ReplaySnapshot {
    const id = createId();

    this.#db.transaction((tx) => {
      tx.insert(schema.gitSnapshots)
        .values({
          id,
          sessionId: input.sessionId,
          kind: input.kind,
          createdAt: input.createdAt ?? new Date(),
          filesChanged: input.filesChanged,
          insertions: input.insertions,
          deletions: input.deletions,
          ...(input.stepId ? { stepId: input.stepId } : {}),
          ...(input.commitSha ? { commitSha: input.commitSha } : {}),
          ...(input.parentCommitSha ? { parentCommitSha: input.parentCommitSha } : {}),
          ...(input.branch ? { branch: input.branch } : {}),
          ...(input.worktreePath ? { worktreePath: input.worktreePath } : {}),
          ...(input.patch ? { patch: input.patch } : {}),
        })
        .run();

      for (const file of input.fileChanges) {
        tx.insert(schema.fileChanges)
          .values({
            id: createId(),
            snapshotId: id,
            path: file.path,
            changeType: file.changeType,
            additions: file.additions,
            deletions: file.deletions,
            ...(file.oldPath ? { oldPath: file.oldPath } : {}),
            ...(file.diff ? { diff: file.diff } : {}),
            ...(file.aiAuthored === undefined ? {} : { aiAuthored: file.aiAuthored }),
          })
          .run();
      }
    });

    const snapshot = this.getSnapshot(id);
    if (!snapshot) throw new Error('Failed to read the snapshot that was just created.');
    return snapshot;
  }

  getSnapshot(id: string): ReplaySnapshot | undefined {
    const row = this.#db
      .select()
      .from(schema.gitSnapshots)
      .where(eq(schema.gitSnapshots.id, id))
      .get();
    return row ? mapSnapshot(row) : undefined;
  }

  listSnapshots(sessionId: string): ReplaySnapshot[] {
    return this.#db
      .select()
      .from(schema.gitSnapshots)
      .where(eq(schema.gitSnapshots.sessionId, sessionId))
      .orderBy(asc(schema.gitSnapshots.createdAt), sql`rowid asc`)
      .all()
      .map((row) => mapSnapshot(row));
  }

  latestSnapshot(sessionId: string): ReplaySnapshot | undefined {
    return this.listSnapshots(sessionId).at(-1);
  }

  listSnapshotFileChanges(snapshotId: string): ReplayFileChange[] {
    return this.#db
      .select()
      .from(schema.fileChanges)
      .where(eq(schema.fileChanges.snapshotId, snapshotId))
      .orderBy(asc(schema.fileChanges.path))
      .all()
      .map((row) => mapFileChange(row));
  }

  /**
   * Return the newest snapshot at or before the selected step. Snapshots are
   * chained working-tree commits, so the closest earlier snapshot represents
   * the state a fork should start from.
   */
  resolveSnapshotForStep(sessionId: string, stepId?: string): ReplaySnapshot | undefined {
    const snapshots = this.listSnapshots(sessionId);
    if (snapshots.length === 0) return undefined;
    if (!stepId) return snapshots.at(-1);

    const target = this.getStep(stepId);
    if (!target || target.sessionId !== sessionId) return snapshots.at(-1);

    const stepSequence = new Map(
      this.listSteps(sessionId, 1_000_000).map((step) => [step.id, step.seq]),
    );

    let selected: ReplaySnapshot | undefined;
    for (const snapshot of snapshots) {
      if (!snapshot.stepId) {
        if (!selected) selected = snapshot;
        continue;
      }
      const sequence = stepSequence.get(snapshot.stepId);
      if (sequence === undefined || sequence > target.seq) continue;
      selected = snapshot;
    }
    return selected ?? snapshots[0];
  }

  insertFork(input: InsertForkInput): ReplayFork {
    const id = createId();
    this.#db
      .insert(schema.replayForks)
      .values({
        id,
        sessionId: input.sessionId,
        branch: input.branch,
        worktreePath: input.worktreePath,
        resumeBrief: input.resumeBrief,
        status: input.status ?? 'ready',
        ...(input.stepId ? { stepId: input.stepId } : {}),
        ...(input.baseCommit ? { baseCommit: input.baseCommit } : {}),
      })
      .run();

    const fork = this.getFork(id);
    if (!fork) throw new Error('Failed to read the fork that was just created.');
    return fork;
  }

  getFork(id: string): ReplayFork | undefined {
    const row = this.#db
      .select()
      .from(schema.replayForks)
      .where(eq(schema.replayForks.id, id))
      .get();
    return row ? mapFork(row) : undefined;
  }

  listForks(sessionId: string): ReplayFork[] {
    return this.#db
      .select()
      .from(schema.replayForks)
      .where(eq(schema.replayForks.sessionId, sessionId))
      .orderBy(desc(schema.replayForks.createdAt), desc(schema.replayForks.id))
      .all()
      .map((row) => mapFork(row));
  }

  updateForkStatus(id: string, status: ReplayForkStatus): ReplayFork | undefined {
    this.#db.update(schema.replayForks).set({ status }).where(eq(schema.replayForks.id, id)).run();
    return this.getFork(id);
  }

  listGuardRules(): GuardRule[] {
    return this.#db
      .select()
      .from(schema.guardRules)
      .orderBy(asc(schema.guardRules.priority), asc(schema.guardRules.id))
      .all()
      .map((row) => mapGuardRule(row));
  }

  getGuardRule(id: string): GuardRule | undefined {
    const row = this.#db.select().from(schema.guardRules).where(eq(schema.guardRules.id, id)).get();
    return row ? mapGuardRule(row) : undefined;
  }

  createGuardRule(input: CreateGuardRuleInput): GuardRule {
    const id = input.id ?? createId();
    this.#db
      .insert(schema.guardRules)
      .values({
        id,
        name: input.name,
        description: input.description,
        kind: input.kind,
        action: input.action,
        severity: input.severity,
        source: input.source ?? 'user',
        enabled: input.enabled,
        priority: input.priority,
        config: input.config,
      })
      .run();

    const rule = this.getGuardRule(id);
    if (!rule) throw new Error('Failed to read the guard rule that was just created.');
    return rule;
  }

  updateGuardRule(id: string, patch: GuardRulePatch): GuardRule | undefined {
    const existing = this.getGuardRule(id);
    if (!existing) return undefined;

    const values: Partial<typeof schema.guardRules.$inferInsert> = { updatedAt: new Date() };
    if (patch.name !== undefined) values.name = patch.name;
    if (patch.description !== undefined) values.description = patch.description;
    if (patch.kind !== undefined) values.kind = patch.kind;
    if (patch.action !== undefined) values.action = patch.action;
    if (patch.severity !== undefined) values.severity = patch.severity;
    if (patch.enabled !== undefined) values.enabled = patch.enabled;
    if (patch.priority !== undefined) values.priority = patch.priority;
    if (patch.config !== undefined) values.config = patch.config;

    this.#db.update(schema.guardRules).set(values).where(eq(schema.guardRules.id, id)).run();
    return this.getGuardRule(id);
  }

  deleteGuardRule(id: string): boolean {
    const result = this.#db.delete(schema.guardRules).where(eq(schema.guardRules.id, id)).run();
    return result.changes > 0;
  }

  insertGuardEvent(input: InsertGuardEventInput): GuardEvent {
    const id = createId();
    this.#db
      .insert(schema.guardEvents)
      .values({
        id,
        sessionId: input.sessionId,
        ruleId: input.ruleId,
        kind: input.kind,
        action: input.action,
        severity: input.severity,
        status: input.status,
        title: input.title,
        description: input.description ?? '',
        evidence: input.evidence ?? [],
        requestedAt: input.requestedAt ?? new Date(),
        ...(input.stepId ? { stepId: input.stepId } : {}),
        ...(input.command ? { command: input.command } : {}),
        ...(input.resolvedAt ? { resolvedAt: input.resolvedAt } : {}),
        ...(input.resolvedBy ? { resolvedBy: input.resolvedBy } : {}),
        ...(input.resolutionNote ? { resolutionNote: input.resolutionNote } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      })
      .run();

    const event = this.getGuardEvent(id);
    if (!event) throw new Error('Failed to read the guard event that was just created.');
    return event;
  }

  getGuardEvent(id: string): GuardEvent | undefined {
    const row = this.#db
      .select()
      .from(schema.guardEvents)
      .where(eq(schema.guardEvents.id, id))
      .get();
    return row ? mapGuardEvent(row) : undefined;
  }

  listGuardEvents(query: GuardEventListQuery): GuardEvent[] {
    const conditions: SQL[] = [];
    if (query.sessionId) conditions.push(eq(schema.guardEvents.sessionId, query.sessionId));
    if (query.status) conditions.push(eq(schema.guardEvents.status, query.status));
    if (query.kind) conditions.push(eq(schema.guardEvents.kind, query.kind));

    return this.#db
      .select()
      .from(schema.guardEvents)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(schema.guardEvents.requestedAt), desc(schema.guardEvents.id))
      .limit(query.limit)
      .all()
      .map((row) => mapGuardEvent(row));
  }

  updateGuardEvent(id: string, patch: UpdateGuardEventInput): GuardEvent | undefined {
    const values: Partial<typeof schema.guardEvents.$inferInsert> = {};
    if (patch.status !== undefined) values.status = patch.status;
    if (patch.resolvedAt !== undefined) values.resolvedAt = patch.resolvedAt;
    if (patch.resolvedBy !== undefined) values.resolvedBy = patch.resolvedBy;
    if (patch.resolutionNote !== undefined) values.resolutionNote = patch.resolutionNote;
    if (Object.keys(values).length === 0) return this.getGuardEvent(id);

    this.#db.update(schema.guardEvents).set(values).where(eq(schema.guardEvents.id, id)).run();
    return this.getGuardEvent(id);
  }

  listPendingGuardEvents(sessionId?: string): GuardEvent[] {
    const conditions: SQL[] = [eq(schema.guardEvents.status, 'pending')];
    if (sessionId) conditions.push(eq(schema.guardEvents.sessionId, sessionId));
    return this.#db
      .select()
      .from(schema.guardEvents)
      .where(and(...conditions))
      .orderBy(asc(schema.guardEvents.requestedAt))
      .all()
      .map((row) => mapGuardEvent(row));
  }

  expireStaleGuardEvents(olderThan: Date): number {
    const result = this.#db
      .update(schema.guardEvents)
      .set({
        status: 'expired',
        resolvedAt: new Date(),
        resolvedBy: 'cockpit',
        resolutionNote: 'The approval window elapsed.',
      })
      .where(
        and(
          eq(schema.guardEvents.status, 'pending'),
          lt(schema.guardEvents.requestedAt, olderThan),
        ),
      )
      .run();
    return result.changes;
  }

  deleteSecretScanEvents(sessionId: string): number {
    const result = this.#db
      .delete(schema.guardEvents)
      .where(
        and(
          eq(schema.guardEvents.sessionId, sessionId),
          like(schema.guardEvents.ruleId, 'secret-scan:%'),
          ne(schema.guardEvents.status, 'pending'),
          // Request-time findings carry source "request"/"response"; only
          // rescan-generated rows are replaced. Legacy rows without metadata
          // are treated as scans so repeated rescans stay idempotent.
          sql`coalesce(json_extract(${schema.guardEvents.metadata}, '$.source'), 'scan') = 'scan'`,
        ),
      )
      .run();
    return result.changes;
  }

  listSessionRedactions(sessionId: string): SessionRedactionRow[] {
    return this.#db
      .select({
        stepId: schema.redactions.stepId,
        ruleId: schema.redactions.ruleId,
        label: schema.redactions.label,
        location: schema.redactions.location,
        occurrences: schema.redactions.occurrences,
      })
      .from(schema.redactions)
      .innerJoin(schema.steps, eq(schema.redactions.stepId, schema.steps.id))
      .where(eq(schema.steps.sessionId, sessionId))
      .all();
  }

  listRecentPromptTexts(sessionId: string, limit = 20): string[] {
    return this.#db
      .select({ promptText: schema.steps.requestPromptText })
      .from(schema.steps)
      .where(
        and(
          eq(schema.steps.sessionId, sessionId),
          sql`${schema.steps.requestPromptText} is not null`,
        ),
      )
      .orderBy(desc(schema.steps.seq))
      .limit(limit)
      .all()
      .flatMap((row) => (row.promptText ? [row.promptText] : []));
  }

  listBudgetPolicies(): BudgetPolicy[] {
    return this.#db
      .select()
      .from(schema.budgetPolicies)
      .orderBy(desc(schema.budgetPolicies.createdAt), desc(schema.budgetPolicies.id))
      .all()
      .map((row) => mapBudgetPolicy(row));
  }

  getBudgetPolicy(id: string): BudgetPolicy | undefined {
    const row = this.#db
      .select()
      .from(schema.budgetPolicies)
      .where(eq(schema.budgetPolicies.id, id))
      .get();
    return row ? mapBudgetPolicy(row) : undefined;
  }

  createBudgetPolicy(input: BudgetPolicyInput): BudgetPolicy {
    const id = createId();
    this.#db
      .insert(schema.budgetPolicies)
      .values({
        id,
        name: input.name,
        scope: input.scope,
        period: input.period,
        limitUsd: input.limitUsd,
        enforcement: input.enforcement,
        enabled: input.enabled,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      })
      .run();

    const policy = this.getBudgetPolicy(id);
    if (!policy) throw new Error('Failed to read the budget policy that was just created.');
    return policy;
  }

  updateBudgetPolicy(id: string, patch: BudgetPolicyPatch): BudgetPolicy | undefined {
    const existing = this.getBudgetPolicy(id);
    if (!existing) return undefined;

    const values: Partial<typeof schema.budgetPolicies.$inferInsert> = { updatedAt: new Date() };
    if (patch.name !== undefined) values.name = patch.name;
    if (patch.scope !== undefined) values.scope = patch.scope;
    if (patch.period !== undefined) values.period = patch.period;
    if (patch.projectId !== undefined) values.projectId = patch.projectId;
    if (patch.sessionId !== undefined) values.sessionId = patch.sessionId;
    if (patch.limitUsd !== undefined) values.limitUsd = patch.limitUsd;
    if (patch.enforcement !== undefined) values.enforcement = patch.enforcement;
    if (patch.enabled !== undefined) values.enabled = patch.enabled;

    this.#db
      .update(schema.budgetPolicies)
      .set(values)
      .where(eq(schema.budgetPolicies.id, id))
      .run();
    return this.getBudgetPolicy(id);
  }

  deleteBudgetPolicy(id: string): boolean {
    const result = this.#db
      .delete(schema.budgetPolicies)
      .where(eq(schema.budgetPolicies.id, id))
      .run();
    return result.changes > 0;
  }

  sessionCostUsd(sessionId: string): number {
    return this.getSession(sessionId)?.totals.totalCostUsd ?? 0;
  }

  spendSince(from: Date, projectId?: string): number {
    const conditions: SQL[] = [gte(schema.sessions.startedAt, from)];
    if (projectId) conditions.push(eq(schema.sessions.projectId, projectId));
    const row = this.#db
      .select({ total: sql<number>`coalesce(sum(${schema.sessions.totalCostUsd}), 0)` })
      .from(schema.sessions)
      .where(and(...conditions))
      .get();
    return row?.total ?? 0;
  }

  replaceCheatAnalysis(input: InsertCheatAnalysisInput): CheatAnalysis {
    const analysisId = createId();
    const generatedAt = input.generatedAt ?? new Date();

    this.#db.transaction((tx) => {
      tx.delete(schema.cheatAnalyses)
        .where(eq(schema.cheatAnalyses.sessionId, input.sessionId))
        .run();

      tx.insert(schema.cheatAnalyses)
        .values({
          id: analysisId,
          sessionId: input.sessionId,
          trustScore: input.trustScore,
          grade: input.grade,
          findingsCount: input.findings.length,
          filesExamined: input.filesExamined,
          generatedAt,
          ...(input.stepId ? { stepId: input.stepId } : {}),
        })
        .run();

      for (const finding of input.findings) {
        tx.insert(schema.cheatFindings)
          .values({
            id: finding.id,
            analysisId,
            sessionId: input.sessionId,
            category: finding.category,
            severity: finding.severity,
            title: finding.title,
            detail: finding.detail,
            detector: finding.detector,
            confidence: finding.confidence,
            evidence: finding.evidence,
            createdAt: new Date(finding.createdAt),
            ...(finding.stepId ? { stepId: finding.stepId } : {}),
            ...(finding.suggestion ? { suggestion: finding.suggestion } : {}),
          })
          .run();
      }
    });

    const analysis = this.getLatestCheatAnalysis(input.sessionId);
    if (!analysis) throw new Error('Failed to read the cheat analysis that was just created.');
    return analysis;
  }

  getLatestCheatAnalysis(sessionId: string): CheatAnalysis | undefined {
    const row = this.#db
      .select()
      .from(schema.cheatAnalyses)
      .where(eq(schema.cheatAnalyses.sessionId, sessionId))
      .orderBy(desc(schema.cheatAnalyses.generatedAt), desc(schema.cheatAnalyses.id))
      .limit(1)
      .get();
    if (!row) return undefined;

    const findings = this.#db
      .select()
      .from(schema.cheatFindings)
      .where(eq(schema.cheatFindings.analysisId, row.id))
      .orderBy(desc(schema.cheatFindings.createdAt), asc(schema.cheatFindings.id))
      .all()
      .map((finding) => mapCheatFinding(finding));

    return CheatAnalysisSchema.parse({
      sessionId: row.sessionId,
      trustScore: row.trustScore,
      grade: row.grade,
      findings,
      filesExamined: row.filesExamined,
      generatedAt: iso(row.generatedAt),
    });
  }

  ensureProject(rootPath: string, name?: string): Project {
    const resolved = path.resolve(rootPath);
    const now = new Date();
    const existing = this.#db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.rootPath, resolved))
      .get();

    if (existing) {
      this.#db
        .update(schema.projects)
        .set({ lastOpenedAt: now, updatedAt: now })
        .where(eq(schema.projects.id, existing.id))
        .run();
      const updated = this.#db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, existing.id))
        .get();
      if (!updated) throw new Error('Failed to read the project that was just updated.');
      return mapProject(updated);
    }

    const id = createId();
    const projectName = name?.trim() || path.basename(resolved) || 'Workspace';
    this.#db
      .insert(schema.projects)
      .values({ id, name: projectName.slice(0, 200), rootPath: resolved, lastOpenedAt: now })
      .run();

    const created = this.#db.select().from(schema.projects).where(eq(schema.projects.id, id)).get();
    if (!created) throw new Error('Failed to read the project that was just created.');
    return mapProject(created);
  }

  setSessionProject(sessionId: string, projectId: string): void {
    this.#db
      .update(schema.sessions)
      .set({ projectId, updatedAt: new Date() })
      .where(eq(schema.sessions.id, sessionId))
      .run();
  }

  getProject(id: string): Project | undefined {
    const row = this.#db.select().from(schema.projects).where(eq(schema.projects.id, id)).get();
    return row ? mapProject(row) : undefined;
  }

  listProjects(): Project[] {
    return this.#db
      .select()
      .from(schema.projects)
      .orderBy(desc(schema.projects.updatedAt), asc(schema.projects.id))
      .all()
      .map((row) => mapProject(row));
  }

  insertProvenanceEntries(inputs: readonly InsertProvenanceInput[]): ProvenanceEntry[] {
    if (inputs.length === 0) return [];
    const now = new Date();
    const entries = inputs.map((input) => {
      const capturedAt = input.capturedAt ?? now;
      return {
        id: createId(),
        projectId: input.projectId,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.stepId ? { stepId: input.stepId } : {}),
        filePath: input.filePath,
        lineStart: input.lineStart,
        lineEnd: input.lineEnd,
        ...(input.commitSha ? { commitSha: input.commitSha } : {}),
        contentHash: input.contentHash,
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.promptExcerpt ? { promptExcerpt: input.promptExcerpt } : {}),
        confidence: input.confidence ?? 1,
        capturedAt,
      };
    });

    this.#db.transaction((tx) => {
      tx.insert(schema.provenanceEntries)
        .values(
          entries.map((entry) => ({
            ...entry,
            capturedAt: entry.capturedAt,
          })),
        )
        .run();
    });

    return entries.map((entry) =>
      ProvenanceEntrySchema.parse({ ...entry, capturedAt: iso(entry.capturedAt) }),
    );
  }

  deleteProvenanceForSession(sessionId: string): number {
    return this.#db
      .delete(schema.provenanceEntries)
      .where(eq(schema.provenanceEntries.sessionId, sessionId))
      .run().changes;
  }

  deleteProvenanceForStep(stepId: string): number {
    return this.#db
      .delete(schema.provenanceEntries)
      .where(eq(schema.provenanceEntries.stepId, stepId))
      .run().changes;
  }

  listProvenanceEntries(query: {
    projectId?: string;
    sessionId?: string;
    stepId?: string;
    filePath?: string;
    limit?: number;
  }): ProvenanceEntry[] {
    const conditions: SQL[] = [];
    if (query.projectId) {
      conditions.push(eq(schema.provenanceEntries.projectId, query.projectId));
    }
    if (query.sessionId) {
      conditions.push(eq(schema.provenanceEntries.sessionId, query.sessionId));
    }
    if (query.stepId) {
      conditions.push(eq(schema.provenanceEntries.stepId, query.stepId));
    }
    if (query.filePath) {
      conditions.push(eq(schema.provenanceEntries.filePath, query.filePath));
    }

    return this.#db
      .select()
      .from(schema.provenanceEntries)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(schema.provenanceEntries.capturedAt), desc(schema.provenanceEntries.id))
      .limit(query.limit ?? 5000)
      .all()
      .map((row) => mapProvenanceEntry(row));
  }

  getUnderstandingFile(id: string): UnderstandingFile | undefined {
    const row = this.#db
      .select()
      .from(schema.understandingFiles)
      .where(eq(schema.understandingFiles.id, id))
      .get();
    return row ? mapUnderstandingFile(row) : undefined;
  }

  getUnderstandingFileByPath(projectId: string, filePath: string): UnderstandingFile | undefined {
    const row = this.#db
      .select()
      .from(schema.understandingFiles)
      .where(
        and(
          eq(schema.understandingFiles.projectId, projectId),
          eq(schema.understandingFiles.path, filePath),
        ),
      )
      .get();
    return row ? mapUnderstandingFile(row) : undefined;
  }

  listUnderstandingFiles(query: {
    projectId?: string;
    sessionId?: string;
    status?: UnderstandingStatus;
    limit?: number;
  }): UnderstandingFile[] {
    const conditions: SQL[] = [];
    if (query.projectId) {
      conditions.push(eq(schema.understandingFiles.projectId, query.projectId));
    }
    if (query.sessionId) {
      conditions.push(eq(schema.understandingFiles.sessionId, query.sessionId));
    }
    if (query.status) {
      conditions.push(eq(schema.understandingFiles.status, query.status));
    }

    return this.#db
      .select()
      .from(schema.understandingFiles)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(schema.understandingFiles.lastTouchedAt), asc(schema.understandingFiles.path))
      .limit(query.limit ?? 200)
      .all()
      .map((row) => mapUnderstandingFile(row));
  }

  createUnderstandingFile(input: CreateUnderstandingFileInput): UnderstandingFile {
    const id = createId();
    const now = new Date();
    this.#db
      .insert(schema.understandingFiles)
      .values({
        id,
        projectId: input.projectId,
        path: input.path,
        aiLines: Math.max(0, Math.trunc(input.aiLines)),
        reviewedLines: Math.max(0, Math.trunc(input.reviewedLines ?? 0)),
        status: input.status ?? 'unseen',
        firstTouchedAt: input.firstTouchedAt ?? now,
        lastTouchedAt: input.lastTouchedAt ?? now,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.lastOpenedAt ? { lastOpenedAt: input.lastOpenedAt } : {}),
        ...(input.acknowledgedAt ? { acknowledgedAt: input.acknowledgedAt } : {}),
        ...(input.explanation ? { explanation: input.explanation } : {}),
      })
      .run();

    const file = this.getUnderstandingFile(id);
    if (!file) throw new Error('Failed to read the understanding file that was just created.');
    return file;
  }

  updateUnderstandingFile(
    id: string,
    patch: UpdateUnderstandingFileInput,
  ): UnderstandingFile | undefined {
    const existing = this.getUnderstandingFile(id);
    if (!existing) return undefined;

    const values: Partial<typeof schema.understandingFiles.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (patch.sessionId !== undefined) values.sessionId = patch.sessionId;
    if (patch.aiLines !== undefined) values.aiLines = Math.max(0, Math.trunc(patch.aiLines));
    if (patch.reviewedLines !== undefined) {
      values.reviewedLines = Math.max(0, Math.trunc(patch.reviewedLines));
    }
    if (patch.status !== undefined) values.status = patch.status;
    if (patch.lastTouchedAt !== undefined) values.lastTouchedAt = patch.lastTouchedAt;
    if (patch.lastOpenedAt !== undefined) values.lastOpenedAt = patch.lastOpenedAt;
    if (patch.acknowledgedAt !== undefined) values.acknowledgedAt = patch.acknowledgedAt;
    if (patch.explanation !== undefined) values.explanation = patch.explanation;

    this.#db
      .update(schema.understandingFiles)
      .set(values)
      .where(eq(schema.understandingFiles.id, id))
      .run();
    return this.getUnderstandingFile(id);
  }

  insertUnderstandingEvent(input: InsertUnderstandingEventInput): UnderstandingEvent {
    const id = createId();
    this.#db
      .insert(schema.understandingEvents)
      .values({
        id,
        understandingFileId: input.understandingFileId,
        type: input.type,
        occurredAt: input.occurredAt ?? new Date(),
        metadata: input.metadata ?? {},
      })
      .run();

    const row = this.#db
      .select()
      .from(schema.understandingEvents)
      .where(eq(schema.understandingEvents.id, id))
      .get();
    if (!row) throw new Error('Failed to read the understanding event that was just created.');
    return mapUnderstandingEvent(row);
  }

  listUnderstandingEvents(understandingFileId: string, limit = 200): UnderstandingEvent[] {
    return this.#db
      .select()
      .from(schema.understandingEvents)
      .where(eq(schema.understandingEvents.understandingFileId, understandingFileId))
      .orderBy(desc(schema.understandingEvents.occurredAt), desc(schema.understandingEvents.id))
      .limit(limit)
      .all()
      .map((row) => mapUnderstandingEvent(row));
  }

  createComprehensionQuiz(input: CreateComprehensionQuizInput): ComprehensionQuiz {
    const id = createId();
    this.#db
      .insert(schema.comprehensionQuizzes)
      .values({
        id,
        understandingFileId: input.understandingFileId,
        questions: input.questions,
        generatedAt: input.generatedAt ?? new Date(),
      })
      .run();

    const quiz = this.getComprehensionQuiz(id);
    if (!quiz) throw new Error('Failed to read the comprehension quiz that was just created.');
    return quiz;
  }

  getComprehensionQuiz(id: string): ComprehensionQuiz | undefined {
    const row = this.#db
      .select()
      .from(schema.comprehensionQuizzes)
      .where(eq(schema.comprehensionQuizzes.id, id))
      .get();
    return row ? mapComprehensionQuiz(row) : undefined;
  }

  listComprehensionQuizzes(understandingFileId: string): ComprehensionQuiz[] {
    return this.#db
      .select()
      .from(schema.comprehensionQuizzes)
      .where(eq(schema.comprehensionQuizzes.understandingFileId, understandingFileId))
      .orderBy(desc(schema.comprehensionQuizzes.generatedAt), desc(schema.comprehensionQuizzes.id))
      .all()
      .map((row) => mapComprehensionQuiz(row));
  }

  getLatestComprehensionQuiz(understandingFileId: string): ComprehensionQuiz | undefined {
    const row = this.#db
      .select()
      .from(schema.comprehensionQuizzes)
      .where(eq(schema.comprehensionQuizzes.understandingFileId, understandingFileId))
      .orderBy(desc(schema.comprehensionQuizzes.generatedAt), desc(schema.comprehensionQuizzes.id))
      .limit(1)
      .get();
    return row ? mapComprehensionQuiz(row) : undefined;
  }

  completeComprehensionQuiz(
    id: string,
    score: number,
    completedAt = new Date(),
  ): ComprehensionQuiz | undefined {
    this.#db
      .update(schema.comprehensionQuizzes)
      .set({ score, completedAt })
      .where(eq(schema.comprehensionQuizzes.id, id))
      .run();
    return this.getComprehensionQuiz(id);
  }

  insertContextSnapshot(input: InsertContextSnapshotInput): ContextSnapshot {
    const id = createId();
    const measuredAt = input.measuredAt ?? new Date();

    this.#db.transaction((tx) => {
      tx.insert(schema.contextSnapshots)
        .values({
          id,
          sessionId: input.sessionId,
          totalTokens: input.totalTokens,
          measuredAt,
          ...(input.stepId ? { stepId: input.stepId } : {}),
          ...(input.provider ? { provider: input.provider } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(input.contextWindow ? { contextWindow: input.contextWindow } : {}),
        })
        .run();

      for (const segment of input.segments) {
        tx.insert(schema.contextSegments)
          .values({
            id: createId(),
            snapshotId: id,
            category: segment.category,
            label: segment.label,
            tokens: segment.tokens,
            percent: segment.percent,
            ...(segment.sourcePath ? { sourcePath: segment.sourcePath } : {}),
            ...(segment.preview ? { preview: segment.preview } : {}),
          })
          .run();
      }

      for (const insight of input.insights) {
        tx.insert(schema.contextInsights)
          .values({
            id: createId(),
            snapshotId: id,
            type: insight.type,
            severity: insight.severity,
            title: insight.title,
            detail: insight.detail,
            paths: insight.paths ?? [],
            ...(insight.estimatedSavingsTokens === undefined
              ? {}
              : { estimatedSavingsTokens: insight.estimatedSavingsTokens }),
          })
          .run();
      }
    });

    const snapshot = this.getContextSnapshot(id);
    if (!snapshot) throw new Error('Failed to read the context snapshot that was just created.');
    return snapshot;
  }

  getContextSnapshot(id: string): ContextSnapshot | undefined {
    const row = this.#db
      .select()
      .from(schema.contextSnapshots)
      .where(eq(schema.contextSnapshots.id, id))
      .get();
    return row ? mapContextSnapshot(row) : undefined;
  }

  listContextSnapshots(sessionId: string, limit = 200): ContextSnapshot[] {
    return this.#db
      .select()
      .from(schema.contextSnapshots)
      .where(eq(schema.contextSnapshots.sessionId, sessionId))
      .orderBy(asc(schema.contextSnapshots.measuredAt), asc(schema.contextSnapshots.id))
      .limit(limit)
      .all()
      .map((row) => mapContextSnapshot(row));
  }

  getLatestContextSnapshot(sessionId: string): ContextSnapshot | undefined {
    const row = this.#db
      .select()
      .from(schema.contextSnapshots)
      .where(eq(schema.contextSnapshots.sessionId, sessionId))
      .orderBy(desc(schema.contextSnapshots.measuredAt), desc(schema.contextSnapshots.id))
      .limit(1)
      .get();
    return row ? mapContextSnapshot(row) : undefined;
  }

  listContextSegments(snapshotId: string): ContextSegment[] {
    return this.#db
      .select()
      .from(schema.contextSegments)
      .where(eq(schema.contextSegments.snapshotId, snapshotId))
      .orderBy(desc(schema.contextSegments.tokens), asc(schema.contextSegments.id))
      .all()
      .map((row) => mapContextSegment(row));
  }

  listContextInsights(snapshotId: string): ContextInsight[] {
    return this.#db
      .select()
      .from(schema.contextInsights)
      .where(eq(schema.contextInsights.snapshotId, snapshotId))
      .orderBy(asc(schema.contextInsights.severity), asc(schema.contextInsights.id))
      .all()
      .map((row) => mapContextInsight(row));
  }

  deleteContextSnapshots(sessionId: string): number {
    return this.#db
      .delete(schema.contextSnapshots)
      .where(eq(schema.contextSnapshots.sessionId, sessionId))
      .run().changes;
  }

  listSessionChangedPaths(sessionId: string): string[] {
    const rows = this.#db
      .select({ path: schema.fileChanges.path })
      .from(schema.fileChanges)
      .innerJoin(schema.gitSnapshots, eq(schema.fileChanges.snapshotId, schema.gitSnapshots.id))
      .where(eq(schema.gitSnapshots.sessionId, sessionId))
      .all();
    return [...new Set(rows.map((row) => row.path))];
  }

  listSessionsBetween(from: Date, to: Date, projectId?: string, agent?: string): Session[] {
    const conditions: SQL[] = [
      gte(schema.sessions.startedAt, from),
      lte(schema.sessions.startedAt, to),
    ];
    if (projectId) conditions.push(eq(schema.sessions.projectId, projectId));
    if (agent) conditions.push(eq(schema.sessions.agentName, agent));

    return this.#db
      .select()
      .from(schema.sessions)
      .where(and(...conditions))
      .orderBy(asc(schema.sessions.startedAt), asc(schema.sessions.id))
      .all()
      .map((row) => mapSession(row));
  }

  listBrainSources(projectId: string): BrainSource[] {
    return this.#db
      .select()
      .from(schema.brainSources)
      .where(eq(schema.brainSources.projectId, projectId))
      .orderBy(asc(schema.brainSources.path))
      .all()
      .map((row) => mapBrainSource(row));
  }

  deleteBrainSources(projectId: string): number {
    return this.#db
      .delete(schema.brainSources)
      .where(eq(schema.brainSources.projectId, projectId))
      .run().changes;
  }

  getBrainSource(projectId: string, sourcePath: string): BrainSource | undefined {
    const row = this.#db
      .select()
      .from(schema.brainSources)
      .where(
        and(eq(schema.brainSources.projectId, projectId), eq(schema.brainSources.path, sourcePath)),
      )
      .get();
    return row ? mapBrainSource(row) : undefined;
  }

  upsertBrainSource(input: UpsertBrainSourceInput): BrainSource {
    const existing = this.getBrainSource(input.projectId, input.path);
    if (existing) {
      this.#db
        .update(schema.brainSources)
        .set({ content: input.content, checksum: input.checksum, updatedAt: new Date() })
        .where(eq(schema.brainSources.id, existing.id))
        .run();
    } else {
      this.#db
        .insert(schema.brainSources)
        .values({
          id: createId(),
          projectId: input.projectId,
          path: input.path,
          content: input.content,
          checksum: input.checksum,
        })
        .run();
    }

    const source = this.getBrainSource(input.projectId, input.path);
    if (!source) throw new Error('Failed to read the brain source that was just written.');
    return source;
  }

  listBrainOutputs(projectId: string): BrainOutput[] {
    return this.#db
      .select()
      .from(schema.brainOutputs)
      .where(eq(schema.brainOutputs.projectId, projectId))
      .orderBy(asc(schema.brainOutputs.path))
      .all()
      .map((row) => mapBrainOutput(row));
  }

  getBrainOutput(projectId: string, outputPath: string): BrainOutput | undefined {
    const row = this.#db
      .select()
      .from(schema.brainOutputs)
      .where(
        and(eq(schema.brainOutputs.projectId, projectId), eq(schema.brainOutputs.path, outputPath)),
      )
      .get();
    return row ? mapBrainOutput(row) : undefined;
  }

  upsertBrainOutput(input: UpsertBrainOutputInput): BrainOutput {
    const existing = this.getBrainOutput(input.projectId, input.path);
    if (existing) {
      this.#db
        .update(schema.brainOutputs)
        .set({
          format: input.format,
          content: input.content,
          checksum: input.checksum,
          sourceChecksum: input.sourceChecksum,
          driftDetected: false,
          updatedAt: new Date(),
        })
        .where(eq(schema.brainOutputs.id, existing.id))
        .run();
    } else {
      this.#db
        .insert(schema.brainOutputs)
        .values({
          id: createId(),
          projectId: input.projectId,
          format: input.format,
          path: input.path,
          content: input.content,
          checksum: input.checksum,
          sourceChecksum: input.sourceChecksum,
        })
        .run();
    }

    const output = this.getBrainOutput(input.projectId, input.path);
    if (!output) throw new Error('Failed to read the brain output that was just written.');
    return output;
  }

  markBrainOutputSynced(id: string, syncedAt = new Date()): BrainOutput | undefined {
    this.#db
      .update(schema.brainOutputs)
      .set({ syncedAt, driftDetected: false, updatedAt: syncedAt })
      .where(eq(schema.brainOutputs.id, id))
      .run();
    const row = this.#db
      .select()
      .from(schema.brainOutputs)
      .where(eq(schema.brainOutputs.id, id))
      .get();
    return row ? mapBrainOutput(row) : undefined;
  }

  markBrainOutputDrift(id: string, drifted: boolean): void {
    this.#db
      .update(schema.brainOutputs)
      .set({ driftDetected: drifted, updatedAt: new Date() })
      .where(eq(schema.brainOutputs.id, id))
      .run();
  }

  insertBrainDriftEvent(input: InsertBrainDriftEventInput): BrainDriftEvent {
    const id = createId();
    this.#db
      .insert(schema.brainDriftEvents)
      .values({
        id,
        projectId: input.projectId,
        outputId: input.outputId,
        detectedAt: input.detectedAt ?? new Date(),
        expectedChecksum: input.expectedChecksum,
        actualChecksum: input.actualChecksum,
      })
      .run();
    const row = this.#db
      .select()
      .from(schema.brainDriftEvents)
      .where(eq(schema.brainDriftEvents.id, id))
      .get();
    if (!row) throw new Error('Failed to read the brain drift event that was just created.');
    return mapBrainDriftEvent(row);
  }

  listBrainDriftEvents(projectId: string, limit = 50): BrainDriftEvent[] {
    return this.#db
      .select()
      .from(schema.brainDriftEvents)
      .where(eq(schema.brainDriftEvents.projectId, projectId))
      .orderBy(desc(schema.brainDriftEvents.detectedAt), desc(schema.brainDriftEvents.id))
      .limit(limit)
      .all()
      .map((row) => mapBrainDriftEvent(row));
  }

  resolveBrainDriftEvents(projectId: string, outputId?: string): number {
    const conditions: SQL[] = [
      eq(schema.brainDriftEvents.projectId, projectId),
      isNull(schema.brainDriftEvents.resolvedAt),
    ];
    if (outputId) conditions.push(eq(schema.brainDriftEvents.outputId, outputId));
    return this.#db
      .update(schema.brainDriftEvents)
      .set({ resolvedAt: new Date() })
      .where(and(...conditions))
      .run().changes;
  }

  insertArenaRun(input: InsertArenaRunInput): ArenaRun {
    const id = createId();
    this.#db
      .insert(schema.arenaRuns)
      .values({
        id,
        provider: input.provider,
        model: input.model,
        status: input.status,
        startedAt: input.startedAt ?? new Date(),
        ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
        ...(input.sourceStepId ? { sourceStepId: input.sourceStepId } : {}),
      })
      .run();
    const run = this.getArenaRun(id);
    if (!run) throw new Error('Failed to read the arena run that was just created.');
    return run;
  }

  updateArenaRun(id: string, patch: UpdateArenaRunInput): ArenaRun | undefined {
    const existing = this.getArenaRun(id);
    if (!existing) return undefined;

    const values: Partial<typeof schema.arenaRuns.$inferInsert> = {};
    if (patch.status !== undefined) values.status = patch.status;
    if (patch.outputText !== undefined) values.outputText = patch.outputText;
    if (patch.diffText !== undefined) values.diffText = patch.diffText;
    if (patch.inputTokens !== undefined) values.inputTokens = patch.inputTokens;
    if (patch.outputTokens !== undefined) values.outputTokens = patch.outputTokens;
    if (patch.costUsd !== undefined) values.costUsd = patch.costUsd;
    if (patch.costKnown !== undefined) values.costKnown = patch.costKnown;
    if (patch.latencyMs !== undefined) values.latencyMs = patch.latencyMs;
    if (patch.ttftMs !== undefined) values.ttftMs = patch.ttftMs;
    if (patch.testsPassed !== undefined) values.testsPassed = patch.testsPassed;
    if (patch.trustScore !== undefined) values.trustScore = patch.trustScore;
    if (patch.baselineCostUsd !== undefined) values.baselineCostUsd = patch.baselineCostUsd;
    if (patch.savingsPercent !== undefined) values.savingsPercent = patch.savingsPercent;
    if (patch.error !== undefined) values.error = patch.error;
    if (patch.completedAt !== undefined) values.completedAt = patch.completedAt;

    if (Object.keys(values).length > 0) {
      this.#db.update(schema.arenaRuns).set(values).where(eq(schema.arenaRuns.id, id)).run();
    }
    return this.getArenaRun(id);
  }

  getArenaRun(id: string): ArenaRun | undefined {
    const row = this.#db.select().from(schema.arenaRuns).where(eq(schema.arenaRuns.id, id)).get();
    return row ? mapArenaRun(row) : undefined;
  }

  listArenaRuns(query: ArenaRunQuery): ArenaRun[] {
    const conditions: SQL[] = [];
    if (query.sessionId) conditions.push(eq(schema.arenaRuns.sourceSessionId, query.sessionId));
    if (query.stepId) conditions.push(eq(schema.arenaRuns.sourceStepId, query.stepId));

    return this.#db
      .select()
      .from(schema.arenaRuns)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(schema.arenaRuns.createdAt), desc(schema.arenaRuns.id))
      .limit(query.limit)
      .all()
      .map((row) => mapArenaRun(row));
  }

  insertHandoffBrief(input: InsertHandoffBriefInput): HandoffBrief {
    const id = createId();
    this.#db
      .insert(schema.handoffBriefs)
      .values({
        id,
        sessionId: input.sessionId,
        title: input.title,
        contentMarkdown: input.contentMarkdown,
        generatedAt: input.generatedAt ?? new Date(),
        ...(input.model ? { model: input.model } : {}),
      })
      .run();
    const brief = this.getHandoffBrief(id);
    if (!brief) throw new Error('Failed to read the handoff brief that was just created.');
    return brief;
  }

  getHandoffBrief(id: string): HandoffBrief | undefined {
    const row = this.#db
      .select()
      .from(schema.handoffBriefs)
      .where(eq(schema.handoffBriefs.id, id))
      .get();
    return row ? mapHandoffBrief(row) : undefined;
  }

  listHandoffBriefs(sessionId: string, limit = 10): HandoffBrief[] {
    return this.#db
      .select()
      .from(schema.handoffBriefs)
      .where(eq(schema.handoffBriefs.sessionId, sessionId))
      .orderBy(desc(schema.handoffBriefs.generatedAt), desc(schema.handoffBriefs.id))
      .limit(limit)
      .all()
      .map((row) => mapHandoffBrief(row));
  }

  latestHandoffBrief(sessionId: string): HandoffBrief | undefined {
    return this.listHandoffBriefs(sessionId, 1)[0];
  }

  getJournalEntry(id: string): JournalEntry | undefined {
    const row = this.#db
      .select()
      .from(schema.journalEntries)
      .where(eq(schema.journalEntries.id, id))
      .get();
    return row ? mapJournalEntry(row) : undefined;
  }

  getJournalEntryForWeek(projectId: string | null, weekStart: string): JournalEntry | undefined {
    const row = this.#db
      .select()
      .from(schema.journalEntries)
      .where(
        and(
          projectId === null
            ? isNull(schema.journalEntries.projectId)
            : eq(schema.journalEntries.projectId, projectId),
          eq(schema.journalEntries.weekStart, weekStart),
        ),
      )
      .get();
    return row ? mapJournalEntry(row) : undefined;
  }

  upsertJournalEntry(input: UpsertJournalEntryInput): JournalEntry {
    const existing = this.getJournalEntryForWeek(input.projectId ?? null, input.weekStart);
    if (existing) {
      this.#db
        .update(schema.journalEntries)
        .set({ title: input.title, markdown: input.markdown, updatedAt: new Date() })
        .where(eq(schema.journalEntries.id, existing.id))
        .run();
      const updated = this.getJournalEntry(existing.id);
      if (!updated) throw new Error('Failed to read the journal entry that was just updated.');
      return updated;
    }

    const id = createId();
    this.#db
      .insert(schema.journalEntries)
      .values({
        id,
        weekStart: input.weekStart,
        title: input.title,
        markdown: input.markdown,
        ...(input.projectId ? { projectId: input.projectId } : {}),
      })
      .run();
    const entry = this.getJournalEntry(id);
    if (!entry) throw new Error('Failed to read the journal entry that was just created.');
    return entry;
  }

  listJournalEntries(query: { projectId?: string; limit?: number }): JournalEntry[] {
    const conditions: SQL[] = [];
    if (query.projectId) conditions.push(eq(schema.journalEntries.projectId, query.projectId));
    return this.#db
      .select()
      .from(schema.journalEntries)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(schema.journalEntries.weekStart), desc(schema.journalEntries.id))
      .limit(query.limit ?? 12)
      .all()
      .map((row) => mapJournalEntry(row));
  }

  insertPairingToken(input: InsertPairingTokenInput): PairingTokenRecord {
    const id = createId();
    const createdAt = new Date();
    this.#db
      .insert(schema.pairingTokens)
      .values({
        id,
        tokenHash: input.tokenHash,
        ...(input.deviceNameHint ? { deviceNameHint: input.deviceNameHint } : {}),
        expiresAt: input.expiresAt,
        createdAt,
      })
      .run();
    const stored = this.getPairingToken(id);
    if (!stored) {
      throw new Error('Cockpit could not read back the pairing token it just created.');
    }
    return stored;
  }

  getPairingToken(id: string): PairingTokenRecord | undefined {
    const row = this.#db
      .select()
      .from(schema.pairingTokens)
      .where(eq(schema.pairingTokens.id, id))
      .get();
    return row ? mapPairingToken(row) : undefined;
  }

  getPairingTokenByHash(tokenHash: string): PairingTokenRecord | undefined {
    const row = this.#db
      .select()
      .from(schema.pairingTokens)
      .where(eq(schema.pairingTokens.tokenHash, tokenHash))
      .get();
    return row ? mapPairingToken(row) : undefined;
  }

  consumePairingToken(id: string, usedAt: Date): boolean {
    const result = this.#db
      .update(schema.pairingTokens)
      .set({ usedAt })
      .where(and(eq(schema.pairingTokens.id, id), isNull(schema.pairingTokens.usedAt)))
      .run();
    return result.changes === 1;
  }

  deletePairingToken(id: string): boolean {
    const result = this.#db
      .delete(schema.pairingTokens)
      .where(eq(schema.pairingTokens.id, id))
      .run();
    return result.changes === 1;
  }

  deleteExpiredPairingTokens(now: Date): number {
    const result = this.#db
      .delete(schema.pairingTokens)
      .where(lt(schema.pairingTokens.expiresAt, now))
      .run();
    return result.changes;
  }

  insertDevice(input: InsertDeviceInput): Device {
    const id = createId();
    this.#db
      .insert(schema.devices)
      .values({
        id,
        name: input.name,
        platform: input.platform,
        tokenHash: input.tokenHash,
        createdAt: new Date(),
      })
      .run();
    const stored = this.getDevice(id);
    if (!stored) {
      throw new Error('Cockpit could not read back the device it just paired.');
    }
    return stored;
  }

  listDevices(): Device[] {
    return this.#db
      .select()
      .from(schema.devices)
      .orderBy(desc(schema.devices.createdAt), asc(schema.devices.id))
      .all()
      .map((row) => mapDevice(row));
  }

  getDevice(id: string): Device | undefined {
    const row = this.#db.select().from(schema.devices).where(eq(schema.devices.id, id)).get();
    return row ? mapDevice(row) : undefined;
  }

  getDeviceByTokenHash(tokenHash: string): Device | undefined {
    const row = this.#db
      .select()
      .from(schema.devices)
      .where(eq(schema.devices.tokenHash, tokenHash))
      .get();
    return row ? mapDevice(row) : undefined;
  }

  revokeDevice(id: string, revokedAt: Date): Device | undefined {
    this.#db
      .update(schema.devices)
      .set({ revokedAt })
      .where(and(eq(schema.devices.id, id), isNull(schema.devices.revokedAt)))
      .run();
    return this.getDevice(id);
  }

  touchDevice(id: string, lastSeenAt: Date): void {
    this.#db.update(schema.devices).set({ lastSeenAt }).where(eq(schema.devices.id, id)).run();
  }

  listPlugins(): Plugin[] {
    return this.#db
      .select()
      .from(schema.plugins)
      .orderBy(asc(schema.plugins.name), asc(schema.plugins.id))
      .all()
      .map((row) => mapPlugin(row));
  }

  getPlugin(id: string): Plugin | undefined {
    const row = this.#db.select().from(schema.plugins).where(eq(schema.plugins.id, id)).get();
    return row ? mapPlugin(row) : undefined;
  }

  getPluginByName(name: string): Plugin | undefined {
    const row = this.#db
      .select()
      .from(schema.plugins)
      .where(eq(schema.plugins.name, name))
      .orderBy(desc(schema.plugins.updatedAt), asc(schema.plugins.id))
      .get();
    return row ? mapPlugin(row) : undefined;
  }

  insertPlugin(input: InsertPluginInput): Plugin {
    const id = createId();
    this.#db
      .insert(schema.plugins)
      .values({
        id,
        name: input.name,
        version: input.version,
        manifest: input.manifest,
        path: input.path,
        enabled: input.enabled ?? true,
        installedAt: new Date(),
        ...(input.description ? { description: input.description } : {}),
      })
      .run();
    const plugin = this.getPlugin(id);
    if (!plugin) throw new Error('Failed to read the plugin that was just installed.');
    return plugin;
  }

  updatePlugin(id: string, patch: UpdatePluginInput): Plugin | undefined {
    const existing = this.getPlugin(id);
    if (!existing) return undefined;

    const values: Partial<typeof schema.plugins.$inferInsert> = { updatedAt: new Date() };
    if (patch.version !== undefined) values.version = patch.version;
    if (patch.description !== undefined) values.description = patch.description;
    if (patch.manifest !== undefined) values.manifest = patch.manifest;
    if (patch.path !== undefined) values.path = patch.path;
    if (patch.enabled !== undefined) values.enabled = patch.enabled;

    this.#db.update(schema.plugins).set(values).where(eq(schema.plugins.id, id)).run();
    return this.getPlugin(id);
  }

  deletePlugin(id: string): boolean {
    const result = this.#db.delete(schema.plugins).where(eq(schema.plugins.id, id)).run();
    return result.changes > 0;
  }

  insertPluginRun(input: InsertPluginRunInput): PluginRun {
    const id = createId();
    this.#db
      .insert(schema.pluginRuns)
      .values({
        id,
        pluginId: input.pluginId,
        kind: input.kind,
        status: input.status,
        startedAt: input.startedAt ?? new Date(),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.result === undefined ? {} : { result: input.result }),
        ...(input.error ? { error: input.error } : {}),
        ...(input.endedAt ? { endedAt: input.endedAt } : {}),
      })
      .run();
    const row = this.#db.select().from(schema.pluginRuns).where(eq(schema.pluginRuns.id, id)).get();
    if (!row) throw new Error('Failed to read the plugin run that was just created.');
    return mapPluginRun(row);
  }

  listPluginRuns(pluginId: string, limit = 20): PluginRun[] {
    return this.#db
      .select()
      .from(schema.pluginRuns)
      .where(eq(schema.pluginRuns.pluginId, pluginId))
      .orderBy(desc(schema.pluginRuns.startedAt), desc(schema.pluginRuns.id))
      .limit(limit)
      .all()
      .map((row) => mapPluginRun(row));
  }

  maxLiveEventSequence(): number {
    const row = this.#db
      .select({ maximum: sql<number | null>`max(${schema.liveEvents.sequence})` })
      .from(schema.liveEvents)
      .get();
    return row?.maximum ?? 0;
  }

  insertLiveEvent(event: LiveEvent): void {
    this.#db
      .insert(schema.liveEvents)
      .values({
        sequence: event.sequence,
        type: event.type,
        payload: event.payload,
        createdAt: new Date(event.at),
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
        ...(event.stepId ? { stepId: event.stepId } : {}),
      })
      .run();
  }
}
