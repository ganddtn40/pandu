import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ApiRequestError } from '../src/lib/api';
import { OverviewPage } from '../src/pages/OverviewPage';
import { SessionsPage } from '../src/pages/SessionsPage';
import { EMPTY_STATS, SESSION_ID, makeSession, renderPage, testClient } from './fixtures';

describe('OverviewPage', () => {
  it('renders recorded totals and the latest flights', async () => {
    const client = testClient({
      stats: async () => ({
        stats: {
          ...EMPTY_STATS,
          sessionCount: 12,
          activeSessionCount: 2,
          stepCount: 48,
          toolCallCount: 9,
          inputTokens: 1200,
          outputTokens: 300,
          cacheReadTokens: 100,
          totalCostUsd: 1.234,
          unknownCostCalls: 2,
          errorCount: 1,
        },
      }),
      listSessions: async () => ({ sessions: [makeSession()], nextCursor: null }),
    });

    renderPage(<OverviewPage />, { client });

    expect(await screen.findByText('12')).toBeInTheDocument();
    expect(screen.getByText('2 in flight')).toBeInTheDocument();
    expect(screen.getByText('1.6K')).toBeInTheDocument();
    expect(screen.getByText('$1.23')).toBeInTheDocument();
    expect(screen.getByText('1 recorded error across flights.')).toBeInTheDocument();

    const flight = screen.getByRole('link', { name: 'Open flight Fix flaky auth test' });
    expect(flight).toHaveAttribute('href', `/sessions/${SESSION_ID}`);
    expect(screen.getByText('1 flight', { exact: false })).toBeInTheDocument();
  });

  it('sends status filters and debounced search to the daemon', async () => {
    const user = userEvent.setup();
    const listSessions = vi.fn(async () => ({ sessions: [makeSession()], nextCursor: null }));

    renderPage(<OverviewPage />, { client: testClient({ listSessions }) });

    await screen.findByRole('link', { name: 'Open flight Fix flaky auth test' });

    await user.click(screen.getByRole('button', { name: 'Completed' }));
    await waitFor(() => {
      expect(listSessions).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'completed' }),
        expect.anything(),
      );
    });
    expect(screen.getByRole('button', { name: 'Completed' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await user.type(screen.getByLabelText('Search flights'), 'auth');
    await waitFor(
      () => {
        expect(listSessions).toHaveBeenLastCalledWith(
          expect.objectContaining({ search: 'auth', status: 'completed' }),
          expect.anything(),
        );
      },
      { timeout: 2000 },
    );
  });

  it('shows the empty state with the exact command to start recording', async () => {
    renderPage(<OverviewPage />);

    expect(await screen.findByText('No flights recorded yet.')).toBeInTheDocument();
    expect(screen.getByText('cockpit run -- claude')).toBeInTheDocument();
  });

  it('shows a stats error and recovers after retry', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const stats = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new ApiRequestError(500, 'internal_error', 'The daemon stopped responding.');
      }
      return { stats: EMPTY_STATS };
    });

    renderPage(<OverviewPage />, { client: testClient({ stats }) });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The daemon stopped responding.');

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
    expect(stats).toHaveBeenCalledTimes(2);
  });
});

describe('SessionsPage', () => {
  it('loads a larger page of flights for the full log', async () => {
    const listSessions = vi.fn(async () => ({ sessions: [makeSession()], nextCursor: null }));

    renderPage(<SessionsPage />, { client: testClient({ listSessions }) });

    expect(
      await screen.findByRole('link', { name: 'Open flight Fix flaky auth test' }),
    ).toBeInTheDocument();
    expect(listSessions).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100 }),
      expect.anything(),
    );
    expect(screen.getByRole('heading', { name: 'Flight log' })).toBeInTheDocument();
  });

  it('clears search and status filters from the empty state', async () => {
    const user = userEvent.setup();
    const listSessions = vi.fn(async () => ({ sessions: [], nextCursor: null }));

    renderPage(<SessionsPage />, { client: testClient({ listSessions }) });

    expect(await screen.findByText('No flights recorded yet.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Failed' }));
    expect(await screen.findByText('No flights match this filter.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    });
    expect(screen.queryByText('No flights match this filter.')).not.toBeInTheDocument();
  });
});
