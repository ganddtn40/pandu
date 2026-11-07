import {
  AcknowledgeUnderstandingResponseSchema,
  AnalyticsQuerySchema,
  AnalyticsResponseSchema,
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
  CreateReplayForkInputSchema,
  CreateReplayForkResponseSchema,
  CreateSessionInputSchema,
  DemoSeedResponseSchema,
  DeviceResponseSchema,
  DevicesResponseSchema,
  DiscoverResponseSchema,
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
  IdSchema,
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
  SessionListQuerySchema,
  SessionProvenanceResponseSchema,
  SessionReplayResponseSchema,
  SnapshotDetailResponseSchema,
  StatsResponseSchema,
  TrustResponseSchema,
  UnderstandingDetailResponseSchema,
  UnderstandingListQuerySchema,
  UnderstandingListResponseSchema,
  WebSocketClientMessageSchema,
  type JsonValue,
  type LiveEvent,
  type WebSocketServerMessage,
} from '@cockpit/core';
import { Hono, type Context } from 'hono';
import { upgradeWebSocket } from '@hono/node-server';
import type { WSContext } from 'hono/ws';
import type { WebSocketLike } from '@hono/node-server';
import { z } from 'zod';

import type { CheatDetector } from './cheat/detector.js';
import type { CockpitConfig } from './config.js';
import { displayHostForUrl } from './config.js';
import type { ContextDoctor } from './context/doctor.js';
import { seedDemoData } from './demo/seed.js';
import type { GitSnapshotService } from './git/snapshots.js';
import type { BudgetService } from './guards/budget.js';
import { GuardServiceError, type GuardService } from './guards/service.js';
import { createCorsMiddleware } from './http/cors.js';
import { mountDashboard, mountDashboardFallback } from './http/dashboard.js';
import { createDeviceAuthMiddleware } from './http/device-auth.js';
import { HttpError, handleHttpError, jsonError, notFound } from './http/errors.js';
import type { Logger } from './logger.js';
import type { LiveEventBus } from './live/bus.js';
import type { AnalyticsService } from './analytics/service.js';
import { ArenaServiceError, type ArenaService } from './arena/service.js';
import { BrainServiceError, type BrainService } from './brain/service.js';
import { HandoffServiceError, type HandoffService } from './handoff/service.js';
import { JournalServiceError, type JournalService } from './journal/service.js';
import { PairingServiceError, type PairingService } from './pairing/service.js';
import { PluginServiceError, type PluginService } from './plugins/service.js';
import { proxyErrorResponse } from './proxy/headers.js';
import { handleProxyRequest } from './proxy/handler.js';
import { parseProxyRoute } from './proxy/routing.js';
import type { ProvenanceService } from './provenance/service.js';
import type { Recorder } from './recording/recorder.js';
import { ForkError, type ForkService } from './replay/fork.js';
import type { SessionManager } from './sessions/manager.js';
import type { Store } from './store/store.js';
import { UnderstandingServiceError, type UnderstandingService } from './understanding/service.js';
import { VERSION } from './version.js';

export interface AppServices {
  config: CockpitConfig;
  store: Store;
  bus: LiveEventBus;
  sessions: SessionManager;
  recorder: Recorder;
  snapshots: GitSnapshotService;
  forks: ForkService;
  guards: GuardService;
  budgets: BudgetService;
  cheats: CheatDetector;
  provenance: ProvenanceService;
  understanding: UnderstandingService;
  contextDoctor: ContextDoctor;
  brain: BrainService;
  arena: ArenaService;
  handoff: HandoffService;
  analytics: AnalyticsService;
  journal: JournalService;
  plugins: PluginService;
  pairing: PairingService;
  logger: Logger;
  startedAtMono?: number;
  webRoot?: string;
  resolveRemoteAddress?: (c: Context) => string | undefined;
}

export interface AppBundle {
  app: Hono;
  closeWebSockets: () => void;
}

const StepsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(2000).default(1000),
});

const PluginRunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const EndSessionInputSchema = z.object({
  status: z.enum(['completed', 'failed', 'killed']).default('completed'),
});

const DiscoverQuerySchema = z.object({
  sessionId: IdSchema.optional(),
});

function parseJson(text: string, context: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, 'bad_request', `${context} must contain valid JSON.`);
  }
}

async function readJsonBody(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (text.trim().length === 0) {
    throw new HttpError(400, 'bad_request', 'A JSON request body is required.');
  }
  return parseJson(text, 'The request body');
}

async function readOptionalJsonBody(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (text.trim().length === 0) return undefined;
  return parseJson(text, 'The request body');
}

function requireId(c: Context, name: string): string {
  const raw = c.req.param(name);
  const parsed = IdSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(400, 'bad_request', `The "${name}" path parameter must be a UUID.`);
  }
  return parsed.data;
}

function requireSession(store: Store, sessionId: string) {
  const session = store.getSession(sessionId);
  if (!session) {
    throw new HttpError(404, 'not_found', 'The requested session was not found.');
  }
  return session;
}

