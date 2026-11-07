import {
  BRAIN_FORMATS,
  BrainFormatSchema,
  BudgetEnforcementSchema,
  BudgetPeriodSchema,
  BudgetScopeSchema,
  type ArenaTarget,
  type BrainFormat,
} from '@cockpit/core';
import { Command, InvalidArgumentError } from 'commander';

import { VERSION } from './version.js';
import { daemonBaseUrl, loadCliConfig } from './config.js';
import { DaemonClient } from './daemon-client.js';
import {
  runContext,
  runDebt,
  runDebtAck,
  runDebtDetail,
  runDebtExplain,
  runDebtOpen,
  runDebtQuiz,
  runProvenance,
} from './debt.js';
import { formatDoctorReport, runDoctor } from './doctor.js';
import { formatDemoResult, runDemo } from './demo.js';
import {
  runBudgetList,
  runBudgetStatus,
  runGuardDecision,
  runGuardEvents,
  runGuardList,
  runGuardScan,
  runTrust,
} from './guards.js';
import {
  collectArenaTarget,
  runAnalytics,
  runArenaList,
  runArenaRun,
  runArenaShow,
  runBrainGenerate,
  runBrainStatus,
  runBrainSync,
  runHandoffGenerate,
  runHandoffList,
  runHandoffShow,
  runJournalGenerate,
  runJournalList,
  runJournalShow,
  runPluginInstall,
  runPluginRemove,
  runPluginRun,
  runPluginRuns,
  runPluginsList,
  runPluginToggle,
  runProjectsList,
} from './phase7.js';
import { runCommand } from './run.js';
import { formatPairingSession, runDeviceList, runDeviceRevoke, runPair } from './phase8.js';
import { startDetached, startForeground } from './start.js';

export interface StartOptions {
  host?: string;
  port?: number;
  detach?: boolean;
}

export interface RunOptions {
  title?: string;
  workspace: string;
  host?: string;
  port?: number;
}

export interface DoctorOptions {
  host?: string;
  port?: number;
}

export interface DaemonOptions {
  host?: string;
  port?: number;
  json?: boolean;
}

export interface GuardEventsOptions extends DaemonOptions {
  session?: string;
  status?: string;
  kind?: string;
  limit?: number;
}

export interface GuardDecisionOptions extends DaemonOptions {
  note?: string;
}

export interface TrustOptions extends DaemonOptions {
  recompute?: boolean;
}

export interface BudgetAddOptions extends DaemonOptions {
  scope: string;
  period: string;
  limit: number;
  enforcement: string;
  projectId?: string;
  sessionId?: string;
}

export interface DebtQuizOptions extends DaemonOptions {
  answers?: string;
}

export interface RecomputeOptions extends DaemonOptions {
  recompute?: boolean;
}

export interface BrainFormatOptions extends DaemonOptions {
  format: BrainFormat[];
}

export interface BrainSyncOptions extends BrainFormatOptions {
  force?: boolean;
  dryRun?: boolean;
}

export interface ArenaRunOptions extends DaemonOptions {
  step: string;
  target: ArenaTarget[];
}

export interface ArenaListOptions extends DaemonOptions {
  session?: string;
  step?: string;
  limit?: number;
}

export interface HandoffGenerateOptions extends DaemonOptions {
  step?: string;
}

export interface AnalyticsOptions extends DaemonOptions {
  days?: number;
  project?: string;
  agent?: string;
}

export interface JournalListOptions extends DaemonOptions {
  project?: string;
  limit?: number;
}

export interface JournalGenerateOptions extends DaemonOptions {
  project?: string;
  week?: string;
}

export interface PluginRunOptions extends DaemonOptions {
  session: string;
  step?: string;
}

export interface PluginRunsOptions extends DaemonOptions {
  limit?: number;
}

export interface PairOptions extends DaemonOptions {
  name?: string;
  ttl?: number;
  wait?: boolean;
}

