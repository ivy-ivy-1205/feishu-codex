import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';

const contextTables = [
  'context_candidate_evidence',
  'context_candidate_projects',
  'context_candidate_record_relations',
  'context_candidates',
  'context_evidence',
  'context_extraction_run_sources',
  'context_extraction_runs',
  'context_record_evidence',
  'context_record_projects',
  'context_record_relations',
  'context_record_versions',
  'context_records',
  'context_reviews',
  'context_source_relations',
  'context_sources'
] as const;

describe('Phase 1E migration', () => {
  it('creates the complete additive schema with source/version idempotency constraints', () => {
    const database = createSqliteDatabase(':memory:');
    migrateDatabase(database.client);

    const tables = database.client.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'context_%'
      ORDER BY name
    `).all().map((row) => (row as { name: string }).name);
    expect(tables).toEqual(contextTables);

    database.client.prepare(`
      INSERT INTO context_sources (
        id, source_system, source_type, external_id, logical_key, source_version,
        occurred_at, authors_json, locator_uri, content_format, content_text,
        metadata_json, content_hash, availability_status, captured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('source-1', 'fixture', 'transcript', 'm1', 'fixture:m1', 1,
      '2026-08-03T00:00:00.000Z', '[]', null, 'text/plain', 'hello', '{}',
      'hash-1', 'available', '2026-08-03T00:00:00.000Z');
    expect(() => database.client.prepare(`
      INSERT INTO context_sources (
        id, source_system, source_type, external_id, logical_key, source_version,
        occurred_at, authors_json, locator_uri, content_format, content_text,
        metadata_json, content_hash, availability_status, captured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('source-2', 'fixture', 'transcript', 'm1', 'fixture:m1', 2,
      '2026-08-03T00:00:00.000Z', '[]', null, 'text/plain', 'hello', '{}',
      'hash-1', 'available', '2026-08-03T00:00:00.000Z')).toThrow(/UNIQUE/);
  });

  it('is repeatable and preserves legacy project and mapping-rule state', () => {
    const database = createSqliteDatabase(':memory:');
    createPhase1DLegacyFixture(database.client);

    migrateDatabase(database.client);
    migrateDatabase(database.client);

    expect(database.client.prepare(`
      SELECT status FROM projects WHERE project_key = 'feishu-adaptor'
    `).get()).toEqual({ status: 'archived' });
    expect(database.client.prepare(`
      SELECT active FROM project_mapping_rules WHERE id = 'system:amy-live'
    `).get()).toEqual({ active: 0 });
  });

  it('recovers from a partially applied Context migration', () => {
    const database = createSqliteDatabase(':memory:');
    database.client.exec(`CREATE TABLE context_sources (
      id TEXT PRIMARY KEY, source_system TEXT NOT NULL, source_type TEXT NOT NULL,
      external_id TEXT NOT NULL, logical_key TEXT NOT NULL, source_version INTEGER NOT NULL CHECK(source_version > 0),
      occurred_at TEXT NOT NULL, authors_json TEXT NOT NULL, locator_uri TEXT,
      content_format TEXT NOT NULL, content_text TEXT NOT NULL, metadata_json TEXT NOT NULL,
      content_hash TEXT NOT NULL, availability_status TEXT NOT NULL
        CHECK(availability_status IN ('available', 'deleted', 'permission_lost', 'unknown')),
      captured_at TEXT NOT NULL,
      UNIQUE(logical_key, content_hash), UNIQUE(logical_key, source_version)
    )`);
    migrateDatabase(database.client);
    const tables = database.client.prepare(`SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'context_%' ORDER BY name`).all()
      .map((row) => (row as { name: string }).name);
    expect(tables).toEqual(contextTables);
    expect(() => migrateDatabase(database.client)).not.toThrow();
  });

  it('creates key unique indexes, foreign keys and durable outbox retry columns', () => {
    const database = createSqliteDatabase(':memory:'); migrateDatabase(database.client);
    for (const table of ['context_sources', 'context_evidence', 'context_extraction_runs',
      'context_candidates', 'context_record_versions', 'context_reviews']) {
      const indexes = database.client.prepare(`PRAGMA index_list(${table})`).all() as Array<{ unique: number }>;
      expect(indexes.some((index) => index.unique === 1), `${table} unique index`).toBe(true);
    }
    for (const table of contextTables) {
      expect(database.client.prepare(`PRAGMA index_list(${table})`).all().length,
        `${table} must expose a primary/unique identity index`).toBeGreaterThan(0);
    }
    const relationFks = database.client.prepare('PRAGMA foreign_key_list(context_record_relations)').all() as
      Array<{ table: string }>;
    expect(relationFks.map((fk) => fk.table)).toEqual(expect.arrayContaining([
      'context_reviews', 'context_record_versions'
    ]));
    const outboxColumns = database.client.prepare('PRAGMA table_info(outbox)').all()
      .map((row) => (row as { name: string }).name);
    expect(outboxColumns).toEqual(expect.arrayContaining([
      'attempt_count', 'next_attempt_at', 'last_error_code', 'delivered_message_id'
    ]));
  });

  it('enforces independent enums, confidence, record versions and project foreign keys', () => {
    const database = createSqliteDatabase(':memory:');
    migrateDatabase(database.client);

    expect(() => database.client.prepare(`
      INSERT INTO context_candidates (
        id, extraction_run_id, candidate_type, scope, summary, subject_key,
        structured_payload, extraction_confidence, factual_status, review_status,
        candidate_fingerprint, external_refs_json, created_at, updated_at
      ) VALUES ('c1', 'missing', 'decision', 'project', 'x', NULL, '{}', 1.2,
        'reported', 'pending', 'f1', '[]', '2026-08-03', '2026-08-03')
    `).run()).toThrow();

    const fkTargets = database.client.prepare('PRAGMA foreign_key_list(context_candidate_projects)')
      .all().map((row) => (row as { table: string }).table);
    expect(fkTargets).toContain('projects');
  });
});

function createPhase1DLegacyFixture(client: import('better-sqlite3').Database): void {
  client.exec(`
    CREATE TABLE projects (project_key TEXT PRIMARY KEY, display_name TEXT NOT NULL, aliases TEXT NOT NULL,
      local_path_hint TEXT, repo_url TEXT, default_branch TEXT, status TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE project_mapping_rules (id TEXT PRIMARY KEY, pattern TEXT NOT NULL, pattern_kind TEXT NOT NULL,
      project_key TEXT NOT NULL REFERENCES projects(project_key), subproject_key TEXT, confidence_hint TEXT NOT NULL,
      priority INTEGER NOT NULL, source TEXT NOT NULL, active INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE batch_jobs (id TEXT PRIMARY KEY, type TEXT NOT NULL, stable_key TEXT NOT NULL UNIQUE,
      payload TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE outbox (id TEXT PRIMARY KEY, destination TEXT NOT NULL, payload TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL, created_at TEXT NOT NULL, delivered_at TEXT);
    CREATE TABLE meeting_summaries (id TEXT PRIMARY KEY, minute_id TEXT NOT NULL, summary_message_id TEXT NOT NULL,
      content TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE meeting_todos (id TEXT PRIMARY KEY, summary_id TEXT NOT NULL, displayed_number INTEGER NOT NULL,
      title TEXT NOT NULL, description TEXT NOT NULL, risk TEXT NOT NULL, capability TEXT NOT NULL DEFAULT 'unknown',
      status TEXT NOT NULL DEFAULT 'proposed', created_at TEXT NOT NULL);
    INSERT INTO projects VALUES ('feishu-adaptor','legacy','[]',NULL,NULL,NULL,'archived','2026-01-01','2026-01-01');
    INSERT INTO project_mapping_rules VALUES ('system:amy-live','legacy','keyword','feishu-adaptor',NULL,
      'high',1,'system',0,'2026-01-01','2026-01-01');
    INSERT INTO batch_jobs VALUES ('legacy-job','process_minute','minute:legacy',
      '{"minuteId":"legacy","attemptsByCode":{"MINUTE_NOT_READY":0,"RATE_LIMITED":0}}',
      'completed','2026-01-01','2026-01-01');
  `);
}