function rethrowForkError(error: unknown): never {
  if (error instanceof ForkError) {
    throw new HttpError(error.status, error.code, error.message);
  }
  throw error;
}

function rethrowGuardError(error: unknown): never {
  if (error instanceof GuardServiceError) {
    throw new HttpError(error.status, error.code, error.message);
  }
  throw error;
}

function rethrowUnderstandingError(error: unknown): never {
  if (error instanceof UnderstandingServiceError) {
    throw new HttpError(error.status, error.code, error.message);
  }
  throw error;
}

function rethrowPairingError(error: unknown): never {
  if (error instanceof PairingServiceError) {
    throw new HttpError(error.status, error.code, error.message);
  }
  throw error;
}

function rethrowBrainError(error: unknown): never {
  if (error instanceof BrainServiceError) {
    throw new HttpError(error.status, error.code, error.message);
  }
  throw error;
}

function rethrowArenaError(error: unknown): never {
  if (error instanceof ArenaServiceError) {
    throw new HttpError(error.status, error.code, error.message);
  }
  throw error;
}

function rethrowHandoffError(error: unknown): never {
  if (error instanceof HandoffServiceError) {
    throw new HttpError(error.status, error.code, error.message);
  }
  throw error;
}

function rethrowJournalError(error: unknown): never {
  if (error instanceof JournalServiceError) {
    throw new HttpError(error.status, error.code, error.message);
  }
  throw error;
}

function rethrowPluginError(error: unknown): never {
  if (error instanceof PluginServiceError) {
    throw new HttpError(error.status, error.code, error.message);
  }
  throw error;
}

function decodeWsMessage(data: unknown): string | undefined {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  return undefined;
}

function websocketJson(message: WebSocketServerMessage): string {
  return JSON.stringify(message);
}

