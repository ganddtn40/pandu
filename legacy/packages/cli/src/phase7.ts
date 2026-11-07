import {
  BRAIN_FORMAT_LABELS,
  PluginManifestSchema,
  formatUsd,
  type AnalyticsQuery,
  type AnalyticsResponse,
  type ArenaRun,
  type ArenaTarget,
  type BrainFormat,
  type BrainProjectStatus,
  type BrainSyncResponse,
  type HandoffBrief,
  type JournalEntry,
  type Plugin,
  type PluginRun,
  type Project,
} from '@cockpit/core';
import { InvalidArgumentError } from 'commander';

import type { DaemonClient } from './daemon-client.js';

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function cap(value: string, maximum: number): string {
  return value.length > maximum ? `${value.slice(0, maximum)}\n…[truncated]` : value;
}

function formatProjectLine(project: Project): string {
  return `${project.name} — ${project.rootPath} (${project.id})`;
}

export function parseArenaTarget(value: string): ArenaTarget {
  const separator = value.indexOf(':');
  if (separator <= 0 || separator === value.length - 1) {
    throw new InvalidArgumentError(
      'Targets must look like provider:model, for example openai:gpt-5.1.',
    );
  }
  const provider = value.slice(0, separator).trim();
  const model = value.slice(separator + 1).trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(provider)) {
    throw new InvalidArgumentError(`Invalid provider id: ${provider}`);
  }
  if (model.length === 0) {
    throw new InvalidArgumentError('The model id cannot be empty.');
  }
  return { provider, model };
}

export function collectArenaTarget(value: string, previous: ArenaTarget[]): ArenaTarget[] {
  return [...previous, parseArenaTarget(value)];
}

function formatBrainOutputs(status: BrainProjectStatus): string[] {
  if (status.outputs.length === 0) {
    return ['  (no generated outputs yet — run cockpit brain generate)'];
  }
  return status.outputs.map((output) => {
    const state = output.drifted
      ? 'drift — edit or run sync --force'
      : output.existsOnDisk
        ? output.syncedAt
          ? 'synced'
          : 'written, not marked synced'
        : 'generated, not written to disk';
    return `  ${BRAIN_FORMAT_LABELS[output.format].padEnd(22)} ${output.path} [${state}]`;
  });
}

export function formatBrainStatus(status: BrainProjectStatus): string {
  const unresolved = status.drift.filter((event) => event.resolvedAt === undefined);
  const lines = [
    `Project: ${status.project.name}`,
    `Root:    ${status.project.rootPath}`,
    `Sources: ${status.sources.length}`,
    '',
    'Outputs:',
    ...formatBrainOutputs(status),
  ];
  if (unresolved.length > 0) {
    lines.push('', `Unresolved drift events: ${unresolved.length}`);
  }
  return `${lines.join('\n')}\n`;
}

export async function runBrainStatus(
  client: DaemonClient,
  projectId: string,
  jsonOutput: boolean,
): Promise<string> {
  const status = await client.getBrainStatus(projectId);
  return jsonOutput ? json(status) : formatBrainStatus(status);
}

export async function runBrainGenerate(
  client: DaemonClient,
  projectId: string,
  formats: readonly BrainFormat[] | undefined,
  jsonOutput: boolean,
): Promise<string> {
  const status = await client.generateBrain(projectId, formats);
  return jsonOutput ? json(status) : formatBrainStatus(status);
}

export function formatBrainSync(result: BrainSyncResponse): string {
  const lines = result.results.map(
    (entry) =>
      `${entry.action.padEnd(10)} ${entry.path}${entry.message ? ` — ${entry.message}` : ''}`,
  );
  return `${[...lines, '', formatBrainStatus(result.status).trimEnd()].join('\n')}\n`;
}

export async function runBrainSync(
  client: DaemonClient,
  projectId: string,
  formats: readonly BrainFormat[] | undefined,
  options: { force: boolean; dryRun: boolean },
  jsonOutput: boolean,
): Promise<string> {
  const result = await client.syncBrain(projectId, {
    ...(formats ? { formats: [...formats] } : {}),
    force: options.force,
    dryRun: options.dryRun,
  });
  return jsonOutput ? json(result) : formatBrainSync(result);
}

function formatArenaRun(run: ArenaRun): string[] {
  const lines = [`${run.provider}/${run.model} — ${run.status}`, `  Run: ${run.id}`];
  if (run.latencyMs !== undefined) lines.push(`  Latency: ${run.latencyMs}ms`);
  lines.push(
    `  Tokens: ${run.inputTokens} in / ${run.outputTokens} out · cost: ${formatUsd(run.costUsd ?? null)}${run.costKnown ? '' : ' (unpriced)'}`,
  );
  if (run.baselineCostUsd !== undefined) {
    lines.push(
      `  Baseline: ${formatUsd(run.baselineCostUsd)}${run.savingsPercent === undefined ? '' : ` · savings: ${run.savingsPercent}%`}`,
    );
  }
  if (run.error) lines.push(`  Error: ${cap(run.error, 2000)}`);
  if (run.outputText) {
    lines.push(
      '',
      '  Output:',
      ...cap(run.outputText, 4000)
        .split('\n')
        .map((line) => `    ${line}`),
    );
  }
  if (run.diffText) {
    lines.push(
      '',
      '  Diff:',
      ...cap(run.diffText, 4000)
        .split('\n')
        .map((line) => `    ${line}`),
    );
  }
  return lines;
}

