import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';

describe('migrateDatabase', () => {
  it('upgrades legacy batch jobs without losing their data', () => {
    const database = createSqliteDatabase(':memory:');
    database.client.exec(`
      CREATE TABLE batch_jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO batch_jobs (id, type, payload, status, created_at, updated_at)
      VALUES ('job_legacy_1', 'process_minute', '{"minuteId":"min_legacy_1"}', 'queued',
        '2026-07-18T00:00:00.000Z', '2026-07-18T00:00:00.000Z');
    `);

    migrateDatabase(database.client);

    expect(database.client.prepare(`
      SELECT id, type, payload, status, stable_key, created_at, updated_at
      FROM batch_jobs
    `).get()).toEqual({
      id: 'job_legacy_1',
      type: 'process_minute',
      payload: '{"minuteId":"min_legacy_1"}',
      status: 'queued',
      stable_key: 'legacy:job_legacy_1',
      created_at: '2026-07-18T00:00:00.000Z',
      updated_at: '2026-07-18T00:00:00.000Z'
    });
    expect(() => database.client.prepare(`
      INSERT INTO batch_jobs (
        id, type, stable_key, payload, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'job_duplicate_key',
      'process_minute',
      'legacy:job_legacy_1',
      '{}',
      'queued',
      '2026-07-18T00:00:00.000Z',
      '2026-07-18T00:00:00.000Z'
    )).toThrow(/UNIQUE constraint failed/);
  });

  it('adds the outbox delivery timestamp without losing pending messages', () => {
    const database = createSqliteDatabase(':memory:');
    database.client.exec(`
      CREATE TABLE outbox (
        id TEXT PRIMARY KEY,
        destination TEXT NOT NULL,
        payload TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL
      );

      INSERT INTO outbox (id, destination, payload, idempotency_key, status, created_at)
      VALUES ('outbox_legacy_1', 'oc_fixture', '{}', 'legacy-outbox:1', 'pending',
        '2026-07-18T00:00:00.000Z');
    `);

    migrateDatabase(database.client);

    expect(database.client.prepare(`
      SELECT id, status, delivered_at FROM outbox
    `).get()).toEqual({
      id: 'outbox_legacy_1',
      status: 'pending',
      delivered_at: null
    });
  });

  it('backfills legacy Todos to an explicit fail-closed capability', () => {
    const database = createSqliteDatabase(':memory:');
    database.client.exec(`
      CREATE TABLE meeting_todos (
        id TEXT PRIMARY KEY,
        summary_id TEXT NOT NULL,
        displayed_number INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        risk TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'proposed',
        created_at TEXT NOT NULL,
        UNIQUE(summary_id, displayed_number)
      );

      INSERT INTO meeting_todos (
        id, summary_id, displayed_number, title, description, risk, status, created_at
      ) VALUES (
        'todo_legacy_1', 'summary_legacy_1', 1, '旧任务', '没有能力分类', 'low',
        'proposed', '2026-07-18T00:00:00.000Z'
      );
    `);

    migrateDatabase(database.client);

    expect(database.client.prepare(`
      SELECT id, capability FROM meeting_todos WHERE id = 'todo_legacy_1'
    `).get()).toEqual({ id: 'todo_legacy_1', capability: 'unknown' });
    expect(() => database.client.prepare(`
      UPDATE meeting_todos SET capability = 'invented_capability'
      WHERE id = 'todo_legacy_1'
    `).run()).toThrow(/CHECK constraint failed/);
  });
});
