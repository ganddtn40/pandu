import { createHash, randomBytes, randomInt } from 'node:crypto';
import { networkInterfaces } from 'node:os';

import {
  DEVICE_TOKEN_PREFIX,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  buildPairingDeepLink,
  formatPairingCode,
  normalizePairingCode,
  type Device,
  type DevicePlatform,
  type PairingClaimInput,
  type PairingClaimResponse,
  type PairingSession,
  type PairingSessionInput,
  type PairingSessionStatus,
} from '@cockpit/core';

import { displayHostForUrl, isLoopbackHostname, type CockpitConfig } from '../config.js';
import type { LiveEventBus } from '../live/bus.js';
import type { Logger } from '../logger.js';
import type { Store } from '../store/store.js';

const CLAIM_ATTEMPT_LIMIT = 10;
const CLAIM_WINDOW_MS = 5 * 60 * 1000;
const DEVICE_TOUCH_INTERVAL_MS = 60 * 1000;

const PLATFORM_LABELS: Readonly<Record<DevicePlatform, string>> = {
  android: 'Android device',
  ios: 'iPhone or iPad',
  desktop: 'Desktop app',
  web: 'Browser',
  cli: 'Command line',
};

export class PairingServiceError extends Error {
  readonly status: number;
  readonly code:
    'bad_request' | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'rate_limited';

  constructor(status: number, code: PairingServiceError['code'], message: string) {
    super(message);
    this.name = 'PairingServiceError';
    this.status = status;
    this.code = code;
  }
}

export interface PairingServiceOptions {
  store: Store;
  bus: LiveEventBus;
  logger: Logger;
  config: CockpitConfig;
  now?: () => Date;
  codeGenerator?: () => string;
  tokenGenerator?: () => string;
}

export interface RevokeDeviceOptions {
  /** When set, a remote device may only revoke itself. */
  actorDeviceId?: string;
}

