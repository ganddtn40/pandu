import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ContextPage } from '../src/pages/ContextPage';
import { DebtPage } from '../src/pages/DebtPage';
import { UnderstandingPage } from '../src/pages/UnderstandingPage';
import {
  CONTEXT_SNAPSHOT_ID,
  QUIZ_ID,
  SESSION_ID,
  UNDERSTANDING_ID,
  makeContextDetail,
  makeContextSegment,
  makeContextSnapshot,
  makeQuizSubmitResponse,
  makeQuizView,
  makeSessionContext,
  makeUnderstandingFileView,
  makeUnderstandingListResponse,
  renderPage,
  testClient,
} from './fixtures';

const SECOND_CONTEXT_ID = '23232323-2323-4323-8323-232323232323';

function renderDebt(client = testClient(), options: { path?: string; route?: string } = {}) {
  return renderPage(<DebtPage />, {
    client,
    path: options.path ?? '/debt',
    route: options.route ?? '/debt',
  });
}

function renderUnderstanding(client = testClient()) {
  return renderPage(<UnderstandingPage />, {
    client,
    path: '/understanding/:id',
    route: `/understanding/${UNDERSTANDING_ID}`,
  });
}

function renderContext(client = testClient()) {
  return renderPage(<ContextPage />, {
    client,
    path: '/sessions/:id/context',
    route: `/sessions/${SESSION_ID}/context`,
  });
}

function radioAt(index: number): HTMLElement {
  const radio = screen.getAllByRole('radio')[index];
  if (!radio) throw new Error(`Missing quiz radio at index ${String(index)}.`);
  return radio;
}

describe('debt page', () => {
  it('renders the workspace debt ledger and hotspots', async () => {
    renderDebt();

    expect(await screen.findByText('75%')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Understanding debt/ })).toBeInTheDocument();
    expect(screen.getByText('Never-reviewed hotspots')).toBeInTheDocument();
    expect(screen.getByText(/9 lines unreviewed · score 25/)).toBeInTheDocument();
    expect(screen.getByText('AI lines')).toBeInTheDocument();
    expect(screen.getByText('Reviewed')).toBeInTheDocument();

    expect(screen.getByRole('link', { name: 'src/auth.ts' })).toHaveAttribute(
      'href',
      `/understanding/${UNDERSTANDING_ID}`,
    );
    expect(screen.getByRole('img', { name: '25% of AI lines reviewed' })).toBeInTheDocument();
  });

  it('requests session-scoped debt and links to the Context Doctor', async () => {
    const listSessionUnderstanding = vi.fn(async () => makeUnderstandingListResponse());
    const client = testClient({ listSessionUnderstanding });

    renderDebt(client, {
      path: '/sessions/:id/understanding',
      route: `/sessions/${SESSION_ID}/understanding`,
    });

    expect(await screen.findByText('Session debt')).toBeInTheDocument();
    expect(listSessionUnderstanding).toHaveBeenCalledWith(
      SESSION_ID,
      {},
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.getByRole('link', { name: 'Context Doctor' })).toHaveAttribute(
      'href',
      `/sessions/${SESSION_ID}/context`,
    );
  });

  it('shows an empty ledger when no AI files are recorded', async () => {
    const summary = makeUnderstandingListResponse().summary;
    const client = testClient({
      listUnderstanding: async () => ({
        files: [],
        summary: {
          ...summary,
          reviewedPercent: 0,
          debtPercent: 0,
          totalAiLines: 0,
          reviewedAiLines: 0,
          fileCount: 0,
          unseenFiles: 0,
          acknowledgedFiles: 0,
          hotspots: [],
          neverReviewedHotspots: [],
        },
      }),
    });

    renderDebt(client);
    expect(await screen.findByText('No AI-authored files yet')).toBeInTheDocument();
  });
});

