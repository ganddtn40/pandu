export {
  DEFAULT_ANTHROPIC_VERSION,
  DEFAULT_HOST,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_PORT,
  DEFAULT_SESSION_IDLE_MS,
  PROXY_KEY_SENTINEL,
  displayHostForUrl,
  isLoopbackAddress,
  isLoopbackHostname,
  isOriginAllowed,
  loadConfig,
  resolveCockpitPaths,
  type AnthropicUpstreamConfig,
  type CockpitConfig,
  type CockpitPaths,
  type LogLevel,
  type UpstreamConfig,
} from './config.js';
export { openDatabase, locateMigrationsFolder } from './db/client.js';
export { DEMO_MAIN_TITLE, seedDemoData, type SeedDemoOptions } from './demo/seed.js';
export {
  GitSnapshotService,
  createWorkingTreeCommit,
  commitExists,
  currentBranch,
  diffSnapshots,
  resolveGitWorkspace,
  resolveHead,
  type DiffFile,
  type GitWorkspace,
  type SessionSnapshotRecorder,
  type SnapshotDiff,
  type StepSnapshotRecorder,
} from './git/snapshots.js';
export { GitCommandError, runGit, type GitResult, type GitRunOptions } from './git/run.js';
export { ForkError, ForkService, type ForkServiceOptions } from './replay/fork.js';
export {
  ContextDoctor,
  type ContextAnalysis,
  type ContextCaptureInput,
  type ContextDoctorOptions,
  type StepContextCapture,
} from './context/doctor.js';
export { AnalyticsService, type AnalyticsServiceOptions } from './analytics/service.js';
export { ArenaService, ArenaServiceError, type ArenaServiceOptions } from './arena/service.js';
export { BrainService, BrainServiceError, type BrainServiceOptions } from './brain/service.js';
export {
  HandoffService,
  HandoffServiceError,
  type HandoffServiceOptions,
} from './handoff/service.js';
export {
  JournalService,
  JournalServiceError,
  weekStartFor,
  type JournalServiceOptions,
} from './journal/service.js';
export {
  PairingService,
  PairingServiceError,
  type PairingServiceOptions,
  type RevokeDeviceOptions,
} from './pairing/service.js';
export {
  PluginService,
  PluginServiceError,
  type PluginRunResult,
  type PluginServiceOptions,
} from './plugins/service.js';
export {
  ProvenanceService,
  aggregateProvenanceFiles,
  countAttributedLines,
  hashContent,
  parseAddedRanges,
  type ProvenanceServiceOptions,
} from './provenance/service.js';
export {
  UnderstandingService,
  UnderstandingServiceError,
  buildDebtSummary,
  toFileView,
  toQuizView,
  type UnderstandingServiceOptions,
} from './understanding/service.js';
export type { CockpitDatabase, CockpitDatabaseConnection } from './db/client.js';
export * as schema from './db/schema.js';
export { createApp, localBaseUrl, type AppBundle, type AppServices } from './app.js';
export {
  createDaemon,
  startDaemon,
  type CreateDaemonOptions,
  type DaemonRuntime,
  type StartDaemonOptions,
  type StartedDaemon,
} from './server.js';
export { createLogger, type Logger, type LogSink } from './logger.js';
export { LiveEventBus, type LiveEventDetails, type LiveEventListener } from './live/bus.js';
export {
  Recorder,
  type BeginRecordedStepInput,
  type FinishRecordedStepInput,
  type RecordedStep,
  type RecorderOptions,
} from './recording/recorder.js';
export {
  RedactionCollector,
  redactHeaders,
  redactJson,
  redactText,
  type CaptureLocation,
  type RedactionRow,
} from './recording/redact.js';
export { parseJsonBody, truncateText, type ParsedJsonBody } from './recording/text.js';
export { SessionManager, type SessionManagerOptions } from './sessions/manager.js';
export { SseParser, type SseEvent } from './sse/parser.js';
export {
  ProtocolCollector,
  collectNonStreamResponse,
  mapAnthropicFinishReason,
  mapOpenAiFinishReason,
  type CollectedResponse,
  type IngestedEvent,
  type ParsedToolCall,
} from './sse/collector.js';
export {
  Store,
  InvalidCursorError,
  type BeginStepInput,
  type CompleteStepInput,
  type ContextInsightInput,
  type ContextSegmentInput,
  type CreateComprehensionQuizInput,
  type CreateSessionRecordInput,
  type CreateUnderstandingFileInput,
  type InsertContextSnapshotInput,
  type InsertForkInput,
  type InsertProvenanceInput,
  type InsertSnapshotInput,
  type InsertUnderstandingEventInput,
  type RedactionRecordInput,
  type SessionPage,
  type SnapshotFileChangeInput,
  type StreamChunkInput,
  type ToolCallRecordInput,
  type TouchSessionInput,
  type UpdateUnderstandingFileInput,
} from './store/store.js';
export { HttpError, jsonError, notFound } from './http/errors.js';
export { createCorsMiddleware } from './http/cors.js';
export { mountDashboard, resolveWebRoot } from './http/dashboard.js';
export { parseProxyRoute, type ProxyRouteResult } from './proxy/routing.js';
export { detectAgent, providerOverride } from './proxy/agent.js';
export { VERSION } from './version.js';
