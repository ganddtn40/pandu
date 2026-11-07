import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { isCockpitHealth, normalizeDaemonUrl, probeDaemon } from '../ui/app.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('normalizeDaemonUrl', () => {
  it('adds a scheme to a bare loopback address', () => {
    assert.equal(normalizeDaemonUrl('127.0.0.1:4319'), 'http://127.0.0.1:4319');
  });

  it('normalizes to an origin and drops trailing paths', () => {
    assert.equal(
      normalizeDaemonUrl('http://localhost:4319/pair?code=ABCD'),
      'http://localhost:4319',
    );
  });

  it('keeps https origins', () => {
    assert.equal(normalizeDaemonUrl('https://cockpit.example.com/'), 'https://cockpit.example.com');
  });

  it('rejects empty, malformed, and non-http values', () => {
    assert.equal(normalizeDaemonUrl(''), null);
    assert.equal(normalizeDaemonUrl('   '), null);
    assert.equal(normalizeDaemonUrl('ftp://127.0.0.1:4319'), null);
    assert.equal(normalizeDaemonUrl('not a url'), null);
  });

  it('rejects embedded credentials', () => {
    assert.equal(normalizeDaemonUrl('http://user:secret@127.0.0.1:4319'), null);
  });
});

describe('isCockpitHealth', () => {
  it('accepts the daemon health envelope', () => {
    assert.equal(isCockpitHealth({ ok: true, service: 'cockpit-daemon', version: '0.1.0' }), true);
  });

  it('rejects other services and error payloads', () => {
    assert.equal(isCockpitHealth({ ok: true, service: 'something-else' }), false);
    assert.equal(isCockpitHealth({ ok: false, service: 'cockpit-daemon' }), false);
    assert.equal(isCockpitHealth(null), false);
    assert.equal(isCockpitHealth('ok'), false);
  });
});

describe('probeDaemon', () => {
  it('requests the health endpoint and returns the payload', async () => {
    const calls = [];
    const payload = await probeDaemon('http://127.0.0.1:4319', async (input, init) => {
      calls.push({ input, init });
      return new Response(
        JSON.stringify({ ok: true, service: 'cockpit-daemon', version: '0.1.0' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    assert.equal(payload.service, 'cockpit-daemon');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].input, 'http://127.0.0.1:4319/api/health');
    assert.equal(calls[0].init.headers.accept, 'application/json');
  });

  it('rejects an HTTP error', async () => {
    await assert.rejects(
      probeDaemon('http://127.0.0.1:4319', async () => new Response(null, { status: 503 })),
      /HTTP 503/,
    );
  });

  it('rejects a response that is not a Cockpit daemon', async () => {
    await assert.rejects(
      probeDaemon(
        'http://127.0.0.1:4319',
        async () =>
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
      /not a Cockpit daemon/,
    );
  });
});

describe('desktop shell assets', () => {
  it('ships a launcher with an iframe and an accessible connect form', () => {
    const html = readFileSync(path.join(root, 'ui/index.html'), 'utf8');
    assert.match(html, /<iframe[\s\S]*id="dashboard-frame"/);
    assert.match(html, /<form id="connect-form"/);
    assert.match(html, /aria-labelledby="launcher-title"/);
    assert.match(html, /role="alert"/);
    assert.match(html, /type="module" src="\.\/app\.js"/);
  });

  it('declares loopback frame and connect permissions in the CSP', () => {
    const config = JSON.parse(readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
    assert.match(config.app.security.csp, /frame-src[^;]*http:\/\/127\.0\.0\.1:\*/);
    assert.match(config.app.security.csp, /connect-src[^;]*http:\/\/localhost:\*/);
    assert.equal(config.build.frontendDist, '../ui');
  });
});
