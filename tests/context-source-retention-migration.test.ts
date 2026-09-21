import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { applyContextSourceRetentionMigration } from '../src/services/context-source-retention-migration.js';

const baseSchema = `
  CREATE TABLE context_sources (
    id TEXT PRIMARY KEY,
    source_system TEXT NOT NULL,
    source_type TEXT NOT NULL,
    external_id TEXT NOT NULL,
    logical_key TEXT NOT NULL,
    source_version INTEGER NOT NULL CHECK(source_version > 0),
    occurred_at TEXT NOT NULL,
    authors_json TEXT NOT NULL,
    locator_uri TEXT,
    content_format TEXT NOT NULL,
    content_text TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    availability_status TEXT NOT NULL CHECK(availability_status IN ('available', 'deleted', 'permission_lost', 'unknown')),
    captured_at TEXT NOT NULL,
    UNIQUE(logical_key, content_hash),
    UNIQUE(logical_key, source_version)
  );
`;

function setup(sql = baseSchema) {
  const database = createSqliteDatabase(':memory:');
  database.client.exec(sql);
  return database;
}

function columnNames(client: ReturnType<typeof setup>['client']): string[] {
  return (client.prepare('PRAGMA table_info(context_sources)').all() as Array<{ name: string }>).map((row) => row.name);
}

describe('context source retention migration', () => {
  it('adds the exact retention columns atomically and preserves existing rows', () => {
    const database = setup();
    database.client.prepare(`INSERT INTO context_sources (
      id, source_system, source_type, external_id, logical_key, source_version, occurred_at,
      authors_json, locator_uri, content_format, content_text, metadata_json, content_hash,
      availability_status, captured_at
    ) VALUES (?, 'feishu', 'minute_transcript', 'minute-1', 'minute-1', 1, ?, '[]', NULL,
      'text/plain', ?, '{}', 'hash-1', 'available', ?)`)
      .run('source-secret-id', '2026-09-20T00:00:00.000Z', 'SECRET TRANSCRIPT', '2026-09-20T00:01:00.000Z');

    const result = applyContextSourceRetentionMigration(database.client);

    expect(result.migrationApplied).toBe(true);
    expect(result.before).toEqual({ rawTextExpiresAt: false, contentState: false, redactedAt: false });
    expect(result.after).toEqual({ rawTextExpiresAt: true, contentState: true, redactedAt: true });
    expect(database.client.prepare(`SELECT content_text, raw_text_expires_at, content_state, redacted_at
      FROM context_sources`).get()).toEqual({
      content_text: 'SECRET TRANSCRIPT', raw_text_expires_at: null, content_state: 'cleartext', redacted_at: null
    });
    database.close();
  });

  it('is an idempotent no-op after the complete migration', () => {
    const database = setup();
    expect(applyContextSourceRetentionMigration(database.client).migrationApplied).toBe(true);
    const second = applyContextSourceRetentionMigration(database.client);
    expect(second.migrationApplied).toBe(false);
    expect(second.before).toEqual(second.after);
    expect(columnNames(database.client).slice(-3)).toEqual(['raw_text_expires_at', 'content_state', 'redacted_at']);
    database.close();
  });

  it('rejects a partially migrated table without adding the missing columns', () => {
    const database = setup();
    database.client.exec('ALTER TABLE context_sources ADD COLUMN raw_text_expires_at TEXT');
    expect(() => applyContextSourceRetentionMigration(database.client))
      .toThrow('CONTEXT_SOURCE_RETENTION_MIGRATION_PARTIAL');
    expect(columnNames(database.client)).not.toContain('content_state');
    expect(columnNames(database.client)).not.toContain('redacted_at');
    database.close();
  });

  it('rejects an unexpected base schema', () => {
    const database = setup(baseSchema.replace('captured_at TEXT NOT NULL,', 'captured_at TEXT,'));
    expect(() => applyContextSourceRetentionMigration(database.client))
      .toThrow('CONTEXT_SOURCE_RETENTION_BASE_SCHEMA_INVALID');
    expect(columnNames(database.client)).not.toContain('raw_text_expires_at');
    database.close();
  });

  it('rejects a missing table and a complete-looking migration with the wrong default', () => {
    const missing = createSqliteDatabase(':memory:');
    expect(() => applyContextSourceRetentionMigration(missing.client))
      .toThrow('CONTEXT_SOURCE_RETENTION_BASE_SCHEMA_INVALID');
    missing.close();

    const malformed = setup();
    malformed.client.exec(`
      ALTER TABLE context_sources ADD COLUMN raw_text_expires_at TEXT;
      ALTER TABLE context_sources ADD COLUMN content_state TEXT NOT NULL DEFAULT 'redacted'
        CHECK(content_state IN ('cleartext', 'redacted'));
      ALTER TABLE context_sources ADD COLUMN redacted_at TEXT;
    `);
    expect(() => applyContextSourceRetentionMigration(malformed.client))
      .toThrow('CONTEXT_SOURCE_RETENTION_BASE_SCHEMA_INVALID');
    malformed.close();
  });

  it('rolls back the first ALTER when the second statement fails', () => {
    const database = setup();
    expect(() => applyContextSourceRetentionMigration(database.client, {
      executeStatement: (sql, index) => {
        if (index === 1) throw new Error('injected migration failure');
        database.client.exec(sql);
      }
    })).toThrow('injected migration failure');
    expect(columnNames(database.client)).not.toContain('raw_text_expires_at');
    expect(columnNames(database.client)).not.toContain('content_state');
    expect(columnNames(database.client)).not.toContain('redacted_at');
    database.close();
  });
});
