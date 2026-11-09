export type SessionStatus = 'active' | 'completed' | 'failed' | 'killed';
export type SessionSource = 'proxy' | 'demo' | 'manual' | 'log_watch' | 'hook_otel';
export type CaptureMode = 'proxy' | 'log_watch' | 'hook_otel' | 'pty';
export type AgentSessionStatus = 'running' | 'exited' | 'killed';
export type AgentPromptState =
  | 'awaiting_prompt'
  | 'permission'
  | 'choice'
  | 'question'
  | 'auth'
  | 'unknown';
export type AgentEventType =
  | 'agent.started'
  | 'done'
  | 'permission'
  | 'question'
  | 'choice'
  | 'auth_required'
  | 'error'
  | 'stuck'
  | 'budget.warn'
  | 'context.high';
export type AgentEventStatus = 'open' | 'acknowledged';
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
  approvalNonce?: string;
  approvalExpiresAt?: string;
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

export interface AgentSession {
  sessionId: string;
  agentName: string;
  projectName: string;
  workingDir: string;
  adapter: string;
  verified: boolean;
  status: AgentSessionStatus;
  needsYou: boolean;
  promptState: AgentPromptState;
  autoApprove: boolean;
  exitCode?: number;
  createdAt: string;
  updatedAt: string;
  outputSequence: number;
}

export interface AgentOutput {
  session: AgentSession;
  output: string;
}

export interface AgentEvent {
  id: string;
  sessionId: string;
  agentName: string;
  projectName: string;
  type: AgentEventType;
  message: string;
  status: AgentEventStatus;
  createdAt: string;
  acknowledgedAt?: string;
  metadata?: Record<string, unknown>;
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
  nonce?: string;
  sessionId?: string;
}

// ----- Remote access -------------------------------------------------------

export type RemoteMode = 'loopback' | 'tailscale' | 'tunnel' | 'lan';
export type RemoteScope = 'view:status' | 'view:content' | 'respond' | 'prompt';
export type RemoteClaimStatus = 'pending' | 'confirmed' | 'denied' | 'expired';

export interface RemoteToolStatus {
  installed: boolean;
  path?: string | null;
  detail?: string | null;
  command: string;
  followUpCommand?: string | null;
}

export interface RemoteTools {
  tailscale: RemoteToolStatus;
  cloudflared: RemoteToolStatus;
  lanIp?: string | null;
  tailscaleIp?: string | null;
  tailscaleDnsName?: string | null;
}

export interface RemoteNotificationStatus {
  enabled: boolean;
  server: string;
  topic?: string | null;
  thirdParty: boolean;
}

export interface RemoteStatus {
  enabled: boolean;
  mode: RemoteMode;
  url?: string | null;
  fingerprint?: string | null;
  port: number;
  startedAt?: string | null;
  lastError?: string | null;
  awaitingTunnel: boolean;
  revokeOnDisable: boolean;
  devices: number;
  pendingPairings: number;
  pendingPrompts: number;
  notifications: RemoteNotificationStatus;
  tools: RemoteTools;
}

export interface RemoteDevice {
  id: string;
  name: string;
  scopes: RemoteScope[];
  requireHostConfirmation: boolean;
  hasPin: boolean;
  pinFailures: number;
  respondLocked: boolean;
  createdAt: string;
  lastSeenAt?: string | null;
  expiresAt?: string | null;
  revokedAt?: string | null;
}

export interface RemotePairingCode {
  code: string;
  expiresAt: string;
  expiresInSeconds: number;
  url: string;
  fingerprint?: string | null;
  qrSvg: string;
  qrPayload: Record<string, unknown>;
}

export interface RemotePendingPairing {
  id: string;
  deviceName: string;
  requestedAt: string;
  ip?: string;
  hasPin: boolean;
  verificationCode: string;
}

export interface RemoteAuditEntry {
  id: string;
  at: string;
  event: string;
  deviceId?: string;
  deviceName?: string;
  ip?: string;
  detail: Record<string, unknown>;
  sizeBytes?: number;
  contentHash?: string;
}

export interface RemoteAuditResponse {
  entries: RemoteAuditEntry[];
  total: number;
  limit: number;
  offset: number;
}

export interface RemoteEndpointScope {
  method: string;
  path: string;
  scope: string;
  note: string;
}

export interface RemotePendingPrompt {
  id: string;
  deviceId: string;
  deviceName: string;
  sessionId: string;
  createdAt: string;
  expiresAt: string;
  sizeBytes: number;
  contentHash: string;
  autoApprove: boolean;
  text?: string;
}

export interface RemoteSessionInfo {
  deviceId: string;
  deviceName: string;
  scopes: RemoteScope[];
  requireHostConfirmation: boolean;
  hasPin: boolean;
  pinFailures: number;
  respondLocked: boolean;
  expiresAt?: string | null;
  mode: RemoteMode;
  url?: string | null;
}

export interface RemoteClaimTicket {
  claimId: string;
  claimSecret: string;
  expiresInSeconds: number;
}

