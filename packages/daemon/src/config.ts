import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';

export const LOG_LEVELS = ['silent', 'error', 'warn', 'info', 'debug'] as const;
export const LogLevelSchema = z.enum(LOG_LEVELS);
export type LogLevel = z.infer<typeof LogLevelSchema>;

const nonEmptyString = z.string().trim().min(1);

function emptyToUndefined(value: unknown): unknown {
  return typeof value === 'string' && value.trim() === '' ? undefined : value;
}

const optionalString = z.preprocess(emptyToUndefined, nonEmptyString.optional());
const optionalUrl = z.preprocess(emptyToUndefined, z.string().url().optional());
const optionalHttpUrl = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .url()
    .refine((value) => {
      const protocol = new URL(value).protocol;
      return protocol === 'http:' || protocol === 'https:';
    }, 'Expected an http(s) URL.')
    .optional(),
);
const optionalPort = z.preprocess(
  emptyToUndefined,
  z.coerce.number().int().min(0).max(65_535).optional(),
);
const optionalPositiveInt = z.preprocess(
  emptyToUndefined,
  z.coerce.number().int().min(1).optional(),
);
const optionalLogLevel = z.preprocess(emptyToUndefined, LogLevelSchema.optional());
const optionalBoolean = z.preprocess(
  emptyToUndefined,
  z
    .enum([
      '1',
      '0',
      'true',
      'false',
      'yes',
      'no',
      'on',
      'off',
      'TRUE',
      'FALSE',
      'YES',
      'NO',
      'ON',
      'OFF',
    ])
    .transform((value) => ['1', 'true', 'yes', 'on'].includes(value.toLowerCase()))
    .optional(),
);

const EnvironmentSchema = z.object({
  COCKPIT_HOME: optionalString,
  COCKPIT_HOST: optionalString,
  COCKPIT_PORT: optionalPort,
  COCKPIT_DATABASE: optionalString,
  COCKPIT_OPENAI_UPSTREAM: optionalUrl,
  COCKPIT_OPENAI_BASE_URL: optionalUrl,
  COCKPIT_ANTHROPIC_UPSTREAM: optionalUrl,
  COCKPIT_ANTHROPIC_BASE_URL: optionalUrl,
  COCKPIT_OPENAI_API_KEY: optionalString,
  OPENAI_API_KEY: optionalString,
  COCKPIT_ANTHROPIC_API_KEY: optionalString,
  ANTHROPIC_API_KEY: optionalString,
  COCKPIT_ANTHROPIC_VERSION: optionalString,
  COCKPIT_ALLOWED_ORIGINS: optionalString,
  COCKPIT_PUBLIC_URL: optionalHttpUrl,
  COCKPIT_SESSION_IDLE_MS: optionalPositiveInt,
  COCKPIT_MAX_BODY_BYTES: optionalPositiveInt,
  COCKPIT_GUARD_APPROVAL_MS: optionalPositiveInt,
  COCKPIT_LOG_LEVEL: optionalLogLevel,
  COCKPIT_DEMO: optionalBoolean,
});

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 4319;
export const DEFAULT_SESSION_IDLE_MS = 30 * 60 * 1000;
export const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;
export const DEFAULT_GUARD_APPROVAL_MS = 120 * 1000;
export const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';
export const PROXY_KEY_SENTINEL = 'cockpit-proxy';

export interface CockpitPaths {
  home: string;
  databasePath: string;
  databaseDirectory: string;
  snapshotsDirectory: string;
  forksDirectory: string;
  brainDirectory: string;
  logsDirectory: string;
}

export interface UpstreamConfig {
  baseUrl: string;
  apiKey?: string;
}

export interface AnthropicUpstreamConfig extends UpstreamConfig {
  version: string;
}

export interface CockpitConfig {
  paths: CockpitPaths;
  host: string;
  port: number;
  databasePath: string;
  openai: UpstreamConfig;
  anthropic: AnthropicUpstreamConfig;
  allowedOrigins: readonly string[];
  publicUrl?: string;
  sessionIdleTimeoutMs: number;
  maxBodyBytes: number;
  guardApprovalTimeoutMs: number;
  logLevel: LogLevel;
  demoMode: boolean;
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

export function resolveCockpitPaths(env: NodeJS.ProcessEnv = process.env): CockpitPaths {
  const parsed = EnvironmentSchema.parse({
    COCKPIT_HOME: env['COCKPIT_HOME'],
  });
  const home = path.resolve(parsed.COCKPIT_HOME ?? path.join(homedir(), '.cockpit'));

  return {
    home,
    databasePath: path.join(home, 'cockpit.db'),
    databaseDirectory: home,
    snapshotsDirectory: path.join(home, 'snapshots'),
    forksDirectory: path.join(home, 'forks'),
    brainDirectory: path.join(home, 'brain'),
    logsDirectory: path.join(home, 'logs'),
  };
}

function parseAllowedOrigins(value: string | undefined): string[] {
  if (!value) return [];

  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)
    .map((origin) => {
      if (origin === '*') return origin;
      const parsed = z.string().url().safeParse(origin);
      if (!parsed.success) {
        throw new Error(`COCKPIT_ALLOWED_ORIGINS contains an invalid origin: ${origin}`);
      }
      return new URL(origin).origin;
    });
}

