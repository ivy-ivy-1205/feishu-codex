import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { ContextSourceRepository } from '../src/repositories/context-source-repository.js';
import { SpaceSyncRepository } from '../src/repositories/space-sync-repository.js';
import { spaceSyncEnvelopeV1Schema, type SpaceSyncEnvelopeV1 } from '../src/domain/space-sync.js';
import { ingestSpaceSyncEnvelope, SpaceSyncIngestionError } from '../src/services/space-sync-ingestion.js';
import { JobRepository } from '../src/repositories/job-repository.js';

function setup(nowSequence: readonly string[] = []) {
  const database = createSqliteDatabase(':memory:');
  migrateDatabase(database.client);
  database.client.prepare(`
    INSERT INTO projects (project_key, display_name, aliases, status, origin, stage, created_at, updated_at)
    VALUES ('smart_listing', 'Smart Listing', '[]', 'active', 'human_confirmed', 'active_project', ?, ?)
  `).run('2026-10-19T00:00:00.000Z', '2026-10-19T00:00:00.000Z');
  database.client.prepare(`
    INSERT INTO projects (project_key, display_name, aliases, status, origin, stage, created_at, updated_at)
    VALUES ('other_project', 'Other', '[]', 'active', 'human_confirmed', 'active_project', ?, ?)
  `).run('2026-10-19T00:00:00.000Z', '2026-10-19T00:00:00.000Z');
  const spaceSyncRepository = new SpaceSyncRepository(database.client);
  const contextSourceRepository = new ContextSourceRepository(database.client);
  spaceSyncRepository.createBinding({
    id: 'binding-1', projectKey: 'smart_listing', spaceId: null, pageId: 'page_1',
    pageUrl: 'https://chatgpt.com/space/page_1', managementMode: 'space', syncMode: 'manual',
    createdAt: new Date('2026-10-19T00:00:00.000Z')
  });
  let index = 0;
  const now = () => new Date(nowSequence[Math.min(index++, nowSequence.length - 1)] ?? '2026-10-19T00:00:00.000Z');
  return { database, spaceSyncRepository, contextSourceRepository, now };
}

function envelope(overrides: Partial<SpaceSyncEnvelopeV1> = {}): SpaceSyncEnvelopeV1 {
  return spaceSyncEnvelopeV1Schema.parse({
    schemaVersion: 1,
    syncId: 'sync_1',
    projectKey: 'smart_listing',
    trigger: 'manual',
    capturedAt: '2026-10-19T00:00:00.000Z',
    page: {
      pageId: 'page_1',
      spaceId: null,
      url: 'https://chatgpt.com/space/page_1',
      title: 'Smart Listing 总览',
      sequence: 1,
      updatedAt: '2026-10-18T10:00:00.000Z',
      blocks: [{ id: 'block_1', hash: 'a'.repeat(64), markdown: '当前阶段：试点' }]
    },
    comments: [{
      threadId: 'thread_1', messageId: 'msg_1', authorId: 'ou_ivy', authorDisplayName: 'Ivy',
      body: '需要补充负责人', createdAt: '2026-10-18T10:05:00.000Z', editedAt: null,
      threadState: 'open', resolvedAt: null, targetBlockId: 'block_1', selectedText: null
    }],
    coverage: { pageComplete: true, commentsComplete: true, nextCursor: null, gaps: [] },
    ...overrides
  });
}

