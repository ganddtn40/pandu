import {
  AcknowledgeUnderstandingResponseSchema,
  AnalyticsQuerySchema,
  AnalyticsResponseSchema,
  ApiErrorSchema,
  ApprovalDecisionSchema,
  ArenaRunInputSchema,
  ArenaRunQuerySchema,
  ArenaRunResponseSchema,
  ArenaRunsResponseSchema,
  BrainGenerateInputSchema,
  BrainProjectStatusSchema,
  BrainSyncInputSchema,
  BrainSyncResponseSchema,
  BudgetPoliciesResponseSchema,
  BudgetPolicyInputSchema,
  BudgetPolicyPatchSchema,
  BudgetPolicyResponseSchema,
  BudgetStatusResponseSchema,
  ContextSnapshotDetailResponseSchema,
  CreateReplayForkResponseSchema,
  DeviceResponseSchema,
  DevicesResponseSchema,
  ExplainUnderstandingResponseSchema,
  GuardEventListQuerySchema,
  GuardEventResponseSchema,
  GuardEventsResponseSchema,
  GuardRuleInputSchema,
  GuardRulePatchSchema,
  GuardRuleResponseSchema,
  GuardRulesResponseSchema,
  HandoffBriefResponseSchema,
  HandoffBriefsResponseSchema,
  HandoffGenerateInputSchema,
  HealthResponseSchema,
  JournalEntriesResponseSchema,
  JournalEntryResponseSchema,
  JournalGenerateInputSchema,
  JournalListQuerySchema,
  PairingClaimInputSchema,
  PairingClaimResponseSchema,
  PairingSessionInputSchema,
  PairingSessionResponseSchema,
  PairingSessionStatusResponseSchema,
  PluginInstallInputSchema,
  PluginPatchSchema,
  PluginResponseSchema,
  PluginRunInputSchema,
  PluginRunResponseSchema,
  PluginRunsResponseSchema,
  PluginsResponseSchema,
  ProjectsResponseSchema,
  QuizStartResponseSchema,
  QuizSubmitInputSchema,
  QuizSubmitResponseSchema,
  RemoveBudgetPolicyResponseSchema,
  RemoveGuardRuleResponseSchema,
  RemovePluginResponseSchema,
  RemoveReplayForkResponseSchema,
  ReplayForksResponseSchema,
  SecretScanResponseSchema,
  SessionContextResponseSchema,
  SessionListResponseSchema,
  SessionProvenanceResponseSchema,
  SessionReplayResponseSchema,
  SessionResponseSchema,
  SessionStepsResponseSchema,
  SnapshotDetailResponseSchema,
  StatsResponseSchema,
  StepDetailResponseSchema,
  TrustResponseSchema,
  UnderstandingDetailResponseSchema,
  UnderstandingListResponseSchema,
  type AcknowledgeUnderstandingResponse,
  type AnalyticsQuery,
  type AnalyticsResponse,
  type ApiErrorCode,
  type ApprovalDecision,
  type ArenaRun,
  type ArenaRunInput,
  type ArenaRunQuery,
  type BrainFormat,
  type BrainProjectStatus,
  type BrainSyncInput,
  type BrainSyncResponse,
  type BudgetPolicy,
  type BudgetPolicyInput,
  type BudgetPolicyPatch,
  type BudgetStatus,
  type ContextSnapshotDetailResponse,
  type CreateReplayForkInput,
  type CreateReplayForkResponse,
  type Device,
  type ExplainUnderstandingResponse,
  type GuardEvent,
  type GuardEventListQuery,
  type GuardRule,
  type GuardRuleInput,
  type GuardRulePatch,
  type HandoffBrief,
  type HandoffGenerateInput,
  type HealthResponse,
  type JournalEntry,
  type JournalGenerateInput,
  type JournalListQuery,
  type PairingClaimInput,
  type PairingClaimResponse,
  type PairingSession,
  type PairingSessionInput,
  type PairingSessionStatus,
  type Plugin,
  type PluginInstallInput,
  type PluginPatch,
  type PluginRun,
  type PluginRunInput,
  type Project,
  type QuizStartResponse,
  type QuizSubmitInput,
  type QuizSubmitResponse,
  type RemoveReplayForkResponse,
  type ReplayForksResponse,
  type SecretScanResponse,
  type SessionContextResponse,
  type SessionListResponse,
  type SessionProvenanceResponse,
  type SessionReplayResponse,
  type SessionResponse,
  type SessionStatus,
  type SessionStepsResponse,
  type SnapshotDetailResponse,
  type StatsResponse,
  type StepDetailResponse,
  type TrustResponse,
  type UnderstandingDetailResponse,
  type UnderstandingListQuery,
  type UnderstandingListResponse,
} from '@cockpit/core';

