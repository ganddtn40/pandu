import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import type {
  BudgetEnforcement,
  BudgetPeriod,
  BudgetScope,
  CheatCategory,
  CheatEvidence,
  CheatSeverity,
  FinishReason,
  GuardAction,
  GuardEvidence,
  GuardEventStatus,
  GuardRuleKind,
  GuardRuleSource,
  GuardSeverity,
  JsonObject,
  JsonValue,
  ProviderProtocol,
  QuizQuestion,
  SessionSource,
  SessionStatus,
  StepKind,
  StepStatus,
  StreamChunkKind,
  ToolCallStatus,
  TrustGrade,
  UnderstandingStatus,
} from '@cockpit/core';

const createdAt = (name = 'created_at') =>
  integer(name, { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`)
    .$defaultFn(() => new Date());

const updatedAt = (name = 'updated_at') =>
  integer(name, { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`)
    .$defaultFn(() => new Date());

const timestamp = (name: string) => integer(name, { mode: 'timestamp_ms' });

export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    rootPath: text('root_path').notNull(),
    lastOpenedAt: timestamp('last_opened_at'),
    metadata: text('metadata', { mode: 'json' }).$type<JsonObject>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('projects_root_path_unique').on(table.rootPath),
    index('projects_updated_at_idx').on(table.updatedAt),
  ],
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<JsonValue>().notNull(),
  updatedAt: updatedAt(),
});

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    source: text('source').$type<SessionSource>().notNull().default('proxy'),
    status: text('status').$type<SessionStatus>().notNull().default('active'),
    agentName: text('agent_name'),
    agentVersion: text('agent_version'),
    agentUserAgent: text('agent_user_agent'),
    agentDetectedFrom: text('agent_detected_from')
      .$type<'headers' | 'wrapper' | 'manual' | 'demo' | 'unknown'>()
      .default('unknown'),
    provider: text('provider'),
    protocol: text('protocol').$type<ProviderProtocol>(),
    model: text('model'),
    workspacePath: text('workspace_path'),
    gitBranch: text('git_branch'),
    gitBaseCommit: text('git_base_commit'),
    startedAt: timestamp('started_at').notNull(),
    endedAt: timestamp('ended_at'),
    durationMs: integer('duration_ms'),
    stepCount: integer('step_count').notNull().default(0),
    modelCallCount: integer('model_call_count').notNull().default(0),
    toolCallCount: integer('tool_call_count').notNull().default(0),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    reasoningTokens: integer('reasoning_tokens').notNull().default(0),
    totalCostUsd: real('total_cost_usd').notNull().default(0),
    unknownCostCalls: integer('unknown_cost_calls').notNull().default(0),
    errorCount: integer('error_count').notNull().default(0),
    tags: text('tags', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    metadata: text('metadata', { mode: 'json' }).$type<JsonObject>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('sessions_project_started_idx').on(table.projectId, table.startedAt),
    index('sessions_status_idx').on(table.status),
    index('sessions_started_at_idx').on(table.startedAt),
    index('sessions_agent_idx').on(table.agentName),
  ],
);