export function formatArenaRuns(runs: readonly ArenaRun[]): string {
  if (runs.length === 0) return 'No arena runs were recorded.\n';
  return `${runs.map((run) => formatArenaRun(run).join('\n')).join('\n\n')}\n`;
}

export async function runArenaRun(
  client: DaemonClient,
  sessionId: string,
  stepId: string,
  targets: readonly ArenaTarget[],
  jsonOutput: boolean,
): Promise<string> {
  if (targets.length === 0) {
    throw new InvalidArgumentError(
      'At least one --target provider:model is required, for example --target openai:gpt-5.1.',
    );
  }
  const runs = await client.runArena(sessionId, { stepId, targets: [...targets] });
  return jsonOutput ? json({ runs }) : formatArenaRuns(runs);
}

export async function runArenaList(
  client: DaemonClient,
  query: { sessionId?: string; stepId?: string; limit?: number },
  jsonOutput: boolean,
): Promise<string> {
  const runs = await client.listArenaRuns({
    ...(query.sessionId ? { sessionId: query.sessionId } : {}),
    ...(query.stepId ? { stepId: query.stepId } : {}),
    ...(query.limit !== undefined ? { limit: query.limit } : {}),
  });
  return jsonOutput ? json({ runs }) : formatArenaRuns(runs);
}

export async function runArenaShow(
  client: DaemonClient,
  runId: string,
  jsonOutput: boolean,
): Promise<string> {
  const run = await client.getArenaRun(runId);
  return jsonOutput ? json({ run }) : formatArenaRuns([run]);
}

export function formatHandoffList(briefs: readonly HandoffBrief[]): string {
  if (briefs.length === 0) return 'No handoff briefs were generated for this session.\n';
  return `${briefs
    .map((brief) => `${brief.id}  ${brief.generatedAt}  ${brief.title}`)
    .join('\n')}\n`;
}

export async function runHandoffGenerate(
  client: DaemonClient,
  sessionId: string,
  stepId: string | undefined,
  jsonOutput: boolean,
): Promise<string> {
  const brief = await client.generateHandoff(sessionId, stepId ? { stepId } : {});
  return jsonOutput ? json({ brief }) : brief.contentMarkdown;
}

export async function runHandoffList(
  client: DaemonClient,
  sessionId: string,
  jsonOutput: boolean,
): Promise<string> {
  const briefs = await client.listHandoffs(sessionId);
  return jsonOutput ? json({ briefs }) : formatHandoffList(briefs);
}

export async function runHandoffShow(
  client: DaemonClient,
  briefId: string,
  jsonOutput: boolean,
): Promise<string> {
  const brief = await client.getHandoff(briefId);
  return jsonOutput ? json({ brief }) : brief.contentMarkdown;
}

