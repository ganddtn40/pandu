import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { PairPage } from '../src/pages/PairPage';
import {
  makeDevice,
  makePairingSession,
  makePairingStatus,
  renderPage,
  testClient,
} from './fixtures';

function renderPair(client = testClient()) {
  return renderPage(<PairPage />, { client, path: '/pair', route: '/pair' });
}

async function createCode(): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: 'Create code' }));
  await screen.findByLabelText('Pairing code');
}

describe('pair page', () => {
  it('creates a code and shows the QR, addresses, and deep link', async () => {
    const createPairing = vi.fn(async () => makePairingSession());
    const client = testClient({
      createPairing,
      listDevices: async () => [],
    });

    renderPair(client);

    expect(
      await screen.findByRole('heading', { name: 'Create a pairing code' }),
    ).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Device name (optional)'), 'Pixel 9');
    await userEvent.selectOptions(screen.getByLabelText('Pairing code lifetime'), '120');
    await createCode();

    expect(createPairing).toHaveBeenCalledWith({ name: 'Pixel 9', ttlSeconds: 120 });
    expect(screen.getByLabelText('Pairing code')).toHaveTextContent('ABCD-EFGH');
    expect(screen.getByText('http://127.0.0.1:4319')).toBeInTheDocument();
    expect(screen.getByText(/cockpit:\/\/pair\?/)).toBeInTheDocument();
    expect(await screen.findByAltText(/QR code containing the Cockpit pairing link/)).toBeVisible();
    expect(screen.getByText(/Expires in/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel code' })).toBeInTheDocument();
  });

  it('moves to a paired state when the code is claimed and refreshes devices', async () => {
    const listDevices = vi.fn(async () => [makeDevice()]);
    const client = testClient({
      createPairing: async () => makePairingSession(),
      getPairingSession: async () =>
        makePairingStatus({ claimed: true, usedAt: '2026-04-05T06:01:00.000Z' }),
      listDevices,
    });

    renderPair(client);
    await createCode();

    expect(await screen.findByRole('heading', { name: 'Device paired' })).toBeInTheDocument();
    expect(screen.getByText(/The code was claimed/)).toBeInTheDocument();
    await waitFor(() => expect(listDevices.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('reports an expired code and lets the operator start over', async () => {
    const client = testClient({
      createPairing: async () => makePairingSession(),
      getPairingSession: async () => makePairingStatus({ expired: true }),
      listDevices: async () => [],
    });

    renderPair(client);
    await createCode();

    expect(await screen.findByRole('heading', { name: 'Code expired' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Create another code' }));
    expect(
      await screen.findByRole('heading', { name: 'Create a pairing code' }),
    ).toBeInTheDocument();
  });

  it('cancels an unused code through the API', async () => {
    const session = makePairingSession();
    const cancelPairing = vi.fn(async () => undefined);
    const client = testClient({
      createPairing: async () => session,
      cancelPairing,
      listDevices: async () => [],
    });

    renderPair(client);
    await createCode();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel code' }));

    await waitFor(() => expect(cancelPairing).toHaveBeenCalledWith(session.id));
    expect(
      await screen.findByRole('heading', { name: 'Create a pairing code' }),
    ).toBeInTheDocument();
  });

  it('explains when nothing is paired', async () => {
    renderPair(testClient({ listDevices: async () => [] }));
    expect(await screen.findByText('No paired devices')).toBeInTheDocument();
  });

  it('revokes a paired device and reloads the list', async () => {
    const revokeDevice = vi.fn(async () => makeDevice({ revokedAt: '2026-04-05T06:30:00.000Z' }));
    let loads = 0;
    const listDevices = vi.fn(async () => {
      loads += 1;
      return loads === 1 ? [makeDevice()] : [makeDevice({ revokedAt: '2026-04-05T06:30:00.000Z' })];
    });

    renderPair(testClient({ listDevices, revokeDevice }));

    expect(await screen.findByText('Pixel 9')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Revoke Pixel 9' }));

    await waitFor(() => expect(revokeDevice).toHaveBeenCalledWith(makeDevice().id));
    expect(await screen.findByText('Revoked')).toBeInTheDocument();
    expect(screen.getByText('No access')).toBeInTheDocument();
  });
});
