import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ApiRequestError } from '../src/lib/api';
import { SessionPage } from '../src/pages/SessionPage';
import {
  SESSION_ID,
  STEP_ONE_ID,
  STEP_TWO_ID,
  TOOL_CALL_ID,
  makeChunk,
  makeSession,
  makeStep,
  makeToolCall,
  renderPage,
  testClient,
} from './fixtures';

const SECOND_CHUNK_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SECOND_TOOL_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

function makeWorkbench() {
  const stepOne = makeStep();
  const stepTwo = makeStep({
    id: STEP_TWO_ID,
    seq: 1,
    model: 'gpt-4.1',
    startedAt: '2026-04-05T06:08:00.000Z',
    endedAt: '2026-04-05T06:08:01.000Z',
    durationMs: 1000,
  });

  const stepOneDetail = {
    step: stepOne,
    chunks: [makeChunk({ stepId: STEP_ONE_ID, deltaText: 'step one token' })],
    toolCalls: [makeToolCall({ id: TOOL_CALL_ID, stepId: STEP_ONE_ID, name: 'read_file' })],
  };

  const stepTwoDetail = {
    step: stepTwo,
    chunks: [
      makeChunk({
        id: SECOND_CHUNK_ID,
        stepId: STEP_TWO_ID,
        deltaText: 'step two token',
      }),
    ],
    toolCalls: [makeToolCall({ id: SECOND_TOOL_ID, stepId: STEP_TWO_ID, name: 'write_file' })],
  };

  const getStep = vi.fn(async (stepId: string) =>
    stepId === STEP_TWO_ID ? stepTwoDetail : stepOneDetail,
  );

  const client = testClient({
    getSession: async () => ({ session: makeSession() }),
    getSessionSteps: async () => ({ steps: [stepOne, stepTwo] }),
    getStep,
  });

  return { client, getStep, stepOne, stepTwo };
}

describe('SessionPage', () => {
  it('loads a flight, follows the latest step, and exposes raw JSON', async () => {
    const user = userEvent.setup();
    const { client, getStep } = makeWorkbench();

    renderPage(<SessionPage />, {
      client,
      route: `/sessions/${SESSION_ID}`,
      path: '/sessions/:id',
    });

    expect(await screen.findByRole('heading', { name: 'Fix flaky auth test' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Step 2' })).toBeInTheDocument();
    await waitFor(() => {
      expect(getStep).toHaveBeenCalledWith(STEP_TWO_ID, expect.anything());
    });

    const rawLink = screen.getByRole('link', { name: /Raw JSON/ });
    expect(rawLink).toHaveAttribute('href', `/api/sessions/${SESSION_ID}`);

    expect(screen.getAllByRole('button', { name: /^Step \d:/ })).toHaveLength(2);
    expect(screen.getByText(/Live feed offline/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Step 1:/ }));
    expect(screen.getByRole('heading', { name: 'Step 1' })).toBeInTheDocument();
    expect(await screen.findByText('POST')).toBeInTheDocument();
    expect(screen.getByText('/v1/chat/completions')).toBeInTheDocument();
  });

  it('inspects request, response, tool, and stream tabs', async () => {
    const user = userEvent.setup();
    const { client } = makeWorkbench();

    renderPage(<SessionPage />, {
      client,
      route: `/sessions/${SESSION_ID}`,
      path: '/sessions/:id',
    });

    await screen.findByRole('heading', { name: 'Step 2' });

    await user.click(screen.getByRole('tab', { name: 'Response' }));
    expect(await screen.findByText('Here is the fix.')).toBeInTheDocument();
    expect(screen.getByText('TTFT 120ms')).toBeInTheDocument();
    expect(within(screen.getByRole('tabpanel')).getByText('$0.018')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /Tools/ }));
    expect(await screen.findByText('write_file')).toBeInTheDocument();
    expect(screen.getByText('src/auth.ts')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /Stream/ }));
    expect(await screen.findByText('step two token')).toBeInTheDocument();
    expect(screen.queryByText(/Showing the last 200/)).not.toBeInTheDocument();
  });

  it('moves between tabs with arrow keys and focus', async () => {
    const user = userEvent.setup();
    const { client } = makeWorkbench();

    renderPage(<SessionPage />, {
      client,
      route: `/sessions/${SESSION_ID}`,
      path: '/sessions/:id',
    });

    await screen.findByRole('heading', { name: 'Step 2' });

    const requestTab = screen.getByRole('tab', { name: 'Request' });
    requestTab.focus();
    expect(requestTab).toHaveFocus();

    await user.keyboard('{ArrowRight}');
    const responseTab = screen.getByRole('tab', { name: 'Response' });
    expect(responseTab).toHaveAttribute('aria-selected', 'true');
    expect(responseTab).toHaveFocus();
    expect(screen.getByRole('tabpanel')).toHaveAttribute(
      'aria-labelledby',
      'inspector-tab-response',
    );

    await user.keyboard('{End}');
    const streamTab = screen.getByRole('tab', { name: /Stream/ });
    expect(streamTab).toHaveAttribute('aria-selected', 'true');
    expect(streamTab).toHaveFocus();

    await user.keyboard('{Home}');
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Request' })).toHaveAttribute('aria-selected', 'true');
    });
  });

  it('shows a clear not-found state for unknown flights', async () => {
    const missing = async (): Promise<never> => {
      throw new ApiRequestError(404, 'not_found', 'The requested session was not found.');
    };

    renderPage(<SessionPage />, {
      client: testClient({ getSession: missing, getSessionSteps: missing }),
      route: '/sessions/99999999-9999-4999-8999-999999999999',
      path: '/sessions/:id',
    });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The requested session was not found.');
    expect(screen.getByRole('link', { name: /Flight log/ })).toHaveAttribute('href', '/sessions');
  });
});