function hashSecret(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function defaultCode(): string {
  let code = '';
  for (let index = 0; index < PAIRING_CODE_LENGTH; index += 1) {
    code += PAIRING_CODE_ALPHABET.charAt(randomInt(0, PAIRING_CODE_ALPHABET.length));
  }
  return code;
}

function defaultToken(): string {
  return `${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

function urlPort(value: string): string {
  const parsed = new URL(value);
  if (parsed.port) return parsed.port;
  return parsed.protocol === 'https:' ? '443' : '80';
}

export class PairingService {
  readonly #store: Store;
  readonly #bus: LiveEventBus;
  readonly #logger: Logger;
  readonly #config: CockpitConfig;
  readonly #now: () => Date;
  readonly #codeGenerator: () => string;
  readonly #tokenGenerator: () => string;
  readonly #failedClaims = new Map<string, number[]>();
  readonly #lastTouch = new Map<string, number>();
  #baseUrl: string;

  constructor(options: PairingServiceOptions) {
    this.#store = options.store;
    this.#bus = options.bus;
    this.#logger = options.logger;
    this.#config = options.config;
    this.#now = options.now ?? (() => new Date());
    this.#codeGenerator = options.codeGenerator ?? defaultCode;
    this.#tokenGenerator = options.tokenGenerator ?? defaultToken;
    this.#baseUrl = `http://${displayHostForUrl(options.config.host)}:${options.config.port}`;
  }

  /** Called once the daemon knows its actual listening port. */
  setBaseUrl(value: string): void {
    this.#baseUrl = value.replace(/\/+$/, '');
  }

  get baseUrl(): string {
    return this.baseUrls()[0] ?? this.#baseUrl;
  }

  /**
   * Public URLs a phone can use to reach this daemon. A configured public URL
   * wins; otherwise a non-loopback bind advertises every LAN IPv4 address.
   */
  baseUrls(): string[] {
    const candidates = new Set<string>();
    if (this.#config.publicUrl) candidates.add(this.#config.publicUrl);

    const local = this.#baseUrl;
    const boundToLoopback = isLoopbackHostname(this.#config.host);

    if (boundToLoopback) {
      if (candidates.size === 0) candidates.add(local);
      return [...candidates];
    }

    for (const address of lanIpv4Addresses()) {
      candidates.add(`http://${address}:${urlPort(local)}`);
    }
    if (candidates.size === 0) candidates.add(local);
    return [...candidates];
  }

  createSession(input: PairingSessionInput): PairingSession {
    const now = this.#now();
    this.#store.deleteExpiredPairingTokens(now);

    const code = this.#codeGenerator();
    const formatted = formatPairingCode(code);
    if (!formatted) {
      throw new Error('The pairing code generator returned an invalid code.');
    }

    const ttlSeconds = input.ttlSeconds;
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
    const record = this.#store.insertPairingToken({
      tokenHash: hashSecret(code),
      ...(input.name ? { deviceNameHint: input.name } : {}),
      expiresAt,
    });

    const urls = this.baseUrls();
    const primary = urls[0];
    if (!primary) {
      throw new Error('Cockpit could not determine a URL for pairing.');
    }
    const deepLink = buildPairingDeepLink(primary, formatted);
    if (!deepLink) {
      throw new Error('Cockpit could not build a pairing deep link.');
    }

    this.#bus.emit('pairing.requested', {
      payload: {
        pairingId: record.id,
        expiresAt: expiresAt.toISOString(),
        ttlSeconds,
        ...(input.name ? { deviceNameHint: input.name } : {}),
      },
    });

    return {
      id: record.id,
      code: formatted,
      expiresAt: expiresAt.toISOString(),
      ttlSeconds,
      ...(input.name ? { name: input.name } : {}),
      urls,
      deepLink,
    };
  }

  getSession(id: string): PairingSessionStatus {
    const record = this.#store.getPairingToken(id);
    if (!record) {
      throw new PairingServiceError(
        404,
        'not_found',
        'The requested pairing session was not found.',
      );
    }

    const now = this.#now();
    const claimed = record.usedAt !== undefined;
    return {
      id: record.id,
      expiresAt: record.expiresAt.toISOString(),
      ...(record.usedAt ? { usedAt: record.usedAt.toISOString() } : {}),
      expired: !claimed && record.expiresAt.getTime() <= now.getTime(),
      claimed,
    };
  }

  cancelSession(id: string): void {
    const record = this.#store.getPairingToken(id);
    if (!record) {
      throw new PairingServiceError(
        404,
        'not_found',
        'The requested pairing session was not found.',
      );
    }
    if (record.usedAt) {
      throw new PairingServiceError(
        409,
        'conflict',
        'This pairing session has already been used and cannot be cancelled.',
      );
    }
    this.#store.deletePairingToken(id);
  }

  claim(input: PairingClaimInput, remoteAddress?: string): PairingClaimResponse {
    const now = this.#now();
    this.#assertClaimAllowed(remoteAddress, now);

    const code = normalizePairingCode(input.code);
    if (!code) {
      this.#recordClaimFailure(remoteAddress, now);
      throw new PairingServiceError(
        401,
        'unauthorized',
        'The pairing code is invalid or has expired.',
      );
    }

    const record = this.#store.getPairingTokenByHash(hashSecret(code));
    if (!record || record.usedAt || record.expiresAt.getTime() <= now.getTime()) {
      this.#recordClaimFailure(remoteAddress, now);
      throw new PairingServiceError(
        401,
        'unauthorized',
        'The pairing code is invalid or has expired.',
      );
    }

    if (!this.#store.consumePairingToken(record.id, now)) {
      this.#recordClaimFailure(remoteAddress, now);
      throw new PairingServiceError(
        409,
        'conflict',
        'This pairing code has already been used. Create a new one.',
      );
    }

    const token = this.#tokenGenerator();
    const name = input.name ?? record.deviceNameHint ?? PLATFORM_LABELS[input.platform];
    const device = this.#store.insertDevice({
      name,
      platform: input.platform,
      tokenHash: hashSecret(token),
    });

    if (remoteAddress) this.#failedClaims.delete(remoteAddress);

    this.#bus.emit('pairing.completed', {
      payload: {
        deviceId: device.id,
        name: device.name,
        platform: device.platform,
      },
    });

    return {
      device,
      token,
      baseUrl: this.baseUrl,
    };
  }

  listDevices(): Device[] {
    return this.#store.listDevices();
  }

  getDevice(id: string): Device {
    const device = this.#store.getDevice(id);
    if (!device) {
      throw new PairingServiceError(404, 'not_found', 'The requested device was not found.');
    }
    return device;
  }

  revokeDevice(id: string, options: RevokeDeviceOptions = {}): Device {
    const device = this.#store.getDevice(id);
    if (!device) {
      throw new PairingServiceError(404, 'not_found', 'The requested device was not found.');
    }
    if (options.actorDeviceId && options.actorDeviceId !== id) {
      throw new PairingServiceError(
        403,
        'forbidden',
        'A paired device may only revoke itself. Revoke other devices from the local dashboard.',
      );
    }
    if (device.revokedAt) return device;

    const revoked = this.#store.revokeDevice(id, this.#now());
    if (!revoked) {
      throw new PairingServiceError(404, 'not_found', 'The requested device was not found.');
    }

    this.#bus.emit('device.revoked', { payload: { deviceId: revoked.id } });
    this.#logger.info(`Cockpit revoked paired device ${revoked.id}`);
    return revoked;
  }

  /** Resolve a bearer token to an active device, touching last-seen lazily. */
  authenticate(token: string): Device | undefined {
    if (!token.startsWith(DEVICE_TOKEN_PREFIX)) return undefined;

    const device = this.#store.getDeviceByTokenHash(hashSecret(token));
    if (!device || device.revokedAt) return undefined;

    const nowMs = this.#now().getTime();
    const previous = this.#lastTouch.get(device.id) ?? 0;
    if (nowMs - previous >= DEVICE_TOUCH_INTERVAL_MS) {
      this.#lastTouch.set(device.id, nowMs);
      try {
        this.#store.touchDevice(device.id, new Date(nowMs));
        return this.#store.getDevice(device.id) ?? device;
      } catch (error) {
        this.#logger.warn('Cockpit could not update a paired device last-seen time', error);
      }
    }

    return device;
  }

  #assertClaimAllowed(remoteAddress: string | undefined, now: Date): void {
    if (!remoteAddress) return;
    const cutoff = now.getTime() - CLAIM_WINDOW_MS;
    const attempts = (this.#failedClaims.get(remoteAddress) ?? []).filter(
      (timestamp) => timestamp > cutoff,
    );
    if (attempts.length >= CLAIM_ATTEMPT_LIMIT) {
      this.#failedClaims.set(remoteAddress, attempts);
      throw new PairingServiceError(
        429,
        'rate_limited',
        'Too many pairing attempts. Wait a few minutes and try again.',
      );
    }
    this.#failedClaims.set(remoteAddress, attempts);
  }

  #recordClaimFailure(remoteAddress: string | undefined, now: Date): void {
    if (!remoteAddress) return;
    const cutoff = now.getTime() - CLAIM_WINDOW_MS;
    const attempts = (this.#failedClaims.get(remoteAddress) ?? []).filter(
      (timestamp) => timestamp > cutoff,
    );
    attempts.push(now.getTime());
    this.#failedClaims.set(remoteAddress, attempts);
  }
}

function lanIpv4Addresses(): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (entry.address.startsWith('169.254.')) continue;
      addresses.push(entry.address);
    }
  }
  return addresses;
}
