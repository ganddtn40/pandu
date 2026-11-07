import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import {
  serve,
  type ServerType,
  type WebSocketLike,
  type WebSocketServerLike,
} from '@hono/node-server';
import type { Context, Hono } from 'hono';

import { createApp, localBaseUrl, type AppBundle } from './app.js';
import { AnalyticsService } from './analytics/service.js';
import { ArenaService } from './arena/service.js';
import { BrainService } from './brain/service.js';
import { CheatDetector } from './cheat/detector.js';
import { loadConfig, type CockpitConfig } from './config.js';
import { ContextDoctor } from './context/doctor.js';
import { openDatabase } from './db/client.js';
import { GitSnapshotService } from './git/snapshots.js';
import { ApprovalBroker } from './guards/approval.js';
import { BudgetService } from './guards/budget.js';
import { GuardService } from './guards/service.js';
import { HandoffService } from './handoff/service.js';
import { resolveWebRoot } from './http/dashboard.js';
import { JournalService } from './journal/service.js';
import { LiveEventBus } from './live/bus.js';
import { createLogger, type Logger } from './logger.js';
import { PairingService } from './pairing/service.js';
import { PluginService } from './plugins/service.js';
import { ProvenanceService } from './provenance/service.js';
import { Recorder } from './recording/recorder.js';
import { ForkService } from './replay/fork.js';
import { SessionManager } from './sessions/manager.js';
import { Store } from './store/store.js';
import { UnderstandingService } from './understanding/service.js';

export interface CreateDaemonOptions {
  env?: NodeJS.ProcessEnv;
  config?: CockpitConfig;
  webRoot?: string;
  /** Test seam for remote-address detection; production uses the TCP socket. */
  resolveRemoteAddress?: (c: Context) => string | undefined;
}

export interface DaemonRuntime {
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
  app: Hono;
  close: () => Promise<void>;
}

export interface StartDaemonOptions extends CreateDaemonOptions {
  host?: string;
  port?: number;
}

export interface StartedDaemon extends DaemonRuntime {
  host: string;
  port: number;
  url: string;
  server: ServerType;
  websocketServer: WebSocketServer;
}

/**
 * `ws` and Hono's structural WebSocket server type diverge on the optionality of
 * `noServer`, even though Hono enforces it at runtime. The adapter keeps the
 * cast local and explicit instead of weakening the server type.
 */
function asWebSocketServerLike(server: WebSocketServer): WebSocketServerLike {
  return {
    options: { noServer: true },
    on: server.on.bind(server) as WebSocketServerLike['on'],
    off: server.off.bind(server) as WebSocketServerLike['off'],
    emit: server.emit.bind(server) as WebSocketServerLike['emit'],
    handleUpgrade: (request, socket, head, callback) => {
      server.handleUpgrade(request, socket, head, (client) => {
        callback(client as unknown as WebSocketLike);
      });
    },
    close: () => server.close(),
  };
}

function withServerOverrides(base: CockpitConfig, options: StartDaemonOptions): CockpitConfig {
  return {
    ...base,
    host: options.host ?? base.host,
    port: options.port ?? base.port,
  };
}

function startSweeper(sessions: SessionManager, idleTimeoutMs: number): NodeJS.Timeout {
  const interval = Math.max(1_000, Math.min(60_000, Math.floor(idleTimeoutMs / 2)));
  const timer = setInterval(() => {
    try {
      sessions.sweep();
    } catch {
      // Sweeping is best effort; a later tick will try again.
    }
  }, interval);
  timer.unref();
  return timer;
}

