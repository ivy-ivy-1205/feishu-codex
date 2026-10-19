import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { JobRepository, type FounderDurableJob } from '../src/repositories/job-repository.js';

const at = new Date('2026-10-19T00:00:00.000Z');

describe('JobRepository Space-scoped analysis batch', () => {
  it('enqueues a space batch keyed by projectKey, not chatId, and dedupes an identical source set', () => {
    const database = createSqliteDatabase(':memory:'); migrateDatabase(database.client);
    const repository = new JobRepository(database.client);
    const first = repository.enqueueSpaceStreamBatch({
      projectKey: 'smart_listing', since: at.toISOString(), until: at.toISOString(),
      sourceIds: ['ctxsrc_1', 'ctxsrc_2'], capturedAt: at
    });
    expect(first.created).toBe(true);
    expect(first.key).toContain('smart_listing');
    expect(first.key).not.toContain('chat');

    const duplicate = repository.enqueueSpaceStreamBatch({
      projectKey: 'smart_listing', since: at.toISOString(), until: at.toISOString(),
      sourceIds: ['ctxsrc_2', 'ctxsrc_1'], capturedAt: at
    });
    expect(duplicate.created).toBe(false);
    expect(duplicate.key).toBe(first.key);
  });

  it('does not dedupe a different source set for the same project', () => {
    const database = createSqliteDatabase(':memory:'); migrateDatabase(database.client);
    const repository = new JobRepository(database.client);
    const first = repository.enqueueSpaceStreamBatch({
      projectKey: 'smart_listing', since: at.toISOString(), until: at.toISOString(),
      sourceIds: ['ctxsrc_1'], capturedAt: at
    });
    const second = repository.enqueueSpaceStreamBatch({
      projectKey: 'smart_listing', since: at.toISOString(), until: at.toISOString(),
      sourceIds: ['ctxsrc_1', 'ctxsrc_3'], capturedAt: at
    });
    expect(second.key).not.toBe(first.key);
  });

  it('throws when enqueued with no sources', () => {
    const database = createSqliteDatabase(':memory:'); migrateDatabase(database.client);
    const repository = new JobRepository(database.client);
    expect(() => repository.enqueueSpaceStreamBatch({
      projectKey: 'smart_listing', since: at.toISOString(), until: at.toISOString(), sourceIds: [], capturedAt: at
    })).toThrow();
  });

  it('is not leased unless explicitly included in supportedKinds', () => {
    const database = createSqliteDatabase(':memory:'); migrateDatabase(database.client);
    const repository = new JobRepository(database.client);
    repository.enqueueSpaceStreamBatch({
      projectKey: 'smart_listing', since: at.toISOString(), until: at.toISOString(),
      sourceIds: ['ctxsrc_1'], capturedAt: at
    });
    expect(repository.leaseNextSupportedJob(at, ['capture_group_message', 'analyze_founder_stream_batch'])).toBeNull();

    const leased = repository.leaseNextSupportedJob(at, ['analyze_founder_stream_space_batch']) as Extract<FounderDurableJob,
      { kind: 'analyze_founder_stream_space_batch' }>;
    expect(leased).toMatchObject({ kind: 'analyze_founder_stream_space_batch', projectKey: 'smart_listing', sourceIds: ['ctxsrc_1'] });
  });

  it('marks a malformed space batch payload as failed instead of leasing it', () => {
    const database = createSqliteDatabase(':memory:'); migrateDatabase(database.client);
    const repository = new JobRepository(database.client);
    database.client.prepare(`INSERT INTO batch_jobs (id, type, stable_key, payload, status, created_at, updated_at)
      VALUES ('bad', 'analyze_founder_stream_space_batch', 'bad', ?, 'queued', ?, ?)`)
      .run(JSON.stringify({ projectKey: 'smart_listing', sourceIds: ['not-a-context-source-id'], since: at.toISOString(),
        until: at.toISOString(), windowKey: 'space:x', attempt: 0 }), at.toISOString(), at.toISOString());
    expect(repository.leaseNextSupportedJob(at, ['analyze_founder_stream_space_batch'])).toBeNull();
    const row = database.client.prepare("SELECT status FROM batch_jobs WHERE stable_key='bad'").get() as { status: string };
    expect(row.status).toBe('failed');
  });

  it('retries a leased space batch job, preserving its projectKey scope and incrementing attempt', () => {
    const database = createSqliteDatabase(':memory:'); migrateDatabase(database.client);
    const repository = new JobRepository(database.client);
    repository.enqueueSpaceStreamBatch({
      projectKey: 'smart_listing', since: at.toISOString(), until: at.toISOString(),
      sourceIds: ['ctxsrc_1'], capturedAt: at
    });
    const leased = repository.leaseNextSupportedJob(at, ['analyze_founder_stream_space_batch']) as Extract<FounderDurableJob,
      { kind: 'analyze_founder_stream_space_batch' }>;
    repository.retryFounderStream(leased, at, { stage: 'topic_analysis', code: 'grounding_invalid' });
    const row = database.client.prepare('SELECT status, payload FROM batch_jobs WHERE stable_key=?').get(leased.key) as
      { status: string; payload: string };
    expect(row.status).toBe('retry');
    expect(JSON.parse(row.payload)).toMatchObject({ projectKey: 'smart_listing', attempt: 1,
      failureStage: 'topic_analysis', failureCode: 'grounding_invalid' });
  });
});