export interface DemoOptions extends DaemonOptions {
  json?: boolean;
}

function collectBrainFormat(value: string, previous: BrainFormat[]): BrainFormat[] {
  const parsed = BrainFormatSchema.safeParse(value);
  if (!parsed.success) {
    throw new InvalidArgumentError(
      `Unknown brain format: ${value}. Use one of ${BRAIN_FORMATS.join(', ')}.`,
    );
  }
  return [...previous, parsed.data];
}

function parseDays(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 365) {
    throw new InvalidArgumentError('Days must be an integer between 1 and 365.');
  }
  return parsed;
}

function parseWeek(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new InvalidArgumentError('Week must be a YYYY-MM-DD date.');
  }
  return value;
}

function parseUsd(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new InvalidArgumentError('Amount must be a non-negative number of US dollars.');
  }
  return parsed;
}

function parsePositiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError('Value must be a positive integer.');
  }
  return parsed;
}

function clientFor(options: { host?: string; port?: number }): DaemonClient {
  const config = loadCliConfig(process.env, overrides(options));
  return new DaemonClient(daemonBaseUrl(config));
}

function parsePort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new InvalidArgumentError('Port must be an integer between 0 and 65535.');
  }
  return parsed;
}

function parseTtl(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 60 || parsed > 900) {
    throw new InvalidArgumentError('TTL must be an integer between 60 and 900 seconds.');
  }
  return parsed;
}

function overrides(options: { host?: string; port?: number }): {
  host?: string;
  port?: number;
} {
  return {
    ...(options.host ? { host: options.host } : {}),
    ...(options.port !== undefined ? { port: options.port } : {}),
  };
}

