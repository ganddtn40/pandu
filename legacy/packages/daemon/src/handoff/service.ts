import {
  formatUsd,
  type CapturedStep,
  type HandoffBrief,
  type HandoffGenerateInput,
  type Session,
} from '@cockpit/core';

import type { Logger } from '../logger.js';
import type { Store } from '../store/store.js';

export class HandoffServiceError extends Error {
  readonly status: number;
  readonly code: 'bad_request' | 'not_found';

  constructor(status: number, code: HandoffServiceError['code'], message: string) {
    super(message);
    this.name = 'HandoffServiceError';
    this.status = status;
    this.code = code;
  }
}

export interface HandoffServiceOptions {
  store: Store;
  logger: Logger;
}

function truncate(value: string, maximum: number): string {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  return singleLine.length > maximum ? `${singleLine.slice(0, maximum - 1)}…` : singleLine;
}

function fence(value: string): string {
  return value.includes('```') ? '~~~' : '```';
}

function stepLabel(step: CapturedStep): string {
  if (step.kind === 'model') return `model ${step.model ?? step.provider ?? 'call'}`;
  if (step.kind === 'tool') return 'tool';
  return step.kind;
}

export class HandoffService {
  readonly #store: Store;
  readonly #logger: Logger;

  constructor(options: HandoffServiceOptions) {
    this.#store = options.store;
    this.#logger = options.logger;
  }

  list(sessionId: string): HandoffBrief[] {
    return this.#store.listHandoffBriefs(sessionId);
  }

  get(id: string): HandoffBrief | undefined {
    return this.#store.getHandoffBrief(id);
  }