export const steps = sqliteTable(
  'steps',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    parentStepId: text('parent_step_id'),
    seq: integer('seq').notNull(),
    kind: text('kind').$type<StepKind>().notNull(),
    status: text('status').$type<StepStatus>().notNull(),
    provider: text('provider'),
    model: text('model'),
    requestProtocol: text('request_protocol').$type<ProviderProtocol>(),
    requestMethod: text('request_method'),
    requestPath: text('request_path'),
    requestStream: integer('request_stream', { mode: 'boolean' }).notNull().default(false),
    requestHeaders: text('request_headers', { mode: 'json' }).$type<Record<string, string>>(),
    requestBody: text('request_body', { mode: 'json' }).$type<JsonValue>(),
    requestSystemPrompt: text('request_system_prompt'),
    requestPromptText: text('request_prompt_text'),
    requestRedactionCount: integer('request_redaction_count').notNull().default(0),
    responseStatus: integer('response_status'),
    responseHeaders: text('response_headers', { mode: 'json' }).$type<Record<string, string>>(),
    responseText: text('response_text'),
    responseThinking: text('response_thinking'),
    responseFinishReason: text('response_finish_reason').$type<FinishReason>(),
    responseError: text('response_error'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    reasoningTokens: integer('reasoning_tokens').notNull().default(0),
    costUsd: real('cost_usd'),
    costKnown: integer('cost_known', { mode: 'boolean' }).notNull().default(false),
    ttftMs: integer('ttft_ms'),
    latencyMs: integer('latency_ms'),
    startedAt: timestamp('started_at').notNull(),
    endedAt: timestamp('ended_at'),
    durationMs: integer('duration_ms'),
    error: text('error'),
    metadata: text('metadata', { mode: 'json' }).$type<JsonObject>(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('steps_session_seq_unique').on(table.sessionId, table.seq),
    index('steps_session_started_idx').on(table.sessionId, table.startedAt),
    index('steps_parent_idx').on(table.parentStepId),
    index('steps_kind_idx').on(table.kind),
  ],
);

export const streamChunks = sqliteTable(
  'stream_chunks',
  {
    id: text('id').primaryKey(),
    stepId: text('step_id')
      .notNull()
      .references(() => steps.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    kind: text('kind').$type<StreamChunkKind>().notNull(),
    data: text('data').notNull(),
    deltaText: text('delta_text'),
    receivedAt: timestamp('received_at').notNull(),
  },
  (table) => [
    uniqueIndex('stream_chunks_step_seq_unique').on(table.stepId, table.seq),
    index('stream_chunks_step_idx').on(table.stepId),
  ],
);

export const toolCalls = sqliteTable(
  'tool_calls',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    stepId: text('step_id').references(() => steps.id, { onDelete: 'set null' }),
    providerToolCallId: text('provider_tool_call_id'),
    name: text('name').notNull(),
    status: text('status').$type<ToolCallStatus>().notNull(),
    input: text('input', { mode: 'json' }).$type<JsonValue>(),
    output: text('output', { mode: 'json' }).$type<JsonValue>(),
    error: text('error'),
    filePaths: text('file_paths', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    startedAt: timestamp('started_at').notNull(),
    endedAt: timestamp('ended_at'),
  },
  (table) => [
    index('tool_calls_session_idx').on(table.sessionId, table.startedAt),
    index('tool_calls_step_idx').on(table.stepId),
    index('tool_calls_name_idx').on(table.name),
  ],
);

export const guardRules = sqliteTable(
  'guard_rules',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    kind: text('kind').$type<GuardRuleKind>().notNull(),
    action: text('action').$type<GuardAction>().notNull(),
    severity: text('severity').$type<GuardSeverity>().notNull(),
    source: text('source').$type<GuardRuleSource>().notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    priority: integer('priority').notNull().default(100),
    config: text('config', { mode: 'json' })
      .$type<JsonObject>()
      .notNull()
      .$defaultFn(() => ({})),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index('guard_rules_enabled_priority_idx').on(table.enabled, table.priority)],
);

export const guardEvents = sqliteTable(
  'guard_events',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    stepId: text('step_id').references(() => steps.id, { onDelete: 'set null' }),
    ruleId: text('rule_id').notNull(),
    kind: text('kind').$type<GuardRuleKind>().notNull(),
    action: text('action').$type<GuardAction>().notNull(),
    severity: text('severity').$type<GuardSeverity>().notNull(),
    status: text('status').$type<GuardEventStatus>().notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    command: text('command'),
    evidence: text('evidence', { mode: 'json' })
      .$type<GuardEvidence[]>()
      .notNull()
      .$defaultFn(() => []),
    requestedAt: timestamp('requested_at').notNull(),
    resolvedAt: timestamp('resolved_at'),
    resolvedBy: text('resolved_by'),
    resolutionNote: text('resolution_note'),
    metadata: text('metadata', { mode: 'json' }).$type<JsonObject>(),
    createdAt: createdAt(),
  },
  (table) => [
    index('guard_events_session_idx').on(table.sessionId, table.requestedAt),
    index('guard_events_status_idx').on(table.status),
    index('guard_events_rule_idx').on(table.ruleId),
  ],
);

