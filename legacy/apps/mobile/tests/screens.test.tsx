import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { MobileApiError } from '../src/lib/api';
import type { LiveState } from '../src/lib/live';
import { PairScreen } from '../src/screens/PairScreen';
import { FlightsTab } from '../src/screens/FlightsTab';
import { OverviewTab } from '../src/screens/OverviewTab';
import { SettingsTab } from '../src/screens/SettingsTab';
import { DEVICE, MOBILE_SESSION, testClient } from './fixtures';

const LIVE: LiveState = { status: 'live', lastEvent: null, eventCount: 0 };

function renderPair(claim = vi.fn()) {
  const onPaired = vi.fn();
  render(<PairScreen claim={claim} onPaired={onPaired} />);
  return { claim, onPaired };
}

describe('PairScreen', () => {
  it('validates the address and code before claiming', async () => {
    const { claim } = renderPair();
    await userEvent.click(screen.getByRole('button', { name: 'Pair this device' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/valid daemon address/i);
    expect(claim).not.toHaveBeenCalled();
  });

  it('claims a code and passes a complete session to the app', async () => {
    const claim = vi.fn(async () => ({
      device: DEVICE,
      token: MOBILE_SESSION.token,
      baseUrl: MOBILE_SESSION.baseUrl,
    }));
    const { onPaired } = renderPair(claim);

    await userEvent.type(screen.getByLabelText('Daemon address'), '192.168.1.20:4319/path');
    await userEvent.type(screen.getByLabelText('Pairing code'), 'abcd efgh');
    await userEvent.type(screen.getByLabelText('Device name (optional)'), 'Pixel 9');
    await userEvent.click(screen.getByRole('button', { name: 'Pair this device' }));

    await waitFor(() =>
      expect(claim).toHaveBeenCalledWith({
        baseUrl: 'http://192.168.1.20:4319',
        code: 'ABCDEFGH',
        name: 'Pixel 9',
      }),
    );
    expect(onPaired).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'http://192.168.1.20:4319',
        token: MOBILE_SESSION.token,
        device: DEVICE,
      }),
    );
  });

  it('prefills from a deep link', () => {
    render(
      <PairScreen
        initial={{ baseUrl: 'http://127.0.0.1:4319', code: 'ABCD-EFGH' }}
        claim={vi.fn()}
        onPaired={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('Daemon address')).toHaveValue('http://127.0.0.1:4319');
    expect(screen.getByLabelText('Pairing code')).toHaveValue('ABCD-EFGH');
  });

  it('shows a daemon rejection without losing the form', async () => {
    const claim = vi.fn(async () => {
      throw new MobileApiError(404, 'not_found', 'That pairing code is invalid or expired.');
    });
    renderPair(claim);

    await userEvent.type(screen.getByLabelText('Daemon address'), 'http://127.0.0.1:4319');
    await userEvent.type(screen.getByLabelText('Pairing code'), 'ABCD-EFGH');
    await userEvent.click(screen.getByRole('button', { name: 'Pair this device' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/invalid or expired/i);
    expect(screen.getByLabelText('Pairing code')).toHaveValue('ABCD-EFGH');
  });
});

describe('OverviewTab', () => {
  it('renders totals and daemon health', async () => {
    render(
      <OverviewTab
        session={MOBILE_SESSION}
        client={testClient()}
        live={LIVE}
        onUnauthorized={vi.fn()}
      />,
    );

    expect(await screen.findByText('42')).toBeInTheDocument();
    expect(screen.getByText(/3[.,]42/)).toBeInTheDocument();
    expect(screen.getByText('0.1.0')).toBeInTheDocument();
    expect(screen.getByText('1h 2m')).toBeInTheDocument();
    expect(screen.getByText(/OpenAI protocol enabled/)).toBeInTheDocument();
    expect(screen.getByText('Live')).toBeInTheDocument();
  });

  it('signs out when the daemon reports the token is unauthorized', async () => {
    const onUnauthorized = vi.fn();
    const client = testClient({
      health: async () => {
        throw new MobileApiError(401, 'unauthorized', 'Revoked.');
      },
    });

    render(
      <OverviewTab
        session={MOBILE_SESSION}
        client={client}
        live={LIVE}
        onUnauthorized={onUnauthorized}
      />,
    );

    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled());
  });
});

describe('FlightsTab', () => {
  it('lists sessions and filters active flights', async () => {
    render(<FlightsTab session={MOBILE_SESSION} client={testClient()} onUnauthorized={vi.fn()} />);

    expect(await screen.findByText('Fix auth regression')).toBeInTheDocument();
    expect(screen.getByText('Ship dashboard filters')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Active' }));

    expect(screen.getByText('Fix auth regression')).toBeInTheDocument();
    expect(screen.queryByText('Ship dashboard filters')).not.toBeInTheDocument();
  });

  it('explains an empty flight log', async () => {
    render(
      <FlightsTab
        session={MOBILE_SESSION}
        client={testClient({ listSessions: async () => [] })}
        onUnauthorized={vi.fn()}
      />,
    );

    expect(await screen.findByText('No flights yet')).toBeInTheDocument();
  });
});

describe('SettingsTab', () => {
  it('confirms before revoking and then forgets the device', async () => {
    const revokeDevice = vi.fn(async () => ({
      ...DEVICE,
      revokedAt: '2026-04-05T06:30:00.000Z',
    }));
    const onUnpair = vi.fn();
    render(
      <SettingsTab
        session={MOBILE_SESSION}
        client={testClient({ revokeDevice })}
        onUnpair={onUnpair}
      />,
    );

    expect(screen.getByText(DEVICE.id)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Unpair this device' }));
    expect(onUnpair).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Yes, unpair' }));
    await waitFor(() => expect(revokeDevice).toHaveBeenCalledWith(DEVICE.id));
    await waitFor(() => expect(onUnpair).toHaveBeenCalled());
  });

  it('can keep the device paired after opening the confirmation', async () => {
    const onUnpair = vi.fn();
    render(<SettingsTab session={MOBILE_SESSION} client={testClient()} onUnpair={onUnpair} />);

    await userEvent.click(screen.getByRole('button', { name: 'Unpair this device' }));
    await userEvent.click(screen.getByRole('button', { name: 'Keep paired' }));

    expect(screen.queryByRole('button', { name: 'Yes, unpair' })).not.toBeInTheDocument();
    expect(onUnpair).not.toHaveBeenCalled();
  });

  it('checks the daemon connection on demand', async () => {
    render(<SettingsTab session={MOBILE_SESSION} client={testClient()} onUnpair={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: 'Check connection' }));

    expect(await screen.findByText(/Daemon 0.1.0/)).toBeInTheDocument();
  });
});
