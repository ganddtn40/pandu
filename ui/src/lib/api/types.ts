export type SessionStatus = 'active' | 'completed' | 'failed' | 'killed';
export type SessionSource = 'proxy' | 'demo' | 'manual' | 'log_watch' | 'hook_otel';
export type CaptureMode = 'proxy' | 'log_watch' | 'hook_otel';
export type StepKind = 'model' | 'tool' | 'guard' | 'snapshot' | 'system';
export type StepStatus = 'running' | 'completed' | 'failed' | 'blocked' | 'cancelled';
export type StreamChunkKind = 'text' | 'thinking' | 'tool_call' | 'usage' | 'event' | 'done' | 'error';
export type GuardEventStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'blocked'
  | 'redacted'
  | 'warned'
  | 'expired';
export type GuardRuleKind =
  | 'secret'
  | 'dangerous_command'
  | 'loop'
  | 'budget'
  | 'egress'
  | 'custom';
export type GuardAction = 'allow' | 'warn' | 'redact' | 'pause' | 'block';
export type GuardSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface AgentInfo {
  name?: string | null;
  version?: string | null;
  userAgent?: string | null;
  detectedFrom?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

export interface SessionTotals extends TokenUsage {
  stepCount: number;
  modelCallCount: number;
  toolCallCount: number;
  totalCostUsd: number;
  unknownCostCalls: number;
  errorCount: number;
}

export interface Session {
  id: string;
  title: string;
  source: SessionSource;
  captureMode: CaptureMode;
  sourceLabel?: string;
  status: SessionStatus;
  protocol?: string;
  provider?: string;
  model?: string;
  agent?: AgentInfo;
  workspacePath?: string;
  gitBranch?: string;
  gitBaseCommit?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  totals: SessionTotals;
  tags: string[];
  metadata?: Record<string, unknown>;
}

export interface CapturedRequest {
  protocol: string;
  method: string;
  path: string;
  model?: string;
  stream: boolean;
  headers: Record<string, string>;
  body?: unknown;
  systemPrompt?: string;
  promptText?: string;
  redactionCount: number;
}

export interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  body?: unknown;
  text?: string;
  thinking?: string;
  finishReason?: string;
  stream?: boolean;
}

export interface Step {
  id: string;
  sessionId: string;
  parentStepId?: string;
  seq: number;
  kind: StepKind;
  status: StepStatus;
  provider?: string;
  model?: string;
  request?: CapturedRequest;
  response?: CapturedResponse;
  usage: TokenUsage;
  costUsd?: number;
  costKnown: boolean;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface StreamChunk {
  id: string;
  stepId: string;
  seq: number;
  kind: StreamChunkKind;
  data: string;
  deltaText?: string;
  receivedAt: string;
}

export interface ToolCall {
  id: string;
  sessionId: string;
  stepId?: string;
  providerToolCallId?: string;
  name: string;
  status: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  filePaths: string[];
  startedAt: string;
  endedAt?: string;
}

export interface StepDetail {
  step: Step;
  redactions: Array<{
    id: string;
    stepId: string;
    ruleId: string;
    label: string;
    location: string;
    occurrences: number;
  }>;
  streamChunks: StreamChunk[];
  toolCalls: ToolCall[];
}

export interface LiveEvent {
  sequence: number;
  type: string;
  at: string;
  sessionId?: string;
  stepId?: string;
  payload: Record<string, unknown>;
}

export interface GuardEvidence {
  field?: string;
  excerpt?: string;
  path?: string;
  line?: number;
  metadata?: Record<string, unknown>;
}

export interface GuardEvent {
  id: string;
  sessionId: string;
  stepId?: string;
  ruleId: string;
  kind: GuardRuleKind;
  action: GuardAction;
  severity: GuardSeverity;
  status: GuardEventStatus;
  title: string;
  description: string;
  command?: string;
  evidence: GuardEvidence[];
  requestedAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  resolutionNote?: string;
  metadata?: Record<string, unknown>;
}

export interface GuardRule {
  id: string;
  name: string;
  description: string;
  kind: GuardRuleKind;
  action: GuardAction;
  severity: GuardSeverity;
  source: string;
  enabled: boolean;
  priority: number;
  config: Record<string, unknown>;
}

export interface AdapterStatus {
  id: string;
  name: string;
  installed: boolean;
  executable?: string;
  command: string;
  verified: boolean;
  capture: CaptureMode[];
}

export interface AdapterList {
  adapters: AdapterStatus[];
  issues: Array<{ source: string; message: string }>;
  installed: number;
  verified: number;
  total: number;
  logWatch: unknown;
  logWatchEnabled: boolean;
}

export interface Health {
  ok: boolean;
  version: string;
  database: string;
  uptimeMs: number;
  demoMode: boolean;
}

export interface OverviewStats {
  sessionCount: number;
  activeSessionCount: number;
  stepCount: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalCostUsd: number;
  unknownCostCalls: number;
  errorCount: number;
  lastSessionAt?: string;
}

export interface Overview {
  stats: OverviewStats;
  activeSessions: Session[];
  recentSessions: Session[];
}

export interface SessionList {
  sessions: Session[];
  total: number;
  limit: number;
  offset: number;
}

export interface Snapshot {
  id: string;
  sessionId: string;
  stepId?: string;
  kind: string;
  commitSha?: string;
  parentCommitSha?: string;
  branch?: string;
  worktreePath?: string;
  patch?: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  createdAt: string;
}

export type FileChangeType = 'added' | 'modified' | 'deleted' | 'renamed';

export interface FileChange {
  id: string;
  snapshotId: string;
  path: string;
  oldPath?: string;
  changeType: FileChangeType;
  additions: number;
  deletions: number;
  diff?: string;
  aiAuthored?: boolean;
}

export interface SnapshotDetailResponse {
  snapshot: Snapshot;
  fileChanges: FileChange[];
}

export interface ReplayResponse {
  session: Session;
  steps: Step[];
  snapshots: Snapshot[];
  forks: unknown[];
}

export interface SettingsResponse {
  settings: Record<string, string>;
}

export interface DemoSeedResponse {
  seeded: boolean;
  sessions: Session[];
}

export interface ApprovalDecision {
  decision: 'approve' | 'deny';
  note?: string;
  actor?: string;
  channel?: string;
  provider?: string;
}
