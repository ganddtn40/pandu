import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { isRecord } from '@cockpit/core';
import { openDatabase, type CockpitConfig } from '@cockpit/daemon';

import { daemonBaseUrl, loadCliConfig } from './config.js';
import { DaemonClient } from './daemon-client.js';

export type DoctorStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  exitCode: number;
}

export interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
  host?: string;
  port?: number;
}

const MINIMUM_NODE: readonly [number, number, number] = [22, 11, 0];

function compareVersions(actual: readonly number[], minimum: readonly number[]): boolean {
  for (let index = 0; index < minimum.length; index += 1) {
    const actualPart = actual[index] ?? 0;
    const minimumPart = minimum[index] ?? 0;
    if (actualPart > minimumPart) return true;
    if (actualPart < minimumPart) return false;
  }
  return true;
}

function nodeCheck(): DoctorCheck {
  const version = process.versions.node;
  const parts = version.split('.').map((part) => Number.parseInt(part, 10));
  const supported = compareVersions(parts, MINIMUM_NODE);
  return {
    name: 'Node.js',
    status: supported ? 'ok' : 'fail',
    detail: supported
      ? `v${version} (requires >= ${MINIMUM_NODE.join('.')})`
      : `v${version} is unsupported; install Node.js ${MINIMUM_NODE.join('.')} or newer`,
  };
}

function platformCheck(): DoctorCheck {
  return {
    name: 'Platform',
    status: 'ok',
    detail: `${process.platform} ${process.arch}`,
  };
}

function homeCheck(config: CockpitConfig): DoctorCheck {
  try {
    mkdirSync(config.paths.home, { recursive: true });
    const directory = mkdtempSync(path.join(config.paths.home, '.doctor-'));
    try {
      writeFileSync(path.join(directory, 'probe'), 'ok', 'utf8');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    return {
      name: 'Cockpit home',
      status: 'ok',
      detail: `${config.paths.home} is writable`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: 'Cockpit home',
      status: 'fail',
      detail: `${config.paths.home} is not writable: ${message}`,
    };
  }
}

function databaseCheck(config: CockpitConfig): DoctorCheck {
  try {
    const connection = openDatabase({ databasePath: config.databasePath });
    try {
      const row = connection.raw
        .prepare("select count(*) as count from sqlite_master where type = 'table'")
        .get();
      const count = isRecord(row) && typeof row['count'] === 'number' ? row['count'] : 0;
      return {
        name: 'Database',
        status: count >= 20 ? 'ok' : 'warn',
        detail:
          count >= 20
            ? `${config.databasePath} (${count} tables)`
            : `${config.databasePath} has only ${count} tables; migrations may be incomplete`,
      };
    } finally {
      connection.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: 'Database',
      status: 'fail',
      detail: `Could not open ${config.databasePath}: ${message}`,
    };
  }
}

function credentialsCheck(env: NodeJS.ProcessEnv): DoctorCheck {
  const openai = env['COCKPIT_OPENAI_API_KEY'] ?? env['OPENAI_API_KEY'];
  const anthropic = env['COCKPIT_ANTHROPIC_API_KEY'] ?? env['ANTHROPIC_API_KEY'];

  if (!openai && !anthropic) {
    return {
      name: 'Credentials',
      status: 'warn',
      detail: 'no daemon-side provider keys; clients must send their own credentials',
    };
  }

  const configured = [openai ? 'OpenAI' : undefined, anthropic ? 'Anthropic' : undefined].filter(
    (name): name is string => name !== undefined,
  );

  return {
    name: 'Credentials',
    status: 'ok',
    detail: `daemon-side keys configured for ${configured.join(' and ')}`,
  };
}

function upstreamCheck(config: CockpitConfig): DoctorCheck {
  return {
    name: 'Upstreams',
    status: 'ok',
    detail: `OpenAI ${config.openai.baseUrl} · Anthropic ${config.anthropic.baseUrl}`,
  };
}

function gitCheck(): DoctorCheck {
  try {
    const version = execFileSync('git', ['--version'], {
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
    return {
      name: 'Git',
      status: 'ok',
      detail: version,
    };
  } catch {
    return {
      name: 'Git',
      status: 'warn',
      detail: 'git was not found; sessions will not include branch or commit context',
    };
  }
}

export async function checkPort(
  host: string,
  port: number,
): Promise<{ available: boolean; detail: string }> {
  if (port === 0) {
    return { available: true, detail: 'port 0 selects an available port at startup' };
  }

  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', (error: NodeJS.ErrnoException) => {
      try {
        server.close();
      } catch {
        // The server never started listening.
      }
      resolve({
        available: false,
        detail:
          error.code === 'EADDRINUSE'
            ? `${host}:${port} is already in use`
            : `${host}:${port} could not be bound: ${error.message}`,
      });
    });
    server.listen(port, host, () => {
      server.close(() => {
        resolve({ available: true, detail: `${host}:${port} is available` });
      });
    });
  });
}

async function daemonChecks(config: CockpitConfig): Promise<DoctorCheck[]> {
  const baseUrl = daemonBaseUrl(config);
  const client = new DaemonClient(baseUrl, { timeoutMs: 800 });
  const health = await client.health();

  if (health) {
    const checks: DoctorCheck[] = [
      {
        name: 'Daemon',
        status: health.database === 'ok' ? 'ok' : 'warn',
        detail: `running at ${baseUrl} (v${health.version}, database ${health.database})`,
      },
      {
        name: 'Port',
        status: 'ok',
        detail: `${config.host}:${config.port} is serving Cockpit`,
      },
    ];
    return checks;
  }

  const port = await checkPort(config.host, config.port);
  return [
    {
      name: 'Daemon',
      status: 'warn',
      detail: `not running at ${baseUrl}; start it with "cockpit start"`,
    },
    {
      name: 'Port',
      status: port.available ? 'ok' : 'warn',
      detail: port.detail,
    },
  ];
}

export function summarizeChecks(checks: DoctorCheck[]): DoctorReport {
  const exitCode = checks.some((check) => check.status === 'fail') ? 1 : 0;
  return { checks, exitCode };
}

export function formatDoctorReport(report: DoctorReport): string {
  const counts = { ok: 0, warn: 0, fail: 0 };
  for (const check of report.checks) {
    counts[check.status] += 1;
  }

  const lines = ['Cockpit doctor', ''];
  for (const check of report.checks) {
    const label = `[${check.status}]`.padEnd(7);
    lines.push(`  ${label} ${check.name.padEnd(14)} ${check.detail}`);
  }
  lines.push(
    '',
    `${counts.ok} ok · ${counts.warn} warning${counts.warn === 1 ? '' : 's'} · ${counts.fail} failure${counts.fail === 1 ? '' : 's'}`,
    '',
  );
  return lines.join('\n');
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  const config = loadCliConfig(env, {
    ...(options.host ? { host: options.host } : {}),
    ...(options.port !== undefined ? { port: options.port } : {}),
  });

  const checks: DoctorCheck[] = [
    nodeCheck(),
    platformCheck(),
    homeCheck(config),
    databaseCheck(config),
  ];

  try {
    checks.push(...(await daemonChecks(config)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push({
      name: 'Daemon',
      status: 'warn',
      detail: `health check failed: ${message}`,
    });
  }

  checks.push(credentialsCheck(env), upstreamCheck(config), gitCheck());
  return summarizeChecks(checks);
}
