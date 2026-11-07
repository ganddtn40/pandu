import path from 'node:path';
import spawn from 'cross-spawn';
import type { ChildProcess } from 'node:child_process';
import type { CreateSessionInput, Session, SessionStatus } from '@cockpit/core';
import type { CockpitConfig } from '@cockpit/daemon';

import { daemonBaseUrl, dashboardUrl } from './config.js';
import { DaemonClient, DaemonRequestError } from './daemon-client.js';
import { buildAgentEnvironment } from './environment.js';
import { readGitContext } from './git.js';
import { startDetached } from './start.js';

const AGENT_LABELS: Readonly<Record<string, string>> = {
  claude: 'Claude Code',
  'claude-code': 'Claude Code',
  opencode: 'OpenCode',
  codex: 'Codex',
  aider: 'Aider',
  gemini: 'Gemini CLI',
  'cursor-agent': 'Cursor',
  cursor: 'Cursor',
  goose: 'Goose',
  amp: 'Amp',
  crush: 'Crush',
  cline: 'Cline',
};

export interface RunCommandOptions {
  command: string[];
  workspace: string;
  title?: string;
  config: CockpitConfig;
}

export interface RunCommandResult {
  session: Session;
  exitCode: number;
}

function commandBasename(command: string): string {
  const base = path.basename(command);
  return base.replace(/\.(?:exe|cmd|bat)$/i, '');
}

export function agentLabelForCommand(command: string): string {
  const base = commandBasename(command).toLowerCase();
  return AGENT_LABELS[base] ?? commandBasename(command);
}

export function defaultSessionTitle(agentName: string, now = new Date()): string {
  const stamp = now.toISOString().slice(0, 16).replace('T', ' ');
  return `${agentName} · ${stamp}`;
}

export function buildRunSessionInput(options: {
  command: string[];
  workspacePath: string;
  title?: string;
  now?: Date;
}): CreateSessionInput {
  const executable = options.command[0];
  if (!executable) {
    throw new Error('A command is required after "cockpit run --".');
  }

  const agentName = agentLabelForCommand(executable);
  const git = readGitContext(options.workspacePath);
  const workspacePath = git.root ?? options.workspacePath;

  return {
    title: options.title ?? defaultSessionTitle(agentName, options.now),
    source: 'manual',
    agent: {
      name: agentName.slice(0, 100),
      detectedFrom: 'wrapper',
    },
    workspacePath,
    ...(git.branch ? { gitBranch: git.branch } : {}),
    ...(git.commit ? { gitBaseCommit: git.commit } : {}),
    tags: ['cli'],
  };
}

function formatCount(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

export function formatSessionSummary(session: Session, baseUrl: string): string {
  const totals = session.totals;
  const costLine = `$${totals.totalCostUsd.toFixed(4)}${
    totals.unknownCostCalls > 0 ? ` (${formatCount(totals.unknownCostCalls)} unpriced)` : ''
  }`;
  const modelLine = session.modelRef?.model ? `  model  ${session.modelRef.model}\n` : '';

  return [
    `Cockpit session ${session.id}`,
    `  status ${session.status} · ${formatCount(totals.stepCount)} steps · ${formatCount(totals.toolCallCount)} tool calls`,
    `  tokens ${formatCount(totals.inputTokens)} in / ${formatCount(totals.outputTokens)} out · ${costLine}`,
    ...(modelLine ? [modelLine.trimEnd()] : []),
    `  review ${dashboardUrl(baseUrl, session.id)}`,
    '',
  ].join('\n');
}

async function ensureDaemon(client: DaemonClient, config: CockpitConfig): Promise<void> {
  const health = await client.health();
  if (health) return;

  process.stderr.write(`Starting Cockpit daemon at ${client.baseUrl}...\n`);
  const started = await startDetached(config);
  if (!started.reused) {
    process.stderr.write(`Cockpit daemon started${started.pid ? ` (pid ${started.pid})` : ''}.\n`);
  }
}

function launchCommand(
  command: string[],
  options: {
    workspace: string;
    env: NodeJS.ProcessEnv;
  },
): { child: ChildProcess; interrupted: () => boolean } {
  const executable = command[0];
  if (!executable) {
    throw new Error('A command is required after "cockpit run --".');
  }

  const child = spawn(executable, command.slice(1), {
    cwd: options.workspace,
    env: options.env,
    stdio: 'inherit',
    windowsHide: false,
  });

  let interrupted = false;
  const forward = (signal: NodeJS.Signals): void => {
    interrupted = true;
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill(signal);
    } catch {
      // The child may have exited between the check and the signal.
    }
  };

  const onSigint = (): void => forward('SIGINT');
  const onSigterm = (): void => forward('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  const cleanup = (): void => {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  };
  child.once('exit', cleanup);
  child.once('error', cleanup);

  return { child, interrupted: () => interrupted };
}

async function waitForChild(child: ChildProcess): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
}> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

export async function runCommand(options: RunCommandOptions): Promise<RunCommandResult> {
  if (options.command.length === 0) {
    throw new Error('A command is required after "cockpit run --".');
  }

  const workspace = path.resolve(options.workspace);
  const baseUrl = daemonBaseUrl(options.config);
  const client = new DaemonClient(baseUrl);

  await ensureDaemon(client, options.config);

  const sessionInput = buildRunSessionInput({
    command: options.command,
    workspacePath: workspace,
    ...(options.title ? { title: options.title } : {}),
  });
  const session = await client.createSession(sessionInput);
  const agentEnvironment = buildAgentEnvironment({
    baseUrl,
    sessionId: session.id,
  });

  process.stderr.write(
    `Cockpit is recording this run as ${session.id}\nReview: ${dashboardUrl(baseUrl, session.id)}\n`,
  );

  let exitCode = 1;
  let interrupted = false;

  try {
    const launched = launchCommand(options.command, {
      workspace,
      env: agentEnvironment.env,
    });
    const result = await waitForChild(launched.child);
    interrupted = launched.interrupted() || result.signal === 'SIGINT';
    exitCode = result.code ?? (interrupted ? 130 : 1);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`cockpit: failed to launch the command: ${message}\n`);
    exitCode = 1;
  }

  const status: SessionStatus = interrupted ? 'killed' : exitCode === 0 ? 'completed' : 'failed';
  try {
    const finished = await client.endSession(session.id, status);
    process.stderr.write(`\n${formatSessionSummary(finished, baseUrl)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `\ncockpit: the run ended, but the session could not be closed: ${message}\nSession: ${dashboardUrl(baseUrl, session.id)}\n`,
    );
  }

  return { session, exitCode };
}

export function isDaemonConnectionError(error: unknown): boolean {
  return error instanceof DaemonRequestError;
}