  generate(sessionId: string, input: HandoffGenerateInput): HandoffBrief {
    const session = this.#store.getSession(sessionId);
    if (!session) {
      throw new HandoffServiceError(404, 'not_found', 'The requested session was not found.');
    }

    let steps = this.#store.listSteps(sessionId, 2000);
    if (input.stepId) {
      const target = this.#store.getStep(input.stepId);
      if (!target || target.sessionId !== sessionId) {
        throw new HandoffServiceError(404, 'not_found', 'The requested step was not found.');
      }
      steps = steps.filter((step) => step.seq <= target.seq);
    }

    const title = `Handoff — ${session.title}`.slice(0, 300);
    const markdown = this.#render(session, steps);
    const brief = this.#store.insertHandoffBrief({
      sessionId,
      title,
      contentMarkdown: markdown,
    });

    this.#logger.debug('Generated a handoff brief', { sessionId, briefId: brief.id });
    return brief;
  }

  #render(session: Session, steps: readonly CapturedStep[]): string {
    const lines: string[] = [];
    const lastPrompt = [...steps].reverse().find((step) => step.request?.promptText)
      ?.request?.promptText;

    lines.push(`# ${`Handoff — ${session.title}`.slice(0, 300)}`, '');

    lines.push('## Objective', '');
    lines.push(
      lastPrompt
        ? truncate(lastPrompt, 1200)
        : 'No user prompt was captured for this session. Read the steps below for context.',
      '',
    );

    lines.push('## Session', '');
    lines.push(`- Status: ${session.status}`);
    lines.push(`- Started: ${session.startedAt}`);
    if (session.endedAt) lines.push(`- Ended: ${session.endedAt}`);
    if (session.agent?.name) lines.push(`- Agent: ${session.agent.name}`);
    if (session.modelRef?.model) lines.push(`- Model: ${session.modelRef.model}`);
    if (session.workspacePath) lines.push(`- Workspace: \`${session.workspacePath}\``);
    if (session.gitBranch) lines.push(`- Branch: \`${session.gitBranch}\``);
    if (session.gitBaseCommit) lines.push(`- Base commit: \`${session.gitBaseCommit}\``);
    lines.push(
      `- Steps: ${session.totals.stepCount} · tool calls: ${session.totals.toolCallCount} · cost: ${formatUsd(session.totals.totalCostUsd)}`,
    );
    if (session.totals.unknownCostCalls > 0) {
      lines.push(`- Unpriced calls: ${session.totals.unknownCostCalls}`);
    }
    lines.push('');

    lines.push('## What happened', '');
    if (steps.length === 0) {
      lines.push('No steps were recorded.', '');
    } else {
      for (const step of steps.slice(-40)) {
        const when = step.endedAt ?? step.startedAt;
        lines.push(`### ${step.seq}. ${stepLabel(step)} — ${step.status} (${when})`);
        if (step.request?.promptText) {
          lines.push('', `> ${truncate(step.request.promptText, 500)}`);
        }
        if (step.response?.text) {
          lines.push(
            '',
            fence(step.response.text),
            truncate(step.response.text, 1200),
            fence(step.response.text),
          );
        }
        if (step.error) {
          lines.push('', `Error: ${truncate(step.error, 500)}`);
        }
        const toolCalls = this.#store.listToolCalls(step.id);
        if (toolCalls.length > 0) {
          lines.push('');
          for (const call of toolCalls) {
            const paths = call.filePaths.length > 0 ? ` — ${call.filePaths.join(', ')}` : '';
            lines.push(`- Tool \`${call.name}\` — ${call.status}${paths}`);
          }
        }
        lines.push('');
      }
    }

    const latestSnapshot = this.#store.latestSnapshot(session.id);
    const changes = latestSnapshot ? this.#store.listSnapshotFileChanges(latestSnapshot.id) : [];
    lines.push('## Files changed', '');
    if (changes.length === 0) {
      lines.push('No file changes were captured.', '');
    } else {
      for (const change of changes) {
        lines.push(
          `- \`${change.path}\` — ${change.changeType} (+${change.additions}/-${change.deletions})`,
        );
      }
      lines.push('');
    }

    const understanding = this.#store.listUnderstandingFiles({
      sessionId: session.id,
      limit: 200,
      ...(session.projectId ? { projectId: session.projectId } : {}),
    });
    const debt = understanding
      .map((file) => ({
        ...file,
        unreviewedLines: Math.max(0, file.aiLines - file.reviewedLines),
      }))
      .filter((file) => file.unreviewedLines > 0)
      .sort((a, b) => b.unreviewedLines - a.unreviewedLines || a.path.localeCompare(b.path));

    lines.push('## Review debt', '');
    if (debt.length === 0) {
      lines.push('No unreviewed AI-written lines were recorded for this session.', '');
    } else {
      for (const file of debt.slice(0, 20)) {
        lines.push(
          `- \`${file.path}\` — ${file.unreviewedLines} unreviewed line(s) of ${file.aiLines} AI line(s) (${file.status})`,
        );
      }
      lines.push('');
    }

    const guardEvents = this.#store
      .listGuardEvents({ sessionId: session.id, limit: 200 })
      .filter((event) => event.action !== 'allow');
    lines.push('## Guard findings', '');
    if (guardEvents.length === 0) {
      lines.push('No guard findings were recorded.', '');
    } else {
      for (const event of guardEvents.slice(0, 20)) {
        lines.push(
          `- [${event.severity}] ${event.title} — ${event.action}/${event.status}${event.resolvedBy ? ` by ${event.resolvedBy}` : ''}`,
        );
      }
      lines.push('');
    }

    const trust = this.#store.getLatestCheatAnalysis(session.id);
    if (trust) {
      lines.push('## Trust', '');
      lines.push(`- Score: ${trust.trustScore}/100 (${trust.grade})`);
      lines.push(`- Findings: ${trust.findings.length}`);
      for (const finding of trust.findings.slice(0, 10)) {
        lines.push(`- [${finding.severity}] ${finding.title}`);
      }
      lines.push('');
    }

    const context = this.#store.getLatestContextSnapshot(session.id);
    if (context) {
      lines.push('## Context', '');
      lines.push(`- Last measured context: ${context.totalTokens} tokens`);
      if (context.contextWindow) {
        lines.push(`- Context window: ${context.contextWindow} tokens`);
      }
      lines.push('');
    }

    lines.push('## Resume', '');
    if (session.workspacePath) {
      lines.push(
        `1. Open \`${session.workspacePath}\`${session.gitBranch ? ` on \`${session.gitBranch}\`` : ''}.`,
      );
    } else {
      lines.push('1. Open the original workspace.');
    }
    lines.push('2. Read the changed files above before trusting the previous agent.');
    lines.push('3. Start a fresh session with `cockpit run -- <agent command>`.');
    lines.push(
      `4. Continue from: ${lastPrompt ? truncate(lastPrompt, 400) : 'the last recorded step.'}`,
    );
    lines.push('');

    return lines.join('\n');
  }
}