interface ResponseSchema<T> {
  parse(value: unknown): T;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

interface MutationOptions extends RequestOptions {
  method: 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
}

export type SessionStatusFilter = SessionStatus | 'all';

export interface SessionFilters {
  search?: string;
  status?: SessionStatusFilter;
  cursor?: string;
  limit?: number;
}

export interface ApiClient {
  health: (options?: RequestOptions) => Promise<HealthResponse>;
  stats: (options?: RequestOptions) => Promise<StatsResponse>;
  listSessions: (
    filters?: SessionFilters,
    options?: RequestOptions,
  ) => Promise<SessionListResponse>;
  getSession: (id: string, options?: RequestOptions) => Promise<SessionResponse>;
  getSessionSteps: (
    id: string,
    options?: RequestOptions & { limit?: number },
  ) => Promise<SessionStepsResponse>;
  getStep: (id: string, options?: RequestOptions) => Promise<StepDetailResponse>;
  getSessionReplay: (id: string, options?: RequestOptions) => Promise<SessionReplayResponse>;
  getSnapshot: (id: string, options?: RequestOptions) => Promise<SnapshotDetailResponse>;
  listForks: (id: string, options?: RequestOptions) => Promise<ReplayForksResponse>;
  createFork: (
    id: string,
    input?: CreateReplayForkInput,
    options?: RequestOptions,
  ) => Promise<CreateReplayForkResponse>;
  removeFork: (forkId: string, options?: RequestOptions) => Promise<RemoveReplayForkResponse>;
  listGuardRules: (options?: RequestOptions) => Promise<GuardRule[]>;
  createGuardRule: (input: GuardRuleInput, options?: RequestOptions) => Promise<GuardRule>;
  updateGuardRule: (
    ruleId: string,
    patch: GuardRulePatch,
    options?: RequestOptions,
  ) => Promise<GuardRule>;
  deleteGuardRule: (ruleId: string, options?: RequestOptions) => Promise<boolean>;
  listGuardEvents: (
    query?: Partial<GuardEventListQuery>,
    options?: RequestOptions,
  ) => Promise<GuardEvent[]>;
  decideGuardEvent: (
    eventId: string,
    decision: ApprovalDecision,
    options?: RequestOptions,
  ) => Promise<GuardEvent>;
  listBudgetPolicies: (options?: RequestOptions) => Promise<BudgetPolicy[]>;
  createBudgetPolicy: (input: BudgetPolicyInput, options?: RequestOptions) => Promise<BudgetPolicy>;
  updateBudgetPolicy: (
    policyId: string,
    patch: BudgetPolicyPatch,
    options?: RequestOptions,
  ) => Promise<BudgetPolicy>;
  deleteBudgetPolicy: (policyId: string, options?: RequestOptions) => Promise<boolean>;
  getSessionBudgets: (sessionId: string, options?: RequestOptions) => Promise<BudgetStatus[]>;
  scanSession: (sessionId: string, options?: RequestOptions) => Promise<SecretScanResponse>;
  getTrust: (sessionId: string, options?: RequestOptions) => Promise<TrustResponse>;
  analyzeTrust: (sessionId: string, options?: RequestOptions) => Promise<TrustResponse>;
  getSessionProvenance: (
    sessionId: string,
    options?: RequestOptions,
  ) => Promise<SessionProvenanceResponse>;
  recomputeSessionProvenance: (
    sessionId: string,
    options?: RequestOptions,
  ) => Promise<SessionProvenanceResponse>;
  listUnderstanding: (
    query?: Partial<UnderstandingListQuery>,
    options?: RequestOptions,
  ) => Promise<UnderstandingListResponse>;
  listSessionUnderstanding: (
    sessionId: string,
    query?: Partial<UnderstandingListQuery>,
    options?: RequestOptions,
  ) => Promise<UnderstandingListResponse>;
  getUnderstanding: (
    understandingId: string,
    options?: RequestOptions,
  ) => Promise<UnderstandingDetailResponse>;
  openUnderstanding: (
    understandingId: string,
    options?: RequestOptions,
  ) => Promise<AcknowledgeUnderstandingResponse>;
  acknowledgeUnderstanding: (
    understandingId: string,
    options?: RequestOptions,
  ) => Promise<AcknowledgeUnderstandingResponse>;
  explainUnderstanding: (
    understandingId: string,
    options?: RequestOptions,
  ) => Promise<ExplainUnderstandingResponse>;
  startUnderstandingQuiz: (
    understandingId: string,
    options?: RequestOptions,
  ) => Promise<QuizStartResponse>;
  submitUnderstandingQuiz: (
    quizId: string,
    input: QuizSubmitInput,
    options?: RequestOptions,
  ) => Promise<QuizSubmitResponse>;
  getSessionContext: (
    sessionId: string,
    options?: RequestOptions,
  ) => Promise<SessionContextResponse>;
  recomputeSessionContext: (
    sessionId: string,
    options?: RequestOptions,
  ) => Promise<SessionContextResponse>;
  getContextSnapshot: (
    snapshotId: string,
    options?: RequestOptions,
  ) => Promise<ContextSnapshotDetailResponse>;
  listProjects: (options?: RequestOptions) => Promise<Project[]>;
  getBrainStatus: (projectId: string, options?: RequestOptions) => Promise<BrainProjectStatus>;
  generateBrain: (
    projectId: string,
    formats?: readonly BrainFormat[],
    options?: RequestOptions,
  ) => Promise<BrainProjectStatus>;
  syncBrain: (
    projectId: string,
    input?: Partial<BrainSyncInput>,
    options?: RequestOptions,
  ) => Promise<BrainSyncResponse>;
  runArena: (
    sessionId: string,
    input: ArenaRunInput,
    options?: RequestOptions,
  ) => Promise<ArenaRun[]>;
  listArenaRuns: (query?: Partial<ArenaRunQuery>, options?: RequestOptions) => Promise<ArenaRun[]>;
  getArenaRun: (runId: string, options?: RequestOptions) => Promise<ArenaRun>;
  listHandoffs: (sessionId: string, options?: RequestOptions) => Promise<HandoffBrief[]>;
  generateHandoff: (
    sessionId: string,
    input?: Partial<HandoffGenerateInput>,
    options?: RequestOptions,
  ) => Promise<HandoffBrief>;
  getHandoff: (briefId: string, options?: RequestOptions) => Promise<HandoffBrief>;
  getAnalytics: (
    query?: Partial<AnalyticsQuery>,
    options?: RequestOptions,
  ) => Promise<AnalyticsResponse>;
  listJournal: (
    query?: Partial<JournalListQuery>,
    options?: RequestOptions,
  ) => Promise<JournalEntry[]>;
  generateJournal: (
    input?: Partial<JournalGenerateInput>,
    options?: RequestOptions,
  ) => Promise<JournalEntry>;
  getJournalEntry: (entryId: string, options?: RequestOptions) => Promise<JournalEntry>;
  listPlugins: (options?: RequestOptions) => Promise<Plugin[]>;
  installPlugin: (input: PluginInstallInput, options?: RequestOptions) => Promise<Plugin>;
  updatePlugin: (pluginId: string, patch: PluginPatch, options?: RequestOptions) => Promise<Plugin>;
  removePlugin: (pluginId: string, options?: RequestOptions) => Promise<boolean>;
  runPlugin: (
    pluginId: string,
    input: PluginRunInput,
    options?: RequestOptions,
  ) => Promise<PluginRun>;
  listPluginRuns: (
    pluginId: string,
    limit?: number,
    options?: RequestOptions,
  ) => Promise<PluginRun[]>;
  createPairing: (
    input?: Partial<PairingSessionInput>,
    options?: RequestOptions,
  ) => Promise<PairingSession>;
  getPairingSession: (id: string, options?: RequestOptions) => Promise<PairingSessionStatus>;
  cancelPairing: (id: string, options?: RequestOptions) => Promise<void>;
  claimPairing: (
    input: PairingClaimInput,
    options?: RequestOptions,
  ) => Promise<PairingClaimResponse>;
  listDevices: (options?: RequestOptions) => Promise<Device[]>;
  revokeDevice: (id: string, options?: RequestOptions) => Promise<Device>;
}

export interface ApiClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details: unknown;

