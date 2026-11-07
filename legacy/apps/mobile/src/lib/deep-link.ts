import { formatPairingCode, parsePairingDeepLink } from '@cockpit/core';

export interface PairingPrefill {
  baseUrl: string;
  code: string;
}

/**
 * Accepts a `cockpit://pair` link or a regular URL with `url` and `code` query
 * parameters, which is handy when the link is pasted into a browser.
 */
export function parsePairingInput(value: string): PairingPrefill | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  const deepLink = parsePairingDeepLink(trimmed);
  if (deepLink) {
    return {
      baseUrl: deepLink.baseUrl,
      code: formatPairingCode(deepLink.code) ?? deepLink.code,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  const baseUrl = parsed.searchParams.get('url');
  const rawCode = parsed.searchParams.get('code');
  if (!baseUrl || !rawCode) return null;

  let normalizedBase: string;
  try {
    const candidate = new URL(baseUrl);
    if (candidate.protocol !== 'http:' && candidate.protocol !== 'https:') return null;
    if (candidate.username || candidate.password) return null;
    normalizedBase = candidate.origin;
  } catch {
    return null;
  }

  const code = formatPairingCode(rawCode);
  if (!code) return null;
  return { baseUrl: normalizedBase, code };
}

/**
 * Reads a pairing link that was used to launch the app in a browser. Android
 * deep links arrive through the Capacitor App plugin instead.
 */
export function readPairingLinkFromLocation(
  location: Pick<Location, 'search'> = window.location,
): PairingPrefill | null {
  const params = new URLSearchParams(location.search);
  const url = params.get('url');
  const code = params.get('code');
  if (!url || !code) return null;
  return parsePairingInput(
    `https://cockpit.invalid/?${new URLSearchParams({ url, code }).toString()}`,
  );
}