export const budgetPolicies = sqliteTable(
  'budget_policies',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    scope: text('scope').$type<BudgetScope>().notNull(),
    period: text('period').$type<BudgetPeriod>().notNull(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').references(() => sessions.id, { onDelete: 'cascade' }),
    limitUsd: real('limit_usd').notNull(),
    enforcement: text('enforcement').$type<BudgetEnforcement>().notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('budget_policies_scope_idx').on(table.scope, table.period),
    index('budget_policies_enabled_idx').on(table.enabled),
  ],
);

export const redactionRules = sqliteTable(
  'redaction_rules',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    pattern: text('pattern').notNull(),
    replacement: text('replacement').notNull().default('[REDACTED]'),
    flags: text('flags').notNull().default('g'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    source: text('source').$type<GuardRuleSource>().notNull().default('builtin'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index('redaction_rules_enabled_idx').on(table.enabled)],
);

export const redactions = sqliteTable(
  'redactions',
  {
    id: text('id').primaryKey(),
    stepId: text('step_id')
      .notNull()
      .references(() => steps.id, { onDelete: 'cascade' }),
    ruleId: text('rule_id').notNull(),
    label: text('label').notNull(),
    location: text('location')
      .$type<'request_headers' | 'request_body' | 'response_headers' | 'response_body'>()
      .notNull(),
    occurrences: integer('occurrences').notNull().default(1),
    createdAt: createdAt(),
  },
  (table) => [index('redactions_step_idx').on(table.stepId)],
);

export const gitSnapshots = sqliteTable(
  'git_snapshots',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    stepId: text('step_id').references(() => steps.id, { onDelete: 'set null' }),
    kind: text('kind').$type<'before' | 'after' | 'fork' | 'checkpoint'>().notNull(),
    commitSha: text('commit_sha'),
    parentCommitSha: text('parent_commit_sha'),
    branch: text('branch'),
    worktreePath: text('worktree_path'),
    patch: text('patch'),
    filesChanged: integer('files_changed').notNull().default(0),
    insertions: integer('insertions').notNull().default(0),
    deletions: integer('deletions').notNull().default(0),
    createdAt: createdAt(),
  },
  (table) => [
    index('git_snapshots_session_idx').on(table.sessionId, table.createdAt),
    index('git_snapshots_step_idx').on(table.stepId),
    index('git_snapshots_commit_idx').on(table.commitSha),
  ],
);

export const fileChanges = sqliteTable(
  'file_changes',
  {
    id: text('id').primaryKey(),
    snapshotId: text('snapshot_id')
      .notNull()
      .references(() => gitSnapshots.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    oldPath: text('old_path'),
    changeType: text('change_type').$type<'added' | 'modified' | 'deleted' | 'renamed'>().notNull(),
    additions: integer('additions').notNull().default(0),
    deletions: integer('deletions').notNull().default(0),
    diff: text('diff'),
    aiAuthored: integer('ai_authored', { mode: 'boolean' }),
    createdAt: createdAt(),
  },
  (table) => [
    index('file_changes_snapshot_idx').on(table.snapshotId),
    index('file_changes_path_idx').on(table.path),
  ],
);

export const provenanceEntries = sqliteTable(
  'provenance_entries',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    stepId: text('step_id').references(() => steps.id, { onDelete: 'set null' }),
    filePath: text('file_path').notNull(),
    lineStart: integer('line_start').notNull(),
    lineEnd: integer('line_end').notNull(),
    commitSha: text('commit_sha'),
    contentHash: text('content_hash').notNull(),
    provider: text('provider'),
    model: text('model'),
    promptExcerpt: text('prompt_excerpt'),
    confidence: real('confidence').notNull().default(1),
    capturedAt: timestamp('captured_at').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index('provenance_project_file_idx').on(table.projectId, table.filePath),
    index('provenance_session_idx').on(table.sessionId),
    index('provenance_hash_idx').on(table.contentHash),
  ],
);

export const understandingFiles = sqliteTable(
  'understanding_files',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    path: text('path').notNull(),
    aiLines: integer('ai_lines').notNull().default(0),
    reviewedLines: integer('reviewed_lines').notNull().default(0),
    status: text('status').$type<UnderstandingStatus>().notNull().default('unseen'),
    firstTouchedAt: timestamp('first_touched_at').notNull(),
    lastTouchedAt: timestamp('last_touched_at').notNull(),
    lastOpenedAt: timestamp('last_opened_at'),
    acknowledgedAt: timestamp('acknowledged_at'),
    explanation: text('explanation'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('understanding_files_project_path_unique').on(table.projectId, table.path),
    index('understanding_files_status_idx').on(table.projectId, table.status),
    index('understanding_files_last_touched_idx').on(table.lastTouchedAt),
  ],
);