describe('understanding page', () => {
  it('renders provenance and generates a deterministic explanation', async () => {
    const explainUnderstanding = vi.fn(async () => ({
      explanation:
        'src/auth.ts contains 12 AI-attributed lines across 1 recorded change range.\nYou opened this file but have not acknowledged it (3/12 lines reviewed).',
      generatedAt: '2026-04-05T06:23:00.000Z',
    }));
    const client = testClient({ explainUnderstanding });

    renderUnderstanding(client);

    expect(await screen.findByText('src/auth.ts')).toBeInTheDocument();
    expect(screen.getByText(/12 AI-attributed lines/)).toBeInTheDocument();
    expect(screen.getByText('lines 4–6')).toBeInTheDocument();
    expect(screen.getByText(/gpt-4\.1 · openai/)).toBeInTheDocument();
    expect(screen.getByText(/Fix the auth race condition/)).toBeInTheDocument();
    expect(screen.getByText(/sha256 aaaaaaaaaaaaaaaa…/)).toBeInTheDocument();
    expect(screen.getByText('No explanation yet')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));

    await waitFor(() => expect(explainUnderstanding).toHaveBeenCalledWith(UNDERSTANDING_ID));
    expect(await screen.findByText(/contains 12 AI-attributed lines/)).toBeInTheDocument();
    expect(
      screen.getByText(/You opened this file but have not acknowledged it/),
    ).toBeInTheDocument();
  });

  it('opens and acknowledges a file through the API', async () => {
    const openUnderstanding = vi.fn(async () => ({
      file: makeUnderstandingFileView({ status: 'opened' }),
    }));
    const acknowledgeUnderstanding = vi.fn(async () => ({
      file: makeUnderstandingFileView({
        status: 'acknowledged',
        reviewedLines: 12,
        unreviewedLines: 0,
        fileScore: 100,
      }),
    }));
    const client = testClient({ openUnderstanding, acknowledgeUnderstanding });

    renderUnderstanding(client);
    await screen.findByText('src/auth.ts');

    await userEvent.click(screen.getByRole('button', { name: 'Mark opened' }));
    await waitFor(() => expect(openUnderstanding).toHaveBeenCalledWith(UNDERSTANDING_ID));

    await userEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(acknowledgeUnderstanding).toHaveBeenCalledWith(UNDERSTANDING_ID));

    expect(await screen.findByText(/12 reviewed · score 100\/100/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeDisabled();
  });

  it('starts, answers, submits, and restarts a comprehension quiz', async () => {
    const startUnderstandingQuiz = vi.fn(async () => ({ quiz: makeQuizView() }));
    const submitUnderstandingQuiz = vi.fn(async () => makeQuizSubmitResponse());
    const client = testClient({ startUnderstandingQuiz, submitUnderstandingQuiz });

    renderUnderstanding(client);
    await screen.findByText('src/auth.ts');

    await userEvent.click(screen.getByRole('button', { name: 'Start quiz' }));
    await waitFor(() => expect(startUnderstandingQuiz).toHaveBeenCalledWith(UNDERSTANDING_ID));
    expect(await screen.findByText(/How many AI-authored lines/)).toBeInTheDocument();
    expect(screen.getByText(/Which model most recently wrote/)).toBeInTheDocument();

    const submit = screen.getByRole('button', { name: 'Submit answers' });
    expect(submit).toBeDisabled();

    await userEvent.click(radioAt(0));
    await userEvent.click(radioAt(3));
    await userEvent.click(radioAt(5));
    expect(radioAt(0)).toBeChecked();
    expect(radioAt(3)).toBeChecked();
    expect(radioAt(5)).toBeChecked();
    expect(screen.getByRole('button', { name: 'Submit answers' })).toBeEnabled();

    await userEvent.click(submit);
    await waitFor(() =>
      expect(submitUnderstandingQuiz).toHaveBeenCalledWith(QUIZ_ID, {
        answers: [
          { questionId: 'q1', choiceId: 'a' },
          { questionId: 'q2', choiceId: 'a' },
          { questionId: 'q3', choiceId: 'a' },
        ],
      }),
    );

    expect(await screen.findByText('3/3 correct · 100%')).toBeInTheDocument();
    expect(
      screen.getByText('Cockpit unions the added line ranges recorded in git snapshots.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('The newest provenance range records model gpt-4.1.'),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'New quiz' }));
    await waitFor(() => expect(startUnderstandingQuiz).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('button', { name: 'Submit answers' })).toBeDisabled();
  });

  it('shows action failures without dropping the file', async () => {
    const client = testClient({
      explainUnderstanding: async () => {
        throw new Error('The daemon is unreachable.');
      },
    });

    renderUnderstanding(client);
    await screen.findByText('src/auth.ts');
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));

    expect(await screen.findByText(/daemon is unreachable/i)).toBeInTheDocument();
    expect(screen.getByText('src/auth.ts')).toBeInTheDocument();
  });
});

