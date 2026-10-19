import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { contextExtractorVersion, contextPromptVersion } from '../src/composition/context-runtime.js';
import { JobRepository } from '../src/repositories/job-repository.js';

describe('Context durable jobs', () => {
  it('enqueues and leases one extraction job idempotently', () => {
    const database = createSqliteDatabase(':memory:');
    migrateDatabase(database.client);
    const repository = new JobRepository(database.client);
    const input = { sourceId: 'ctxsrc_1', extractorVersion: 'v1', promptVersion: 'p1' };
    expect(repository.enqueueContextExtraction(input).created).toBe(true);
    expect(repository.enqueueContextExtraction(input).created).toBe(false);
    expect(repository.leaseNextSupportedJob(new Date('2030-01-01T00:00:00.000Z'))).toMatchObject({
      kind: 'extract_context_candidates', sourceId: 'ctxsrc_1', extractionKey: 'v1:p1', attempt: 0
    });
  });

  it('does not lease Context work when only Phase 1D jobs are enabled', () => {
    const database = createSqliteDatabase(':memory:');
    migrateDatabase(database.client);
    const repository = new JobRepository(database.client);
    repository.enqueueContextExtraction({ sourceId: 'ctxsrc_1', extractorVersion: 'v1', promptVersion: 'p1' });
    expect(repository.leaseNextSupportedJob(new Date('2030-01-01T00:00:00.000Z'), ['process_minute'])).toBeNull();
  });

  it('uses a new extraction identity after the failed phase1e-v1 schema contract', () => {
    const database = createSqliteDatabase(':memory:');
    migrateDatabase(database.client);
    const repository = new JobRepository(database.client);
    const legacy = repository.enqueueContextExtraction({
      sourceId: 'ctxsrc_schema_recovery', extractorVersion: 'phase1e-v1', promptVersion: 'context-v1'
    });
    const legacyLease = repository.leaseNextSupportedJob(new Date('2030-01-01T00:00:00.000Z'))!;
    if (legacyLease.kind !== 'extract_context_candidates') throw new Error('expected Context extraction job');
    repository.markContextFailed(legacyLease, 'CODEX_EXECUTION_FAILED',
      new Date('2030-01-01T00:00:01.000Z'));

    const recovery = repository.enqueueContextExtraction({
      sourceId: legacy.job.sourceId, extractorVersion: contextExtractorVersion,
      promptVersion: contextPromptVersion
    });

    expect(recovery.created).toBe(true);
    expect(recovery.job.extractionKey).not.toBe(legacy.job.extractionKey);
  });
});
