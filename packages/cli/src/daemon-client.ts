import {
  AcknowledgeUnderstandingResponseSchema,
  AnalyticsQuerySchema,
  AnalyticsResponseSchema,
  ApprovalDecisionSchema,
  ArenaRunInputSchema,
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
  CreateSessionInputSchema,
  DemoSeedResponseSchema,
  DeviceResponseSchema,
  DevicesResponseSchema,
  ExplainUnderstandingResponseSchema,
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
  SecretScanResponseSchema,
  SessionContextResponseSchema,
  SessionProvenanceResponseSchema,
  SessionResponseSchema,
  SessionSchema,
  SessionStepsResponseSchema,
  StepDetailResponseSchema,
  TrustResponseSchema,
  UnderstandingDetailResponseSchema,
  UnderstandingListResponseSchema,
  type AcknowledgeUnderstandingResponse,
  type AnalyticsQuery,
  type AnalyticsResponse,
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
  type CreateSessionInput,
  type DemoSeedResponse,
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
  type SecretScanResponse,
  type Session,
  type SessionContextResponse,
  type SessionProvenanceResponse,
  type SessionStatus,
  type SessionStepsResponse,
  type StepDetailResponse,
  type TrustResponse,
  type UnderstandingDetailResponse,
  type UnderstandingListQuery,
  type UnderstandingListResponse,
} from '@cockpit/core';
import type { z } from 'zod';

const DEFAULT_TIMEOUT_MS = 3_000;

export class DaemonRequestError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;

  constructor(message: string, options: { status?: number; code?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DaemonRequestError';
    this.status = options.status;
    this.code = options.code;
  }
}

function trimBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

async function responseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

export class DaemonClient {
  readonly baseUrl: string;
  readonly timeoutMs: number;

  constructor(baseUrl: string, options: { timeoutMs?: number } = {}) {
    this.baseUrl = trimBaseUrl(baseUrl);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async health(): Promise<HealthResponse | undefined> {
    try {
      return await this.request('/api/health', HealthResponseSchema, {
        method: 'GET',
      });
    } catch {
      return undefined;
    }
  }

  async createSession(input: CreateSessionInput): Promise<Session> {
    const parsed = CreateSessionInputSchema.parse(input);
    const response = await this.request('/api/sessions', SessionResponseSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(parsed),
    });
    return response.session;
  }

