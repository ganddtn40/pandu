import { describe, expect, it } from 'vitest';

import { parsePairingInput, readPairingLinkFromLocation } from '../src/lib/deep-link';

describe('parsePairingInput', () => {
  it('parses a cockpit deep link', () => {
    expect(
      parsePairingInput('cockpit://pair?url=http%3A%2F%2F192.168.1.20%3A4319&code=abcd-efgh'),
    ).toEqual({ baseUrl: 'http://192.168.1.20:4319', code: 'ABCD-EFGH' });
  });

  it('parses a regular URL with url and code parameters', () => {
    expect(
      parsePairingInput('https://cockpit.invalid/?url=http%3A%2F%2F127.0.0.1%3A4319&code=ABCDEFGH'),
    ).toEqual({ baseUrl: 'http://127.0.0.1:4319', code: 'ABCD-EFGH' });
  });

  it('rejects links without an http daemon URL or a valid code', () => {
    expect(parsePairingInput('cockpit://pair?url=ftp%3A%2F%2Fhost&code=ABCDEFGH')).toBeNull();
    expect(parsePairingInput('cockpit://pair?url=http%3A%2F%2Fhost&code=nope')).toBeNull();
    expect(parsePairingInput('https://cockpit.invalid/?code=ABCDEFGH')).toBeNull();
    expect(parsePairingInput('not a link')).toBeNull();
  });

  it('rejects embedded credentials', () => {
    expect(
      parsePairingInput(
        'cockpit://pair?url=http%3A%2F%2Fuser%3Apass%40127.0.0.1%3A4319&code=ABCDEFGH',
      ),
    ).toBeNull();
  });

  it('reads pairing parameters from a launch URL', () => {
    expect(
      readPairingLinkFromLocation({
        search: '?url=http%3A%2F%2F127.0.0.1%3A4319&code=ABCD-EFGH',
      }),
    ).toEqual({ baseUrl: 'http://127.0.0.1:4319', code: 'ABCD-EFGH' });
    expect(readPairingLinkFromLocation({ search: '' })).toBeNull();
  });
});