describe('context page', () => {
  it('renders the latest context, segments, and insights', async () => {
    renderContext();

    expect(await screen.findByText('3,200')).toBeInTheDocument();
    expect(screen.getByText('0.3% of 1,047,576')).toBeInTheDocument();
    expect(screen.getByText('gpt-4.1')).toBeInTheDocument();
    expect(screen.getByText('System prompt')).toBeInTheDocument();
    expect(screen.getByText(/You are a careful coding agent/)).toBeInTheDocument();
    expect(screen.getByText('Large tool output in context')).toBeInTheDocument();
    expect(screen.getByText(/Estimated savings: 900 tokens/)).toBeInTheDocument();
    expect(screen.getByText(/src\/auth\.ts/)).toBeInTheDocument();
  });

  it('selects a different snapshot and reloads its detail', async () => {
    const first = makeContextSnapshot();
    const second = makeContextSnapshot({
      id: SECOND_CONTEXT_ID,
      totalTokens: 6400,
      model: 'claude-sonnet-4',
      measuredAt: '2026-04-05T06:09:00.000Z',
    });
    const getContextSnapshot = vi.fn(async (snapshotId: string) =>
      snapshotId === SECOND_CONTEXT_ID
        ? makeContextDetail({
            snapshot: second,
            segments: [
              makeContextSegment({
                snapshotId: SECOND_CONTEXT_ID,
                label: 'Conversation history',
                tokens: 6400,
                percent: 100,
                preview: 'A long debugging session.',
              }),
            ],
            insights: [],
          })
        : makeContextDetail(),
    );
    const client = testClient({
      getSessionContext: async () =>
        makeSessionContext({ snapshots: [first, second], latest: second }),
      getContextSnapshot,
    });

    renderContext(client);

    expect(await screen.findByText('Conversation history')).toBeInTheDocument();
    expect(screen.getByText('No context problems detected')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /3,200 tokens/ }));
    await waitFor(() =>
      expect(getContextSnapshot).toHaveBeenCalledWith(
        CONTEXT_SNAPSHOT_ID,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );

    expect(await screen.findByText('System prompt')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /3,200 tokens/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: /6,400 tokens/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('recomputes snapshots and reloads the latest detail', async () => {
    const updated = makeContextSnapshot({
      id: SECOND_CONTEXT_ID,
      totalTokens: 4800,
      measuredAt: '2026-04-05T06:10:00.000Z',
    });
    const recomputeSessionContext = vi.fn(async () =>
      makeSessionContext({ snapshots: [updated], latest: updated }),
    );
    let detailCalls = 0;
    const getContextSnapshot = vi.fn(async () => {
      detailCalls += 1;
      return detailCalls === 1
        ? makeContextDetail()
        : makeContextDetail({
            snapshot: updated,
            segments: [
              makeContextSegment({
                snapshotId: SECOND_CONTEXT_ID,
                label: 'Recomputed request',
                tokens: 4800,
                percent: 100,
              }),
            ],
            insights: [],
          });
    });
    const client = testClient({ recomputeSessionContext, getContextSnapshot });

    renderContext(client);
    await screen.findByText('System prompt');

    await userEvent.click(screen.getByRole('button', { name: 'Recompute' }));
    await waitFor(() => expect(recomputeSessionContext).toHaveBeenCalledWith(SESSION_ID));

    expect(await screen.findByText('Recomputed request')).toBeInTheDocument();
    expect(screen.getByText('4,800')).toBeInTheDocument();
  });

  it('shows an empty state when no snapshots exist', async () => {
    const client = testClient({
      getSessionContext: async () => makeSessionContext({ snapshots: [], latest: null }),
    });

    renderContext(client);

    expect(await screen.findByText('No context snapshots yet')).toBeInTheDocument();
    expect(screen.getByText('context window unknown')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
