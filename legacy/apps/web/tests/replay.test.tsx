import type { ReplayFork } from '@cockpit/core';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ReplayPage } from '../src/pages/ReplayPage';
import {
  FORK_ID,
  SESSION_ID,
  SNAPSHOT_ID,
  STEP_TWO_ID,
  makeFileChange,
  makeFork,
  makeReplay,
  makeSnapshot,
  makeSnapshotDetail,
  makeStep,
  makeStepDetail,
  renderPage,
  testClient,
} from './fixtures';

function makeReplayFixture() {
  const stepOne = makeStep();
  const stepTwo = makeStep({
    id: STEP_TWO_ID,
    seq: 1,
    model: 'gpt-4.1',
    startedAt: '2026-04-05T06:08:00.000Z',
    endedAt: '2026-04-05T06:08:01.000Z',
    durationMs: 1000,
    request: {
      protocol: 'openai',
      method: 'POST',
      path: '/v1/chat/completions',
      model: 'gpt-4.1',
      stream: false,
      headers: {},
      body: {
        model: 'gpt-4.1',
        messages: [{ role: 'user', content: 'Second prompt' }],
      },
      promptText: 'Second prompt',
      redactionCount: 0,
    },
    response: {
      status: 200,
      headers: {},
      finishReason: 'stop',
      text: 'Second response',
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
      latencyMs: 1000,
    },
  });

  const steps = [stepOne, stepTwo];
  const snapshots = [makeSnapshot()];

  const client = testClient({
    getSessionReplay: async () => makeReplay({ steps, snapshots }),
    getStep: async (stepId) => {
      const step = steps.find((candidate) => candidate.id === stepId) ?? stepOne;
      return makeStepDetail(step);
    },
    getSnapshot: async () => makeSnapshotDetail(),
  });

  return { client, steps, snapshots };
}

function renderReplay(client = makeReplayFixture().client) {
  return renderPage(<ReplayPage />, {
    client,
    path: '/sessions/:id/replay',
    route: `/sessions/${SESSION_ID}/replay`,
  });
}

