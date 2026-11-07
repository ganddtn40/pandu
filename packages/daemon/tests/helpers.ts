import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Context } from 'hono';

import { loadConfig, startDaemon, type StartedDaemon } from '../src/index.js';

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export function capturedBodyText(body: Buffer): string {
  return body.toString('utf8');
}

export interface CapturedUpstreamRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export type UpstreamHandler = (
  request: CapturedUpstreamRequest,
  response: ServerResponse,
) => void | Promise<void>;

export interface FakeUpstream {
  url: string;
  requests: CapturedUpstreamRequest[];
  close: () => Promise<void>;
}

export async function startUpstream(handler: UpstreamHandler): Promise<FakeUpstream> {
  const requests: CapturedUpstreamRequest[] = [];

  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }

      const captured: CapturedUpstreamRequest = {
        method: request.method ?? 'GET',
        url: request.url ?? '/',
        headers: request.headers,
        body: Buffer.concat(chunks),
      };
      requests.push(captured);

      try {
        await handler(captured, response);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!response.headersSent) {
          response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        }
        response.end(`fake upstream failed: ${message}`);
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address() as AddressInfo | null;
  if (!address || typeof address === 'string') {
    throw new Error('The fake upstream did not report a listening port.');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

export interface StartTestDaemonOptions {
  home: string;
  openAiUpstream: string;
  anthropicUpstream?: string;
  env?: NodeJS.ProcessEnv;
  webRoot?: string;
  resolveRemoteAddress?: (c: Context) => string | undefined;
}

// Undici refuses to connect to a small set of ports. An ephemeral port can
// occasionally land on one, which would make every fetch in a test fail with
// "bad port". Retry with a fresh ephemeral port instead of guessing a range.
const UNDICI_BLOCKED_PORTS = new Set([6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);

export async function startTestDaemon(options: StartTestDaemonOptions): Promise<StartedDaemon> {
  const config = loadConfig({
    COCKPIT_HOME: options.home,
    COCKPIT_DATABASE: ':memory:',
    COCKPIT_HOST: '127.0.0.1',
    COCKPIT_PORT: '0',
    COCKPIT_LOG_LEVEL: 'silent',
    COCKPIT_OPENAI_UPSTREAM: options.openAiUpstream,
    COCKPIT_ANTHROPIC_UPSTREAM: options.anthropicUpstream ?? options.openAiUpstream,
    COCKPIT_OPENAI_API_KEY: 'sk-test-openai',
    COCKPIT_ANTHROPIC_API_KEY: 'sk-ant-test-anthropic',
    COCKPIT_ANTHROPIC_VERSION: '2023-06-01',
    ...options.env,
  });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const daemon = await startDaemon({
      config,
      ...(options.webRoot === undefined ? {} : { webRoot: options.webRoot }),
      ...(options.resolveRemoteAddress
        ? { resolveRemoteAddress: options.resolveRemoteAddress }
        : {}),
    });
    if (!UNDICI_BLOCKED_PORTS.has(daemon.port)) return daemon;
    await daemon.close();
  }

  throw new Error('Could not bind the test daemon to a port fetch is allowed to use.');
}

export async function waitFor<T>(
  probe: () => T | undefined,
  options: { timeoutMs?: number; intervalMs?: number; description?: string } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 4_000;
  const intervalMs = options.intervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${options.description ?? 'a condition'}.`);
    }
    await delay(intervalMs);
  }
}

export async function readAllBytes(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      if (result.value) chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}
