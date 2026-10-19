import { pathToFileURL } from 'node:url';
import { statSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { createSqliteDatabase } from '../db/client.js';
import { applyContextSourceRetentionMigration } from '../services/context-source-retention-migration.js';

interface MigrationCliDependencies {
  client: Database.Database;
  write: (line: string) => void;
}

export function runContextSourceRetentionMigrationCli(
  args: string[],
  dependencies: MigrationCliDependencies
): void {
  const normalizedArgs = args[0] === '--' ? args.slice(1) : args;
  if (normalizedArgs.length !== 1 || normalizedArgs[0] !== '--apply') {
    throw new Error('CONTEXT_SOURCE_RETENTION_MIGRATION_ARGUMENTS_INVALID');
  }
  const result = applyContextSourceRetentionMigration(dependencies.client);
  const integrityRow = dependencies.client.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
  const foreignKeyViolations = dependencies.client.prepare('PRAGMA foreign_key_check').all().length;
  const sourceCountRow = dependencies.client.prepare('SELECT COUNT(*) AS count FROM context_sources').get() as { count: number };
  dependencies.write(JSON.stringify({
    ...result,
    sourceCount: sourceCountRow.count,
    integrity: integrityRow.integrity_check,
    foreignKeyViolations
  }));
}

export function resolveMigrationDatabasePath(value: string | undefined): string {
  const databasePath = value?.trim();
  if (!databasePath || databasePath === ':memory:' || /^[a-z][a-z0-9+.-]*:/iu.test(databasePath)) {
    throw new Error('SQLite database file path required');
  }
  try {
    if (!statSync(databasePath).isFile()) throw new Error('not a file');
  } catch {
    throw new Error('Existing SQLite database file required');
  }
  return databasePath;
}

function main(): void {
  const databasePath = resolveMigrationDatabasePath(process.env.DATABASE_URL);
  const database = createSqliteDatabase(databasePath);
  try {
    runContextSourceRetentionMigrationCli(process.argv.slice(2), {
      client: database.client,
      write: (line) => process.stdout.write(`${line}\n`)
    });
  } finally {
    database.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch {
    process.stderr.write('Context source retention migration failed. No source content logged.\n');
    process.exitCode = 1;
  }
}
