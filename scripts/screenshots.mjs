#!/usr/bin/env node
/**
 * Capture real dashboard screenshots from a seeded demo daemon.
 *
 * Usage:
 *   pnpm build
 *   pnpm screenshots
 *
 * The script starts an in-memory daemon with the built dashboard, seeds the
 * same demo data as `cockpit demo`, and drives a locally installed Chrome or
 * Edge through the DevTools protocol. It never contacts an agent or provider.
 *
 * Set COCKPIT_CHROME to an explicit browser executable if auto-detection fails.
 */
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const daemonEntry = path.join(root, 'packages', 'daemon', 'dist', 'index.js');
const webRoot = path.join(root, 'apps', 'web', 'dist');
const outputDir = path.join(root, 'docs', 'assets');

const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1 };

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message) {
  throw new Error(message);
}

function findBrowser() {
  const override = process.env['COCKPIT_CHROME'];
  if (override) {
    if (!existsSync(override)) fail(`COCKPIT_CHROME does not exist: ${override}`);
    return override;
  }

  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env['LOCALAPPDATA'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ].filter((candidate) => candidate.length > 0);

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  fail('No Chrome or Edge installation was found. Set COCKPIT_CHROME to a browser executable.');
}

class CdpClient {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #events = new EventEmitter();

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(
          typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8'),
        );
      } catch {
        return;
      }

      if (typeof message.id === 'number') {
        const entry = this.#pending.get(message.id);
        if (!entry) return;
        this.#pending.delete(message.id);
        if (message.error) {
          entry.reject(new Error(message.error.message ?? 'DevTools command failed'));
        } else {
          entry.resolve(message.result ?? {});
        }
        return;
      }

      if (typeof message.method === 'string') {
        this.#events.emit(message.method, message.params ?? {}, message.sessionId);
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId === undefined ? {} : { sessionId }),
        }),
      );
    });
  }

  waitFor(method, sessionId, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#events.off(method, handler);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);

      const handler = (params, eventSessionId) => {
        if (sessionId !== undefined && eventSessionId !== sessionId) return;
        clearTimeout(timer);
        this.#events.off(method, handler);
        resolve(params);
      };

      this.#events.on(method, handler);
    });
  }

  close() {
    this.#socket.close();
  }
}

async function connectToBrowser(port, browserPath) {
  let endpoint = browserPath;
  if (!endpoint) {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (!response.ok) fail(`Chrome returned ${response.status} from /json/version`);
    const version = await response.json();
    endpoint = version.webSocketDebuggerUrl;
  }
  if (typeof endpoint !== 'string' || endpoint.length === 0) {
    fail('Chrome did not report a DevTools WebSocket endpoint');
  }

  const socket = new globalThis.WebSocket(
    endpoint.startsWith('ws://') ? endpoint : `ws://127.0.0.1:${port}${endpoint}`,
  );
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out connecting to Chrome')), 15_000);
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        reject(new Error('Chrome refused the DevTools connection'));
      },
      { once: true },
    );
  });
  return new CdpClient(socket);
}