export const understandingEvents = sqliteTable(
  'understanding_events',
  {
    id: text('id').primaryKey(),
    understandingFileId: text('understanding_file_id')
      .notNull()
      .references(() => understandingFiles.id, { onDelete: 'cascade' }),
    type: text('type')
      .$type<'opened' | 'acknowledged' | 'explanation_viewed' | 'quiz_started' | 'quiz_completed'>()
      .notNull(),
    occurredAt: timestamp('occurred_at').notNull(),
    metadata: text('metadata', { mode: 'json' })
      .$type<Record<string, string>>()
      .notNull()
      .$defaultFn(() => ({})),
  },
  (table) => [
    index('understanding_events_file_idx').on(table.understandingFileId, table.occurredAt),
  ],
);

export const comprehensionQuizzes = sqliteTable(
  'comprehension_quizzes',
  {
    id: text('id').primaryKey(),
    understandingFileId: text('understanding_file_id')
      .notNull()
      .references(() => understandingFiles.id, { onDelete: 'cascade' }),
    questions: text('questions', { mode: 'json' }).$type<QuizQuestion[]>().notNull(),
    generatedAt: timestamp('generated_at').notNull(),
    completedAt: timestamp('completed_at'),
    score: real('score'),
    createdAt: createdAt(),
  },
  (table) => [
    index('comprehension_quizzes_file_idx').on(table.understandingFileId, table.generatedAt),
  ],
);

export const cheatAnalyses = sqliteTable(
  'cheat_analyses',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    stepId: text('step_id').references(() => steps.id, { onDelete: 'set null' }),
    trustScore: integer('trust_score').notNull(),
    grade: text('grade').$type<TrustGrade>().notNull(),
    findingsCount: integer('findings_count').notNull().default(0),
    filesExamined: integer('files_examined').notNull().default(0),
    generatedAt: timestamp('generated_at').notNull(),
    createdAt: createdAt(),
  },
  (table) => [index('cheat_analyses_session_idx').on(table.sessionId, table.generatedAt)],
);

export const cheatFindings = sqliteTable(
  'cheat_findings',
  {
    id: text('id').primaryKey(),
    analysisId: text('analysis_id')
      .notNull()
      .references(() => cheatAnalyses.id, { onDelete: 'cascade' }),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    stepId: text('step_id').references(() => steps.id, { onDelete: 'set null' }),
    category: text('category').$type<CheatCategory>().notNull(),
    severity: text('severity').$type<CheatSeverity>().notNull(),
    title: text('title').notNull(),
    detail: text('detail').notNull(),
    detector: text('detector').notNull(),
    confidence: real('confidence').notNull().default(1),
    evidence: text('evidence', { mode: 'json' }).$type<CheatEvidence[]>().notNull(),
    suggestion: text('suggestion'),
    createdAt: createdAt(),
  },
  (table) => [
    index('cheat_findings_analysis_idx').on(table.analysisId),
    index('cheat_findings_session_idx').on(table.sessionId),
    index('cheat_findings_category_idx').on(table.category),
  ],
);

export const contextSnapshots = sqliteTable(
  'context_snapshots',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    stepId: text('step_id').references(() => steps.id, { onDelete: 'set null' }),
    provider: text('provider'),
    model: text('model'),
    totalTokens: integer('total_tokens').notNull().default(0),
    contextWindow: integer('context_window'),
    measuredAt: timestamp('measured_at').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index('context_snapshots_session_idx').on(table.sessionId, table.measuredAt),
    index('context_snapshots_step_idx').on(table.stepId),
  ],
);

export const contextSegments = sqliteTable(
  'context_segments',
  {
    id: text('id').primaryKey(),
    snapshotId: text('snapshot_id')
      .notNull()
      .references(() => contextSnapshots.id, { onDelete: 'cascade' }),
    category: text('category')
      .$type<'system' | 'rules' | 'files' | 'history' | 'tool_output' | 'other'>()
      .notNull(),
    label: text('label').notNull(),
    tokens: integer('tokens').notNull(),
    percent: real('percent').notNull(),
    sourcePath: text('source_path'),
    preview: text('preview'),
    createdAt: createdAt(),
  },
  (table) => [
    index('context_segments_snapshot_idx').on(table.snapshotId),
    index('context_segments_category_idx').on(table.category),
  ],
);