  constructor(status: number, code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError';
}

export function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof Error && error.message.length > 0) return error.message;
  return 'An unexpected error occurred.';
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = (options.baseUrl ?? '').replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;

  async function send(
    path: string,
    requestOptions: RequestOptions | MutationOptions = {},
  ): Promise<Response> {
    const mutation = 'method' in requestOptions ? requestOptions : undefined;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (mutation?.body !== undefined) headers['content-type'] = 'application/json';

    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        headers,
        ...(mutation ? { method: mutation.method } : {}),
        ...(mutation?.body === undefined ? {} : { body: JSON.stringify(mutation.body) }),
        ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new ApiRequestError(
        0,
        'internal_error',
        'The Cockpit daemon is unreachable. Check that it is running on this machine.',
      );
    }

    if (!response.ok) {
      let code: ApiErrorCode = 'internal_error';
      let message = `The daemon responded with HTTP ${response.status}.`;
      let details: unknown;

      try {
        const parsed = ApiErrorSchema.safeParse(await response.json());
        if (parsed.success) {
          code = parsed.data.error.code;
          message = parsed.data.error.message;
          details = parsed.data.error.details;
        }
      } catch {
        // Keep the status-based fallback when the body is not JSON.
      }

      throw new ApiRequestError(response.status, code, message, details);
    }

    return response;
  }

  async function request<T>(
    path: string,
    schema: ResponseSchema<T>,
    requestOptions: RequestOptions | MutationOptions = {},
  ): Promise<T> {
    const response = await send(path, requestOptions);
    const payload: unknown = await response.json();
    try {
      return schema.parse(payload);
    } catch {
      throw new ApiRequestError(
        response.status,
        'internal_error',
        'The daemon returned a response Cockpit could not understand.',
      );
    }
  }

  async function requestNoContent(
    path: string,
    requestOptions: RequestOptions | MutationOptions = {},
  ): Promise<void> {
    await send(path, requestOptions);
  }

  function sessionQuery(filters: SessionFilters): string {
    const params = new URLSearchParams();
    const search = filters.search?.trim();
    if (search) params.set('search', search);
    if (filters.status && filters.status !== 'all') params.set('status', filters.status);
    if (filters.cursor) params.set('cursor', filters.cursor);
    params.set('limit', String(filters.limit ?? 50));
    const query = params.toString();
    return query.length > 0 ? `?${query}` : '';
  }

  return {
    health(requestOptions = {}) {
      return request('/api/health', HealthResponseSchema, requestOptions);
    },
    stats(requestOptions = {}) {
      return request('/api/stats', StatsResponseSchema, requestOptions);
    },
    listSessions(filters = {}, requestOptions = {}) {
      return request(
        `/api/sessions${sessionQuery(filters)}`,
        SessionListResponseSchema,
        requestOptions,
      );
    },
    getSession(id, requestOptions = {}) {
      return request(
        `/api/sessions/${encodeURIComponent(id)}`,
        SessionResponseSchema,
        requestOptions,
      );
    },
    getSessionSteps(id, requestOptions = {}) {
      const limit = requestOptions.limit;
      const query = limit === undefined ? '' : `?limit=${String(limit)}`;
      return request(
        `/api/sessions/${encodeURIComponent(id)}/steps${query}`,
        SessionStepsResponseSchema,
        requestOptions.signal ? { signal: requestOptions.signal } : {},
      );
    },
    getStep(id, requestOptions = {}) {
      return request(
        `/api/steps/${encodeURIComponent(id)}`,
        StepDetailResponseSchema,
        requestOptions,
      );
    },
    getSessionReplay(id, requestOptions = {}) {
      return request(
        `/api/sessions/${encodeURIComponent(id)}/replay`,
        SessionReplayResponseSchema,
        requestOptions,
      );
    },
    getSnapshot(id, requestOptions = {}) {
      return request(
        `/api/snapshots/${encodeURIComponent(id)}`,
        SnapshotDetailResponseSchema,
        requestOptions,
      );
    },
    listForks(id, requestOptions = {}) {
      return request(
        `/api/sessions/${encodeURIComponent(id)}/forks`,
        ReplayForksResponseSchema,
        requestOptions,
      );
    },
    createFork(id, input = {}, requestOptions = {}) {
      return request(
        `/api/sessions/${encodeURIComponent(id)}/forks`,
        CreateReplayForkResponseSchema,
        {
          method: 'POST',
          body: input,
          ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
        },
      );
    },
    removeFork(forkId, requestOptions = {}) {
      return request(`/api/forks/${encodeURIComponent(forkId)}`, RemoveReplayForkResponseSchema, {
        method: 'DELETE',
        ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
      });
    },
    async listGuardRules(requestOptions = {}) {
      const response = await request('/api/guards/rules', GuardRulesResponseSchema, requestOptions);
      return response.rules;
    },
    async createGuardRule(input, requestOptions = {}) {
      const body = GuardRuleInputSchema.parse(input);
      const response = await request('/api/guards/rules', GuardRuleResponseSchema, {
        method: 'POST',
        body,
        ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
      });
      return response.rule;
    },
    async updateGuardRule(ruleId, patch, requestOptions = {}) {
      const body = GuardRulePatchSchema.parse(patch);
      const response = await request(
        `/api/guards/rules/${encodeURIComponent(ruleId)}`,
        GuardRuleResponseSchema,
        {
          method: 'PATCH',
          body,
          ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
        },
      );
      return response.rule;
    },
    async deleteGuardRule(ruleId, requestOptions = {}) {
      const response = await request(
        `/api/guards/rules/${encodeURIComponent(ruleId)}`,
        RemoveGuardRuleResponseSchema,
        {
          method: 'DELETE',
          ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
        },
      );
      return response.removed;
    },
    async listGuardEvents(query = {}, requestOptions = {}) {
      const parsed = GuardEventListQuerySchema.parse(query);
      const params = new URLSearchParams();
      if (parsed.sessionId) params.set('sessionId', parsed.sessionId);
      if (parsed.status) params.set('status', parsed.status);
      if (parsed.kind) params.set('kind', parsed.kind);
      params.set('limit', String(parsed.limit));
      const response = await request(
        `/api/guards/events?${params.toString()}`,
        GuardEventsResponseSchema,
        requestOptions,
      );
      return response.events;
    },
    async decideGuardEvent(eventId, decision, requestOptions = {}) {
      const body = ApprovalDecisionSchema.parse(decision);
      const response = await request(
        `/api/guards/events/${encodeURIComponent(eventId)}/decision`,
        GuardEventResponseSchema,
        {
          method: 'POST',
          body,
          ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
        },
      );
      return response.event;
    },
    async listBudgetPolicies(requestOptions = {}) {
      const response = await request('/api/budgets', BudgetPoliciesResponseSchema, requestOptions);
      return response.policies;
    },
    async createBudgetPolicy(input, requestOptions = {}) {
      const body = BudgetPolicyInputSchema.parse(input);
      const response = await request('/api/budgets', BudgetPolicyResponseSchema, {
        method: 'POST',
        body,
        ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
      });
      return response.policy;
    },
    async updateBudgetPolicy(policyId, patch, requestOptions = {}) {
      const body = BudgetPolicyPatchSchema.parse(patch);
      const response = await request(
        `/api/budgets/${encodeURIComponent(policyId)}`,
        BudgetPolicyResponseSchema,
        {
          method: 'PATCH',
          body,
          ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
        },
      );
      return response.policy;
    },
    async deleteBudgetPolicy(policyId, requestOptions = {}) {
      const response = await request(
        `/api/budgets/${encodeURIComponent(policyId)}`,
        RemoveBudgetPolicyResponseSchema,
        {
          method: 'DELETE',
          ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
        },
      );
      return response.removed;
    },
    async getSessionBudgets(sessionId, requestOptions = {}) {
      const response = await request(
        `/api/sessions/${encodeURIComponent(sessionId)}/budgets`,
        BudgetStatusResponseSchema,
        requestOptions,
      );
      return response.statuses;
    },
    scanSession(sessionId, requestOptions = {}) {
      return request(
        `/api/sessions/${encodeURIComponent(sessionId)}/scan`,
        SecretScanResponseSchema,
        {
          method: 'POST',
          ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
        },
      );
    },
    getTrust(sessionId, requestOptions = {}) {
      return request(
        `/api/sessions/${encodeURIComponent(sessionId)}/trust`,
        TrustResponseSchema,
        requestOptions,
      );
    },
    analyzeTrust(sessionId, requestOptions = {}) {
      return request(`/api/sessions/${encodeURIComponent(sessionId)}/trust`, TrustResponseSchema, {
        method: 'POST',
        ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
      });
    },
    getSessionProvenance(sessionId, requestOptions = {}) {
      return request(
        `/api/sessions/${encodeURIComponent(sessionId)}/provenance`,
        SessionProvenanceResponseSchema,
        requestOptions,
      );
    },
    recomputeSessionProvenance(sessionId, requestOptions = {}) {
      return request(
        `/api/sessions/${encodeURIComponent(sessionId)}/provenance`,
        SessionProvenanceResponseSchema,
        {
          method: 'POST',
          ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
        },
      );
    },
    listUnderstanding(query = {}, requestOptions = {}) {
      const params = new URLSearchParams();
      if (query.projectId) params.set('projectId', query.projectId);
      if (query.sessionId) params.set('sessionId', query.sessionId);
      if (query.status) params.set('status', query.status);
      if (query.limit !== undefined) params.set('limit', String(query.limit));
      const suffix = params.size > 0 ? `?${params.toString()}` : '';
      return request(
        `/api/understanding${suffix}`,
        UnderstandingListResponseSchema,
        requestOptions,
      );
    },
    listSessionUnderstanding(sessionId, query = {}, requestOptions = {}) {
      const params = new URLSearchParams();
      if (query.status) params.set('status', query.status);
      if (query.limit !== undefined) params.set('limit', String(query.limit));
      const suffix = params.size > 0 ? `?${params.toString()}` : '';
      return request(
        `/api/sessions/${encodeURIComponent(sessionId)}/understanding${suffix}`,
        UnderstandingListResponseSchema,
        requestOptions,
      );
    },
    getUnderstanding(understandingId, requestOptions = {}) {
      return request(
        `/api/understanding/${encodeURIComponent(understandingId)}`,
        UnderstandingDetailResponseSchema,
        requestOptions,
      );
    },
    openUnderstanding(understandingId, requestOptions = {}) {
      return request(
        `/api/understanding/${encodeURIComponent(understandingId)}/open`,
        AcknowledgeUnderstandingResponseSchema,
        {
          method: 'POST',
          ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
        },
      );
    },
    acknowledgeUnderstanding(understandingId, requestOptions = {}) {
      return request(
        `/api/understanding/${encodeURIComponent(understandingId)}/acknowledge`,
        AcknowledgeUnderstandingResponseSchema,
        {
          method: 'POST',
          ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
        },
      );
    },
    explainUnderstanding(understandingId, requestOptions = {}) {
      return request(
        `/api/understanding/${encodeURIComponent(understandingId)}/explain`,
        ExplainUnderstandingResponseSchema,
        {
          method: 'POST',
          ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
        },
      );
    },
    startUnderstandingQuiz(understandingId, requestOptions = {}) {
      return request(
        `/api/understanding/${encodeURIComponent(understandingId)}/quiz`,
        QuizStartResponseSchema,
        {
          method: 'POST',
          ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
        },
      );
    },
    submitUnderstandingQuiz(quizId, input, requestOptions = {}) {
      const body = QuizSubmitInputSchema.parse(input);
      return request(
        `/api/understanding/quizzes/${encodeURIComponent(quizId)}/submit`,
        QuizSubmitResponseSchema,
        {
          method: 'POST',
          body,
          ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
        },
      );
    },
    getSessionContext(sessionId, requestOptions = {}) {
      return request(
        `/api/sessions/${encodeURIComponent(sessionId)}/context`,
        SessionContextResponseSchema,
        requestOptions,
      );
    },
    recomputeSessionContext(sessionId, requestOptions = {}) {
      return request(
        `/api/sessions/${encodeURIComponent(sessionId)}/context`,
        SessionContextResponseSchema,
        {
          method: 'POST',
          ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
        },
      );
    },
    getContextSnapshot(snapshotId, requestOptions = {}) {
      return request(
        `/api/context/${encodeURIComponent(snapshotId)}`,
        ContextSnapshotDetailResponseSchema,
        requestOptions,
      );
    },
    async listProjects(requestOptions = {}) {
      const response = await request('/api/projects', ProjectsResponseSchema, requestOptions);
      return response.projects;
    },
    getBrainStatus(projectId, requestOptions = {}) {
      return request(
        `/api/projects/${encodeURIComponent(projectId)}/brain`,
        BrainProjectStatusSchema,
        requestOptions,
      );
    },
    generateBrain(projectId, formats, requestOptions = {}) {
      const body = BrainGenerateInputSchema.parse(formats === undefined ? {} : { formats });
      return request(
        `/api/projects/${encodeURIComponent(projectId)}/brain/generate`,
        BrainProjectStatusSchema,
        {
          method: 'POST',
          body,
          ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
        },
      );
    },
    syncBrain(projectId, input = {}, requestOptions = {}) {
      const body = BrainSyncInputSchema.parse(input);
      return request(
        `/api/projects/${encodeURIComponent(projectId)}/brain/sync`,
        BrainSyncResponseSchema,
        {
          method: 'POST',
          body,
          ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
        },
      );
    },
    async runArena(sessionId, input, requestOptions = {}) {
      const body = ArenaRunInputSchema.parse(input);
      const response = await request(
        `/api/sessions/${encodeURIComponent(sessionId)}/arena`,
        ArenaRunsResponseSchema,
        {
          method: 'POST',
          body,
          ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
        },
      );
      return response.runs;
    },
    async listArenaRuns(query = {}, requestOptions = {}) {
      const parsed = ArenaRunQuerySchema.parse(query);
      const params = new URLSearchParams({ limit: String(parsed.limit) });
      if (parsed.sessionId) params.set('sessionId', parsed.sessionId);
      if (parsed.stepId) params.set('stepId', parsed.stepId);
      const response = await request(
        `/api/arena?${params.toString()}`,
        ArenaRunsResponseSchema,
        requestOptions,
      );
      return response.runs;
    },
    async getArenaRun(runId, requestOptions = {}) {
      const response = await request(
        `/api/arena/${encodeURIComponent(runId)}`,
        ArenaRunResponseSchema,
        requestOptions,
      );
      return response.run;
    },
    async listHandoffs(sessionId, requestOptions = {}) {
      const response = await request(
        `/api/sessions/${encodeURIComponent(sessionId)}/handoffs`,
        HandoffBriefsResponseSchema,
        requestOptions,
      );
      return response.briefs;
    },
    async generateHandoff(sessionId, input = {}, requestOptions = {}) {
      const body = HandoffGenerateInputSchema.parse(input);
      const response = await request(
        `/api/sessions/${encodeURIComponent(sessionId)}/handoffs`,
        HandoffBriefResponseSchema,
        {
          method: 'POST',
          body,
          ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
        },
      );
      return response.brief;
    },
    async getHandoff(briefId, requestOptions = {}) {
      const response = await request(
        `/api/handoffs/${encodeURIComponent(briefId)}`,
        HandoffBriefResponseSchema,
        requestOptions,
      );
      return response.brief;
    },
    getAnalytics(query = {}, requestOptions = {}) {
      const parsed = AnalyticsQuerySchema.parse(query);
      const params = new URLSearchParams({ days: String(parsed.days) });
      if (parsed.projectId) params.set('projectId', parsed.projectId);
      if (parsed.agent) params.set('agent', parsed.agent);
      return request(
        `/api/analytics?${params.toString()}`,
        AnalyticsResponseSchema,
        requestOptions,
      );
    },
    async listJournal(query = {}, requestOptions = {}) {
      const parsed = JournalListQuerySchema.parse(query);
      const params = new URLSearchParams({ limit: String(parsed.limit) });
      if (parsed.projectId) params.set('projectId', parsed.projectId);
      const response = await request(
        `/api/journal?${params.toString()}`,
        JournalEntriesResponseSchema,
        requestOptions,
      );
      return response.entries;
    },
    async generateJournal(input = {}, requestOptions = {}) {
      const body = JournalGenerateInputSchema.parse(input);
      const response = await request('/api/journal/generate', JournalEntryResponseSchema, {
        method: 'POST',
        body,
        ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
      });
      return response.entry;
    },
    async getJournalEntry(entryId, requestOptions = {}) {
      const response = await request(
        `/api/journal/${encodeURIComponent(entryId)}`,
        JournalEntryResponseSchema,
        requestOptions,
      );
      return response.entry;
    },
    async listPlugins(requestOptions = {}) {
      const response = await request('/api/plugins', PluginsResponseSchema, requestOptions);
      return response.plugins;
    },
    async installPlugin(input, requestOptions = {}) {
      const body = PluginInstallInputSchema.parse(input);
      const response = await request('/api/plugins', PluginResponseSchema, {
        method: 'POST',
        body,
        ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
      });
      return response.plugin;
    },
    async updatePlugin(pluginId, patch, requestOptions = {}) {
      const body = PluginPatchSchema.parse(patch);
      const response = await request(
        `/api/plugins/${encodeURIComponent(pluginId)}`,
        PluginResponseSchema,
        {
          method: 'PATCH',
          body,
          ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
        },
      );
      return response.plugin;
    },
    async removePlugin(pluginId, requestOptions = {}) {
      const response = await request(
        `/api/plugins/${encodeURIComponent(pluginId)}`,
        RemovePluginResponseSchema,
        {
          method: 'DELETE',
          ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
        },
      );
      return response.removed;
    },
    async runPlugin(pluginId, input, requestOptions = {}) {
      const body = PluginRunInputSchema.parse(input);
      const response = await request(
        `/api/plugins/${encodeURIComponent(pluginId)}/run`,
        PluginRunResponseSchema,
        {
          method: 'POST',
          body,
          ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
        },
      );
      return response.run;
    },
    async listPluginRuns(pluginId, limit = 20, requestOptions = {}) {
      const params = new URLSearchParams({ limit: String(limit) });
      const response = await request(
        `/api/plugins/${encodeURIComponent(pluginId)}/runs?${params.toString()}`,
        PluginRunsResponseSchema,
        requestOptions,
      );
      return response.runs;
    },
    async createPairing(input = {}, requestOptions = {}) {
      const body = PairingSessionInputSchema.parse(input);
      const response = await request('/api/pairing/sessions', PairingSessionResponseSchema, {
        method: 'POST',
        body,
        ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
      });
      return response.pairing;
    },
    async getPairingSession(id, requestOptions = {}) {
      const response = await request(
        `/api/pairing/sessions/${encodeURIComponent(id)}`,
        PairingSessionStatusResponseSchema,
        requestOptions,
      );
      return response.pairing;
    },
    async cancelPairing(id, requestOptions = {}) {
      await requestNoContent(`/api/pairing/sessions/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
      });
    },
    async claimPairing(input, requestOptions = {}) {
      const body = PairingClaimInputSchema.parse(input);
      return request('/api/pairing/claim', PairingClaimResponseSchema, {
        method: 'POST',
        body,
        ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
      });
    },
    async listDevices(requestOptions = {}) {
      const response = await request('/api/devices', DevicesResponseSchema, requestOptions);
      return response.devices;
    },
    async revokeDevice(id, requestOptions = {}) {
      const response = await request(
        `/api/devices/${encodeURIComponent(id)}`,
        DeviceResponseSchema,
        {
          method: 'DELETE',
          ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
        },
      );
      return response.device;
    },
  };
}

export const defaultApiClient = createApiClient();
