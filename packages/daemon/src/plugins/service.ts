import { spawn } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  JsonObjectSchema,
  JsonValueSchema,
  PluginManifestSchema,
  type JsonObject,
  type JsonValue,
  type Plugin,
  type PluginManifest,
  type PluginRun,
  type PluginRunInput,
  type PluginRunStatus,
} from '@cockpit/core';

import type { Logger } from '../logger.js';
import type { Store } from '../store/store.js';

export class PluginServiceError extends Error {
  readonly status: number;
  readonly code: 'bad_request' | 'not_found' | 'conflict';

  constructor(status: number, code: PluginServiceError['code'], message: string) {
    super(message);
    this.name = 'PluginServiceError';
    this.status = status;
    this.code = code;
  }
}

export interface PluginServiceOptions {
  store: Store;
  logger: Logger;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface PluginRunResult {
  run: PluginRun;
}

interface InstalledPluginFiles {
  directory: string;
  manifest: PluginManifest;
  manifestJson: JsonObject;
}

interface ExecutionOutcome {
  status: PluginRunStatus;
  result?: JsonValue;
  error?: string;
}

const MANIFEST_FILE = 'cockpit-plugin.json';
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_PAYLOAD_STEPS = 200;
const MAX_PAYLOAD_PROVENANCE = 500;
const MAX_PAYLOAD_GUARD_EVENTS = 200;
const MAX_PAYLOAD_UNDERSTANDING = 200;
const MAX_TOOL_CALLS_PER_STEP = 100;
const MAX_PROMPT_CHARS = 4_000;
const MAX_RESPONSE_CHARS = 20_000;
const MAX_TOOL_INPUT_CHARS = 10_000;

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  if (relative === '') return true;
  if (path.isAbsolute(relative)) return false;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

function pluginEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'Path',
    'PATHEXT',
    'SystemRoot',
    'SYSTEMROOT',
    'windir',
    'ComSpec',
    'TEMP',
    'TMP',
    'TMPDIR',
    'HOME',
    'USERPROFILE',
  ]) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  environment['COCKPIT_PLUGIN'] = '1';
  environment['COCKPIT_PLUGIN_API'] = '1';
  return environment;
}

function capText(value: string, maximum: number): string {
  return value.length > maximum ? `${value.slice(0, maximum)}\n…[truncated]` : value;
}

function capJson(value: JsonValue | undefined, maximum: number): JsonValue | undefined {
  if (value === undefined) return undefined;
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { truncated: true, preview: '[unserializable]' };
  }
  if (serialized.length <= maximum) return value;
  return { truncated: true, preview: capText(serialized, maximum) };
}

function parseJsonValue(text: string): JsonValue | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const validated = JsonValueSchema.safeParse(parsed);
    return validated.success ? validated.data : undefined;
  } catch {
    return undefined;
  }
}

export class PluginService {
  readonly #store: Store;
  readonly #logger: Logger;
  readonly #timeoutMs: number;
  readonly #maxOutputBytes: number;

  constructor(options: PluginServiceOptions) {
    this.#store = options.store;
    this.#logger = options.logger;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#maxOutputBytes = options.maxOutputBytes ?? 1_000_000;
  }

  list(): Plugin[] {
    return this.#store.listPlugins();
  }

  get(id: string): Plugin | undefined {
    return this.#store.getPlugin(id);
  }

  runs(id: string, limit = 20): PluginRun[] {
    const plugin = this.#store.getPlugin(id);
    if (!plugin) {
      throw new PluginServiceError(404, 'not_found', 'The requested plugin was not found.');
    }
    return this.#store.listPluginRuns(id, limit);
  }

