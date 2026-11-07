import {
  GuardEventListQuerySchema,
  type BudgetPolicy,
  type BudgetStatus,
  type CheatAnalysis,
  type GuardEvent,
  type GuardRule,
  type SecretScanResponse,
} from '@cockpit/core';

import type { DaemonClient } from './daemon-client.js';

function pad(value: string, width: number): string {
  return value.length >= width ? value : value.padEnd(width);
}

function truncate(value: string, maximum: number): string {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  return singleLine.length > maximum ? `${singleLine.slice(0, maximum - 1)}…` : singleLine;
}

export function formatGuardRules(rules: readonly GuardRule[]): string {
  if (rules.length === 0) return 'No guard rules are installed.\n';
  const lines = [
    `${pad('ID', 34)} ${pad('ACTION', 7)} ${pad('SEVERITY', 8)} ${pad('STATE', 6)} NAME`,
  ];
  for (const rule of rules) {
    lines.push(
      `${pad(rule.id, 34)} ${pad(rule.action, 7)} ${pad(rule.severity, 8)} ${pad(rule.enabled ? 'on' : 'off', 6)} ${rule.name}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export function formatGuardEvents(events: readonly GuardEvent[]): string {
  if (events.length === 0) return 'No guard events recorded.\n';
  const lines = [
    `${pad('ID', 36)} ${pad('STATUS', 8)} ${pad('ACTION', 7)} ${pad('SEVERITY', 8)} TITLE`,
  ];
  for (const event of events) {
    lines.push(
      `${pad(event.id, 36)} ${pad(event.status, 8)} ${pad(event.action, 7)} ${pad(event.severity, 8)} ${truncate(event.title, 80)}`,
    );
    if (event.resolutionNote) {
      lines.push(`${' '.repeat(36)} note: ${truncate(event.resolutionNote, 120)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function formatBudgetPolicies(policies: readonly BudgetPolicy[]): string {
  if (policies.length === 0) return 'No budget policies configured.\n';
  const lines = [
    `${pad('ID', 36)} ${pad('SCOPE', 8)} ${pad('PERIOD', 7)} ${pad('LIMIT', 10)} ${pad('ENFORCE', 7)} ${pad('STATE', 5)} NAME`,
  ];
  for (const policy of policies) {
    const target = policy.scope === 'session' ? policy.sessionId : policy.projectId;
    lines.push(
      `${pad(policy.id, 36)} ${pad(policy.scope, 8)} ${pad(policy.period, 7)} ${pad(`$${policy.limitUsd.toFixed(2)}`, 10)} ${pad(policy.enforcement, 7)} ${pad(policy.enabled ? 'on' : 'off', 5)} ${policy.name}${target ? ` (${target})` : ''}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export function formatBudgetStatuses(statuses: readonly BudgetStatus[]): string {
  if (statuses.length === 0) return 'No budget policies apply to this session.\n';
  const lines = [
    `${pad('NAME', 24)} ${pad('SPENT', 10)} ${pad('LIMIT', 10)} ${pad('USED', 6)} ${pad('STATE', 8)} PERIOD`,
  ];
  for (const status of statuses) {
    const state = status.exceeded ? 'exceeded' : status.warning ? 'warning' : 'ok';
    lines.push(
      `${pad(truncate(status.name, 24), 24)} ${pad(`$${status.spentUsd.toFixed(4)}`, 10)} ${pad(`$${status.limitUsd.toFixed(4)}`, 10)} ${pad(`${Math.round(status.usageRatio * 100)}%`, 6)} ${pad(state, 8)} ${status.period} (since ${status.periodStart})`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export function formatTrust(analysis: CheatAnalysis | null): string {
  if (!analysis) {
    return 'No trust analysis is available yet. Run `cockpit trust <session> --recompute`.\n';
  }

  const lines = [
    `Trust score: ${analysis.trustScore}/100 (grade ${analysis.grade})`,
    `Findings: ${analysis.findings.length} across ${analysis.filesExamined} changed file(s)`,
    `Generated: ${analysis.generatedAt}`,
  ];

  for (const finding of analysis.findings) {
    lines.push('');
    lines.push(`[${finding.severity.toUpperCase()}] ${finding.title}`);
    lines.push(`  category: ${finding.category}  confidence: ${finding.confidence}`);
    lines.push(`  ${finding.detail}`);
    for (const evidence of finding.evidence.slice(0, 3)) {
      lines.push(
        `  ${evidence.filePath}${evidence.startLine ? `:${evidence.startLine}` : ''} — ${truncate(evidence.excerpt, 120)}`,
      );
    }
    if (finding.suggestion) lines.push(`  fix: ${finding.suggestion}`);
  }

  return `${lines.join('\n')}\n`;
}

export function formatSecretScan(result: SecretScanResponse): string {
  if (result.findings.length === 0) {
    return `No secrets found in session ${result.sessionId} (${result.filesExamined} step(s) scanned).\n`;
  }
  const lines = [
    `Secret scan for ${result.sessionId}: ${result.findings.length} finding(s) in ${result.filesExamined} step(s)`,
  ];
  for (const finding of result.findings) {
    lines.push(
      `  [${finding.action}] ${finding.type} (${finding.location}, ${Math.round(finding.confidence * 100)}%): ${finding.preview}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export async function runGuardList(client: DaemonClient, json: boolean): Promise<string> {
  const rules = await client.listGuardRules();
  return json ? `${JSON.stringify({ rules }, null, 2)}\n` : formatGuardRules(rules);
}

export async function runGuardEvents(
  client: DaemonClient,
  query: Record<string, unknown>,
  json: boolean,
): Promise<string> {
  const parsed = GuardEventListQuerySchema.parse(query);
  const events = await client.listGuardEvents(parsed);
  return json ? `${JSON.stringify({ events }, null, 2)}\n` : formatGuardEvents(events);
}

export async function runGuardDecision(
  client: DaemonClient,
  eventId: string,
  decision: 'approve' | 'deny',
  note: string | undefined,
  json: boolean,
): Promise<string> {
  const event = await client.decideGuardEvent(eventId, {
    decision,
    channel: 'cli',
    ...(note ? { note } : {}),
  });
  return json
    ? `${JSON.stringify({ event }, null, 2)}\n`
    : `Guard event ${event.id} is now ${event.status}.\n`;
}

export async function runGuardScan(
  client: DaemonClient,
  sessionId: string,
  json: boolean,
): Promise<string> {
  const result = await client.scanSession(sessionId);
  return json ? `${JSON.stringify(result, null, 2)}\n` : formatSecretScan(result);
}

export async function runTrust(
  client: DaemonClient,
  sessionId: string,
  recompute: boolean,
  json: boolean,
): Promise<string> {
  const response = recompute
    ? await client.analyzeTrust(sessionId)
    : await client.getTrust(sessionId);
  return json ? `${JSON.stringify(response, null, 2)}\n` : formatTrust(response.analysis);
}

export async function runBudgetList(client: DaemonClient, json: boolean): Promise<string> {
  const policies = await client.listBudgetPolicies();
  return json ? `${JSON.stringify({ policies }, null, 2)}\n` : formatBudgetPolicies(policies);
}

export async function runBudgetStatus(
  client: DaemonClient,
  sessionId: string,
  json: boolean,
): Promise<string> {
  const statuses = await client.sessionBudgets(sessionId);
  return json ? `${JSON.stringify({ statuses }, null, 2)}\n` : formatBudgetStatuses(statuses);
}