  async getSession(sessionId: string): Promise<Session> {
    const response = await this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}`,
      SessionResponseSchema,
      { method: 'GET' },
    );
    return SessionSchema.parse(response.session);
  }

  async seedDemo(): Promise<DemoSeedResponse> {
    return this.request('/api/demo/seed', DemoSeedResponseSchema, {
      method: 'POST',
    });
  }

  async endSession(sessionId: string, status: SessionStatus): Promise<Session> {
    const response = await this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/end`,
      SessionResponseSchema,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status }),
      },
    );
    return response.session;
  }

  async listSteps(sessionId: string): Promise<SessionStepsResponse> {
    return this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/steps`,
      SessionStepsResponseSchema,
      { method: 'GET' },
    );
  }

  async getStep(stepId: string): Promise<StepDetailResponse> {
    return this.request(`/api/steps/${encodeURIComponent(stepId)}`, StepDetailResponseSchema, {
      method: 'GET',
    });
  }

  async listGuardRules(): Promise<GuardRule[]> {
    const response = await this.request('/api/guards/rules', GuardRulesResponseSchema, {
      method: 'GET',
    });
    return response.rules;
  }

  async createGuardRule(input: GuardRuleInput): Promise<GuardRule> {
    const parsed = GuardRuleInputSchema.parse(input);
    const response = await this.request('/api/guards/rules', GuardRuleResponseSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(parsed),
    });
    return response.rule;
  }

  async updateGuardRule(ruleId: string, patch: GuardRulePatch): Promise<GuardRule> {
    const parsed = GuardRulePatchSchema.parse(patch);
    const response = await this.request(
      `/api/guards/rules/${encodeURIComponent(ruleId)}`,
      GuardRuleResponseSchema,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parsed),
      },
    );
    return response.rule;
  }

  async deleteGuardRule(ruleId: string): Promise<boolean> {
    const response = await this.request(
      `/api/guards/rules/${encodeURIComponent(ruleId)}`,
      RemoveGuardRuleResponseSchema,
      { method: 'DELETE' },
    );
    return response.removed;
  }

  async listGuardEvents(query: Partial<GuardEventListQuery> = {}): Promise<GuardEvent[]> {
    const params = new URLSearchParams();
    if (query.sessionId) params.set('sessionId', query.sessionId);
    if (query.status) params.set('status', query.status);
    if (query.kind) params.set('kind', query.kind);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    const response = await this.request(`/api/guards/events${suffix}`, GuardEventsResponseSchema, {
      method: 'GET',
    });
    return response.events;
  }

  async decideGuardEvent(eventId: string, decision: ApprovalDecision): Promise<GuardEvent> {
    const parsed = ApprovalDecisionSchema.parse(decision);
    const response = await this.request(
      `/api/guards/events/${encodeURIComponent(eventId)}/decision`,
      GuardEventResponseSchema,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parsed),
      },
    );
    return response.event;
  }

  async listBudgetPolicies(): Promise<BudgetPolicy[]> {
    const response = await this.request('/api/budgets', BudgetPoliciesResponseSchema, {
      method: 'GET',
    });
    return response.policies;
  }

  async createBudgetPolicy(input: BudgetPolicyInput): Promise<BudgetPolicy> {
    const parsed = BudgetPolicyInputSchema.parse(input);
    const response = await this.request('/api/budgets', BudgetPolicyResponseSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(parsed),
    });
    return response.policy;
  }

  async updateBudgetPolicy(policyId: string, patch: BudgetPolicyPatch): Promise<BudgetPolicy> {
    const parsed = BudgetPolicyPatchSchema.parse(patch);
    const response = await this.request(
      `/api/budgets/${encodeURIComponent(policyId)}`,
      BudgetPolicyResponseSchema,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parsed),
      },
    );
    return response.policy;
  }

  async deleteBudgetPolicy(policyId: string): Promise<boolean> {
    const response = await this.request(
      `/api/budgets/${encodeURIComponent(policyId)}`,
      RemoveBudgetPolicyResponseSchema,
      { method: 'DELETE' },
    );
    return response.removed;
  }

  async sessionBudgets(sessionId: string): Promise<BudgetStatus[]> {
    const response = await this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/budgets`,
      BudgetStatusResponseSchema,
      { method: 'GET' },
    );
    return response.statuses;
  }

  async scanSession(sessionId: string): Promise<SecretScanResponse> {
    return this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/scan`,
      SecretScanResponseSchema,
      { method: 'POST' },
    );
  }

  async getTrust(sessionId: string): Promise<TrustResponse> {
    return this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/trust`,
      TrustResponseSchema,
      { method: 'GET' },
    );
  }

  async analyzeTrust(sessionId: string): Promise<TrustResponse> {
    return this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/trust`,
      TrustResponseSchema,
      { method: 'POST' },
    );
  }

  async getSessionProvenance(sessionId: string): Promise<SessionProvenanceResponse> {
    return this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/provenance`,
      SessionProvenanceResponseSchema,
      { method: 'GET' },
    );
  }

  async recomputeSessionProvenance(sessionId: string): Promise<SessionProvenanceResponse> {
    return this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/provenance`,
      SessionProvenanceResponseSchema,
      { method: 'POST' },
    );
  }

  async listUnderstanding(
    query: Partial<UnderstandingListQuery> = {},
  ): Promise<UnderstandingListResponse> {
    const params = new URLSearchParams();
    if (query.projectId) params.set('projectId', query.projectId);
    if (query.sessionId) params.set('sessionId', query.sessionId);
    if (query.status) params.set('status', query.status);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    return this.request(`/api/understanding${suffix}`, UnderstandingListResponseSchema, {
      method: 'GET',
    });
  }

  async listSessionUnderstanding(
    sessionId: string,
    query: Partial<UnderstandingListQuery> = {},
  ): Promise<UnderstandingListResponse> {
    const params = new URLSearchParams();
    if (query.status) params.set('status', query.status);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    return this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/understanding${suffix}`,
      UnderstandingListResponseSchema,
      { method: 'GET' },
    );
  }

  async getUnderstanding(understandingId: string): Promise<UnderstandingDetailResponse> {
    return this.request(
      `/api/understanding/${encodeURIComponent(understandingId)}`,
      UnderstandingDetailResponseSchema,
      { method: 'GET' },
    );
  }

  async openUnderstanding(understandingId: string): Promise<AcknowledgeUnderstandingResponse> {
    return this.request(
      `/api/understanding/${encodeURIComponent(understandingId)}/open`,
      AcknowledgeUnderstandingResponseSchema,
      { method: 'POST' },
    );
  }

  async acknowledgeUnderstanding(
    understandingId: string,
  ): Promise<AcknowledgeUnderstandingResponse> {
    return this.request(
      `/api/understanding/${encodeURIComponent(understandingId)}/acknowledge`,
      AcknowledgeUnderstandingResponseSchema,
      { method: 'POST' },
    );
  }

  async explainUnderstanding(understandingId: string): Promise<ExplainUnderstandingResponse> {
    return this.request(
      `/api/understanding/${encodeURIComponent(understandingId)}/explain`,
      ExplainUnderstandingResponseSchema,
      { method: 'POST' },
    );
  }

  async startUnderstandingQuiz(understandingId: string): Promise<QuizStartResponse> {
    return this.request(
      `/api/understanding/${encodeURIComponent(understandingId)}/quiz`,
      QuizStartResponseSchema,
      { method: 'POST' },
    );
  }

  async submitUnderstandingQuiz(
    quizId: string,
    input: QuizSubmitInput,
  ): Promise<QuizSubmitResponse> {
    const parsed = QuizSubmitInputSchema.parse(input);
    return this.request(
      `/api/understanding/quizzes/${encodeURIComponent(quizId)}/submit`,
      QuizSubmitResponseSchema,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parsed),
      },
    );
  }

  async getSessionContext(sessionId: string): Promise<SessionContextResponse> {
    return this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/context`,
      SessionContextResponseSchema,
      { method: 'GET' },
    );
  }

  async recomputeSessionContext(sessionId: string): Promise<SessionContextResponse> {
    return this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/context`,
      SessionContextResponseSchema,
      { method: 'POST' },
    );
  }

  async getContextSnapshot(snapshotId: string): Promise<ContextSnapshotDetailResponse> {
    return this.request(
      `/api/context/${encodeURIComponent(snapshotId)}`,
      ContextSnapshotDetailResponseSchema,
      { method: 'GET' },
    );
  }

  async listProjects(): Promise<Project[]> {
    const response = await this.request('/api/projects', ProjectsResponseSchema, {
      method: 'GET',
    });
    return response.projects;
  }

  async getBrainStatus(projectId: string): Promise<BrainProjectStatus> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/brain`,
      BrainProjectStatusSchema,
      { method: 'GET' },
    );
  }

  async generateBrain(
    projectId: string,
    formats?: readonly BrainFormat[],
  ): Promise<BrainProjectStatus> {
    const body = BrainGenerateInputSchema.parse(formats === undefined ? {} : { formats });
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/brain/generate`,
      BrainProjectStatusSchema,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
  }

  async syncBrain(
    projectId: string,
    input: Partial<BrainSyncInput> = {},
  ): Promise<BrainSyncResponse> {
    const body = BrainSyncInputSchema.parse(input);
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/brain/sync`,
      BrainSyncResponseSchema,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
  }

  async runArena(sessionId: string, input: ArenaRunInput): Promise<ArenaRun[]> {
    const body = ArenaRunInputSchema.parse(input);
    const response = await this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/arena`,
      ArenaRunsResponseSchema,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    return response.runs;
  }

  async listArenaRuns(query: Partial<ArenaRunQuery> = {}): Promise<ArenaRun[]> {
    const params = new URLSearchParams();
    if (query.sessionId) params.set('sessionId', query.sessionId);
    if (query.stepId) params.set('stepId', query.stepId);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    const response = await this.request(`/api/arena${suffix}`, ArenaRunsResponseSchema, {
      method: 'GET',
    });
    return response.runs;
  }

  async getArenaRun(runId: string): Promise<ArenaRun> {
    const response = await this.request(
      `/api/arena/${encodeURIComponent(runId)}`,
      ArenaRunResponseSchema,
      { method: 'GET' },
    );
    return response.run;
  }

  async listHandoffs(sessionId: string): Promise<HandoffBrief[]> {
    const response = await this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/handoffs`,
      HandoffBriefsResponseSchema,
      { method: 'GET' },
    );
    return response.briefs;
  }

  async generateHandoff(
    sessionId: string,
    input: Partial<HandoffGenerateInput> = {},
  ): Promise<HandoffBrief> {
    const body = HandoffGenerateInputSchema.parse(input);
    const response = await this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/handoffs`,
      HandoffBriefResponseSchema,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    return response.brief;
  }

  async getHandoff(briefId: string): Promise<HandoffBrief> {
    const response = await this.request(
      `/api/handoffs/${encodeURIComponent(briefId)}`,
      HandoffBriefResponseSchema,
      { method: 'GET' },
    );
    return response.brief;
  }

  async getAnalytics(query: Partial<AnalyticsQuery> = {}): Promise<AnalyticsResponse> {
    const parsed = AnalyticsQuerySchema.parse(query);
    const params = new URLSearchParams({ days: String(parsed.days) });
    if (parsed.projectId) params.set('projectId', parsed.projectId);
    if (parsed.agent) params.set('agent', parsed.agent);
    return this.request(`/api/analytics?${params.toString()}`, AnalyticsResponseSchema, {
      method: 'GET',
    });
  }

  async listJournal(query: Partial<JournalListQuery> = {}): Promise<JournalEntry[]> {
    const parsed = JournalListQuerySchema.parse(query);
    const params = new URLSearchParams({ limit: String(parsed.limit) });
    if (parsed.projectId) params.set('projectId', parsed.projectId);
    const response = await this.request(
      `/api/journal?${params.toString()}`,
      JournalEntriesResponseSchema,
      { method: 'GET' },
    );
    return response.entries;
  }

  async generateJournal(input: Partial<JournalGenerateInput> = {}): Promise<JournalEntry> {
    const body = JournalGenerateInputSchema.parse(input);
    const response = await this.request('/api/journal/generate', JournalEntryResponseSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return response.entry;
  }

  async getJournalEntry(entryId: string): Promise<JournalEntry> {
    const response = await this.request(
      `/api/journal/${encodeURIComponent(entryId)}`,
      JournalEntryResponseSchema,
      { method: 'GET' },
    );
    return response.entry;
  }

  async listPlugins(): Promise<Plugin[]> {
    const response = await this.request('/api/plugins', PluginsResponseSchema, {
      method: 'GET',
    });
    return response.plugins;
  }

  async installPlugin(input: PluginInstallInput): Promise<Plugin> {
    const body = PluginInstallInputSchema.parse(input);
    const response = await this.request('/api/plugins', PluginResponseSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return response.plugin;
  }

  async updatePlugin(pluginId: string, patch: PluginPatch): Promise<Plugin> {
    const body = PluginPatchSchema.parse(patch);
    const response = await this.request(
      `/api/plugins/${encodeURIComponent(pluginId)}`,
      PluginResponseSchema,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    return response.plugin;
  }

  async removePlugin(pluginId: string): Promise<boolean> {
    const response = await this.request(
      `/api/plugins/${encodeURIComponent(pluginId)}`,
      RemovePluginResponseSchema,
      { method: 'DELETE' },
    );
    return response.removed;
  }

  async runPlugin(pluginId: string, input: PluginRunInput): Promise<PluginRun> {
    const body = PluginRunInputSchema.parse(input);
    const response = await this.request(
      `/api/plugins/${encodeURIComponent(pluginId)}/run`,
      PluginRunResponseSchema,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    return response.run;
  }

  async listPluginRuns(pluginId: string, limit = 20): Promise<PluginRun[]> {
    const params = new URLSearchParams({ limit: String(limit) });
    const response = await this.request(
      `/api/plugins/${encodeURIComponent(pluginId)}/runs?${params.toString()}`,
      PluginRunsResponseSchema,
      { method: 'GET' },
    );
    return response.runs;
  }

  async createPairing(input: PairingSessionInput): Promise<PairingSession> {
    const body = PairingSessionInputSchema.parse(input);
    const response = await this.request('/api/pairing/sessions', PairingSessionResponseSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return response.pairing;
  }

  async pairingStatus(id: string): Promise<PairingSessionStatus> {
    const response = await this.request(
      `/api/pairing/sessions/${encodeURIComponent(id)}`,
      PairingSessionStatusResponseSchema,
      { method: 'GET' },
    );
    return response.pairing;
  }

  async claimPairing(input: PairingClaimInput): Promise<PairingClaimResponse> {
    const body = PairingClaimInputSchema.parse(input);
    return this.request('/api/pairing/claim', PairingClaimResponseSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async listDevices(): Promise<Device[]> {
    const response = await this.request('/api/devices', DevicesResponseSchema, { method: 'GET' });
    return response.devices;
  }

  async revokeDevice(id: string): Promise<Device> {
    const response = await this.request(
      `/api/devices/${encodeURIComponent(id)}`,
      DeviceResponseSchema,
      { method: 'DELETE' },
    );
    return response.device;
  }

  private async request<T>(route: string, schema: z.ZodType<T>, init: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${route}`, {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new DaemonRequestError(`Cockpit daemon is unreachable at ${this.baseUrl}: ${message}`, {
        cause: error,
      });
    }

    const text = await responseText(response);
    if (!response.ok) {
      let code: string | undefined;
      let message = `Cockpit daemon returned HTTP ${response.status}.`;
      try {
        const parsed: unknown = JSON.parse(text);
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          'error' in parsed &&
          typeof parsed.error === 'object' &&
          parsed.error !== null &&
          'message' in parsed.error &&
          typeof parsed.error.message === 'string'
        ) {
          message = parsed.error.message;
          if ('code' in parsed.error && typeof parsed.error.code === 'string') {
            code = parsed.error.code;
          }
        }
      } catch {
        // Keep the status-based message when the body is not JSON.
      }
      throw new DaemonRequestError(message, {
        status: response.status,
        ...(code === undefined ? {} : { code }),
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new DaemonRequestError('Cockpit daemon returned an invalid JSON response.', {
        status: response.status,
        cause: error,
      });
    }

    return schema.parse(parsed);
  }
}