describe('ingestSpaceSyncEnvelope', () => {
  it('writes a page source, a comment source, coverage and a run receipt in one pass', () => {
    const { database, spaceSyncRepository, contextSourceRepository, now } = setup();
    const result = ingestSpaceSyncEnvelope(envelope(), {
      client: database.client, spaceSyncRepository, contextSourceRepository,
      limits: { maxBlocks: 100, maxComments: 100 }, now
    });
    expect(result.replay).toBe(false);
    expect(result.run.pageSourceCreated).toBe(true);
    expect(result.run.commentSourcesCreated).toBe(1);

    const sources = contextSourceRepository.listSources();
    expect(sources.map((s) => s.sourceType).sort()).toEqual(
      ['space_page_comment', 'space_page_snapshot', 'space_sync_coverage'].sort()
    );
    const binding = spaceSyncRepository.getBindingById('binding-1');
    expect(binding?.lastSeenSequence).toBe(1);
    expect(binding?.lastSuccessfulSyncAt).toBeTruthy();
  });

  it('is idempotent: resubmitting the same syncId with identical content replays without new writes', () => {
    const { database, spaceSyncRepository, contextSourceRepository, now } = setup();
    const deps = { client: database.client, spaceSyncRepository, contextSourceRepository,
      limits: { maxBlocks: 100, maxComments: 100 }, now };
    ingestSpaceSyncEnvelope(envelope(), deps);
    const sourceCountAfterFirst = contextSourceRepository.listSources().length;

    const replay = ingestSpaceSyncEnvelope(envelope(), deps);
    expect(replay.replay).toBe(true);
    expect(contextSourceRepository.listSources().length).toBe(sourceCountAfterFirst);
  });

  it('rejects reusing the same syncId for a different envelope (replay-with-tamper)', () => {
    const { database, spaceSyncRepository, contextSourceRepository, now } = setup();
    const deps = { client: database.client, spaceSyncRepository, contextSourceRepository,
      limits: { maxBlocks: 100, maxComments: 100 }, now };
    ingestSpaceSyncEnvelope(envelope(), deps);

    expect(() => ingestSpaceSyncEnvelope(envelope({
      page: { ...envelope().page, sequence: 2, blocks: [{ id: 'block_1', hash: 'b'.repeat(64), markdown: '阶段已变化' }] }
    }), deps)).toThrow(SpaceSyncIngestionError);
  });

  it('creates a new source version when the page content actually changes, keyed by the same logical key', () => {
    const { database, spaceSyncRepository, contextSourceRepository, now } = setup();
    const deps = { client: database.client, spaceSyncRepository, contextSourceRepository,
      limits: { maxBlocks: 100, maxComments: 100 }, now };
    ingestSpaceSyncEnvelope(envelope(), deps);
    const second = ingestSpaceSyncEnvelope(envelope({
      syncId: 'sync_2',
      page: { ...envelope().page, sequence: 2, blocks: [{ id: 'block_1', hash: 'b'.repeat(64), markdown: '阶段已变化' }] }
    }), deps);
    expect(second.run.pageSourceCreated).toBe(true);
    const pageSources = contextSourceRepository.listSources().filter((s) => s.sourceType === 'space_page_snapshot');
    expect(pageSources).toHaveLength(2);
    expect(new Set(pageSources.map((s) => s.logicalKey)).size).toBe(1);
  });

  it('does not create a new comment source when only the page changes (per-message versioning)', () => {
    const { database, spaceSyncRepository, contextSourceRepository, now } = setup();
    const deps = { client: database.client, spaceSyncRepository, contextSourceRepository,
      limits: { maxBlocks: 100, maxComments: 100 }, now };
    ingestSpaceSyncEnvelope(envelope(), deps);
    const second = ingestSpaceSyncEnvelope(envelope({
      syncId: 'sync_2',
      page: { ...envelope().page, sequence: 2, blocks: [{ id: 'block_1', hash: 'b'.repeat(64), markdown: '阶段已变化' }] }
    }), deps);
    expect(second.run.commentSourcesCreated).toBe(0);
  });

  it('rejects ingestion for a page with no registered binding', () => {
    const { database, spaceSyncRepository, contextSourceRepository, now } = setup();
    const deps = { client: database.client, spaceSyncRepository, contextSourceRepository,
      limits: { maxBlocks: 100, maxComments: 100 }, now };
    expect(() => ingestSpaceSyncEnvelope(envelope({
      page: { ...envelope().page, pageId: 'page_unregistered' }
    }), deps)).toThrow('space_sync_unregistered_page');
  });

  it('rejects ingestion when the envelope projectKey does not match the binding', () => {
    const { database, spaceSyncRepository, contextSourceRepository, now } = setup();
    const deps = { client: database.client, spaceSyncRepository, contextSourceRepository,
      limits: { maxBlocks: 100, maxComments: 100 }, now };
    expect(() => ingestSpaceSyncEnvelope(envelope({ projectKey: 'other_project' }), deps))
      .toThrow('space_sync_project_mismatch');
  });

  it('rejects ingestion when the binding is paused or permission_lost', () => {
    const { database, spaceSyncRepository, contextSourceRepository, now } = setup();
    spaceSyncRepository.recordSyncFailure({
      bindingId: 'binding-1', errorCode: 'permission_denied', attemptedAt: new Date('2026-10-19T00:00:00.000Z')
    });
    const deps = { client: database.client, spaceSyncRepository, contextSourceRepository,
      limits: { maxBlocks: 100, maxComments: 100 }, now };
    expect(() => ingestSpaceSyncEnvelope(envelope(), deps)).toThrow('space_sync_binding_not_active');
  });

  it('rejects an envelope whose block count exceeds the configured limit', () => {
    const { database, spaceSyncRepository, contextSourceRepository, now } = setup();
    const deps = { client: database.client, spaceSyncRepository, contextSourceRepository,
      limits: { maxBlocks: 0, maxComments: 100 }, now };
    expect(() => ingestSpaceSyncEnvelope(envelope(), deps)).toThrow('space_sync_too_many_blocks');
  });

  it('never writes anything when the limit check fails before the transaction starts', () => {
    const { database, spaceSyncRepository, contextSourceRepository, now } = setup();
    const deps = { client: database.client, spaceSyncRepository, contextSourceRepository,
      limits: { maxBlocks: 0, maxComments: 100 }, now };
    expect(() => ingestSpaceSyncEnvelope(envelope(), deps)).toThrow();
    expect(contextSourceRepository.listSources()).toHaveLength(0);
    expect(spaceSyncRepository.getRunBySyncId('sync_1')).toBeNull();
  });

  it('records coverage gaps as dedicated sources without leaking page content into them', () => {
    const { database, spaceSyncRepository, contextSourceRepository, now } = setup();
    const deps = { client: database.client, spaceSyncRepository, contextSourceRepository,
      limits: { maxBlocks: 100, maxComments: 100 }, now };
    ingestSpaceSyncEnvelope(envelope({
      coverage: { pageComplete: true, commentsComplete: false, nextCursor: 'cursor-2',
        gaps: [{ code: 'comments_partial', summary: '评论分页未读完' }] }
    }), deps);
    const gapSources = contextSourceRepository.listSources().filter((s) => s.sourceType === 'space_sync_gap');
    expect(gapSources).toHaveLength(1);
    expect(gapSources[0]?.contentText).toBe('评论分页未读完');
  });

  it('enqueues a Space analysis batch for the newly created sources when a jobRepository is supplied and enabled', () => {
    const { database, spaceSyncRepository, contextSourceRepository, now } = setup();
    const jobRepository = new JobRepository(database.client);
    ingestSpaceSyncEnvelope(envelope(), {
      client: database.client, spaceSyncRepository, contextSourceRepository,
      limits: { maxBlocks: 100, maxComments: 100 }, now, jobRepository, spaceAnalysisEnabled: true
    });
    const rows = database.client.prepare("SELECT payload FROM batch_jobs WHERE type='analyze_founder_stream_space_batch'")
      .all() as { payload: string }[];
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0]!.payload);
    expect(payload.projectKey).toBe('smart_listing');
    const pageSourceId = contextSourceRepository.listSources().find((s) => s.sourceType === 'space_page_snapshot')!.id;
    const commentSourceId = contextSourceRepository.listSources().find((s) => s.sourceType === 'space_page_comment')!.id;
    expect(payload.sourceIds.sort()).toEqual([commentSourceId, pageSourceId].sort());
  });

  it('does not enqueue anything when spaceAnalysisEnabled is left off, even with a jobRepository supplied', () => {
    const { database, spaceSyncRepository, contextSourceRepository, now } = setup();
    const jobRepository = new JobRepository(database.client);
    ingestSpaceSyncEnvelope(envelope(), {
      client: database.client, spaceSyncRepository, contextSourceRepository,
      limits: { maxBlocks: 100, maxComments: 100 }, now, jobRepository
    });
    expect(database.client.prepare("SELECT count(*) n FROM batch_jobs WHERE type='analyze_founder_stream_space_batch'").get())
      .toEqual({ n: 0 });
  });

  it('does not re-enqueue on a replayed (idempotent) resubmit of the same syncId', () => {
    const { database, spaceSyncRepository, contextSourceRepository, now } = setup();
    const jobRepository = new JobRepository(database.client);
    const deps = { client: database.client, spaceSyncRepository, contextSourceRepository,
      limits: { maxBlocks: 100, maxComments: 100 }, now, jobRepository, spaceAnalysisEnabled: true };
    ingestSpaceSyncEnvelope(envelope(), deps);
    const countAfterFirst = (database.client.prepare("SELECT count(*) n FROM batch_jobs WHERE type='analyze_founder_stream_space_batch'").get() as { n: number }).n;
    ingestSpaceSyncEnvelope(envelope(), deps);
    expect((database.client.prepare("SELECT count(*) n FROM batch_jobs WHERE type='analyze_founder_stream_space_batch'").get() as { n: number }).n)
      .toBe(countAfterFirst);
  });

  it('does not enqueue a new batch for an unchanged page version when no new comment arrived', () => {
    const { database, spaceSyncRepository, contextSourceRepository, now } = setup();
    const jobRepository = new JobRepository(database.client);
    const deps = { client: database.client, spaceSyncRepository, contextSourceRepository,
      limits: { maxBlocks: 100, maxComments: 100 }, now, jobRepository, spaceAnalysisEnabled: true };
    ingestSpaceSyncEnvelope(envelope(), deps);
    ingestSpaceSyncEnvelope(envelope({ syncId: 'sync_2' }), deps);
    expect(database.client.prepare("SELECT count(*) n FROM batch_jobs WHERE type='analyze_founder_stream_space_batch'").get())
      .toEqual({ n: 1 });
  });
});
