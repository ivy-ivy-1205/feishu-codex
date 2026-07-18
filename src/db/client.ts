import { mkdirSync } from 'node:fs';
import { dirname, parse } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

export interface SqliteDatabase {
  client: Database.Database;
  db: BetterSQLite3Database<typeof schema>;
  close(): void;
}

export function createSqliteDatabase(filename: string): SqliteDatabase {
  ensureSqliteParentDirectory(filename);
  const client = new Database(filename);
  client.pragma('foreign_keys = ON');

  return {
    client,
    db: drizzle({ client, schema }),
    close: () => client.close()
  };
}

function ensureSqliteParentDirectory(filename: string): void {
  if (filename === ':memory:') {
    return;
  }
  const parentDirectory = dirname(filename);
  if (parentDirectory === '.' || parentDirectory === parse(parentDirectory).root) {
    return;
  }
  mkdirSync(parentDirectory, { recursive: true, mode: 0o700 });
}
