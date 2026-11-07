import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createId } from '@cockpit/core';

import { openDatabase, type CockpitDatabaseConnection } from '../src/db/client.js';
import { projects, sessions, steps } from '../src/db/schema.js';

describe('database', () => {
  let directory: string;
  let connection: CockpitDatabaseConnection | undefined;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'cockpit-db-'));
  });

  afterEach(() => {
    connection?.close();
    connection = undefined;
    rmSync(directory, { recursive: true, force: true });
  });

  it('applies migrations and persists a project, session, and step', () => {
    connection = openDatabase({ databasePath: path.join(directory, 'cockpit.db') });
    const projectId = createId();
    const sessionId = createId();
    const stepId = createId();
    const startedAt = new Date();

    connection.db
      .insert(projects)
      .values({ id: projectId, name: 'Cockpit', rootPath: 'C:\\projects\\cockpit' })
      .run();
    connection.db
      .insert(sessions)
      .values({
        id: sessionId,
        projectId,
        title: 'Refactor the proxy',
        provider: 'openai',
        protocol: 'openai',
        model: 'gpt-4.1',
        startedAt,
        tags: ['refactor'],
      })
      .run();
    connection.db
      .insert(steps)
      .values({
        id: stepId,
        sessionId,
        seq: 1,
        kind: 'model',
        status: 'completed',
        startedAt,
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 0.0006,
        costKnown: true,
      })
      .run();

    const storedSession = connection.db.select().from(sessions).get();
    const storedStep = connection.db.select().from(steps).get();
    const storedProject = connection.db.select().from(projects).get();

    expect(storedProject?.name).toBe('Cockpit');
    expect(storedSession?.title).toBe('Refactor the proxy');
    expect(storedSession?.tags).toEqual(['refactor']);
    expect(storedSession?.stepCount).toBe(0);
    expect(storedStep?.inputTokens).toBe(100);
    expect(storedStep?.costKnown).toBe(true);
  });

  it('enforces foreign keys with cascade deletes', () => {
    connection = openDatabase({ databasePath: path.join(directory, 'cascade.db') });
    const projectId = createId();
    const sessionId = createId();

    connection.db
      .insert(projects)
      .values({ id: projectId, name: 'Cascade', rootPath: 'C:\\projects\\cascade' })
      .run();
    connection.db
      .insert(sessions)
      .values({ id: sessionId, projectId, title: 'Doomed session', startedAt: new Date() })
      .run();

    connection.raw.prepare('DELETE FROM projects WHERE id = ?').run(projectId);

    const count = connection.raw.prepare('SELECT COUNT(*) AS count FROM sessions').get() as {
      count: number;
    };
    expect(count.count).toBe(0);
  });

  it('enforces unique step sequence numbers within a session', () => {
    connection = openDatabase({ databasePath: path.join(directory, 'unique.db') });
    const sessionId = createId();
    const startedAt = new Date();

    connection.db
      .insert(sessions)
      .values({ id: sessionId, title: 'Unique sequences', startedAt })
      .run();
    connection.db
      .insert(steps)
      .values({
        id: createId(),
        sessionId,
        seq: 1,
        kind: 'model',
        status: 'running',
        startedAt,
      })
      .run();

    expect(() =>
      connection?.db
        .insert(steps)
        .values({
          id: createId(),
          sessionId,
          seq: 1,
          kind: 'tool',
          status: 'running',
          startedAt,
        })
        .run(),
    ).toThrow();
  });

  it('can reopen a database without rerunning destructive migrations', () => {
    const databasePath = path.join(directory, 'reopen.db');
    connection = openDatabase({ databasePath });
    connection.db
      .insert(projects)
      .values({ id: createId(), name: 'Persisted', rootPath: 'C:\\projects\\persisted' })
      .run();
    connection.close();
    connection = undefined;

    connection = openDatabase({ databasePath });
    const rows = connection.db.select().from(projects).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('Persisted');
  });
});
