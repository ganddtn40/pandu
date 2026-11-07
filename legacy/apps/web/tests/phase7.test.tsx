import type { AnalyticsQuery } from '@cockpit/core';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { AnalyticsPage } from '../src/pages/AnalyticsPage';
import { ArenaPage } from '../src/pages/ArenaPage';
import { BrainPage } from '../src/pages/BrainPage';
import { HandoffPage } from '../src/pages/HandoffPage';
import { JournalPage } from '../src/pages/JournalPage';
import { PluginsPage } from '../src/pages/PluginsPage';
import {
  PROJECT_ID,
  SESSION_ID,
  STEP_ONE_ID,
  makeAnalytics,
  makeArenaRun,
  makeBrainStatus,
  makeHandoffBrief,
  makeJournalEntry,
  makePlugin,
  makePluginRun,
  makeProject,
  makeSession,
  makeStep,
  renderPage,
  testClient,
} from './fixtures';

function sessionClient(overrides: Parameters<typeof testClient>[0] = {}) {
  return testClient({
    listSessions: async () => ({ sessions: [makeSession()], nextCursor: null }),
    getSessionSteps: async () => ({ steps: [makeStep()] }),
    ...overrides,
  });
}

describe('AnalyticsPage', () => {
  it('renders totals, daily buckets, models, and agents from the local ledger', async () => {
    renderPage(<AnalyticsPage />);

    const totals = await screen.findByLabelText('Analytics totals');
    expect(within(totals).getByText('Sessions')).toBeInTheDocument();
    expect(within(totals).getByText('2')).toBeInTheDocument();
    expect(within(totals).getByText('8')).toBeInTheDocument();
    expect(within(totals).getByText('2 unpriced')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Steps and spend per UTC day' })).toBeInTheDocument();
    expect(screen.getByText('openai/gpt-4.1')).toBeInTheDocument();
    expect(screen.getByText('opencode')).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: '2026-04-04' })).toBeInTheDocument();
    expect(screen.getByText('UTC buckets')).toBeInTheDocument();
  });

  it('re-queries when the window or project changes', async () => {
    const user = userEvent.setup();
    const getAnalytics = vi.fn(async (query?: Partial<AnalyticsQuery>) =>
      makeAnalytics({
        range: {
          ...makeAnalytics().range,
          days: query?.days ?? 30,
        },
      }),
    );
    renderPage(<AnalyticsPage />, { client: testClient({ getAnalytics }) });

    await screen.findByLabelText('Analytics totals');
    expect(getAnalytics).toHaveBeenCalledWith(
      { days: 30 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    await user.selectOptions(screen.getByLabelText('Analytics window in days'), '7');
    await waitFor(() =>
      expect(getAnalytics).toHaveBeenCalledWith(
        { days: 7 },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );

    await user.selectOptions(screen.getByLabelText('Filter analytics by project'), PROJECT_ID);
    await waitFor(() =>
      expect(getAnalytics).toHaveBeenCalledWith(
        { days: 7, projectId: PROJECT_ID },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
  });
});

describe('BrainPage', () => {
  function brainClient() {
    return testClient({
      listProjects: async () => [makeProject()],
      getBrainStatus: async () => makeBrainStatus(),
      generateBrain: vi.fn(async () => makeBrainStatus()),
      syncBrain: vi.fn(async () => ({
        results: [
          {
            format: 'agents_md' as const,
            path: 'AGENTS.md',
            action: 'written' as const,
            message: 'Wrote 120 bytes.',
          },
        ],
        status: makeBrainStatus(),
      })),
    });
  }

  it('auto-selects the first project and explains empty outputs', async () => {
    renderPage(<BrainPage />, { client: brainClient() });

    expect(await screen.findByRole('heading', { name: 'Project Brain' })).toBeInTheDocument();
    expect(screen.getByLabelText('Project to generate a brain for')).toHaveValue(PROJECT_ID);
    expect(await screen.findByText('No outputs yet')).toBeInTheDocument();
    expect(screen.getByText('No sources read')).toBeInTheDocument();
    expect(screen.getByText('No drift recorded')).toBeInTheDocument();
    expect(screen.getByText('Deterministic generation')).toBeInTheDocument();
  });

  it('generates formats, dry-runs sync, and forces a write when asked', async () => {
    const user = userEvent.setup();
    const client = brainClient();
    renderPage(<BrainPage />, { client });

    await screen.findByText('No outputs yet');
    const generate = screen.getByRole('button', { name: 'Generate' });
    await user.click(generate);
    expect(client.generateBrain).toHaveBeenCalledWith(PROJECT_ID, [
      'agents_md',
      'claude_md',
      'cursorrules',
      'gemini_md',
      'copilot_instructions',
    ]);

    await user.click(screen.getByRole('button', { name: 'Dry run' }));
    expect(client.syncBrain).toHaveBeenCalledWith(PROJECT_ID, {
      formats: ['agents_md', 'claude_md', 'cursorrules', 'gemini_md', 'copilot_instructions'],
      force: false,
      dryRun: true,
    });
    expect(await screen.findByText('Wrote 120 bytes.')).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: /Overwrite drifted files/ }));
    await user.click(screen.getByRole('button', { name: 'Write to disk' }));
    expect(client.syncBrain).toHaveBeenLastCalledWith(PROJECT_ID, {
      formats: ['agents_md', 'claude_md', 'cursorrules', 'gemini_md', 'copilot_instructions'],
      force: true,
      dryRun: false,
    });
  });

  it('renders generated outputs, sync state, and drift events', async () => {
    const user = userEvent.setup();
    const outputId = 'abababab-abab-4bab-8bab-abababababab';
    const driftId = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
    const status = makeBrainStatus({
      sources: [
        {
          id: outputId,
          path: 'README.md',
          checksum: 'a'.repeat(64),
          updatedAt: '2026-04-05T06:00:00.000Z',
        },
      ],
      outputs: [
        {
          id: outputId,
          projectId: PROJECT_ID,
          format: 'agents_md',
          path: 'AGENTS.md',
          content: '# Agent Instructions\n',
          checksum: 'a'.repeat(64),
          sourceChecksum: 'a'.repeat(64),
          syncedAt: '2026-04-05T06:00:00.000Z',
          driftDetected: false,
          existsOnDisk: true,
          drifted: false,
          createdAt: '2026-04-05T06:00:00.000Z',
          updatedAt: '2026-04-05T06:00:00.000Z',
        },
        {
          id: driftId,
          projectId: PROJECT_ID,
          format: 'claude_md',
          path: 'CLAUDE.md',
          content: '# Claude Instructions\n',
          checksum: 'a'.repeat(64),
          sourceChecksum: 'a'.repeat(64),
          driftDetected: true,
          existsOnDisk: true,
          diskChecksum: 'b'.repeat(64),
          drifted: true,
          createdAt: '2026-04-05T06:00:00.000Z',
          updatedAt: '2026-04-05T06:00:00.000Z',
        },
      ],
      drift: [
        {
          id: driftId,
          projectId: PROJECT_ID,
          outputId: driftId,
          expectedChecksum: 'a'.repeat(64),
          actualChecksum: 'b'.repeat(64),
          detectedAt: '2026-04-05T06:00:00.000Z',
        },
      ],
    });
    renderPage(<BrainPage />, {
      client: testClient({
        listProjects: async () => [makeProject()],
        getBrainStatus: async () => status,
      }),
    });

    expect(await screen.findByText('Present on disk')).toBeInTheDocument();
    expect(screen.getByText('synced')).toBeInTheDocument();
    expect(screen.getByText('drift')).toBeInTheDocument();
    expect(screen.getByText('README.md')).toBeInTheDocument();
    expect(screen.getByText('Unresolved drift')).toBeInTheDocument();
    expect(screen.getByText(/expected aaaaaaaaaa · actual bbbbbbbbbb/)).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: /CLAUDE\.md/ }));
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    expect(screen.getByText('4 formats')).toBeInTheDocument();
  });

  it('shows the empty state when no project has been recorded', async () => {
    renderPage(<BrainPage />, {
      client: testClient({ listProjects: async () => [] }),
    });

    expect(await screen.findByText('No projects recorded')).toBeInTheDocument();
    expect(screen.getByText(/Run an agent through Cockpit once/)).toBeInTheDocument();
  });
});