export function createDaemon(options: CreateDaemonOptions = {}): DaemonRuntime {
  const config = options.config ?? loadConfig(options.env);
  const logger = createLogger(config.logLevel);
  const connection = openDatabase({ databasePath: config.databasePath });
  const webRoot = options.webRoot ?? resolveWebRoot(options.env ?? process.env);

  try {
    const store = new Store(connection);
    const bus = new LiveEventBus({
      initialSequence: store.maxLiveEventSequence(),
      persist: (event) => store.insertLiveEvent(event),
      logger,
    });
    const broker = new ApprovalBroker();
    const guards = new GuardService({
      store,
      bus,
      logger,
      approvalTimeoutMs: config.guardApprovalTimeoutMs,
      broker,
    });
    const budgets = new BudgetService({
      store,
      bus,
      logger,
      broker,
      approvalTimeoutMs: config.guardApprovalTimeoutMs,
    });
    const cheats = new CheatDetector({ store, bus, logger });
    const provenance = new ProvenanceService({ store, logger });
    const understanding = new UnderstandingService({ store, logger, bus });
    const contextDoctor = new ContextDoctor({ store, logger });
    const brain = new BrainService({ store, logger });
    const arena = new ArenaService({ store, config, logger });
    const handoff = new HandoffService({ store, logger });
    const analytics = new AnalyticsService({ store });
    const journal = new JournalService({ store, logger });
    const plugins = new PluginService({ store, logger });
    const pairing = new PairingService({ store, bus, logger, config });
    const snapshots = new GitSnapshotService({
      store,
      logger,
      onSnapshot: (snapshot) => {
        guards.scheduleScan(snapshot.sessionId);
        cheats.schedule(snapshot.sessionId);
        try {
          provenance.recordSnapshot(snapshot);
        } catch (error) {
          logger.warn('Cockpit could not derive provenance from a snapshot', error);
        }
        try {
          understanding.syncSession(snapshot.sessionId);
        } catch (error) {
          logger.warn('Cockpit could not update understanding debt', error);
        }
      },
    });
    const sessions = new SessionManager({
      store,
      bus,
      logger,
      idleTimeoutMs: config.sessionIdleTimeoutMs,
      snapshots,
      onSessionEnded: (session) => {
        try {
          guards.scanSession(session.id);
        } catch (error) {
          logger.warn('Cockpit could not scan a finished session for secrets', error);
        }
        cheats.schedule(session.id);
        void snapshots
          .flushSession(session.id)
          .then(() => understanding.syncSession(session.id))
          .catch((error: unknown) => {
            logger.warn('Cockpit could not finalize understanding debt', error);
          });
      },
    });
    const recorder = new Recorder({
      store,
      bus,
      logger,
      snapshots,
      guards,
      contextDoctor,
    });
    const forks = new ForkService({ store, config, logger });
    const startedAtMono = performance.now();
    const appBundle: AppBundle = createApp({
      config,
      store,
      bus,
      sessions,
      recorder,
      snapshots,
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
      startedAtMono,
      ...(webRoot ? { webRoot } : {}),
      ...(options.resolveRemoteAddress
        ? { resolveRemoteAddress: options.resolveRemoteAddress }
        : {}),
    });
    const sweeper = startSweeper(sessions, config.sessionIdleTimeoutMs);

    let closePromise: Promise<void> | undefined;
    const close = async (): Promise<void> => {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        clearInterval(sweeper);
        appBundle.closeWebSockets();
        try {
          sessions.shutdown();
        } finally {
          try {
            await snapshots.flushAll();
          } finally {
            guards.close();
            cheats.dispose();
            store.close();
          }
        }
      })();
      return closePromise;
    };

    return {
      config,
      store,
      bus,
      sessions,
      recorder,
      snapshots,
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
      app: appBundle.app,
      close,
    };
  } catch (error) {
    connection.close();
    throw error;
  }
}

function waitForListening(server: ServerType): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onListening = (): void => {
      cleanup();
      const address = server.address();
      if (address && typeof address !== 'string') {
        resolve((address as AddressInfo).port);
        return;
      }
      reject(new Error('Cockpit could not determine the daemon port.'));
    };
    const cleanup = (): void => {
      server.off('error', onError);
      server.off('listening', onListening);
    };

    server.once('error', onError);
    server.once('listening', onListening);
  });
}

export async function startDaemon(options: StartDaemonOptions = {}): Promise<StartedDaemon> {
  const baseConfig = options.config ?? loadConfig(options.env);
  const config = withServerOverrides(baseConfig, options);
  const runtime = createDaemon({ ...options, config });
  const websocketServer = new WebSocketServer({ noServer: true });

  let server: ServerType;
  try {
    server = serve(
      {
        fetch: runtime.app.fetch,
        hostname: config.host,
        port: config.port,
        websocket: { server: asWebSocketServerLike(websocketServer) },
      },
      undefined,
    );
  } catch (error) {
    websocketServer.close();
    await runtime.close();
    throw error;
  }

  let port: number;
  try {
    port = await waitForListening(server);
  } catch (error) {
    websocketServer.close();
    server.close();
    await runtime.close();
    throw error;
  }

  const url = localBaseUrl(config, port);
  runtime.pairing.setBaseUrl(url);
  runtime.logger.info(`Cockpit daemon listening on ${url}`, {
    database: runtime.config.databasePath,
  });

  let closePromise: Promise<void> | undefined;
  const close = async (): Promise<void> => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      const httpServer = server as HttpServer;
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(forceTimer);
          resolve();
        };
        const forceTimer = setTimeout(() => {
          httpServer.closeAllConnections();
        }, 1_000);
        forceTimer.unref();

        httpServer.close(() => finish());
        httpServer.closeIdleConnections();
      });

      websocketServer.close();
      await runtime.close();
      runtime.logger.info('Cockpit daemon stopped');
    })();
    return closePromise;
  };

  return {
    ...runtime,
    host: config.host,
    port,
    url,
    server,
    websocketServer,
    close,
  };
}
