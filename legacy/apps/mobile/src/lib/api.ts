import {
  ApiErrorSchema,
  HealthResponseSchema,
  PairingClaimResponseSchema,
  SessionListResponseSchema,
  StatsResponseSchema,
  DeviceResponseSchema,
  normalizePairingCode,
  type ApiErrorCode,
  type Device,
  type HealthResponse,
  type PairingClaimResponse,
  type Session,
  type OverviewStats,
} from '@cockpit/core';
import type { z } from 'zod';

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface MobileApiClientOptions {
  baseUrl: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

export interface PairingClaimRequest {
  code: string;
  name?: string;
}

export interface MobileApiClient {
  health: (options?: RequestOptions) => Promise<HealthResponse>;
  stats: (options?: RequestOptions) => Promise<OverviewStats>;
  listSessions: (options?: RequestOptions) => Promise<Session[]>;
  claimPairing: (
    input: PairingClaimRequest,
    options?: RequestOptions,
  ) => Promise<PairingClaimResponse>;
  revokeDevice: (id: string, options?: RequestOptions) => Promise<Device>;
}

export class MobileApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;

  constructor(status: number, code: ApiErrorCode, message: string) {
    super(message);
    this.name = 'MobileApiError';
    this.status = status;
    this.code = code;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError';
}

function messageForStatus(status: number): string {
  if (status === 401) return 'This device is not paired with the daemon, or its token was revoked.';
  if (status === 403) return 'This device is not allowed to perform that action.';
  if (status === 404) return 'The daemon could not find that resource.';
  return `The daemon responded with HTTP ${String(status)}.`;
}

export function createMobileClient(options: MobileApiClientOptions): MobileApiClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const token = options.token;

  async function request<T>(
    path: string,
    schema: z.ZodType<T>,
    requestOptions: RequestOptions & { method?: string; body?: unknown; auth?: boolean } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (requestOptions.body !== undefined) headers['content-type'] = 'application/json';
    if (requestOptions.auth !== false && token) headers.authorization = `Bearer ${token}`;

    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        headers,
        ...(requestOptions.method ? { method: requestOptions.method } : {}),
        ...(requestOptions.body === undefined ? {} : { body: JSON.stringify(requestOptions.body) }),
        ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new MobileApiError(
        0,
        'internal_error',
        'Cockpit could not reach the daemon. Check the address and that the daemon is running.',
      );
    }

    if (!response.ok) {
      let code: ApiErrorCode = 'internal_error';
      let message = messageForStatus(response.status);
      try {
        const parsed = ApiErrorSchema.safeParse(await response.json());
        if (parsed.success) {
          code = parsed.data.error.code;
          message = parsed.data.error.message;
        }
      } catch {
        // Keep the status-based fallback when the body is not JSON.
      }
      throw new MobileApiError(response.status, code, message);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new MobileApiError(
        response.status,
        'internal_error',
        'The daemon returned a response Cockpit could not read.',
      );
    }

    try {
      return schema.parse(payload);
    } catch {
      throw new MobileApiError(
        response.status,
        'internal_error',
        'The daemon returned a response Cockpit could not understand.',
      );
    }
  }

  return {
    async health(requestOptions = {}) {
      return request('/api/health', HealthResponseSchema, {
        ...requestOptions,
        auth: false,
      });
    },
    async stats(requestOptions = {}) {
      const response = await request('/api/stats', StatsResponseSchema, requestOptions);
      return response.stats;
    },
    async listSessions(requestOptions = {}) {
      const response = await request(
        '/api/sessions?limit=50',
        SessionListResponseSchema,
        requestOptions,
      );
      return response.sessions;
    },
    async claimPairing(input, requestOptions = {}) {
      const code = normalizePairingCode(input.code);
      if (!code) {
        throw new MobileApiError(
          0,
          'bad_request',
          'Enter the eight-character code shown in the Cockpit dashboard.',
        );
      }
      return request('/api/pairing/claim', PairingClaimResponseSchema, {
        ...requestOptions,
        method: 'POST',
        auth: false,
        body: {
          code,
          platform: 'android',
          ...(input.name && input.name.trim().length > 0 ? { name: input.name.trim() } : {}),
        },
      });
    },
    async revokeDevice(id, requestOptions = {}) {
      const response = await request(
        `/api/devices/${encodeURIComponent(id)}`,
        DeviceResponseSchema,
        { ...requestOptions, method: 'DELETE' },
      );
      return response.device;
    },
  };
}

export interface ClaimDeviceInput {
  baseUrl: string;
  code: string;
  name?: string;
}

export async function claimDevice(input: ClaimDeviceInput): Promise<PairingClaimResponse> {
  const client = createMobileClient({ baseUrl: input.baseUrl });
  return client.claimPairing({
    code: input.code,
    ...(input.name ? { name: input.name } : {}),
  });
}

export function describeMobileError(error: unknown): string {
  if (error instanceof MobileApiError) return error.message;
  if (error instanceof Error && error.message.length > 0) return error.message;
  return 'An unexpected error occurred.';
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof MobileApiError && error.status === 401;
}
