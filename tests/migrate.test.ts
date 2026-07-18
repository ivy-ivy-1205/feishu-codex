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
});