export const contextInsights = sqliteTable(
  'context_insights',
  {
    id: text('id').primaryKey(),
    snapshotId: text('snapshot_id')
      .notNull()
      .references(() => contextSnapshots.id, { onDelete: 'cascade' }),
    type: text('type')
      .$type<
        | 'duplicate_instruction'
        | 'conflicting_instruction'
        | 'stale_file'
        | 'large_tool_output'
        | 'history_bloat'
        | 'unused_rule'
        | 'compaction'
      >()
      .notNull(),
    severity: text('severity').$type<'info' | 'low' | 'medium' | 'high'>().notNull(),
    title: text('title').notNull(),
    detail: text('detail').notNull(),
    paths: text('paths', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    estimatedSavingsTokens: integer('estimated_savings_tokens'),
    createdAt: createdAt(),
  },
  (table) => [index('context_insights_snapshot_idx').on(table.snapshotId)],
);

export const brainSources = sqliteTable(
  'brain_sources',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    content: text('content').notNull(),
    checksum: text('checksum').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('brain_sources_project_path_unique').on(table.projectId, table.path)],
);

export const brainOutputs = sqliteTable(
  'brain_outputs',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    format: text('format')
      .$type<'agents_md' | 'claude_md' | 'cursorrules' | 'gemini_md' | 'copilot_instructions'>()
      .notNull(),
    path: text('path').notNull(),
    content: text('content').notNull(),
    checksum: text('checksum').notNull(),
    sourceChecksum: text('source_checksum').notNull(),
    syncedAt: timestamp('synced_at'),
    driftDetected: integer('drift_detected', { mode: 'boolean' }).notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('brain_outputs_project_path_unique').on(table.projectId, table.path)],
);

export const brainDriftEvents = sqliteTable(
  'brain_drift_events',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    outputId: text('output_id')
      .notNull()
      .references(() => brainOutputs.id, { onDelete: 'cascade' }),
    detectedAt: timestamp('detected_at').notNull(),
    expectedChecksum: text('expected_checksum').notNull(),
    actualChecksum: text('actual_checksum').notNull(),
    resolvedAt: timestamp('resolved_at'),
    createdAt: createdAt(),
  },
  (table) => [index('brain_drift_events_project_idx').on(table.projectId, table.detectedAt)],
);

export const arenaRuns = sqliteTable(
  'arena_runs',
  {
    id: text('id').primaryKey(),
    sourceSessionId: text('source_session_id').references(() => sessions.id, {
      onDelete: 'set null',
    }),
    sourceStepId: text('source_step_id').references(() => steps.id, { onDelete: 'set null' }),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    status: text('status')
      .$type<'queued' | 'running' | 'completed' | 'failed' | 'cancelled'>()
      .notNull(),
    outputText: text('output_text'),
    diffText: text('diff_text'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costUsd: real('cost_usd'),
    costKnown: integer('cost_known', { mode: 'boolean' }).notNull().default(false),
    latencyMs: integer('latency_ms'),
    ttftMs: integer('ttft_ms'),
    testsPassed: integer('tests_passed', { mode: 'boolean' }),
    trustScore: integer('trust_score'),
    baselineCostUsd: real('baseline_cost_usd'),
    savingsPercent: real('savings_percent'),
    error: text('error'),
    startedAt: timestamp('started_at').notNull(),
    completedAt: timestamp('completed_at'),
    createdAt: createdAt(),
  },
  (table) => [
    index('arena_runs_session_idx').on(table.sourceSessionId, table.createdAt),
    index('arena_runs_status_idx').on(table.status),
  ],
);

export const handoffBriefs = sqliteTable(
  'handoff_briefs',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    contentMarkdown: text('content_markdown').notNull(),
    generatedAt: timestamp('generated_at').notNull(),
    model: text('model'),
    createdAt: createdAt(),
  },
  (table) => [index('handoff_briefs_session_idx').on(table.sessionId, table.generatedAt)],
);