describe('replay page', () => {
  it('renders the selected step transcript, tools, and snapshot diff', async () => {
    const { client } = makeReplayFixture();
    renderReplay(client);

    expect(await screen.findByText('Second response')).toBeInTheDocument();
    expect(screen.getByText('Second prompt')).toBeInTheDocument();
    expect(screen.getAllByText('read_file').length).toBeGreaterThan(0);
    expect(await screen.findByText(/newFlag = true/)).toBeInTheDocument();
    expect(screen.getByText(/Step 2 of 2/)).toBeInTheDocument();
    expect(screen.getAllByText(/abcdef0123/).length).toBeGreaterThan(0);
  });

  it('scrubs between steps and mirrors the selection in the timeline', async () => {
    const { client } = makeReplayFixture();
    renderReplay(client);

    await screen.findByText('Second response');
    await userEvent.click(screen.getByRole('button', { name: 'Previous step' }));

    expect(screen.getByText('Hello from the cockpit')).toBeInTheDocument();
    expect(screen.getByText('Here is the fix.')).toBeInTheDocument();
    expect(screen.getByText(/Step 1 of 2/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Replay position'), { target: { value: '1' } });
    expect(screen.getByText('Second response')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next step' })).toBeDisabled();
  });

  it('toggles playback controls without auto-playing on load', async () => {
    const { client } = makeReplayFixture();
    renderReplay(client);

    await screen.findByText('Second response');
    await userEvent.click(screen.getByRole('button', { name: 'Previous step' }));
    await userEvent.click(screen.getByRole('button', { name: 'Play replay' }));

    expect(screen.getByRole('button', { name: 'Pause replay' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Pause replay' }));
    expect(screen.getByRole('button', { name: 'Play replay' })).toBeInTheDocument();
  });

  it('creates a fork from the selected step and refreshes the fork list', async () => {
    const fixture = makeReplayFixture();
    let forks: ReplayFork[] = [];
    let receivedInput: unknown;
    const createdFork = makeFork();

    const client = testClient({
      ...fixture.client,
      getSessionReplay: async () =>
        makeReplay({ steps: fixture.steps, snapshots: fixture.snapshots, forks }),
      createFork: async (_sessionId, input) => {
        receivedInput = input;
        forks = [createdFork];
        return { fork: createdFork };
      },
    });

    renderReplay(client);
    await screen.findByText('Second response');

    await userEvent.click(screen.getByRole('button', { name: 'Fork from here' }));

    await waitFor(() => {
      expect(receivedInput).toEqual({ stepId: STEP_TWO_ID });
    });
    expect(await screen.findByText(createdFork.branch)).toBeInTheDocument();
    expect(screen.getByText(createdFork.worktreePath)).toBeInTheDocument();
    expect(screen.getByText(/Fork ready on/)).toBeInTheDocument();
  });

  it('removes a fork after explicit confirmation', async () => {
    const fixture = makeReplayFixture();
    const fork = makeFork();
    let forks: ReplayFork[] = [fork];
    const removeFork = vi.fn(async (forkId: string) => {
      forks = [];
      return { fork: makeFork({ id: forkId, status: 'removed' }) };
    });

    const client = testClient({
      ...fixture.client,
      getSessionReplay: async () =>
        makeReplay({ steps: fixture.steps, snapshots: fixture.snapshots, forks }),
      removeFork,
    });

    renderReplay(client);
    await screen.findByText(fork.branch);

    await userEvent.click(screen.getByRole('button', { name: 'Remove worktree' }));
    expect(removeFork).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Confirm remove' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Confirm remove' }));

    await waitFor(() => {
      expect(removeFork).toHaveBeenCalledWith(FORK_ID);
    });
    expect(await screen.findByText(/No forks yet/)).toBeInTheDocument();
  });

  it('shows the exact diff for the snapshot covering the step', async () => {
    const fixture = makeReplayFixture();
    const getSnapshot = vi.fn(async () => ({
      snapshot: makeSnapshot(),
      fileChanges: [
        makeFileChange({
          path: 'src/auth.ts',
          diff: '@@ -1 +1 @@\n-const retry = 1;\n+const retry = 3;\n',
        }),
      ],
    }));

    renderReplay(
      testClient({
        ...fixture.client,
        getSessionReplay: async () =>
          makeReplay({ steps: fixture.steps, snapshots: fixture.snapshots }),
        getSnapshot,
      }),
    );

    await screen.findByText(/retry = 3/);
    expect(getSnapshot).toHaveBeenCalledWith(SNAPSHOT_ID, expect.anything());
    expect(screen.getByText('modified')).toBeInTheDocument();
    expect(screen.getAllByText('src/auth.ts').length).toBeGreaterThan(0);
  });

  it('disables forking until a snapshot exists', async () => {
    const fixture = makeReplayFixture();
    renderReplay(
      testClient({
        ...fixture.client,
        getSessionReplay: async () => makeReplay({ steps: fixture.steps }),
      }),
    );

    await screen.findByText('Second response');
    expect(screen.getByRole('button', { name: 'Fork from here' })).toBeDisabled();
    expect(screen.getByText(/Forking unlocks once a snapshot exists/)).toBeInTheDocument();
  });

  it('links back to the flight and the steps stay selectable', async () => {
    const { client } = makeReplayFixture();
    renderReplay(client);

    await screen.findByText('Second response');
    expect(screen.getByRole('link', { name: /Flight/ })).toHaveAttribute(
      'href',
      `/sessions/${SESSION_ID}`,
    );

    await userEvent.click(screen.getByRole('button', { name: /gpt-4.1-mini/ }));
    expect(screen.getByText('Hello from the cockpit')).toBeInTheDocument();
    expect(screen.getByText(/Step 1 of 2/)).toBeInTheDocument();
  });

  it('renders an error state when the replay cannot be loaded', async () => {
    const client = testClient({
      getSessionReplay: async () => {
        throw new Error('replay unavailable');
      },
    });

    renderReplay(client);

    expect(await screen.findByRole('alert')).toHaveTextContent('replay unavailable');
    expect(screen.getByRole('link', { name: /Flight log/ })).toBeInTheDocument();
  });
});