async function launchBrowser(executable) {
  const profile = mkdtempSync(path.join(os.tmpdir(), 'cockpit-chrome-'));
  const child = spawn(
    executable,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--mute-audio',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--remote-allow-origins=*',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
  );

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-4_000);
  });

  const portFile = path.join(profile, 'DevToolsActivePort');
  let port;
  let browserPath;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (existsSync(portFile)) {
      const [firstLine, secondLine] = readFileSync(portFile, 'utf8').split(/\r?\n/);
      const parsed = Number(firstLine);
      if (Number.isInteger(parsed) && parsed > 0) {
        port = parsed;
        browserPath = secondLine;
        break;
      }
    }
    if (child.exitCode !== null) {
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      fail(`Chrome exited before it was ready.\n${stderr.trim()}`);
    }
    await delay(100);
  }

  if (port === undefined) {
    child.kill();
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    fail(`Chrome did not open a DevTools port.\n${stderr.trim()}`);
  }

  let client;
  try {
    client = await connectToBrowser(port, browserPath);
  } catch (error) {
    child.kill();
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    throw error;
  }

  return {
    client,
    profile,
    async close() {
      await client.send('Browser.close').catch(() => undefined);
      await new Promise((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          child.kill();
          resolve();
        }, 5_000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      client.close();
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}

async function waitForPage(client, sessionId, expectedText, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  let stableTicks = 0;

  while (Date.now() < deadline) {
    const { result } = await client.send(
      'Runtime.evaluate',
      {
        expression: `(() => {
          const skeletons = document.querySelectorAll('.skeleton').length;
          const busy = document.querySelectorAll('[aria-busy="true"]').length;
          const hasText = document.body.innerText.includes(${JSON.stringify(expectedText)});
          return document.readyState === 'complete' && skeletons === 0 && busy === 0 && hasText;
        })()`,
        returnByValue: true,
      },
      sessionId,
    );

    if (result.value === true) {
      stableTicks += 1;
      if (stableTicks >= 3) return;
    } else {
      stableTicks = 0;
    }

    await delay(250);
  }

  fail(`The page did not finish loading. Expected text: ${JSON.stringify(expectedText)}`);
}

function pngDimensions(file) {
  const buffer = readFileSync(file);
  const signature = buffer.subarray(0, 8).toString('hex');
  if (signature !== '89504e470d0a1a0a') fail(`${file} is not a PNG`);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function capture(client, shot) {
  const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });

  try {
    await client.send('Page.enable', {}, sessionId);
    await client.send(
      'Emulation.setDeviceMetricsOverride',
      { ...VIEWPORT, mobile: false },
      sessionId,
    );
    await client.send(
      'Emulation.setEmulatedMedia',
      { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] },
      sessionId,
    );

    const loaded = client.waitFor('Page.loadEventFired', sessionId);
    await client.send('Page.navigate', { url: shot.url }, sessionId);
    await loaded;

    await client.send(
      'Runtime.evaluate',
      {
        expression: 'document.fonts.ready.then(() => true)',
        awaitPromise: true,
        returnByValue: true,
      },
      sessionId,
    );

    await waitForPage(client, sessionId, shot.expect);
    await delay(800);

    const { data } = await client.send(
      'Page.captureScreenshot',
      { format: 'png', fromSurface: true },
      sessionId,
    );
    const file = path.join(outputDir, `${shot.name}.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));

    const dimensions = pngDimensions(file);
    const bytes = statSync(file).size;
    if (bytes < 10_000) fail(`${shot.name}.png is suspiciously small (${bytes} bytes)`);
    if (dimensions.width !== VIEWPORT.width || dimensions.height !== VIEWPORT.height) {
      fail(
        `${shot.name}.png is ${dimensions.width}x${dimensions.height}, expected ` +
          `${VIEWPORT.width}x${VIEWPORT.height}`,
      );
    }

    console.log(
      `screenshots: ${shot.name}.png ${dimensions.width}x${dimensions.height} ` +
        `(${Math.round(bytes / 1024)} KiB)`,
    );
  } finally {
    await client.send('Target.closeTarget', { targetId }).catch(() => undefined);
  }
}

async function main() {
  if (!existsSync(daemonEntry)) {
    fail('packages/daemon/dist is missing. Run "pnpm build" first.');
  }
  if (!existsSync(path.join(webRoot, 'index.html'))) {
    fail('apps/web/dist is missing. Run "pnpm --filter @cockpit/web build" first.');
  }

  const browser = findBrowser();
  console.log(`screenshots: browser ${browser}`);

  const { loadConfig, seedDemoData, startDaemon } = await import(pathToFileURL(daemonEntry).href);

  const home = mkdtempSync(path.join(os.tmpdir(), 'cockpit-shots-home-'));
  const config = loadConfig({
    COCKPIT_HOME: home,
    COCKPIT_DATABASE: ':memory:',
    COCKPIT_HOST: '127.0.0.1',
    COCKPIT_PORT: '0',
    COCKPIT_LOG_LEVEL: 'silent',
    COCKPIT_DEMO: '1',
    COCKPIT_OPENAI_UPSTREAM: 'http://127.0.0.1:9',
    COCKPIT_ANTHROPIC_UPSTREAM: 'http://127.0.0.1:9',
  });

  let daemon;
  let chrome;

  try {
    daemon = await startDaemon({ config, webRoot });
    const seed = seedDemoData(daemon.store, {
      workspacePath: '/Users/demo/projects/aurora-notes',
    });
    console.log(`screenshots: seeded ${seed.sessions.length} flights, ${seed.totals.steps} steps`);

    mkdirSync(outputDir, { recursive: true });

    const sessionPath = `/sessions/${seed.sessionId}`;
    const shots = [
      {
        name: 'overview',
        url: `${daemon.url}/`,
        expect: 'Every agent flight,',
      },
      {
        name: 'flight-log',
        url: `${daemon.url}/sessions`,
        expect: 'Demo flight: add checkout rate limiting',
      },
      {
        name: 'session',
        url: `${daemon.url}${sessionPath}`,
        expect: 'Demo flight: add checkout rate limiting',
      },
      {
        name: 'replay',
        url: `${daemon.url}${sessionPath}/replay`,
        expect: 'Demo flight: add checkout rate limiting',
      },
      {
        name: 'trust',
        url: `${daemon.url}${sessionPath}/trust`,
        expect: 'Did the agent earn it',
      },
      {
        name: 'context',
        url: `${daemon.url}${sessionPath}/context`,
        expect: 'What did the agent actually read',
      },
      {
        name: 'understanding',
        url: `${daemon.url}/debt`,
        expect: 'Understanding debt',
      },
      {
        name: 'guards',
        url: `${daemon.url}/guards`,
        expect: 'Guards',
      },
      {
        name: 'analytics',
        url: `${daemon.url}/analytics`,
        expect: 'Analytics',
      },
    ];

    chrome = await launchBrowser(browser);

    for (const shot of shots) {
      await capture(chrome.client, shot);
    }

    console.log(`screenshots: wrote ${shots.length} images to docs/assets`);
  } finally {
    if (chrome) await chrome.close().catch(() => undefined);
    if (daemon) await daemon.close().catch(() => undefined);
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

main().catch((error) => {
  console.error(`screenshots: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
