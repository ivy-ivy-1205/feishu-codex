import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveMigrationDatabasePath,
  runContextSourceRetentionMigrationCli
} from '../src/cli/migrate-context-source-retention.js';

const baseSchema = `CREATE TABLE context_sources (
  id TEXT PRIMARY KEY, source_system TEXT NOT NULL, source_type TEXT NOT NULL, external_id TEXT NOT NULL,
  logical_key TEXT NOT NULL, source_version INTEGER NOT NULL CHECK(source_version > 0), occurred_at TEXT NOT NULL,
  authors_json TEXT NOT NULL, locator_uri TEXT, content_format TEXT NOT NULL, content_text TEXT NOT NULL,
  metadata_json TEXT NOT NULL, content_hash TEXT NOT NULL,
  availability_status TEXT NOT NULL CHECK(availability_status IN ('available', 'deleted', 'permission_lost', 'unknown')),
  captured_at TEXT NOT NULL, UNIQUE(logical_key, content_hash), UNIQUE(logical_key, source_version)
)`;

describe('context source retention migration CLI', () => {
  it('accepts only an existing SQLite file path at the process boundary', () => {
    const directory = mkdtempSync(join(tmpdir(), 'retention-migration-'));
    try {
      const path = join(directory, 'fixture.sqlite');
      const database = createSqliteDatabase(path);
      database.close();
      expect(resolveMigrationDatabasePath(` ${path} `)).toBe(path);
      for (const invalid of [undefined, '', ':memory:', 'postgres://db', 'https://example.test/db', join(directory, 'missing.sqlite')]) {
        expect(() => resolveMigrationDatabasePath(invalid)).toThrow();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('requires the explicit apply flag', () => {
    const database = createSqliteDatabase(':memory:');
    database.client.exec(baseSchema);
    expect(() => runContextSourceRetentionMigrationCli([], { client: database.client, write: () => undefined }))
      .toThrow('CONTEXT_SOURCE_RETENTION_MIGRATION_ARGUMENTS_INVALID');
    database.close();
  });

  it('prints only safe structural diagnostics and supports a repeated no-op', () => {
    const database = createSqliteDatabase(':memory:');
    database.client.exec(baseSchema);
    database.client.prepare(`INSERT INTO context_sources VALUES (
      'secret-source-id', 'feishu', 'group_message', 'secret-external-id', 'secret-logical-key', 1,
      '2026-09-20T00:00:00.000Z', '[]', NULL, 'text/plain', 'SECRET BODY', '{}', 'secret-hash',
      'available', '2026-09-20T00:01:00.000Z'
    )`).run();
    const lines: string[] = [];

    runContextSourceRetentionMigrationCli(['--apply'], { client: database.client, write: (line) => lines.push(line) });
    runContextSourceRetentionMigrationCli(['--apply'], { client: database.client, write: (line) => lines.push(line) });

    expect(JSON.parse(lines[0]!)).toEqual({
      migrationApplied: true,
      before: { rawTextExpiresAt: false, contentState: false, redactedAt: false },
      after: { rawTextExpiresAt: true, contentState: true, redactedAt: true },
      sourceCount: 1,
      integrity: 'ok',
      foreignKeyViolations: 0
    });
    expect(JSON.parse(lines[1]!).migrationApplied).toBe(false);
    expect(lines.join('\n')).not.toContain('SECRET BODY');
    expect(lines.join('\n')).not.toContain('secret-source-id');
    expect(lines.join('\n')).not.toContain('secret-external-id');
    database.close();
  });
});