function resolveDatabasePath(candidate: string | undefined, fallback: string): string {
  if (!candidate) return fallback;
  if (candidate === ':memory:') return candidate;
  return path.resolve(candidate);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CockpitConfig {
  const parsed = EnvironmentSchema.parse(env);
  const paths = resolveCockpitPaths(env);

  const openaiBaseUrl =
    parsed.COCKPIT_OPENAI_UPSTREAM ?? parsed.COCKPIT_OPENAI_BASE_URL ?? 'https://api.openai.com';
  const anthropicBaseUrl =
    parsed.COCKPIT_ANTHROPIC_UPSTREAM ??
    parsed.COCKPIT_ANTHROPIC_BASE_URL ??
    'https://api.anthropic.com';

  const openaiKey = parsed.COCKPIT_OPENAI_API_KEY ?? parsed.OPENAI_API_KEY;
  const anthropicKey = parsed.COCKPIT_ANTHROPIC_API_KEY ?? parsed.ANTHROPIC_API_KEY;

  return {
    paths,
    host: parsed.COCKPIT_HOST ?? DEFAULT_HOST,
    port: parsed.COCKPIT_PORT ?? DEFAULT_PORT,
    databasePath: resolveDatabasePath(parsed.COCKPIT_DATABASE, paths.databasePath),
    openai: {
      baseUrl: stripTrailingSlashes(openaiBaseUrl),
      ...(openaiKey ? { apiKey: openaiKey } : {}),
    },
    anthropic: {
      baseUrl: stripTrailingSlashes(anthropicBaseUrl),
      ...(anthropicKey ? { apiKey: anthropicKey } : {}),
      version: parsed.COCKPIT_ANTHROPIC_VERSION ?? DEFAULT_ANTHROPIC_VERSION,
    },
    allowedOrigins: parseAllowedOrigins(parsed.COCKPIT_ALLOWED_ORIGINS),
    ...(parsed.COCKPIT_PUBLIC_URL
      ? { publicUrl: stripTrailingSlashes(parsed.COCKPIT_PUBLIC_URL) }
      : {}),
    sessionIdleTimeoutMs: parsed.COCKPIT_SESSION_IDLE_MS ?? DEFAULT_SESSION_IDLE_MS,
    maxBodyBytes: parsed.COCKPIT_MAX_BODY_BYTES ?? DEFAULT_MAX_BODY_BYTES,
    guardApprovalTimeoutMs: parsed.COCKPIT_GUARD_APPROVAL_MS ?? DEFAULT_GUARD_APPROVAL_MS,
    logLevel: parsed.COCKPIT_LOG_LEVEL ?? 'info',
    demoMode: parsed.COCKPIT_DEMO ?? false,
  };
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '127.0.0.1' ||
    normalized === '[::1]' ||
    normalized === '::1'
  );
}

export function isOriginAllowed(
  origin: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  if (!origin) return true;
  if (allowedOrigins.includes('*')) return true;

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }

  const normalized = parsed.origin;
  if (allowedOrigins.some((allowed) => allowed.toLowerCase() === normalized.toLowerCase())) {
    return true;
  }

  return isLoopbackHostname(parsed.hostname);
}

export function displayHostForUrl(host: string): string {
  if (host === '0.0.0.0' || host === '::' || host === '') return '127.0.0.1';
  if (host.includes(':') && !host.startsWith('[')) return `[${host}]`;
  return host;
}

/**
 * Loopback sockets are trusted because they belong to the machine running the
 * daemon. Remote devices must present a paired bearer token instead.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.trim().toLowerCase();
  if (normalized === '::1' || normalized === 'localhost') return true;
  if (normalized.startsWith('::ffff:')) return isLoopbackAddress(normalized.slice(7));
  return /^127(?:\.\d{1,3}){3}$/.test(normalized);
}