describe('ArenaPage', () => {
  it('replays a recorded step against provider:model targets', async () => {
    const user = userEvent.setup();
    const runArena = vi.fn(async () => [makeArenaRun()]);
    renderPage(<ArenaPage />, { client: sessionClient({ runArena }) });

    await screen.findByRole('option', { name: 'Fix flaky auth test' });
    await user.selectOptions(screen.getByLabelText('Source session'), SESSION_ID);
    await user.selectOptions(screen.getByLabelText('Source step'), STEP_ONE_ID);

    expect(await screen.findByText(/gpt-4.1-mini · 1,200 in \/ 340 out/)).toBeInTheDocument();

    const target = screen.getByPlaceholderText('openai:gpt-5.1');
    await user.type(target, 'openai:gpt-5.1');
    await user.click(screen.getByRole('button', { name: 'Run comparison' }));

    expect(runArena).toHaveBeenCalledWith(SESSION_ID, {
      stepId: STEP_ONE_ID,
      targets: [{ provider: 'openai', model: 'gpt-5.1' }],
    });
    expect(await screen.findByRole('heading', { name: 'Latest comparison' })).toBeInTheDocument();
    expect(screen.getAllByText('openai/gpt-5.1').length).toBeGreaterThan(0);
  });

  it('rejects malformed targets before calling the daemon', async () => {
    const user = userEvent.setup();
    const runArena = vi.fn(async () => [makeArenaRun()]);
    renderPage(<ArenaPage />, { client: sessionClient({ runArena }) });

    await screen.findByRole('option', { name: 'Fix flaky auth test' });
    await user.selectOptions(screen.getByLabelText('Source session'), SESSION_ID);
    await user.selectOptions(screen.getByLabelText('Source step'), STEP_ONE_ID);
    await user.type(screen.getByPlaceholderText('openai:gpt-5.1'), 'gpt-5.1');
    await user.click(screen.getByRole('button', { name: 'Run comparison' }));

    expect(await screen.findByText(/is not a provider:model target/)).toBeInTheDocument();
    expect(runArena).not.toHaveBeenCalled();
  });

  it('renders run history with cost, latency, and output details', async () => {
    renderPage(<ArenaPage />, {
      client: sessionClient({
        listArenaRuns: async () => [
          makeArenaRun({
            status: 'failed',
            error: 'Upstream rejected the request.',
            costKnown: false,
            costUsd: undefined,
          }),
        ],
      }),
    });

    expect(await screen.findByText('openai/gpt-5.1')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('unpriced')).toBeInTheDocument();
    expect(screen.getByText('Upstream rejected the request.')).toBeInTheDocument();
    expect(screen.getByText('Output and diff')).toBeInTheDocument();
    expect(screen.getByText('1.2s')).toBeInTheDocument();
  });

  it('shows the empty history state', async () => {
    renderPage(<ArenaPage />, {
      client: sessionClient({ listArenaRuns: async () => [] }),
    });

    expect(await screen.findByText('No arena runs yet')).toBeInTheDocument();
  });
});

