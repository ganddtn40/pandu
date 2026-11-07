import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import * as schema from './schema.js';

export type CockpitDatabase = BetterSQLite3Database<typeof schema>;

export interface CockpitDatabaseConnection {
  db: CockpitDatabase;
  raw: Database.Database;
  close: () => void;
}

export interface OpenDatabaseOptions {
  databasePath: string;
  migrationsFolder?: string;
  runMigrations?: boolean;
}

/**
 * Migrations live in `packages/daemon/drizzle`. Locate them relative to this
 * module so both `tsx src/...` during development and bundled `dist/index.js`
 * at runtime find the same folder.
 */
export function locateMigrationsFolder(
  startDirectory = path.dirname(fileURLToPath(import.meta.url)),
): string {
  let current = path.resolve(startDirectory);

  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = path.join(current, 'drizzle');
    if (existsSync(path.join(candidate, 'meta', '_journal.json'))) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new Error(
    `Could not locate the Cockpit migrations folder from ${startDirectory}. Run the build from the repository root.`,
  );
}

export function openDatabase(options: OpenDatabaseOptions): CockpitDatabaseConnection {
  const isMemory = options.databasePath === ':memory:';
  if (!isMemory) {
    mkdirSync(path.dirname(options.databasePath), { recursive: true });
  }

  const raw = new Database(options.databasePath);
  raw.pragma('foreign_keys = ON');
  raw.pragma('busy_timeout = 5000');
  raw.pragma('synchronous = NORMAL');
  if (!isMemory) {
    raw.pragma('journal_mode = WAL');
  }

  const db = drizzle(raw, { schema });

  if (options.runMigrations !== false) {
    migrate(db, {
      migrationsFolder: options.migrationsFolder ?? locateMigrationsFolder(),
    });
  }

  return {
    db,
    raw,
    close: () => {
      raw.close();
    },
  };
}
