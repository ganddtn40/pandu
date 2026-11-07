import type { CheatAnalysis } from '@cockpit/core';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { GuardsPage } from '../src/pages/GuardsPage';
import { TrustPage } from '../src/pages/TrustPage';
import {
  GUARD_EVENT_ID,
  SESSION_ID,
  makeBudgetPolicy,
  makeBudgetStatus,
  makeGuardEvent,
  makeGuardRule,
  renderPage,
  testClient,
} from './fixtures';

const ANALYSIS: CheatAnalysis = {
  sessionId: SESSION_ID,
  trustScore: 64,
  grade: 'D',
  filesExamined: 3,
  generatedAt: '2026-04-05T06:20:00.000Z',
  findings: [
    {
      id: GUARD_EVENT_ID,
      sessionId: SESSION_ID,
      category: 'deleted_test',
      severity: 'critical',
      title: 'Test file deleted: tests/auth.test.ts',
      detail: 'A test file was removed in this step.',
      detector: 'deleted-test',
      confidence: 1,
      evidence: [
        {
          filePath: 'tests/auth.test.ts',
          startLine: 1,
          excerpt: 'File deleted.',
          explanation: 'The snapshot reports this test file as deleted.',
        },
      ],
      suggestion: 'Restore the test file.',
      createdAt: '2026-04-05T06:20:00.000Z',
    },
  ],
};

function renderGuards(client = testClient()) {
  return renderPage(<GuardsPage />, { client, path: '/guards', route: '/guards' });
}

describe('guards page', () => {
  it('shows pending approvals, rules, events, and budgets', async () => {
    const client = testClient({
      listGuardRules: async () => [makeGuardRule()],
      listGuardEvents: async () => [
        makeGuardEvent(),
        makeGuardEvent({
          id: '22222222-2222-4222-8222-222222222222',
          status: 'warned',
          action: 'warn',
          severity: 'medium',
          title: 'API key in prompt',
          requestedAt: '2026-04-05T06:10:00.000Z',
        }),
      ],
      listBudgetPolicies: async () => [makeBudgetPolicy()],
    });

    renderGuards(client);

    expect(await screen.findByText('Dangerous command requested')).toBeInTheDocument();
    expect(screen.getByText('API key in prompt')).toBeInTheDocument();
    expect(screen.getByText('Dangerous shell command')).toBeInTheDocument();
    expect(screen.getByText('Monthly lab budget')).toBeInTheDocument();
    expect(screen.getByText('Approve')).toBeInTheDocument();
  });

  it('resolves a pending approval through the API', async () => {
    const decideGuardEvent = vi.fn(async () =>
      makeGuardEvent({ status: 'approved', resolvedBy: 'dashboard' }),
    );
    const client = testClient({ decideGuardEvent });

    renderGuards(client);
    await screen.findByText('Dangerous command requested');
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      expect(decideGuardEvent).toHaveBeenCalledWith(GUARD_EVENT_ID, {
        decision: 'approve',
        channel: 'dashboard',
      });
    });
    expect(await screen.findByText('Nothing is waiting')).toBeInTheDocument();
  });

  it('toggles rules and removes budgets', async () => {
    const updateGuardRule = vi.fn(async () => makeGuardRule({ enabled: false }));
    const deleteBudgetPolicy = vi.fn(async () => true);
    const client = testClient({ updateGuardRule, deleteBudgetPolicy });

    renderGuards(client);
    await screen.findByText('Dangerous shell command');

    await userEvent.click(screen.getByRole('button', { name: 'Disable' }));
    await waitFor(() => {
      expect(updateGuardRule).toHaveBeenCalledWith('builtin-dangerous-command', { enabled: false });
    });
    expect(await screen.findByRole('button', { name: 'Enable' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => {
      expect(deleteBudgetPolicy).toHaveBeenCalledWith('44444444-4444-4444-8444-444444444444');
    });
    expect(await screen.findByText('No budgets configured')).toBeInTheDocument();
  });
});

describe('trust page', () => {
  it('renders the score, findings, and budget status', async () => {
    const client = testClient({
      getTrust: async () => ({ analysis: ANALYSIS }),
      getSessionBudgets: async () => [
        makeBudgetStatus({ spentUsd: 24, remainingUsd: 1, usageRatio: 0.96, exceeded: true }),
      ],
    });

    renderPage(<TrustPage />, {
      client,
      path: '/sessions/:id/trust',
      route: `/sessions/${SESSION_ID}/trust`,
    });

    expect(await screen.findByText('64')).toBeInTheDocument();
    expect(screen.getByText('Grade D')).toBeInTheDocument();
    expect(screen.getByText('Test file deleted: tests/auth.test.ts')).toBeInTheDocument();
    expect(screen.getByText('tests/auth.test.ts:1')).toBeInTheDocument();
    expect(screen.getByText('Monthly lab budget')).toBeInTheDocument();
    expect(screen.getByText('exceeded')).toBeInTheDocument();
  });

  it('recomputes trust and scans for secrets', async () => {
    const analyzeTrust = vi.fn(async () => ({ analysis: ANALYSIS }));
    const scanSession = vi.fn(async () => ({
      sessionId: SESSION_ID,
      scannedAt: '2026-04-05T06:25:00.000Z',
      findings: [],
      events: [],
      filesExamined: 2,
    }));
    const client = testClient({ analyzeTrust, scanSession });

    renderPage(<TrustPage />, {
      client,
      path: '/sessions/:id/trust',
      route: `/sessions/${SESSION_ID}/trust`,
    });

    await screen.findByText('No analysis yet');
    await userEvent.click(screen.getByRole('button', { name: 'Re-analyze' }));
    await waitFor(() => expect(analyzeTrust).toHaveBeenCalledWith(SESSION_ID));
    expect(await screen.findByText('64')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Scan for secrets' }));
    await waitFor(() => expect(scanSession).toHaveBeenCalledWith(SESSION_ID));
    expect(await screen.findByText('Clean scan')).toBeInTheDocument();
  });
});