export const journalEntries = sqliteTable(
  'journal_entries',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    weekStart: text('week_start').notNull(),
    title: text('title').notNull(),
    markdown: text('markdown').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index('journal_entries_project_week_idx').on(table.projectId, table.weekStart)],
);

export const plugins = sqliteTable(
  'plugins',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    version: text('version').notNull(),
    description: text('description'),
    manifest: text('manifest', { mode: 'json' }).$type<JsonObject>().notNull(),
    path: text('path').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    installedAt: timestamp('installed_at').notNull(),
    updatedAt: updatedAt(),
  },
  (table) => [index('plugins_enabled_idx').on(table.enabled)],
);

export const pluginRuns = sqliteTable(
  'plugin_runs',
  {
    id: text('id').primaryKey(),
    pluginId: text('plugin_id')
      .notNull()
      .references(() => plugins.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    kind: text('kind').$type<'guard' | 'analyzer'>().notNull(),
    status: text('status').$type<'ok' | 'error' | 'timeout'>().notNull(),
    result: text('result', { mode: 'json' }).$type<JsonValue>(),
    error: text('error'),
    startedAt: timestamp('started_at').notNull(),
    endedAt: timestamp('ended_at'),
  },
  (table) => [
    index('plugin_runs_plugin_idx').on(table.pluginId, table.startedAt),
    index('plugin_runs_session_idx').on(table.sessionId),
  ],
);

export const devices = sqliteTable(
  'devices',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    platform: text('platform').$type<'android' | 'ios' | 'desktop' | 'web' | 'cli'>().notNull(),
    tokenHash: text('token_hash').notNull(),
    publicKey: text('public_key'),
    lastSeenAt: timestamp('last_seen_at'),
    revokedAt: timestamp('revoked_at'),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex('devices_token_hash_unique').on(table.tokenHash)],
);

export const pairingTokens = sqliteTable(
  'pairing_tokens',
  {
    id: text('id').primaryKey(),
    tokenHash: text('token_hash').notNull(),
    deviceNameHint: text('device_name_hint'),
    expiresAt: timestamp('expires_at').notNull(),
    usedAt: timestamp('used_at'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('pairing_tokens_hash_unique').on(table.tokenHash),
    index('pairing_tokens_expiry_idx').on(table.expiresAt),
  ],
);

export const replayForks = sqliteTable(
  'replay_forks',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    stepId: text('step_id').references(() => steps.id, { onDelete: 'set null' }),
    branch: text('branch').notNull(),
    worktreePath: text('worktree_path').notNull(),
    baseCommit: text('base_commit'),
    resumeBrief: text('resume_brief').notNull(),
    status: text('status')
      .$type<'creating' | 'ready' | 'error' | 'removed'>()
      .notNull()
      .default('creating'),
    createdAt: createdAt(),
  },
  (table) => [index('replay_forks_session_idx').on(table.sessionId, table.createdAt)],
);

export const liveEvents = sqliteTable(
  'live_events',
  {
    sequence: integer('sequence').primaryKey({ autoIncrement: true }),
    type: text('type').notNull(),
    sessionId: text('session_id'),
    stepId: text('step_id'),
    payload: text('payload', { mode: 'json' })
      .$type<JsonObject>()
      .notNull()
      .$defaultFn(() => ({})),
    createdAt: createdAt(),
  },
  (table) => [
    index('live_events_session_idx').on(table.sessionId, table.sequence),
    index('live_events_created_at_idx').on(table.createdAt),
  ],
);

export const schema = {
  projects,
  settings,
  sessions,
  steps,
  streamChunks,
  toolCalls,
  guardRules,
  guardEvents,
  budgetPolicies,
  redactionRules,
  redactions,
  gitSnapshots,
  fileChanges,
  provenanceEntries,
  understandingFiles,
  understandingEvents,
  comprehensionQuizzes,
  cheatAnalyses,
  cheatFindings,
  contextSnapshots,
  contextSegments,
  contextInsights,
  brainSources,
  brainOutputs,
  brainDriftEvents,
  arenaRuns,
  handoffBriefs,
  journalEntries,
  plugins,
  pluginRuns,
  devices,
  pairingTokens,
  replayForks,
  liveEvents,
};
