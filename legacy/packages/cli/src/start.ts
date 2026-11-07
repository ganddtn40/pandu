import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { HealthResponse } from '@cockpit/core';
import { startDaemon, type CockpitConfig } from '@cockpit/daemon';

import { daemonBaseUrl, dashboardUrl } from './config.js';
import { DaemonClient } from './daemon-client.js';

export interface DetachedStartResult {
  pid: number | undefined;
  url: string;
  dashboardUrl: string;
  reused: boolean;
  logPath: string;
}

export interface StartDetachedOptions {
  /** Extra environment variables for the detached daemon. */
  env?: NodeJS.ProcessEnv;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export function pidFilePath(config: CockpitConfig): string {
  return path.join(config.paths.home, 'daemon.pid');
}

export function daemonLogPath(config: CockpitConfig): string {
  return path.join(config.paths.logsDirectory, 'daemon.log');
}

function ensureDirectories(config: CockpitConfig): void {
  mkdirSync(config.paths.home, { recursive: true });
  mkdirSync(config.paths.logsDirectory, { recursive: true });
}

function writePidFile(config: CockpitConfig, pid: number): void {
  ensureDirectories(config);
  writeFileSync(pidFilePath(config), `${pid}\n`, 'utf8');
}

function removePidFile(config: CockpitConfig, pid?: number): void {
  const file = pidFilePath(config);
  try {
    if (pid !== undefined) {
      const existing = readFileSync(file, 'utf8').trim();
      if (existing !== String(pid)) return;
    }
    rmSync(file, { force: true });
  } catch {
    // A missing PID file is not an error.
  }
}

export async function waitForDaemon(
  client: DaemonClient,
  timeoutMs = 15_000,
): Promise<HealthResponse> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await client.health();
    if (health) return health;
    await delay(150);
  }
  throw new Error(`Cockpit did not become healthy at ${client.baseUrl} within ${timeoutMs}ms.`);
}

export async function startDetached(
  config: CockpitConfig,
  options: StartDetachedOptions = {},
): Promise<DetachedStartResult> {
  if (config.port === 0) {
    throw new Error('A detached Cockpit daemon needs a fixed port; port 0 is not supported.');
  }

  const url = daemonBaseUrl(config);
  const client = new DaemonClient(url, { timeoutMs: 600 });
  const existing = await client.health();
  if (existing) {
    return {
      pid: undefined,
      url,
      dashboardUrl: dashboardUrl(url),
      reused: true,
      logPath: daemonLogPath(config),
    };
  }

  const script = process.argv[1];
  if (!script) {
    throw new Error('Cockpit could not locate its own CLI entry point to start a daemon.');
  }

  ensureDirectories(config);
  const logPath = daemonLogPath(config);
  const logFd = openSync(logPath, 'a');
  let child: ChildProcess;
  try {
    child = spawn(
      process.execPath,
      [script, 'start', '--host', config.host, '--port', String(config.port)],
      {
        detached: true,
        windowsHide: true,
        stdio: ['ignore', logFd, logFd],
        env: {
          ...process.env,
          ...options.env,
          COCKPIT_HOME: config.paths.home,
          COCKPIT_LOG_LEVEL: process.env['COCKPIT_LOG_LEVEL'] ?? 'info',
        },
      },
    );
  } finally {
    closeSync(logFd);
  }

  child.unref();

  try {
    await waitForDaemon(client);
  } catch (error) {
    child.kill();
    removePidFile(config, child.pid);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message} See ${logPath} for daemon output.`);
  }

  if (child.pid !== undefined) {
    writePidFile(config, child.pid);
  }

  return {
    pid: child.pid,
    url,
    dashboardUrl: dashboardUrl(url),
    reused: false,
    logPath,
  };
}

export async function startForeground(config: CockpitConfig): Promise<void> {
  const url = daemonBaseUrl(config);
  const client = new DaemonClient(url, { timeoutMs: 800 });
  const existing = await client.health();
  if (existing) {
    process.stdout.write(`Cockpit is already running at ${url}\nDashboard: ${dashboardUrl(url)}\n`);
    return;
  }

  let daemon;
  try {
    daemon = await startDaemon({ config });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not start Cockpit at ${url}: ${message}`);
  }

  writePidFile(config, process.pid);
  process.stdout.write(
    `Cockpit daemon listening at ${daemon.url}\nDashboard: ${dashboardUrl(daemon.url)}\nDatabase: ${config.databasePath}\nPress Ctrl+C to stop.\n`,
  );

  await new Promise<void>((resolve) => {
    let shuttingDown = false;

    const shutdown = (): void => {
      if (shuttingDown) {
        process.exit(130);
      }
      shuttingDown = true;
      void daemon
        .close()
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          process.stderr.write(`cockpit: failed to stop cleanly: ${message}\n`);
        })
        .finally(() => {
          process.off('SIGINT', shutdown);
          process.off('SIGTERM', shutdown);
          removePidFile(config, process.pid);
          resolve();
        });
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}
