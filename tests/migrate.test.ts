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
      status: 'queued',
      stable_key: 'legacy:job_legacy_1',
      payload: JSON.stringify({
        minuteId: 'min_legacy_1',
        subscriberOpenIds: [],
        attemptsByCode: {
          MINUTE_NOT_READY: 0,
          RATE_LIMITED: 0
        }
      }),
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

  it('migrates a legacy shared attempt conservatively into both retry budgets', () => {
    const database = createSqliteDatabase(':memory:');
    database.client.exec(`
      CREATE TABLE batch_jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        stable_key TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO batch_jobs (
        id, type, stable_key, payload, status, created_at, updated_at
      ) VALUES (
        'minute:min_legacy_attempt', 'process_minute', 'minute:min_legacy_attempt',
        '{"minuteId":"min_legacy_attempt","attempt":3}', 'retry',
        '2026-07-18T00:00:00.000Z', '2026-07-18T00:00:00.000Z'
      );
    `);

    migrateDatabase(database.client);

    const row = database.client.prepare(`
      SELECT status, payload FROM batch_jobs WHERE stable_key = 'minute:min_legacy_attempt'
    `).get() as { status: string; payload: string };
    expect(row.status).toBe('retry');
    expect(JSON.parse(row.payload)).toEqual({
      minuteId: 'min_legacy_attempt',
      subscriberOpenIds: [],
      attemptsByCode: { MINUTE_NOT_READY: 3, RATE_LIMITED: 3 }
    });
  });

  it('fails malformed process-minute payloads closed during migration', () => {
    const database = createSqliteDatabase(':memory:');
    database.client.exec(`
      CREATE TABLE batch_jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        stable_key TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO batch_jobs (
        id, type, stable_key, payload, status, created_at, updated_at
      ) VALUES (
        'minute:min_bad_payload', 'process_minute', 'minute:min_bad_payload',
        'not-json', 'queued', '2026-07-18T00:00:00.000Z',
        '2026-07-18T00:00:00.000Z'
      );
    `);

    migrateDatabase(database.client);

    const row = database.client.prepare(`
      SELECT status, payload FROM batch_jobs WHERE stable_key = 'minute:min_bad_payload'
    `).get() as { status: string; payload: string };
    expect(row.status).toBe('failed');
    expect(JSON.parse(row.payload)).toEqual({ failureReason: 'JOB_PAYLOAD_INVALID' });
  });

  it('fails malformed per-code counters closed instead of resetting them', () => {
    const database = createSqliteDatabase(':memory:');
    database.client.exec(`
      CREATE TABLE batch_jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        stable_key TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO batch_jobs (
        id, type, stable_key, payload, status, created_at, updated_at
      ) VALUES (
        'minute:min_bad_attempts', 'process_minute', 'minute:min_bad_attempts',
        '{"minuteId":"min_bad_attempts","attemptsByCode":{"MINUTE_NOT_READY":-1,"RATE_LIMITED":0}}',
        'retry', '2026-07-18T00:00:00.000Z', '2026-07-18T00:00:00.000Z'
      );
    `);

    migrateDatabase(database.client);

    const row = database.client.prepare(`
      SELECT status, payload FROM batch_jobs WHERE stable_key = 'minute:min_bad_attempts'
    `).get() as { status: string; payload: string };
    expect(row.status).toBe('failed');
    expect(JSON.parse(row.payload)).toEqual({ failureReason: 'JOB_PAYLOAD_INVALID' });
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