  async install(pluginPath: string): Promise<Plugin> {
    const files = await this.#readPluginFiles(pluginPath);
    const existing = this.#store.getPluginByName(files.manifest.name);

    if (existing) {
      const updated = this.#store.updatePlugin(existing.id, {
        version: files.manifest.version,
        path: files.directory,
        manifest: files.manifestJson,
        ...(files.manifest.description !== undefined
          ? { description: files.manifest.description }
          : {}),
      });
      if (!updated) throw new Error('Failed to update the plugin that was just reinstalled.');
      this.#logger.info('Reinstalled a plugin', { name: updated.name, id: updated.id });
      return updated;
    }

    const plugin = this.#store.insertPlugin({
      name: files.manifest.name,
      version: files.manifest.version,
      path: files.directory,
      manifest: files.manifestJson,
      ...(files.manifest.description !== undefined
        ? { description: files.manifest.description }
        : {}),
    });
    this.#logger.info('Installed a plugin', { name: plugin.name, id: plugin.id });
    return plugin;
  }

  setEnabled(id: string, enabled: boolean): Plugin {
    const updated = this.#store.updatePlugin(id, { enabled });
    if (!updated) {
      throw new PluginServiceError(404, 'not_found', 'The requested plugin was not found.');
    }
    return updated;
  }

  remove(id: string): boolean {
    const removed = this.#store.deletePlugin(id);
    if (!removed) {
      throw new PluginServiceError(404, 'not_found', 'The requested plugin was not found.');
    }
    return true;
  }

  async run(id: string, input: PluginRunInput): Promise<PluginRun> {
    const plugin = this.#store.getPlugin(id);
    if (!plugin) {
      throw new PluginServiceError(404, 'not_found', 'The requested plugin was not found.');
    }
    if (!plugin.enabled) {
      throw new PluginServiceError(
        409,
        'conflict',
        'This plugin is disabled. Enable it before running it.',
      );
    }

    const manifest = PluginManifestSchema.safeParse(plugin.manifest);
    if (!manifest.success) {
      throw new PluginServiceError(
        409,
        'conflict',
        'The stored plugin manifest is invalid. Reinstall the plugin.',
      );
    }

    const session = this.#store.getSession(input.sessionId);
    if (!session) {
      throw new PluginServiceError(404, 'not_found', 'The requested session was not found.');
    }
    if (input.stepId) {
      const step = this.#store.getStep(input.stepId);
      if (!step || step.sessionId !== session.id) {
        throw new PluginServiceError(404, 'not_found', 'The requested step was not found.');
      }
    }

    const entryPath = await this.#resolveEntry(plugin, manifest.data);
    const payload = this.#buildPayload(plugin, manifest.data, input);
    const startedAt = new Date();
    const outcome = await this.#execute(entryPath, plugin.path, payload);

    const run = this.#store.insertPluginRun({
      pluginId: plugin.id,
      sessionId: session.id,
      kind: manifest.data.kind,
      status: outcome.status,
      startedAt,
      endedAt: new Date(),
      ...(outcome.result === undefined ? {} : { result: outcome.result }),
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
    });

    this.#logger.debug('Ran a plugin', {
      pluginId: plugin.id,
      runId: run.id,
      status: run.status,
    });
    return run;
  }

  async #readPluginFiles(pluginPath: string): Promise<InstalledPluginFiles> {
    const requested = path.resolve(pluginPath);
    let info;
    try {
      info = await stat(requested);
    } catch {
      throw new PluginServiceError(
        400,
        'bad_request',
        `The plugin path does not exist: ${requested}`,
      );
    }

    const manifestPath = info.isDirectory() ? path.join(requested, MANIFEST_FILE) : requested;
    const directory = info.isDirectory() ? requested : path.dirname(requested);

    let manifestInfo;
    try {
      manifestInfo = await stat(manifestPath);
    } catch {
      throw new PluginServiceError(
        400,
        'bad_request',
        `The plugin directory does not contain ${MANIFEST_FILE}.`,
      );
    }
    if (!manifestInfo.isFile()) {
      throw new PluginServiceError(400, 'bad_request', 'The plugin manifest must be a file.');
    }
    if (manifestInfo.size > MAX_MANIFEST_BYTES) {
      throw new PluginServiceError(400, 'bad_request', 'The plugin manifest is too large.');
    }

    let raw: string;
    try {
      raw = await readFile(manifestPath, 'utf8');
    } catch {
      throw new PluginServiceError(400, 'bad_request', 'The plugin manifest could not be read.');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new PluginServiceError(400, 'bad_request', 'The plugin manifest is not valid JSON.');
    }

    const validated = PluginManifestSchema.safeParse(parsed);
    if (!validated.success) {
      throw new PluginServiceError(400, 'bad_request', 'The plugin manifest is invalid.');
    }

    let directoryReal: string;
    try {
      directoryReal = await realpath(directory);
    } catch {
      throw new PluginServiceError(400, 'bad_request', 'The plugin directory could not be read.');
    }

    await this.#assertEntry(directoryReal, validated.data);

    return {
      directory: directoryReal,
      manifest: validated.data,
      manifestJson: JsonObjectSchema.parse(validated.data),
    };
  }

  async #assertEntry(directory: string, manifest: PluginManifest): Promise<void> {
    const entryPath = path.resolve(directory, manifest.entry);
    if (!isWithin(directory, entryPath)) {
      throw new PluginServiceError(
        400,
        'bad_request',
        'The plugin entry must stay inside the plugin directory.',
      );
    }

    let entryReal: string;
    try {
      entryReal = await realpath(entryPath);
    } catch {
      throw new PluginServiceError(
        400,
        'bad_request',
        `The plugin entry does not exist: ${manifest.entry}`,
      );
    }
    if (!isWithin(directory, entryReal)) {
      throw new PluginServiceError(
        400,
        'bad_request',
        'The plugin entry resolves outside the plugin directory.',
      );
    }

    const info = await stat(entryReal);
    if (!info.isFile()) {
      throw new PluginServiceError(400, 'bad_request', 'The plugin entry must be a file.');
    }
  }

  async #resolveEntry(plugin: Plugin, manifest: PluginManifest): Promise<string> {
    let directory: string;
    try {
      directory = await realpath(plugin.path);
    } catch {
      throw new PluginServiceError(
        409,
        'conflict',
        'The plugin directory no longer exists. Reinstall the plugin.',
      );
    }
    await this.#assertEntry(directory, manifest);

    const entryPath = path.resolve(directory, manifest.entry);
    return realpath(entryPath);
  }

  #buildPayload(plugin: Plugin, manifest: PluginManifest, input: PluginRunInput): JsonObject {
    const session = this.#store.getSession(input.sessionId);
    if (!session) {
      throw new PluginServiceError(404, 'not_found', 'The requested session was not found.');
    }

    let steps = this.#store.listSteps(session.id, 2000);
    if (input.stepId) {
      const target = this.#store.getStep(input.stepId);
      if (!target) {
        throw new PluginServiceError(404, 'not_found', 'The requested step was not found.');
      }
      steps = steps.filter((step) => step.seq <= target.seq);
    }
    steps = steps.slice(-MAX_PAYLOAD_STEPS);

    const provenance = this.#store
      .listProvenanceEntries({
        ...(session.projectId ? { projectId: session.projectId } : {}),
        limit: MAX_PAYLOAD_PROVENANCE,
      })
      .filter((entry) => entry.sessionId === session.id);
    const guardEvents = this.#store.listGuardEvents({
      sessionId: session.id,
      limit: MAX_PAYLOAD_GUARD_EVENTS,
    });
    const understanding = session.projectId
      ? this.#store.listUnderstandingFiles({
          projectId: session.projectId,
          sessionId: session.id,
          limit: MAX_PAYLOAD_UNDERSTANDING,
        })
      : [];

    const payload: JsonObject = {
      apiVersion: 1,
      plugin: {
        name: manifest.name,
        version: manifest.version,
        kind: manifest.kind,
        permissions: [...manifest.permissions],
      },
      session: session as unknown as JsonObject,
      steps: steps.map((step) => {
        const toolCalls = this.#store
          .listToolCalls(step.id)
          .slice(0, MAX_TOOL_CALLS_PER_STEP)
          .map((call) => ({
            name: call.name,
            status: call.status,
            filePaths: call.filePaths.slice(0, 50),
            ...(call.input === undefined
              ? {}
              : { input: capJson(call.input, MAX_TOOL_INPUT_CHARS) ?? null }),
          }));

        return {
          id: step.id,
          seq: step.seq,
          kind: step.kind,
          status: step.status,
          ...(step.provider ? { provider: step.provider } : {}),
          ...(step.model ? { model: step.model } : {}),
          startedAt: step.startedAt,
          ...(step.endedAt ? { endedAt: step.endedAt } : {}),
          ...(step.durationMs === undefined ? {} : { durationMs: step.durationMs }),
          ...(step.error ? { error: step.error } : {}),
          ...(step.request
            ? {
                request: {
                  protocol: step.request.protocol,
                  method: step.request.method,
                  path: step.request.path,
                  ...(step.request.model ? { model: step.request.model } : {}),
                  ...(step.request.promptText
                    ? { promptText: capText(step.request.promptText, MAX_PROMPT_CHARS) }
                    : {}),
                },
              }
            : {}),
          ...(step.response
            ? {
                response: {
                  status: step.response.status,
                  ...(step.response.finishReason
                    ? { finishReason: step.response.finishReason }
                    : {}),
                  ...(step.response.text
                    ? { text: capText(step.response.text, MAX_RESPONSE_CHARS) }
                    : {}),
                },
              }
            : {}),
          usage: step.usage as unknown as JsonObject,
          costKnown: step.costKnown,
          ...(step.costUsd === undefined ? {} : { costUsd: step.costUsd }),
          toolCalls,
        };
      }),
      provenance: provenance as unknown as JsonValue[],
      guardEvents: guardEvents as unknown as JsonValue[],
      understanding: understanding as unknown as JsonValue[],
    };

    return JsonObjectSchema.parse(payload);
  }

  #execute(entryPath: string, cwd: string, payload: JsonObject): Promise<ExecutionOutcome> {
    return new Promise((resolve) => {
      let settled = false;
      let stdout = '';
      let stderr = '';
      let truncated = false;
      let timedOut = false;

      const finish = (outcome: ExecutionOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      };

      const child = spawn(process.execPath, [entryPath], {
        cwd,
        env: pluginEnvironment(),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, this.#timeoutMs);

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (truncated) return;
        if (stdout.length + chunk.length > this.#maxOutputBytes) {
          stdout += chunk.slice(0, Math.max(0, this.#maxOutputBytes - stdout.length));
          truncated = true;
          return;
        }
        stdout += chunk;
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        if (stderr.length >= MAX_STDERR_BYTES) return;
        stderr += chunk.slice(0, MAX_STDERR_BYTES - stderr.length);
      });

      child.on('error', (error: Error) => {
        finish({
          status: 'error',
          error: `The plugin process could not start: ${error.message}`,
        });
      });

      child.on('close', (code, signal) => {
        if (timedOut) {
          finish({
            status: 'timeout',
            error: `The plugin did not finish within ${this.#timeoutMs}ms.`,
          });
          return;
        }
        if (truncated) {
          finish({
            status: 'error',
            error: `The plugin wrote more than ${this.#maxOutputBytes} bytes to stdout.`,
          });
          return;
        }
        if (code !== 0) {
          const detail = stderr.trim() || stdout.trim();
          finish({
            status: 'error',
            error: capText(
              `The plugin exited with ${code === null ? `signal ${signal ?? 'unknown'}` : `code ${code}`}.${detail ? `\n${detail}` : ''}`,
              10_000,
            ),
          });
          return;
        }

        const parsed = parseJsonValue(stdout);
        if (parsed !== undefined) {
          finish({ status: 'ok', result: parsed });
          return;
        }
        finish({
          status: 'ok',
          result: { text: capText(stdout.trim(), this.#maxOutputBytes) },
        });
      });

      child.stdin.on('error', () => {
        // The plugin may exit before reading stdin; the exit status decides the run.
      });
      child.stdin.end(JSON.stringify(payload), 'utf8');
    });
  }
}
