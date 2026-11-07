import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionSchema } from '@cockpit/core';

import {
  agentLabelForCommand,
  buildRunSessionInput,
  defaultSessionTitle,
  formatSessionSummary,
} from '../src/run.js';
import { dashboardUrl } from '../src/config.js';

const directories: string[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'cockpit-cli-run-'));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

describe('dashboard URLs', () => {
  it('points at the app root or a session workbench', () => {
    expect(dashboardUrl('http://127.0.0.1:4317')).toBe('http://127.0.0.1:4317/');
    expect(dashboardUrl('http://127.0.0.1:4317/')).toBe('http://127.0.0.1:4317/');
    expect(dashboardUrl('http://127.0.0.1:4317', 'session-1')).toBe(
      'http://127.0.0.1:4317/sessions/session-1',
    );
    expect(dashboardUrl('http://127.0.0.1:4317', 'a b')).toBe(
      'http://127.0.0.1:4317/sessions/a%20b',
    );
  });
});

describe('run helpers', () => {
  it('maps known agent executables to friendly labels', () => {
    expect(agentLabelForCommand('opencode')).toBe('OpenCode');
    expect(agentLabelForCommand('opencode.exe')).toBe('OpenCode');
    expect(agentLabelForCommand('claude-code')).toBe('Claude Code');
    expect(agentLabelForCommand('codex')).toBe('Codex');
    expect(agentLabelForCommand('some-custom-agent')).toBe('some-custom-agent');
  });

  it('builds a deterministic default title', () => {
    expect(defaultSessionTitle('OpenCode', new Date('2026-02-03T04:05:06.000Z'))).toBe(
      'OpenCode · 2026-02-03 04:05',
    );
  });

  it('builds a manual session input tagged for the CLI', () => {
    const directory = tempDirectory();
    const input = buildRunSessionInput({
      command: ['opencode', '--model', 'test'],
      workspacePath: directory,
      title: 'Fix the build',
      now: new Date('2026-02-03T04:05:06.000Z'),
    });

    expect(input.title).toBe('Fix the build');
    expect(input.source).toBe('manual');
    expect(input.tags).toEqual(['cli']);
    expect(input.agent).toEqual({ name: 'OpenCode', detectedFrom: 'wrapper' });
    expect(input.workspacePath).toBe(directory);
    expect(input.gitBranch).toBeUndefined();
    expect(input.gitBaseCommit).toBeUndefined();
  });

  it('requires an executable', () => {
    expect(() => buildRunSessionInput({ command: [], workspacePath: tempDirectory() })).toThrow(
      'A command is required',
    );
  });

  it('formats a session summary including unknown costs and model', () => {
    const session = SessionSchema.parse({
      id: '55555555-5555-4555-8555-555555555555',
      title: 'Summary test',
      source: 'manual',
      status: 'completed',
      modelRef: { provider: 'openai', protocol: 'openai', model: 'gpt-4o-mini' },
      startedAt: '2026-02-03T04:05:06.000Z',
      totals: {
        stepCount: 1234,
        toolCallCount: 7,
        inputTokens: 1000,
        outputTokens: 250,
        totalCostUsd: 0.0123,
        unknownCostCalls: 2,
      },
      tags: [],
    });

    const summary = formatSessionSummary(session, 'http://127.0.0.1:4317');
    expect(summary).toContain('Cockpit session 55555555-5555-4555-8555-555555555555');
    expect(summary).toContain('1,234 steps');
    expect(summary).toContain('7 tool calls');
    expect(summary).toContain('1,000 in / 250 out');
    expect(summary).toContain('$0.0123 (2 unpriced)');
    expect(summary).toContain('model  gpt-4o-mini');
    expect(summary).toContain(
      'review http://127.0.0.1:4317/sessions/55555555-5555-4555-8555-555555555555',
    );
  });
});