export function formatAnalytics(response: AnalyticsResponse): string {
  const lines = [
    `Cockpit analytics — ${response.range.days} day(s)`,
    `Range: ${response.range.from} → ${response.range.to}`,
    '',
    `Sessions:   ${response.totals.sessionCount}`,
    `Steps:      ${response.totals.stepCount}`,
    `Tool calls: ${response.totals.toolCallCount}`,
    `Tokens:     ${response.totals.inputTokens} in / ${response.totals.outputTokens} out`,
    `Cache:      ${response.totals.cacheReadTokens} read / ${response.totals.cacheWriteTokens} write`,
    `Cost:       ${formatUsd(response.totals.totalCostUsd)}${response.totals.unknownCostCalls > 0 ? ` (${response.totals.unknownCostCalls} unpriced calls)` : ''}`,
    `Errors:     ${response.totals.errorCount}`,
    '',
    'Daily:',
  ];

  for (const point of response.daily) {
    lines.push(
      `  ${point.date}  ${String(point.sessionCount).padStart(3)} session(s)  ${String(point.stepCount).padStart(5)} step(s)  ${formatUsd(point.totalCostUsd).padStart(9)}  ${point.errorCount} error(s)`,
    );
  }

  lines.push('', 'Models:');
  if (response.models.length === 0) {
    lines.push('  (none)');
  } else {
    for (const model of response.models) {
      const label = model.provider ? `${model.provider}/${model.model}` : model.model;
      lines.push(
        `  ${label} — ${model.sessionCount} session(s), ${model.stepCount} step(s), ${formatUsd(model.totalCostUsd)}`,
      );
    }
  }

  lines.push('', 'Agents:');
  if (response.agents.length === 0) {
    lines.push('  (none)');
  } else {
    for (const agent of response.agents) {
      lines.push(
        `  ${agent.agent} — ${agent.sessionCount} session(s), ${agent.stepCount} step(s), ${formatUsd(agent.totalCostUsd)}`,
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

export async function runAnalytics(
  client: DaemonClient,
  query: Partial<AnalyticsQuery>,
  jsonOutput: boolean,
): Promise<string> {
  const response = await client.getAnalytics(query);
  return jsonOutput ? json(response) : formatAnalytics(response);
}

export function formatJournalList(entries: readonly JournalEntry[]): string {
  if (entries.length === 0) return 'No journal entries yet. Run cockpit journal generate.\n';
  return `${entries
    .map((entry) => `${entry.weekStart}  ${entry.title} (${entry.id})`)
    .join('\n')}\n`;
}

export async function runJournalList(
  client: DaemonClient,
  query: { projectId?: string; limit?: number },
  jsonOutput: boolean,
): Promise<string> {
  const entries = await client.listJournal({
    ...(query.projectId ? { projectId: query.projectId } : {}),
    ...(query.limit !== undefined ? { limit: query.limit } : {}),
  });
  return jsonOutput ? json({ entries }) : formatJournalList(entries);
}

export async function runJournalGenerate(
  client: DaemonClient,
  input: { projectId?: string; weekStart?: string },
  jsonOutput: boolean,
): Promise<string> {
  const entry = await client.generateJournal({
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.weekStart ? { weekStart: input.weekStart } : {}),
  });
  return jsonOutput ? json({ entry }) : entry.markdown;
}

export async function runJournalShow(
  client: DaemonClient,
  entryId: string,
  jsonOutput: boolean,
): Promise<string> {
  const entry = await client.getJournalEntry(entryId);
  return jsonOutput ? json({ entry }) : entry.markdown;
}

function pluginKind(plugin: Plugin): string {
  const manifest = PluginManifestSchema.safeParse(plugin.manifest);
  return manifest.success ? manifest.data.kind : 'unknown';
}

export function formatPlugins(plugins: readonly Plugin[]): string {
  if (plugins.length === 0) {
    return 'No plugins are installed. Install one with cockpit plugins install <path>.\n';
  }
  return `${plugins
    .map(
      (plugin) =>
        `${plugin.enabled ? 'enabled ' : 'disabled'}  ${plugin.name}@${plugin.version}  [${pluginKind(plugin)}]  ${plugin.path}  (${plugin.id})`,
    )
    .join('\n')}\n`;
}

export async function runPluginsList(client: DaemonClient, jsonOutput: boolean): Promise<string> {
  const plugins = await client.listPlugins();
  return jsonOutput ? json({ plugins }) : formatPlugins(plugins);
}

export async function runPluginInstall(
  client: DaemonClient,
  pluginPath: string,
  jsonOutput: boolean,
): Promise<string> {
  const plugin = await client.installPlugin({ path: pluginPath });
  return jsonOutput
    ? json({ plugin })
    : `Installed ${plugin.name}@${plugin.version} (${plugin.id}).\n`;
}

export async function runPluginToggle(
  client: DaemonClient,
  pluginId: string,
  enabled: boolean,
  jsonOutput: boolean,
): Promise<string> {
  const plugin = await client.updatePlugin(pluginId, { enabled });
  return jsonOutput
    ? json({ plugin })
    : `${plugin.name} is now ${plugin.enabled ? 'enabled' : 'disabled'}.\n`;
}

export async function runPluginRemove(
  client: DaemonClient,
  pluginId: string,
  jsonOutput: boolean,
): Promise<string> {
  const removed = await client.removePlugin(pluginId);
  return jsonOutput ? json({ removed, id: pluginId }) : `Plugin ${pluginId} removed.\n`;
}

export function formatPluginRun(run: PluginRun): string {
  const lines = [`Plugin run ${run.id} — ${run.status}`];
  if (run.error) lines.push(`Error: ${cap(run.error, 4000)}`);
  if (run.result !== undefined) {
    lines.push('', cap(JSON.stringify(run.result, null, 2), 20_000));
  }
  return `${lines.join('\n')}\n`;
}

export async function runPluginRun(
  client: DaemonClient,
  pluginId: string,
  sessionId: string,
  stepId: string | undefined,
  jsonOutput: boolean,
): Promise<string> {
  const run = await client.runPlugin(pluginId, {
    sessionId,
    ...(stepId ? { stepId } : {}),
  });
  return jsonOutput ? json({ run }) : formatPluginRun(run);
}

export async function runPluginRuns(
  client: DaemonClient,
  pluginId: string,
  limit: number,
  jsonOutput: boolean,
): Promise<string> {
  const runs = await client.listPluginRuns(pluginId, limit);
  if (jsonOutput) return json({ runs });
  if (runs.length === 0) return 'No runs were recorded for this plugin.\n';
  return `${runs.map((run) => formatPluginRun(run).trimEnd()).join('\n\n')}\n`;
}

export async function runProjectsList(client: DaemonClient, jsonOutput: boolean): Promise<string> {
  const projects = await client.listProjects();
  if (jsonOutput) return json({ projects });
  if (projects.length === 0) {
    return 'No projects have been recorded yet. Run an agent through Cockpit first.\n';
  }
  return `${projects.map((project) => formatProjectLine(project)).join('\n')}\n`;
}