export function createProgram(): Command {
  const program = new Command()
    .name('cockpit')
    .description('Local-first flight recorder and control tower for AI coding agents.')
    .version(VERSION, '-v, --version', 'print the Cockpit version')
    .enablePositionalOptions()
    .showHelpAfterError('Run cockpit --help for usage.')
    .addHelpText(
      'after',
      '\nExamples:\n  cockpit start\n  cockpit demo\n  cockpit run -- claude\n  cockpit run --title "Fix auth" -- opencode\n  cockpit doctor\n',
    );

  program.configureOutput({
    writeErr: (message) => process.stderr.write(message),
  });

  program
    .command('start')
    .description('start the local Cockpit daemon')
    .option('--host <host>', 'bind host (default 127.0.0.1)')
    .option('--port <port>', 'bind port (default 4319)', parsePort)
    .option('--detach', 'run the daemon in the background')
    .action(async (options: StartOptions) => {
      const config = loadCliConfig(process.env, overrides(options));
      if (options.detach) {
        const result = await startDetached(config);
        if (result.reused) {
          process.stdout.write(
            `Cockpit is already running at ${result.url}\nDashboard: ${result.dashboardUrl}\n`,
          );
          return;
        }
        process.stdout.write(
          `Cockpit daemon started at ${result.url}\nDashboard: ${result.dashboardUrl}\n${result.pid ? `PID: ${result.pid}\n` : ''}Logs: ${result.logPath}\n`,
        );
        return;
      }

      await startForeground(config);
    });

  program
    .command('run')
    .description('run an agent command inside an explicit Cockpit session')
    .argument('<command...>', 'command and arguments; place -- before the command')
    .option('--title <title>', 'session title')
    .option('--workspace <path>', 'working directory', process.cwd())
    .option('--host <host>', 'daemon host (default 127.0.0.1)')
    .option('--port <port>', 'daemon port (default 4319)', parsePort)
    .action(async (command: string[], options: RunOptions) => {
      const config = loadCliConfig(process.env, overrides(options));
      const result = await runCommand({
        command,
        workspace: options.workspace,
        config,
        ...(options.title ? { title: options.title } : {}),
      });
      process.exitCode = result.exitCode;
    });

  program
    .command('doctor')
    .description('check the local Cockpit installation and environment')
    .option('--host <host>', 'daemon host to check')
    .option('--port <port>', 'daemon port to check', parsePort)
    .action(async (options: DoctorOptions) => {
      const report = await runDoctor(overrides(options));
      process.stdout.write(formatDoctorReport(report));
      process.exitCode = report.exitCode;
    });

  program
    .command('demo')
    .description('seed a realistic demo flight without an agent')
    .option('--json', 'print machine-readable JSON')
    .option('--host <host>', 'daemon host (default 127.0.0.1)')
    .option('--port <port>', 'daemon port (default 4319)', parsePort)
    .action(async (options: DemoOptions) => {
      const config = loadCliConfig(process.env, overrides(options));
      const result = await runDemo(config);
      process.stdout.write(formatDemoResult(result, options.json === true));
    });

  const guard = program
    .command('guard')
    .description('inspect guard rules and resolve pending approvals');

  guard
    .command('list')
    .description('list guard rules')
    .option('--json', 'print machine-readable JSON')
    .option('--host <host>', 'daemon host')
    .option('--port <port>', 'daemon port', parsePort)
    .action(async (options: DaemonOptions) => {
      process.stdout.write(await runGuardList(clientFor(options), options.json === true));
    });

  guard
    .command('events')
    .description('list recent guard events')
    .option('--session <id>', 'filter by session id')
    .option('--status <status>', 'filter by event status')
    .option('--kind <kind>', 'filter by rule kind')
    .option('--limit <count>', 'maximum events to return (1-500)', parsePositiveInt)
    .option('--json', 'print machine-readable JSON')
    .option('--host <host>', 'daemon host')
    .option('--port <port>', 'daemon port', parsePort)
    .action(async (options: GuardEventsOptions) => {
      const query = {
        ...(options.session ? { sessionId: options.session } : {}),
        ...(options.status ? { status: options.status } : {}),
        ...(options.kind ? { kind: options.kind } : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      };
      process.stdout.write(await runGuardEvents(clientFor(options), query, options.json === true));
    });

  for (const decision of ['approve', 'deny'] as const) {
    guard
      .command(`${decision} <eventId>`)
      .description(`${decision} a pending guard event`)
      .option('--note <note>', 'resolution note recorded with the decision')
      .option('--json', 'print machine-readable JSON')
      .option('--host <host>', 'daemon host')
      .option('--port <port>', 'daemon port', parsePort)
      .action(async (eventId: string, options: GuardDecisionOptions) => {
        process.stdout.write(
          await runGuardDecision(
            clientFor(options),
            eventId,
            decision,
            options.note,
            options.json === true,
          ),
        );
      });
  }

  guard
    .command('scan <sessionId>')
    .description('rescan a session for secrets')
    .option('--json', 'print machine-readable JSON')
    .option('--host <host>', 'daemon host')
    .option('--port <port>', 'daemon port', parsePort)
    .action(async (sessionId: string, options: DaemonOptions) => {
      process.stdout.write(
        await runGuardScan(clientFor(options), sessionId, options.json === true),
      );
    });

  program
    .command('trust <sessionId>')
    .description('show the trust score and cheat findings for a session')
    .option('--recompute', 're-analyze the session before printing')
    .option('--json', 'print machine-readable JSON')
    .option('--host <host>', 'daemon host')
    .option('--port <port>', 'daemon port', parsePort)
    .action(async (sessionId: string, options: TrustOptions) => {
      process.stdout.write(
        await runTrust(
          clientFor(options),
          sessionId,
          options.recompute === true,
          options.json === true,
        ),
      );
    });

  const budget = program.command('budget').description('manage local spending budgets');

  budget
    .command('list')
    .description('list budget policies')
    .option('--json', 'print machine-readable JSON')
    .option('--host <host>', 'daemon host')
    .option('--port <port>', 'daemon port', parsePort)
    .action(async (options: DaemonOptions) => {
      process.stdout.write(await runBudgetList(clientFor(options), options.json === true));
    });

  budget
    .command('status <sessionId>')
    .description('show the budget status for a session')
    .option('--json', 'print machine-readable JSON')
    .option('--host <host>', 'daemon host')
    .option('--port <port>', 'daemon port', parsePort)
    .action(async (sessionId: string, options: DaemonOptions) => {
      process.stdout.write(
        await runBudgetStatus(clientFor(options), sessionId, options.json === true),
      );
    });

  budget
    .command('add <name>')
    .description('create a budget policy')
    .requiredOption('--limit <usd>', 'spending limit in US dollars', parseUsd)
    .option('--scope <scope>', 'session, project, or global', 'global')
    .option('--period <period>', 'session, day, week, or month', 'month')
    .option('--enforcement <mode>', 'warn, pause, or block', 'warn')
    .option('--project-id <id>', 'project id for a project-scoped budget')
    .option('--session-id <id>', 'session id for a session-scoped budget')
    .option('--json', 'print machine-readable JSON')
    .option('--host <host>', 'daemon host')
    .option('--port <port>', 'daemon port', parsePort)
    .action(async (name: string, options: BudgetAddOptions) => {
      const client = clientFor(options);
      const policy = await client.createBudgetPolicy({
        name,
        scope: BudgetScopeSchema.parse(options.scope),
        period: BudgetPeriodSchema.parse(options.period),
        limitUsd: options.limit,
        enforcement: BudgetEnforcementSchema.parse(options.enforcement),
        enabled: true,
        ...(options.projectId ? { projectId: options.projectId } : {}),
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      });
      process.stdout.write(
        options.json
          ? `${JSON.stringify({ policy }, null, 2)}\n`
          : `Budget policy ${policy.id} created (${policy.name}, $${policy.limitUsd.toFixed(2)} per ${policy.period}).\n`,
      );
    });

  budget
    .command('remove <id>')
    .description('delete a budget policy')
    .option('--host <host>', 'daemon host')
    .option('--port <port>', 'daemon port', parsePort)
    .action(async (id: string, options: DaemonOptions) => {
      const removed = await clientFor(options).deleteBudgetPolicy(id);
      process.stdout.write(
        removed ? `Budget policy ${id} removed.\n` : `Budget policy ${id} was not found.\n`,
      );
    });

  const debt = program
    .command('debt [sessionId]')
    .description('show AI understanding debt for a session or the whole workspace')
    .option('--json', 'print machine-readable JSON')
    .option('--host <host>', 'daemon host')
    .option('--port <port>', 'daemon port', parsePort)
    .action(async (sessionId: string | undefined, options: DaemonOptions) => {
      process.stdout.write(await runDebt(clientFor(options), sessionId, options.json === true));
    });

  debt
    .command('show <id>')
    .description('show one understanding file with provenance, events, and quizzes')
    .option('--json', 'print machine-readable JSON')
    .option('--host <host>', 'daemon host')
    .option('--port <port>', 'daemon port', parsePort)
    .action(async (id: string, options: DaemonOptions) => {
      process.stdout.write(await runDebtDetail(clientFor(options), id, options.json === true));
    });

  debt
    .command('open <id>')
    .description('mark an understanding file as opened')
    .option('--json', 'print machine-readable JSON')
    .option('--host <host>', 'daemon host')
    .option('--port <port>', 'daemon port', parsePort)
    .action(async (id: string, options: DaemonOptions) => {
      process.stdout.write(await runDebtOpen(clientFor(options), id, options.json === true));
    });

  debt
    .command('ack <id>')
    .description('acknowledge that you reviewed an AI-authored file')
    .option('--json', 'print machine-readable JSON')
    .option('--host <host>', 'daemon host')
    .option('--port <port>', 'daemon port', parsePort)
    .action(async (id: string, options: DaemonOptions) => {
      process.stdout.write(await runDebtAck(clientFor(options), id, options.json === true));
    });

  debt
    .command('explain <id>')
    .description('explain what changed in an AI-authored file and why it matters')
    .option('--json', 'print machine-readable JSON')
    .option('--host <host>', 'daemon host')
    .option('--port <port>', 'daemon port', parsePort)
    .action(async (id: string, options: DaemonOptions) => {
      process.stdout.write(await runDebtExplain(clientFor(options), id, options.json === true));
    });

  debt
    .command('quiz <id>')
    .description('start or submit a comprehension quiz for an AI-authored file')
    .option('--answers <choices>', 'comma-separated choice ids, for example a,b,c')
    .option('--json', 'print machine-readable JSON')
    .option('--host <host>', 'daemon host')
    .option('--port <port>', 'daemon port', parsePort)
    .action(async (id: string, options: DebtQuizOptions) => {
      process.stdout.write(
        await runDebtQuiz(clientFor(options), id, options.answers, options.json === true),
      );
    });

  program
    .command('context <sessionId>')
    .description('inspect the context the agent sent, with token and insight analysis')
    .option('--recompute', 'rebuild context snapshots from recorded steps')
    .option('--json', 'print machine-readable JSON')
    .option('--host <host>', 'daemon host')
    .option('--port <port>', 'daemon port', parsePort)
    .action(async (sessionId: string, options: RecomputeOptions) => {
      process.stdout.write(
        await runContext(
          clientFor(options),
          sessionId,
          options.recompute === true,
          options.json === true,
        ),
      );
    });

  program
    .command('provenance <sessionId>')
    .description('show which AI-authored line ranges Cockpit attributed to a session')
    .option('--recompute', 'rebuild provenance from recorded git snapshots')
    .option('--json', 'print machine-readable JSON')
    .option('--host <host>', 'daemon host')
    .option('--port <port>', 'daemon port', parsePort)
    .action(async (sessionId: string, options: RecomputeOptions) => {
      process.stdout.write(
        await runProvenance(
          clientFor(options),
          sessionId,
          options.recompute === true,
          options.json === true,
        ),
      );
    });

  program
    .command('projects')
    .description('list projects that Cockpit has recorded')
    .option('--json', 'print machine-readable JSON')
    .option('--host <host>', 'daemon host')
    .option('--port <port>', 'daemon port', parsePort)
    .action(async (options: DaemonOptions) => {
      process.stdout.write(await runProjectsList(clientFor(options), options.json === true));
    });

  const brain = program
    .command('brain')
    .description('generate and sync Project Brain instruction files');

  brain
    .command('status <projectId>')
    .description('show generated outputs, source checksums, and drift')
    .option('--json', 'print machine-readable JSON')
    .option('--host <host>', 'daemon host')
    .option('--port <port>', 'daemon port', parsePort)
    .action(async (projectId: string, options: DaemonOptions) => {
      process.stdout.write(
        await runBrainStatus(clientFor(options), projectId, options.json === true),
      );
    });

  brain
    .command('generate <projectId>')
    .description('read the repository and generate instruction files')
    .option(
      '--format <format>',
      `output format: ${BRAIN_FORMATS.join(', ')}; repeat to choose several`,
      collectBrainFormat,
      [],
    )
    .option('--json', 'print machine-readable JSON')
    .option('--host <host>', 'daemon host')
    .option('--port <port>', 'daemon port', parsePort)
    .action(async (projectId: string, options: BrainFormatOptions) => {
      const formats = options.format.length > 0 ? options.format : undefined;
      process.stdout.write(
        await runBrainGenerate(clientFor(options), projectId, formats, options.json === true),
      );
    });

  brain
    .command('sync <projectId>')
    .description('write generated instruction files to disk')
    .option(
      '--format <format>',
      `output format: ${BRAIN_FORMATS.join(', ')}; repeat to choose several`,
      collectBrainFormat,
      [],
    )
    .option('--force', 'overwrite files that changed since Cockpit generated them')
    .option('--dry-run', 'report what would be written without touching disk')
    .option('--json', 'print machine-readable JSON')
    .option('--host <host>', 'daemon host')
    .option('--port <port>', 'daemon port', parsePort)
    .action(async (projectId: string, options: BrainSyncOptions) => {
      const formats = options.format.length > 0 ? options.format : undefined;
      process.stdout.write(
        await runBrainSync(
          clientFor(options),
          projectId,
          formats,
          { force: options.force === true, dryRun: options.dryRun === true },
          options.json === true,
        ),
      );
    });

  const arena = program
    .command('arena')
    .description('replay a recorded step against several models and compare the results');

  arena
    .command('run <sessionId>')
    .description('replay one recorded step against provider:model targets')
    .requiredOption('--step <stepId>', 'recorded step to replay')
    .option(
      '--target <provider:model>',
      'model target; repeat for several models',
      collectArenaTarget,
      [],
    )
    .option('--json', 'print machine-readable JSON')
    .option('--host <host>', 'daemon host')
    .option('--port <port>', 'daemon port', parsePort)
    .action(async (sessionId: string, options: ArenaRunOptions) => {
      process.stdout.write(
        await runArenaRun(
          clientFor(options),
          sessionId,
          options.step,
          options.target,
          options.json === true,
        ),
      );
    });

  arena
    .command('list')
    .description('list recent arena runs')
    .option('--session <id>', 'filter by source session id')
    .option('--step <id>', 'filter by source step id')
    .option('--limit <count>', 'maximum runs to return (1-100)', parsePositiveInt)
    .option('--json', 'print machine-readable JSON')
    .option('--host <host>', 'daemon host')
    .option('--port <port>', 'daemon port', parsePort)
    .action(async (options: ArenaListOptions) => {
      process.stdout.write(
        await runArenaList(
          clientFor(options),
          {
            ...(options.session ? { sessionId: options.session } : {}),
            ...(options.step ? { stepId: options.step } : {}),
            ...(options.limit !== undefined ? { limit: options.limit } : {}),
          },
          options.json === true,
        ),
      );
    });

  arena
    .command('show <runId>')
    .description('show one arena run, including output and extracted diff')
    .option('--json', 'print machine-readable JSON')
    .option('--host <host>', 'daemon host')
    .option('--port <port>', 'daemon port', parsePort)
    .action(async (runId: string, options: DaemonOptions) => {
      process.stdout.write(await runArenaShow(clientFor(options), runId, options.json === true));
    });

  const handoff = program
    .command('handoff')
    .description('generate deterministic handoff briefs for a session');

  handoff
    .command('generate <sessionId>')
    .description('generate a handoff brief from recorded work')
    .option('--step <stepId>', 'stop at this step instead of the end of the session')
    .option('--json', 'print machine-readable JSON')
    .option('--host <host>', 'daemon host')
    .option('--port <port>', 'daemon port', parsePort)
    .action(async (sessionId: string, options: HandoffGenerateOptions) => {
      process.stdout.write(
        await runHandoffGenerate(
          clientFor(options),
          sessionId,
          options.step,
          options.json === true,
        ),
      );
    });

  handoff
    .command('list <sessionId>')
    .description('list handoff briefs for a session')
    .option('--json', 'print machine-readable JSON')
    .option('--host <host>', 'daemon host')
    .option('--port <port>', 'daemon port', parsePort)
    .action(async (sessionId: string, options: DaemonOptions) => {
      process.stdout.write(
        await runHandoffList(clientFor(options), sessionId, options.json === true),
      );
    });

  handoff
    .command('show <briefId>')
    .description('print a stored handoff brief')
    .option('--json', 'print machine-readable JSON')
    .option('--host <host>', 'daemon host')
    .option('--port <port>', 'daemon port', parsePort)
    .action(async (briefId: string, options: DaemonOptions) => {
      process.stdout.write(
        await runHandoffShow(clientFor(options), briefId, options.json === true),
      );
    });

  program
    .command('analytics')
    .description('show sessions, tokens, cost, models, and agents over a date window')
    .option('--days <days>', 'window in days (1-365)', parseDays)
    .option('--project <id>', 'filter by project id')
    .option('--agent <name>', 'filter by agent name')
    .option('--json', 'print machine-readable JSON')
    .option('--host <host>', 'daemon host')
    .option('--port <port>', 'daemon port', parsePort)
    .action(async (options: AnalyticsOptions) => {
      process.stdout.write(
        await runAnalytics(
          clientFor(options),
          {
            ...(options.days !== undefined ? { days: options.days } : {}),
            ...(options.project ? { projectId: options.project } : {}),
            ...(options.agent ? { agent: options.agent } : {}),
          },
          options.json === true,
        ),
      );
    });

  const journal = program
    .command('journal')
    .description('generate and read weekly engineering journals');

  journal
    .command('list')
    .description('list stored journal entries')
    .option('--project <id>', 'filter by project id')
    .option('--limit <count>', 'maximum entries to return (1-100)', parsePositiveInt)
    .option('--json', 'print machine-readable JSON')
    .option('--host <host>', 'daemon host')
    .option('--port <port>', 'daemon port', parsePort)
    .action(async (options: JournalListOptions) => {
      process.stdout.write(
        await runJournalList(
          clientFor(options),
          {
            ...(options.project ? { projectId: options.project } : {}),
            ...(options.limit !== undefined ? { limit: options.limit } : {}),
          },
          options.json === true,
        ),
      );
    });

  journal
    .command('generate')
    .description('generate or refresh the journal for a UTC week')
    .option('--project <id>', 'generate for one project instead of the workspace')
    .option('--week <date>', 'UTC week start (YYYY-MM-DD); defaults to this week', parseWeek)
    .option('--json', 'print machine-readable JSON')
    .option('--host <host>', 'daemon host')
    .option('--port <port>', 'daemon port', parsePort)
    .action(async (options: JournalGenerateOptions) => {
      process.stdout.write(
        await runJournalGenerate(
          clientFor(options),
          {
            ...(options.project ? { projectId: options.project } : {}),
            ...(options.week ? { weekStart: options.week } : {}),
          },
          options.json === true,
        ),
      );
    });

  journal
    .command('show <entryId>')
    .description('print one stored journal entry')
    .option('--json', 'print machine-readable JSON')
    .option('--host <host>', 'daemon host')
    .option('--port <port>', 'daemon port', parsePort)
    .action(async (entryId: string, options: DaemonOptions) => {
      process.stdout.write(
        await runJournalShow(clientFor(options), entryId, options.json === true),
      );
    });

  const plugins = program
    .command('plugins')
    .description('install and run local guard and analyzer plugins');

  plugins
    .command('list')
    .description('list installed plugins')
    .option('--json', 'print machine-readable JSON')
    .option('--host <host>', 'daemon host')
    .option('--port <port>', 'daemon port', parsePort)
    .action(async (options: DaemonOptions) => {
      process.stdout.write(await runPluginsList(clientFor(options), options.json === true));
    });

  plugins
    .command('install <path>')
    .description('install a plugin directory that contains cockpit-plugin.json')
    .option('--json', 'print machine-readable JSON')
    .option('--host <host>', 'daemon host')
    .option('--port <port>', 'daemon port', parsePort)
    .action(async (pluginPath: string, options: DaemonOptions) => {
      process.stdout.write(
        await runPluginInstall(clientFor(options), pluginPath, options.json === true),
      );
    });

  for (const [action, enabled] of [
    ['enable', true],
    ['disable', false],
  ] as const) {
    plugins
      .command(`${action} <pluginId>`)
      .description(`${action} an installed plugin`)
      .option('--json', 'print machine-readable JSON')
      .option('--host <host>', 'daemon host')
      .option('--port <port>', 'daemon port', parsePort)
      .action(async (pluginId: string, options: DaemonOptions) => {
        process.stdout.write(
          await runPluginToggle(clientFor(options), pluginId, enabled, options.json === true),
        );
      });
  }

  plugins
    .command('remove <pluginId>')
    .description('remove an installed plugin and its run history')
    .option('--json', 'print machine-readable JSON')
    .option('--host <host>', 'daemon host')
    .option('--port <port>', 'daemon port', parsePort)
    .action(async (pluginId: string, options: DaemonOptions) => {
      process.stdout.write(
        await runPluginRemove(clientFor(options), pluginId, options.json === true),
      );
    });

  plugins
    .command('run <pluginId>')
    .description('run a plugin against a recorded session')
    .requiredOption('--session <id>', 'session to analyze')
    .option('--step <id>', 'include steps up to this step')
    .option('--json', 'print machine-readable JSON')
    .option('--host <host>', 'daemon host')
    .option('--port <port>', 'daemon port', parsePort)
    .action(async (pluginId: string, options: PluginRunOptions) => {
      process.stdout.write(
        await runPluginRun(
          clientFor(options),
          pluginId,
          options.session,
          options.step,
          options.json === true,
        ),
      );
    });

  plugins
    .command('runs <pluginId>')
    .description('list recent runs for a plugin')
    .option('--limit <count>', 'maximum runs to return (1-100)', parsePositiveInt)
    .option('--json', 'print machine-readable JSON')
    .option('--host <host>', 'daemon host')
    .option('--port <port>', 'daemon port', parsePort)
    .action(async (pluginId: string, options: PluginRunsOptions) => {
      process.stdout.write(
        await runPluginRuns(
          clientFor(options),
          pluginId,
          options.limit ?? 20,
          options.json === true,
        ),
      );
    });

  program
    .command('pair')
    .description('create a one-time pairing code for the mobile or desktop app')
    .option('--name <name>', 'suggested device name')
    .option('--ttl <seconds>', 'code lifetime in seconds (60-900, default 300)', parseTtl)
    .option('--wait', 'wait until the code is claimed or expires')
    .option('--json', 'print machine-readable JSON')
    .option('--host <host>', 'daemon host')
    .option('--port <port>', 'daemon port', parsePort)
    .action(async (options: PairOptions) => {
      const output = await runPair(
        clientFor(options),
        {
          ttlSeconds: options.ttl ?? 300,
          ...(options.name ? { name: options.name } : {}),
        },
        {
          wait: options.wait === true,
          json: options.json === true,
          onSession: (session) => process.stdout.write(formatPairingSession(session)),
        },
      );
      process.stdout.write(output);
    });

  const devices = program
    .command('devices')
    .description('list and revoke devices paired with this Cockpit daemon');

  devices
    .command('list')
    .description('list paired devices')
    .option('--json', 'print machine-readable JSON')
    .option('--host <host>', 'daemon host')
    .option('--port <port>', 'daemon port', parsePort)
    .action(async (options: DaemonOptions) => {
      process.stdout.write(await runDeviceList(clientFor(options), options.json === true));
    });

  devices
    .command('revoke')
    .description('revoke a paired device token')
    .argument('<id>', 'device id from `cockpit devices list`')
    .option('--json', 'print machine-readable JSON')
    .option('--host <host>', 'daemon host')
    .option('--port <port>', 'daemon port', parsePort)
    .action(async (deviceId: string, options: DaemonOptions) => {
      process.stdout.write(
        await runDeviceRevoke(clientFor(options), deviceId, options.json === true),
      );
    });

  return program;
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  const program = createProgram();
  if (argv.length <= 2) {
    program.outputHelp();
    return;
  }
  await program.parseAsync(argv);
}
