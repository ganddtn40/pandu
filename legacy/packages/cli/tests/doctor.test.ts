import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  checkPort,
  formatDoctorReport,
  runDoctor,
  summarizeChecks,
  type DoctorCheck,
} from '../src/doctor.js';

const directories: string[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'cockpit-cli-doctor-'));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

describe('doctor reporting', () => {
  it('sets a failing exit code only for failed checks', () => {
    const checks: DoctorCheck[] = [
      { name: 'one', status: 'ok', detail: '' },
      { name: 'two', status: 'warn', detail: '' },
    ];
    expect(summarizeChecks(checks).exitCode).toBe(0);

    expect(
      summarizeChecks([...checks, { name: 'three', status: 'fail', detail: '' }]).exitCode,
    ).toBe(1);
  });

  it('formats counts with correct singular and plural labels', () => {
    const report = summarizeChecks([
      { name: 'Node.js', status: 'ok', detail: 'v22' },
      { name: 'Daemon', status: 'warn', detail: 'not running' },
      { name: 'Database', status: 'fail', detail: 'broken' },
    ]);

    const text = formatDoctorReport(report);
    expect(text).toContain('Cockpit doctor');
    expect(text).toContain('[ok]    Node.js');
    expect(text).toContain('[warn]  Daemon');
    expect(text).toContain('[fail]  Database');
    expect(text).toContain('1 ok · 1 warning · 1 failure');

    const plural = formatDoctorReport(
      summarizeChecks([
        { name: 'a', status: 'warn', detail: '' },
        { name: 'b', status: 'warn', detail: '' },
        { name: 'c', status: 'fail', detail: '' },
        { name: 'd', status: 'fail', detail: '' },
      ]),
    );
    expect(plural).toContain('0 ok · 2 warnings · 2 failures');
  });
});

describe('checkPort', () => {
  it('reports port zero as available without binding', async () => {
    await expect(checkPort('127.0.0.1', 0)).resolves.toEqual({
      available: true,
      detail: 'port 0 selects an available port at startup',
    });
  });

  it('detects an occupied port', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      server.close();
      throw new Error('The test server did not report a port.');
    }

    try {
      const result = await checkPort('127.0.0.1', address.port);
      expect(result.available).toBe(false);
      expect(result.detail).toContain('already in use');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('runDoctor', () => {
  it('checks the local install and reports a stopped daemon as a warning', async () => {
    const directory = tempDirectory();
    const report = await runDoctor({
      env: {
        COCKPIT_HOME: path.join(directory, 'home'),
        COCKPIT_DATABASE: path.join(directory, 'cockpit.db'),
        COCKPIT_HOST: '127.0.0.1',
        COCKPIT_PORT: '0',
        COCKPIT_OPENAI_API_KEY: 'sk-test-openai',
      },
    });

    expect(report.exitCode).toBe(0);
    const byName = new Map(report.checks.map((check) => [check.name, check]));
    expect(byName.get('Node.js')?.status).toBe('ok');
    expect(byName.get('Platform')?.status).toBe('ok');
    expect(byName.get('Cockpit home')?.status).toBe('ok');
    expect(byName.get('Database')?.status).toBe('ok');
    expect(byName.get('Database')?.detail).toContain('tables');
    expect(byName.get('Daemon')?.status).toBe('warn');
    expect(byName.get('Daemon')?.detail).toContain('not running');
    expect(byName.get('Port')?.status).toBe('ok');
    expect(byName.get('Credentials')?.status).toBe('ok');
    expect(byName.get('Credentials')?.detail).toContain('OpenAI');
    expect(byName.get('Upstreams')?.status).toBe('ok');
    expect(byName.get('Git')?.status).toBe('ok');
  });
});