export interface RemoteClaimPoll {
  status: RemoteClaimStatus;
  deviceId?: string;
  deviceName?: string;
  token?: string;
  createdAt?: string;
}

// ----- Market --------------------------------------------------------------

export type MarketKind = 'skill' | 'mcp';
export type TrustTier = 'official' | 'community-reviewed' | 'unreviewed';
export type InstallScope = 'user' | 'project';
export type InstallState = 'installed' | 'uninstalled';
export type RegistrySource = 'environment' | 'cache' | 'repo' | 'bundled' | 'network';

export interface MarketReviewer {
  name: string;
  date: string;
  ciPassed: boolean;
  ciUrl?: string | null;
}

export interface MarketPermission {
  id: string;
  description: string;
}

export interface MarketSource {
  repo: string;
  commit: string;
  contentSha256: string;
  files: string[];
}

export interface AgentSupport {
  agent: string;
  name: string;
  scopes: InstallScope[];
  verified: boolean;
  available: boolean;
}

export interface MarketCard {
  id: string;
  kind: MarketKind;
  name: string;
  version: string;
  shortDescription: string;
  longDescription: string;
  categories: string[];
  agents: string[];
  license: string;
  trust: TrustTier;
  reviewer?: MarketReviewer | null;
  reviewedOn?: string | null;
  homepage?: string | null;
  permissions: MarketPermission[];
  example: boolean;
  revoked: boolean;
  installed: boolean;
  installedVersion?: string | null;
  updateAvailable: boolean;
  latestVersion: string;
  support: AgentSupport[];
}

export interface MarketDetail extends MarketCard {
  source: MarketSource;
  readme: string;
}

export interface CatalogCounts {
  skills: number;
  mcp: number;
  installed: number;
}

export interface MarketSettings {
  autoRefresh: boolean;
  lastRefresh?: string | null;
}

export interface CatalogResponse {
  entries: MarketCard[];
  categories: string[];
  agents: string[];
  generatedAt?: string | null;
  source: RegistrySource;
  offline: boolean;
  warnings: string[];
  lastError?: string | null;
  settings: MarketSettings;
  counts: CatalogCounts;
}

export interface ManualInstructions {
  reason: string;
  path: string;
  steps: string[];
  snippet: string;
}

export interface PreviewFile {
  path: string;
  displayPath: string;
  sha256: string;
  size: number;
  action: string;
  binary: boolean;
  diff?: string | null;
  content?: string | null;
}

export interface PreviewConfig {
  path: string;
  displayPath: string;
  format: string;
  keyPath: string[];
  before?: unknown;
  after: unknown;
  diff: string;
  action: string;
  secretNames: string[];
}

export interface InstallPreview {
  previewId: string;
  kind: MarketKind;
  entryId: string;
  name: string;
  version: string;
  agent: string;
  scope: InstallScope;
  trust: TrustTier;
  license: string;
  source: MarketSource;
  permissions: MarketPermission[];
  command?: string | null;
  commandWarning?: string | null;
  files: PreviewFile[];
  config?: PreviewConfig | null;
  manual?: ManualInstructions | null;
  secretNames: string[];
  warnings: string[];
  update: boolean;
  installedVersion?: string | null;
  totalBytes: number;
  conflicts: string[];
}

export interface InstallOutcome {
  installId: string;
  kind: MarketKind;
  entryId: string;
  name: string;
  version: string;
  agent: string;
  scope: InstallScope;
  backupId: string;
  filesWritten: number;
  configPath?: string | null;
  undoAvailable: boolean;
  warnings: string[];
}

export interface UninstallPreview {
  installId: string;
  kind: MarketKind;
  entryId: string;
  name: string;
  agent: string;
  scope: InstallScope;
  filesToRemove: string[];
  filesEdited: string[];
  filesMissing: string[];
  configAction: string;
  needsConfirmation: boolean;
}

export interface UninstallOutcome {
  preview: UninstallPreview;
  backupId: string;
  undoAvailable: boolean;
}

export interface UndoOutcome {
  installId: string;
  state: string;
  restoredFiles: number;
  restoredConfig: boolean;
}

export interface InstalledSummary {
  installId: string;
  kind: MarketKind;
  entryId: string;
  name: string;
  version: string;
  agent: string;
  scope: InstallScope;
  trust: TrustTier;
  state: InstallState;
  installedAt: string;
  updatedAt: string;
  revoked: boolean;
  updateAvailable: boolean;
  latestVersion?: string | null;
  needsAttention: boolean;
  attention: string[];
  fileCount: number;
  configPath?: string | null;
  backupId: string;
}

export interface InstalledResponse {
  installs: InstalledSummary[];
  source: RegistrySource;
  offline: boolean;
  warnings: string[];
  lastError?: string | null;
}

export interface MarketStatus {
  hostOnly: boolean;
  autoRefresh: boolean;
  lastRefresh?: string | null;
}

