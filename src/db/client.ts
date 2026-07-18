import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

export interface SqliteDatabase {
  client: Database.Database;
  db: BetterSQLite3Database<typeof schema>;
  close(): void;
}

export function createSqliteDatabase(filename: string): SqliteDatabase {
  const client = new Database(filename);
  client.pragma('foreign_keys = ON');

  return {
    client,
    db: drizzle({ client, schema }),
    close: () => client.close()
  };
}