export function createApp(services: AppServices): AppBundle {
  const {
    config,
    store,
    bus,
    sessions,
    forks,
    guards,
    budgets,
    cheats,
    provenance,
    understanding,
    contextDoctor,
    brain,
    arena,
    handoff,
    analytics,
    journal,
    plugins,
    pairing,
    logger,
  } = services;
  const app = new Hono();
  const startedAtMono = services.startedAtMono ?? performance.now();
  const sockets = new Set<WSContext<WebSocketLike>>();

  app.use('*', createCorsMiddleware(config.allowedOrigins));
  app.use(
    '*',
    createDeviceAuthMiddleware({
      pairing,
      ...(services.resolveRemoteAddress
        ? { resolveRemoteAddress: services.resolveRemoteAddress }
        : {}),
    }),
  );

  app.onError((error, c) => handleHttpError(error, c));

  app.get('/api/health', (c) => {
    const payload = HealthResponseSchema.parse({
      ok: true,
      service: 'cockpit-daemon',
      version: VERSION,
      uptimeSeconds: Math.max(0, Math.round((performance.now() - startedAtMono) / 1000)),
      database: store.ping() ? 'ok' : 'degraded',
      demoMode: config.demoMode,
      protocol: {
        openai: true,
        anthropic: true,
      },
    });
    c.header('cache-control', 'no-store');
    return c.json(payload, 200);
  });

  app.post('/api/demo/seed', (c) => {
    const result = seedDemoData(store);
    c.header('cache-control', 'no-store');
    return c.json(DemoSeedResponseSchema.parse(result), result.created ? 201 : 200);
  });

  app.post('/api/pairing/sessions', async (c) => {
    const parsed = PairingSessionInputSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      throw new HttpError(
        400,
        'bad_request',
        'The pairing session payload is invalid.',
        parsed.error.issues,
      );
    }

    try {
      const session = pairing.createSession(parsed.data);
      c.header('cache-control', 'no-store');
      return c.json(PairingSessionResponseSchema.parse({ pairing: session }), 201);
    } catch (error) {
      rethrowPairingError(error);
    }
  });

  app.get('/api/pairing/sessions/:id', (c) => {
    const id = requireId(c, 'id');
    try {
      const status = pairing.getSession(id);
      c.header('cache-control', 'no-store');
      return c.json(PairingSessionStatusResponseSchema.parse({ pairing: status }), 200);
    } catch (error) {
      rethrowPairingError(error);
    }
  });

  app.delete('/api/pairing/sessions/:id', (c) => {
    const id = requireId(c, 'id');
    try {
      pairing.cancelSession(id);
      c.header('cache-control', 'no-store');
      return c.body(null, 204);
    } catch (error) {
      rethrowPairingError(error);
    }
  });

  app.post('/api/pairing/claim', async (c) => {
    const parsed = PairingClaimInputSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      throw new HttpError(
        400,
        'bad_request',
        'The pairing claim payload is invalid.',
        parsed.error.issues,
      );
    }

    try {
      const claim = pairing.claim(parsed.data, c.get('remoteAddress'));
      c.header('cache-control', 'no-store');
      return c.json(PairingClaimResponseSchema.parse(claim), 200);
    } catch (error) {
      rethrowPairingError(error);
    }
  });

  app.get('/api/devices', (c) => {
    c.header('cache-control', 'no-store');
    return c.json(DevicesResponseSchema.parse({ devices: pairing.listDevices() }), 200);
  });

  app.get('/api/devices/me', (c) => {
    const current = c.get('device');
    if (!current) {
      return jsonError(
        c,
        404,
        'not_found',
        'This request is local and is not associated with a paired device.',
      );
    }
    c.header('cache-control', 'no-store');
    return c.json(DeviceResponseSchema.parse({ device: pairing.getDevice(current.id) }), 200);
  });

  app.delete('/api/devices/:id', (c) => {
    const id = requireId(c, 'id');
    const actor = c.get('device');
    try {
      const device = pairing.revokeDevice(id, actor ? { actorDeviceId: actor.id } : {});
      c.header('cache-control', 'no-store');
      return c.json(DeviceResponseSchema.parse({ device }), 200);
    } catch (error) {
      rethrowPairingError(error);
    }
  });

  app.get('/api/stats', (c) => {
    const payload = StatsResponseSchema.parse({ stats: store.getOverviewStats() });
    c.header('cache-control', 'no-store');
    return c.json(payload, 200);
  });

  app.get('/api/sessions', (c) => {
    const parsed = SessionListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      throw new HttpError(
        400,
        'bad_request',
        'The session query parameters are invalid.',
        parsed.error.issues,
      );
    }

    try {
      const page = store.listSessions(parsed.data);
      return c.json(page, 200);
    } catch (error) {
      if (error instanceof Error && error.name === 'InvalidCursorError') {
        throw new HttpError(400, 'bad_request', 'The pagination cursor is invalid.');
      }
      throw error;
    }
  });

  app.post('/api/sessions', async (c) => {
    const body: JsonValue | undefined = (await readJsonBody(c)) as JsonValue;
    const parsed = CreateSessionInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(
        400,
        'bad_request',
        'The session payload is invalid.',
        parsed.error.issues,
      );
    }

    const session = sessions.create(parsed.data);
    c.header('location', `/api/sessions/${session.id}`);
    return c.json({ session }, 201);
  });

  app.get('/api/sessions/:id', (c) => {
    const sessionId = requireId(c, 'id');
    const session = requireSession(store, sessionId);
    return c.json({ session }, 200);
  });

  app.post('/api/sessions/:id/end', async (c) => {
    const sessionId = requireId(c, 'id');
    requireSession(store, sessionId);

    const body = await readOptionalJsonBody(c);
    const parsed = EndSessionInputSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new HttpError(
        400,
        'bad_request',
        'The session end payload is invalid.',
        parsed.error.issues,
      );
    }

    const session = sessions.endSession(sessionId, parsed.data.status);
    if (!session) {
      throw new HttpError(404, 'not_found', 'The requested session was not found.');
    }
    return c.json({ session }, 200);
  });

  app.get('/api/sessions/:id/steps', (c) => {
    const sessionId = requireId(c, 'id');
    requireSession(store, sessionId);

    const parsed = StepsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      throw new HttpError(
        400,
        'bad_request',
        'The step query parameters are invalid.',
        parsed.error.issues,
      );
    }

    return c.json({ steps: store.listSteps(sessionId, parsed.data.limit) }, 200);
  });

  app.get('/api/steps/:id', (c) => {
    const stepId = requireId(c, 'id');
    const step = store.getStep(stepId);
    if (!step) {
      throw new HttpError(404, 'not_found', 'The requested step was not found.');
    }

    return c.json(
      {
        step,
        chunks: store.listStreamChunks(stepId),
        toolCalls: store.listToolCalls(stepId),
      },
      200,
    );
  });

  app.get('/api/sessions/:id/replay', (c) => {
    const sessionId = requireId(c, 'id');
    const session = requireSession(store, sessionId);
    const replay = SessionReplayResponseSchema.parse({
      session,
      steps: store.listSteps(sessionId, 2000),
      snapshots: store.listSnapshots(sessionId).map((snapshot) => {
        const { patch: _patch, ...summary } = snapshot;
        return summary;
      }),
      forks: store.listForks(sessionId),
    });
    c.header('cache-control', 'no-store');
    return c.json(replay, 200);
  });

  app.get('/api/snapshots/:id', (c) => {
    const snapshotId = requireId(c, 'id');
    const snapshot = store.getSnapshot(snapshotId);
    if (!snapshot) {
      throw new HttpError(404, 'not_found', 'The requested snapshot was not found.');
    }
    const payload = SnapshotDetailResponseSchema.parse({
      snapshot,
      fileChanges: store.listSnapshotFileChanges(snapshotId),
    });
    c.header('cache-control', 'no-store');
    return c.json(payload, 200);
  });

  app.get('/api/sessions/:id/forks', (c) => {
    const sessionId = requireId(c, 'id');
    requireSession(store, sessionId);
    return c.json(ReplayForksResponseSchema.parse({ forks: store.listForks(sessionId) }), 200);
  });

  app.post('/api/sessions/:id/forks', async (c) => {
    const sessionId = requireId(c, 'id');
    const session = requireSession(store, sessionId);
    const body = await readOptionalJsonBody(c);
    const parsed = CreateReplayForkInputSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new HttpError(400, 'bad_request', 'The fork payload is invalid.', parsed.error.issues);
    }

    try {
      const fork = await forks.create(session, parsed.data);
      c.header('location', `/api/forks/${fork.id}`);
      return c.json(CreateReplayForkResponseSchema.parse({ fork }), 201);
    } catch (error) {
      rethrowForkError(error);
    }
  });

  app.delete('/api/forks/:id', async (c) => {
    const forkId = requireId(c, 'id');
    try {
      const fork = await forks.remove(forkId);
      return c.json(RemoveReplayForkResponseSchema.parse({ fork }), 200);
    } catch (error) {
      rethrowForkError(error);
    }
  });

  app.get('/api/guards/rules', (c) => {
    const payload = GuardRulesResponseSchema.parse({ rules: guards.listRules() });
    c.header('cache-control', 'no-store');
    return c.json(payload, 200);
  });

  app.post('/api/guards/rules', async (c) => {
    const body: JsonValue | undefined = (await readJsonBody(c)) as JsonValue;
    const parsed = GuardRuleInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(
        400,
        'bad_request',
        'The guard rule payload is invalid.',
        parsed.error.issues,
      );
    }
    const rule = guards.createRule(parsed.data);
    c.header('location', `/api/guards/rules/${rule.id}`);
    return c.json(GuardRuleResponseSchema.parse({ rule }), 201);
  });

  app.patch('/api/guards/rules/:id', async (c) => {
    const ruleId = c.req.param('id');
    const body: JsonValue | undefined = (await readJsonBody(c)) as JsonValue;
    const parsed = GuardRulePatchSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(
        400,
        'bad_request',
        'The guard rule patch is invalid.',
        parsed.error.issues,
      );
    }
    try {
      const rule = guards.updateRule(ruleId, parsed.data);
      return c.json(GuardRuleResponseSchema.parse({ rule }), 200);
    } catch (error) {
      rethrowGuardError(error);
    }
  });

  app.delete('/api/guards/rules/:id', (c) => {
    const ruleId = c.req.param('id');
    try {
      guards.deleteRule(ruleId);
      return c.json(RemoveGuardRuleResponseSchema.parse({ removed: true, id: ruleId }), 200);
    } catch (error) {
      rethrowGuardError(error);
    }
  });

  app.get('/api/guards/events', (c) => {
    const parsed = GuardEventListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      throw new HttpError(
        400,
        'bad_request',
        'The guard event query parameters are invalid.',
        parsed.error.issues,
      );
    }
    const payload = GuardEventsResponseSchema.parse({ events: guards.listEvents(parsed.data) });
    c.header('cache-control', 'no-store');
    return c.json(payload, 200);
  });

  app.post('/api/guards/events/:id/decision', async (c) => {
    const eventId = requireId(c, 'id');
    const body: JsonValue | undefined = (await readJsonBody(c)) as JsonValue;
    const parsed = ApprovalDecisionSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(
        400,
        'bad_request',
        'The approval decision is invalid.',
        parsed.error.issues,
      );
    }
    try {
      const event = guards.resolveEvent(eventId, parsed.data);
      return c.json(GuardEventResponseSchema.parse({ event }), 200);
    } catch (error) {
      rethrowGuardError(error);
    }
  });

  app.get('/api/budgets', (c) => {
    const payload = BudgetPoliciesResponseSchema.parse({ policies: store.listBudgetPolicies() });
    c.header('cache-control', 'no-store');
    return c.json(payload, 200);
  });

  app.post('/api/budgets', async (c) => {
    const body: JsonValue | undefined = (await readJsonBody(c)) as JsonValue;
    const parsed = BudgetPolicyInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(
        400,
        'bad_request',
        'The budget policy payload is invalid.',
        parsed.error.issues,
      );
    }
    const policy = store.createBudgetPolicy(parsed.data);
    c.header('location', `/api/budgets/${policy.id}`);
    return c.json(BudgetPolicyResponseSchema.parse({ policy }), 201);
  });

  app.patch('/api/budgets/:id', async (c) => {
    const budgetId = requireId(c, 'id');
    const existing = store.getBudgetPolicy(budgetId);
    if (!existing) throw new HttpError(404, 'not_found', 'The budget policy was not found.');

    const body: JsonValue | undefined = (await readJsonBody(c)) as JsonValue;
    const parsed = BudgetPolicyPatchSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(
        400,
        'bad_request',
        'The budget policy patch is invalid.',
        parsed.error.issues,
      );
    }

    const merged = BudgetPolicyInputSchema.safeParse({ ...existing, ...parsed.data });
    if (!merged.success) {
      throw new HttpError(
        400,
        'bad_request',
        'The updated budget policy would be invalid.',
        merged.error.issues,
      );
    }

    const policy = store.updateBudgetPolicy(budgetId, parsed.data);
    if (!policy) throw new HttpError(404, 'not_found', 'The budget policy was not found.');
    return c.json(BudgetPolicyResponseSchema.parse({ policy }), 200);
  });

  app.delete('/api/budgets/:id', (c) => {
    const budgetId = requireId(c, 'id');
    const removed = store.deleteBudgetPolicy(budgetId);
    if (!removed) throw new HttpError(404, 'not_found', 'The budget policy was not found.');
    return c.json(RemoveBudgetPolicyResponseSchema.parse({ removed, id: budgetId }), 200);
  });

  app.get('/api/sessions/:id/budgets', (c) => {
    const sessionId = requireId(c, 'id');
    requireSession(store, sessionId);
    const payload = BudgetStatusResponseSchema.parse({ statuses: budgets.statuses(sessionId) });
    c.header('cache-control', 'no-store');
    return c.json(payload, 200);
  });

  app.post('/api/sessions/:id/scan', (c) => {
    const sessionId = requireId(c, 'id');
    try {
      const result = guards.scanSession(sessionId);
      return c.json(SecretScanResponseSchema.parse(result), 200);
    } catch (error) {
      rethrowGuardError(error);
    }
  });

  app.get('/api/sessions/:id/trust', (c) => {
    const sessionId = requireId(c, 'id');
    requireSession(store, sessionId);
    const payload = TrustResponseSchema.parse({
      analysis: store.getLatestCheatAnalysis(sessionId) ?? null,
    });
    c.header('cache-control', 'no-store');
    return c.json(payload, 200);
  });

  app.post('/api/sessions/:id/trust', (c) => {
    const sessionId = requireId(c, 'id');
    requireSession(store, sessionId);
    const analysis = cheats.analyzeSession(sessionId) ?? null;
    return c.json(TrustResponseSchema.parse({ analysis }), 200);
  });

  app.get('/api/sessions/:id/provenance', (c) => {
    const sessionId = requireId(c, 'id');
    requireSession(store, sessionId);
    const payload = provenance.summary(sessionId);
    if (!payload) throw new HttpError(404, 'not_found', 'The requested session was not found.');
    c.header('cache-control', 'no-store');
    return c.json(SessionProvenanceResponseSchema.parse(payload), 200);
  });

  app.post('/api/sessions/:id/provenance', (c) => {
    const sessionId = requireId(c, 'id');
    requireSession(store, sessionId);
    const payload = provenance.recomputeSession(sessionId);
    if (!payload) throw new HttpError(404, 'not_found', 'The requested session was not found.');
    return c.json(SessionProvenanceResponseSchema.parse(payload), 200);
  });

  app.get('/api/understanding', (c) => {
    const parsed = UnderstandingListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      throw new HttpError(
        400,
        'bad_request',
        'The understanding query parameters are invalid.',
        parsed.error.issues,
      );
    }
    c.header('cache-control', 'no-store');
    return c.json(UnderstandingListResponseSchema.parse(understanding.list(parsed.data)), 200);
  });

  app.get('/api/sessions/:id/understanding', (c) => {
    const sessionId = requireId(c, 'id');
    requireSession(store, sessionId);
    const parsed = UnderstandingListQuerySchema.safeParse({
      ...c.req.query(),
      sessionId,
    });
    if (!parsed.success) {
      throw new HttpError(
        400,
        'bad_request',
        'The understanding query parameters are invalid.',
        parsed.error.issues,
      );
    }
    c.header('cache-control', 'no-store');
    return c.json(UnderstandingListResponseSchema.parse(understanding.list(parsed.data)), 200);
  });

  app.post('/api/understanding/quizzes/:id/submit', async (c) => {
    const quizId = requireId(c, 'id');
    const body: JsonValue | undefined = (await readJsonBody(c)) as JsonValue;
    const parsed = QuizSubmitInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(
        400,
        'bad_request',
        'The quiz submission is invalid.',
        parsed.error.issues,
      );
    }

    try {
      return c.json(
        QuizSubmitResponseSchema.parse(understanding.submitQuiz(quizId, parsed.data)),
        200,
      );
    } catch (error) {
      rethrowUnderstandingError(error);
    }
  });

  app.get('/api/understanding/:id', (c) => {
    const understandingId = requireId(c, 'id');
    const payload = understanding.detail(understandingId);
    if (!payload) {
      throw new HttpError(404, 'not_found', 'The understanding file was not found.');
    }
    c.header('cache-control', 'no-store');
    return c.json(UnderstandingDetailResponseSchema.parse(payload), 200);
  });

  app.post('/api/understanding/:id/open', (c) => {
    const understandingId = requireId(c, 'id');
    const file = understanding.open(understandingId);
    if (!file) throw new HttpError(404, 'not_found', 'The understanding file was not found.');
    return c.json(AcknowledgeUnderstandingResponseSchema.parse({ file }), 200);
  });

  app.post('/api/understanding/:id/acknowledge', (c) => {
    const understandingId = requireId(c, 'id');
    const file = understanding.acknowledge(understandingId);
    if (!file) throw new HttpError(404, 'not_found', 'The understanding file was not found.');
    return c.json(AcknowledgeUnderstandingResponseSchema.parse({ file }), 200);
  });

  app.post('/api/understanding/:id/explain', (c) => {
    const understandingId = requireId(c, 'id');
    const result = understanding.explain(understandingId);
    if (!result) throw new HttpError(404, 'not_found', 'The understanding file was not found.');
    return c.json(ExplainUnderstandingResponseSchema.parse(result), 200);
  });

  app.post('/api/understanding/:id/quiz', (c) => {
    const understandingId = requireId(c, 'id');
    const quiz = understanding.startQuiz(understandingId);
    if (!quiz) throw new HttpError(404, 'not_found', 'The understanding file was not found.');
    return c.json(QuizStartResponseSchema.parse({ quiz }), 200);
  });

  app.get('/api/sessions/:id/context', (c) => {
    const sessionId = requireId(c, 'id');
    requireSession(store, sessionId);
    c.header('cache-control', 'no-store');
    return c.json(SessionContextResponseSchema.parse(contextDoctor.list(sessionId)), 200);
  });

  app.post('/api/sessions/:id/context', (c) => {
    const sessionId = requireId(c, 'id');
    requireSession(store, sessionId);
    contextDoctor.recomputeSession(sessionId);
    return c.json(SessionContextResponseSchema.parse(contextDoctor.list(sessionId)), 200);
  });

  app.get('/api/context/:id', (c) => {
    const snapshotId = requireId(c, 'id');
    const payload = contextDoctor.detail(snapshotId);
    if (!payload) {
      throw new HttpError(404, 'not_found', 'The context snapshot was not found.');
    }
    c.header('cache-control', 'no-store');
    return c.json(ContextSnapshotDetailResponseSchema.parse(payload), 200);
  });

  app.get('/api/projects', (c) => {
    const payload = ProjectsResponseSchema.parse({ projects: store.listProjects() });
    c.header('cache-control', 'no-store');
    return c.json(payload, 200);
  });

  app.get('/api/projects/:id/brain', async (c) => {
    const projectId = requireId(c, 'id');
    try {
      const status = await brain.status(projectId);
      c.header('cache-control', 'no-store');
      return c.json(BrainProjectStatusSchema.parse(status), 200);
    } catch (error) {
      rethrowBrainError(error);
    }
  });

  app.post('/api/projects/:id/brain/generate', async (c) => {
    const projectId = requireId(c, 'id');
    const body = (await readOptionalJsonBody(c)) ?? {};
    const parsed = BrainGenerateInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(
        400,
        'bad_request',
        'The brain generation request is invalid.',
        parsed.error.issues,
      );
    }

    try {
      const status = await brain.generate(projectId, parsed.data.formats);
      return c.json(BrainProjectStatusSchema.parse(status), 200);
    } catch (error) {
      rethrowBrainError(error);
    }
  });

  app.post('/api/projects/:id/brain/sync', async (c) => {
    const projectId = requireId(c, 'id');
    const body = (await readOptionalJsonBody(c)) ?? {};
    const parsed = BrainSyncInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(
        400,
        'bad_request',
        'The brain sync request is invalid.',
        parsed.error.issues,
      );
    }

    try {
      const result = await brain.sync(projectId, parsed.data);
      return c.json(BrainSyncResponseSchema.parse(result), 200);
    } catch (error) {
      rethrowBrainError(error);
    }
  });

  app.post('/api/sessions/:id/arena', async (c) => {
    const sessionId = requireId(c, 'id');
    const body: JsonValue | undefined = (await readJsonBody(c)) as JsonValue;
    const parsed = ArenaRunInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(400, 'bad_request', 'The arena request is invalid.', parsed.error.issues);
    }

    try {
      const runs = await arena.run(sessionId, parsed.data);
      return c.json(ArenaRunsResponseSchema.parse({ runs }), 200);
    } catch (error) {
      rethrowArenaError(error);
    }
  });

  app.get('/api/arena', (c) => {
    const parsed = ArenaRunQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      throw new HttpError(
        400,
        'bad_request',
        'The arena query parameters are invalid.',
        parsed.error.issues,
      );
    }

    const runs = arena.list({
      limit: parsed.data.limit,
      ...(parsed.data.sessionId ? { sessionId: parsed.data.sessionId } : {}),
      ...(parsed.data.stepId ? { stepId: parsed.data.stepId } : {}),
    });
    c.header('cache-control', 'no-store');
    return c.json(ArenaRunsResponseSchema.parse({ runs }), 200);
  });

  app.get('/api/arena/:id', (c) => {
    const runId = requireId(c, 'id');
    const run = arena.get(runId);
    if (!run) {
      throw new HttpError(404, 'not_found', 'The arena run was not found.');
    }
    c.header('cache-control', 'no-store');
    return c.json(ArenaRunResponseSchema.parse({ run }), 200);
  });

  app.get('/api/sessions/:id/handoffs', (c) => {
    const sessionId = requireId(c, 'id');
    requireSession(store, sessionId);
    const briefs = handoff.list(sessionId);
    c.header('cache-control', 'no-store');
    return c.json(HandoffBriefsResponseSchema.parse({ briefs }), 200);
  });

  app.post('/api/sessions/:id/handoffs', async (c) => {
    const sessionId = requireId(c, 'id');
    const body = (await readOptionalJsonBody(c)) ?? {};
    const parsed = HandoffGenerateInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(
        400,
        'bad_request',
        'The handoff request is invalid.',
        parsed.error.issues,
      );
    }

    try {
      const brief = handoff.generate(sessionId, parsed.data);
      c.header('location', `/api/handoffs/${brief.id}`);
      return c.json(HandoffBriefResponseSchema.parse({ brief }), 201);
    } catch (error) {
      rethrowHandoffError(error);
    }
  });

  app.get('/api/handoffs/:id', (c) => {
    const briefId = requireId(c, 'id');
    const brief = handoff.get(briefId);
    if (!brief) {
      throw new HttpError(404, 'not_found', 'The handoff brief was not found.');
    }
    c.header('cache-control', 'no-store');
    return c.json(HandoffBriefResponseSchema.parse({ brief }), 200);
  });

  app.get('/api/analytics', (c) => {
    const parsed = AnalyticsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      throw new HttpError(
        400,
        'bad_request',
        'The analytics query parameters are invalid.',
        parsed.error.issues,
      );
    }

    c.header('cache-control', 'no-store');
    return c.json(AnalyticsResponseSchema.parse(analytics.query(parsed.data)), 200);
  });

  app.get('/api/journal', (c) => {
    const parsed = JournalListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      throw new HttpError(
        400,
        'bad_request',
        'The journal query parameters are invalid.',
        parsed.error.issues,
      );
    }

    c.header('cache-control', 'no-store');
    return c.json(JournalEntriesResponseSchema.parse({ entries: journal.list(parsed.data) }), 200);
  });

  app.post('/api/journal/generate', async (c) => {
    const body = (await readOptionalJsonBody(c)) ?? {};
    const parsed = JournalGenerateInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(
        400,
        'bad_request',
        'The journal request is invalid.',
        parsed.error.issues,
      );
    }

    try {
      const entry = journal.generate(parsed.data);
      return c.json(JournalEntryResponseSchema.parse({ entry }), 200);
    } catch (error) {
      rethrowJournalError(error);
    }
  });

  app.get('/api/journal/:id', (c) => {
    const entryId = requireId(c, 'id');
    const entry = store.getJournalEntry(entryId);
    if (!entry) {
      throw new HttpError(404, 'not_found', 'The journal entry was not found.');
    }
    c.header('cache-control', 'no-store');
    return c.json(JournalEntryResponseSchema.parse({ entry }), 200);
  });

  app.get('/api/plugins', (c) => {
    const payload = PluginsResponseSchema.parse({ plugins: plugins.list() });
    c.header('cache-control', 'no-store');
    return c.json(payload, 200);
  });

  app.post('/api/plugins', async (c) => {
    const body = (await readJsonBody(c)) as JsonValue;
    const parsed = PluginInstallInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(
        400,
        'bad_request',
        'The plugin install request is invalid.',
        parsed.error.issues,
      );
    }

    try {
      const plugin = await plugins.install(parsed.data.path);
      c.header('location', `/api/plugins/${plugin.id}`);
      return c.json(PluginResponseSchema.parse({ plugin }), 201);
    } catch (error) {
      rethrowPluginError(error);
    }
  });

  app.patch('/api/plugins/:id', async (c) => {
    const pluginId = requireId(c, 'id');
    const body = (await readJsonBody(c)) as JsonValue;
    const parsed = PluginPatchSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(400, 'bad_request', 'The plugin update is invalid.', parsed.error.issues);
    }

    try {
      const plugin = plugins.setEnabled(pluginId, parsed.data.enabled);
      return c.json(PluginResponseSchema.parse({ plugin }), 200);
    } catch (error) {
      rethrowPluginError(error);
    }
  });

  app.delete('/api/plugins/:id', (c) => {
    const pluginId = requireId(c, 'id');
    try {
      plugins.remove(pluginId);
      return c.json(RemovePluginResponseSchema.parse({ removed: true, id: pluginId }), 200);
    } catch (error) {
      rethrowPluginError(error);
    }
  });

  app.post('/api/plugins/:id/run', async (c) => {
    const pluginId = requireId(c, 'id');
    const body = (await readJsonBody(c)) as JsonValue;
    const parsed = PluginRunInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(
        400,
        'bad_request',
        'The plugin run request is invalid.',
        parsed.error.issues,
      );
    }

    try {
      const run = await plugins.run(pluginId, parsed.data);
      return c.json(PluginRunResponseSchema.parse({ run }), 200);
    } catch (error) {
      rethrowPluginError(error);
    }
  });

  app.get('/api/plugins/:id/runs', (c) => {
    const pluginId = requireId(c, 'id');
    const parsed = PluginRunsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      throw new HttpError(
        400,
        'bad_request',
        'The plugin run query parameters are invalid.',
        parsed.error.issues,
      );
    }

    try {
      const runs = plugins.runs(pluginId, parsed.data.limit);
      c.header('cache-control', 'no-store');
      return c.json(PluginRunsResponseSchema.parse({ runs }), 200);
    } catch (error) {
      rethrowPluginError(error);
    }
  });

  app.get('/api/discover', (c) => {
    const parsed = DiscoverQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      throw new HttpError(
        400,
        'bad_request',
        'The discover query parameters are invalid.',
        parsed.error.issues,
      );
    }

    const origin = new URL(c.req.url).origin;
    const prefix = parsed.data.sessionId ? `/s/${parsed.data.sessionId}` : '';
    const payload = DiscoverResponseSchema.parse({
      providers: [
        {
          id: 'openai',
          protocol: 'openai',
          baseUrl: `${origin}${prefix}/openai/v1`,
        },
        {
          id: 'anthropic',
          protocol: 'anthropic',
          baseUrl: `${origin}${prefix}/anthropic`,
        },
      ],
    });
    return c.json(payload, 200);
  });

  const websocketHandler = upgradeWebSocket((c) => {
    const query = c.req.query('sessionId');
    let filter: string | undefined = query;
    let listener: (() => void) | undefined;

    const subscribe = (ws: WSContext<WebSocketLike>): void => {
      listener?.();
      listener = bus.subscribe((event: LiveEvent) => {
        if (filter && event.sessionId !== filter) return;
        try {
          ws.send(websocketJson({ type: 'event', event }));
        } catch (error) {
          logger.debug('Failed to deliver a live event to a WebSocket', error);
        }
      });
    };

    return {
      onOpen(_event, ws) {
        sockets.add(ws);
        ws.send(websocketJson({ type: 'ready', sequence: bus.sequence }));
        subscribe(ws);
      },
      onMessage(event, ws) {
        const text = decodeWsMessage(event.data);
        if (text === undefined) {
          ws.send(websocketJson({ type: 'error', message: 'Only text messages are supported.' }));
          return;
        }

        let payload: unknown;
        try {
          payload = JSON.parse(text) as unknown;
        } catch {
          ws.send(websocketJson({ type: 'error', message: 'Malformed JSON message.' }));
          return;
        }

        const parsed = WebSocketClientMessageSchema.safeParse(payload);
        if (!parsed.success) {
          ws.send(websocketJson({ type: 'error', message: 'Unknown WebSocket message.' }));
          return;
        }

        switch (parsed.data.type) {
          case 'ping':
            ws.send(websocketJson({ type: 'pong' }));
            break;
          case 'subscribe':
            filter = parsed.data.sessionId;
            subscribe(ws);
            ws.send(
              websocketJson({
                type: 'subscribed',
                ...(filter ? { sessionId: filter } : {}),
              }),
            );
            break;
          case 'unsubscribe':
            if (!parsed.data.sessionId || parsed.data.sessionId === filter) {
              filter = undefined;
            }
            subscribe(ws);
            ws.send(
              websocketJson({
                type: 'subscribed',
                ...(filter ? { sessionId: filter } : {}),
              }),
            );
            break;
        }
      },
      onClose(_event, ws) {
        sockets.delete(ws);
        listener?.();
        listener = undefined;
      },
      onError(_event, ws) {
        sockets.delete(ws);
        listener?.();
        listener = undefined;
      },
    };
  });

  app.get(
    '/api/ws',
    async (c, next): Promise<Response | void> => {
      const query = c.req.query('sessionId');
      if (query && !IdSchema.safeParse(query).success) {
        return jsonError(c, 400, 'bad_request', 'The sessionId query parameter must be a UUID.');
      }
      await next();
    },
    websocketHandler,
  );

  if (services.webRoot) {
    mountDashboard(app, services.webRoot);
  } else {
    mountDashboardFallback(app);
  }

  app.all('*', async (c) => {
    const url = new URL(c.req.url);
    const route = parseProxyRoute(url.pathname, c.req.header('x-cockpit-protocol'));

    if (!route.ok) {
      if (route.reason === 'invalid_session') {
        return jsonError(c, 400, 'bad_request', 'The session path segment must be a UUID.');
      }
      if (route.reason === 'invalid_path') {
        return jsonError(c, 400, 'bad_request', 'The proxy path is incomplete.');
      }
      return notFound(c);
    }

    try {
      return await handleProxyRequest(c, route, services);
    } catch (error) {
      logger.error('Unhandled proxy failure', error);
      return proxyErrorResponse(
        route.protocol,
        500,
        'Cockpit failed while forwarding the request. See the daemon log for details.',
      );
    }
  });

  app.notFound((c) => notFound(c));

  return {
    app,
    closeWebSockets: () => {
      for (const socket of sockets) {
        try {
          socket.close(1001, 'Cockpit is shutting down.');
        } catch {
          // A socket may already be closing.
        }
      }
      sockets.clear();
    },
  };
}

export function localBaseUrl(config: CockpitConfig, port: number): string {
  return `http://${displayHostForUrl(config.host)}:${port}`;
}