describe('JournalPage', () => {
  it('renders the latest week and regenerates the selected project and week', async () => {
    const user = userEvent.setup();
    const generateJournal = vi.fn(async () => makeJournalEntry());
    renderPage(<JournalPage />, {
      client: testClient({
        listProjects: async () => [makeProject()],
        generateJournal,
      }),
    });

    expect(await screen.findByRole('heading', { name: 'Week of 2026-03-30' })).toBeInTheDocument();
    expect(screen.getByText(/Shipped auth hardening/)).toBeInTheDocument();
    expect(screen.getByText('2026-03-30')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Journal project filter'), PROJECT_ID);
    await waitFor(() =>
      expect(screen.getByLabelText('Journal project filter')).toHaveValue(PROJECT_ID),
    );

    await user.click(screen.getByRole('button', { name: 'Generate week' }));
    expect(generateJournal).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      weekStart: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
  });

  it('shows the empty journal state', async () => {
    renderPage(<JournalPage />, {
      client: testClient({ listJournal: async () => [] }),
    });

    expect(await screen.findByText('No journal entries yet')).toBeInTheDocument();
    expect(screen.getByText(/Nothing is generated automatically/)).toBeInTheDocument();
  });
});

describe('PluginsPage', () => {
  it('lists installed plugins with kind and status', async () => {
    renderPage(<PluginsPage />, { client: sessionClient() });

    expect(await screen.findAllByText('example-guard')).not.toHaveLength(0);
    expect(screen.getByText('v0.1.0')).toBeInTheDocument();
    expect(screen.getByText('guard')).toBeInTheDocument();
    expect(screen.getByText('enabled')).toBeInTheDocument();
    expect(screen.getByText('C:\\work\\plugins\\example-guard')).toBeInTheDocument();
  });

  it('installs a local plugin and clears the path on success', async () => {
    const user = userEvent.setup();
    const installPlugin = vi.fn(async () => makePlugin({ name: 'new-plugin' }));
    renderPage(<PluginsPage />, { client: sessionClient({ installPlugin }) });

    const input = screen.getByLabelText(/Plugin directory or cockpit-plugin.json path/);
    await user.type(input, 'C:\\work\\new-plugin');
    await user.click(screen.getByRole('button', { name: 'Install' }));

    expect(installPlugin).toHaveBeenCalledWith({ path: 'C:\\work\\new-plugin' });
    await waitFor(() => expect(input).toHaveValue(''));
  });

  it('toggles, loads history, and removes a plugin', async () => {
    const user = userEvent.setup();
    const updatePlugin = vi.fn(async () => makePlugin({ enabled: false }));
    const removePlugin = vi.fn(async () => true);
    const listPluginRuns = vi.fn(async () => [makePluginRun()]);
    renderPage(<PluginsPage />, {
      client: sessionClient({ updatePlugin, removePlugin, listPluginRuns }),
    });

    await screen.findAllByText('example-guard');
    await user.click(screen.getByRole('button', { name: 'Disable' }));
    expect(updatePlugin).toHaveBeenCalledWith(makePlugin().id, { enabled: false });
    expect(await screen.findByText('disabled')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'History' }));
    expect(listPluginRuns).toHaveBeenCalledWith(makePlugin().id, 20);
    expect(await screen.findByText(/"findings": \[\]/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(removePlugin).toHaveBeenCalledWith(makePlugin().id);
    expect(await screen.findByText('No plugins installed')).toBeInTheDocument();
  });

  it('runs an enabled plugin against a session and shows the result', async () => {
    const user = userEvent.setup();
    const runPlugin = vi.fn(async () => makePluginRun());
    renderPage(<PluginsPage />, { client: sessionClient({ runPlugin }) });

    await screen.findAllByText('example-guard');
    await user.selectOptions(screen.getByLabelText('Session for the plugin'), SESSION_ID);
    await user.click(screen.getByRole('button', { name: 'Run plugin' }));

    expect(runPlugin).toHaveBeenCalledWith(makePlugin().id, { sessionId: SESSION_ID });
    expect(await screen.findByText('Latest result')).toBeInTheDocument();
    expect((await screen.findAllByText(/"findings": \[\]/)).length).toBeGreaterThan(0);
  });

  it('shows the empty library state', async () => {
    renderPage(<PluginsPage />, {
      client: testClient({ listPlugins: async () => [] }),
    });

    expect(await screen.findByText('No plugins installed')).toBeInTheDocument();
    expect(screen.getByText('Nothing to run')).toBeInTheDocument();
  });
});

describe('HandoffPage', () => {
  function renderHandoff(client = testClient()) {
    return renderPage(<HandoffPage />, {
      client,
      path: '/sessions/:id/handoff',
      route: `/sessions/${SESSION_ID}/handoff`,
    });
  }

  it('renders the generated brief and resumes at the end of the session', async () => {
    const user = userEvent.setup();
    const generateHandoff = vi.fn(async () => makeHandoffBrief());
    renderHandoff(sessionClient({ generateHandoff }));

    expect(
      await screen.findByRole('heading', { name: 'Handoff · Auth hardening' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/# Handoff/)).toBeInTheDocument();
    expect(screen.getByText(/Resume at step 3/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Replay/ })).toHaveAttribute(
      'href',
      `/sessions/${SESSION_ID}/replay`,
    );

    await user.click(screen.getByRole('button', { name: 'Generate brief' }));
    expect(generateHandoff).toHaveBeenCalledWith(SESSION_ID, {});
  });

  it('can generate a brief that stops after a chosen step', async () => {
    const user = userEvent.setup();
    const generateHandoff = vi.fn(async () => makeHandoffBrief());
    renderHandoff(sessionClient({ generateHandoff }));

    await screen.findByRole('heading', { name: 'Handoff · Auth hardening' });
    await user.selectOptions(
      screen.getByLabelText('Generate handoff after a specific step'),
      STEP_ONE_ID,
    );
    await user.click(screen.getByRole('button', { name: 'Generate brief' }));

    expect(generateHandoff).toHaveBeenCalledWith(SESSION_ID, { stepId: STEP_ONE_ID });
  });

  it('shows the empty brief state', async () => {
    renderHandoff(sessionClient({ listHandoffs: async () => [] }));

    expect(await screen.findByText('No handoff briefs yet')).toBeInTheDocument();
    expect(screen.getByText(/Choose a step above to stop the brief/)).toBeInTheDocument();
  });
});
