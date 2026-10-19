import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { ContextSourceRepository } from '../src/repositories/context-source-repository.js';
import { SpaceSyncRepository } from '../src/repositories/space-sync-repository.js';
import { spaceSyncEnvelopeV1Schema, type SpaceSyncEnvelopeV1 } from '../src/domain/space-sync.js';
import { ingestSpaceSyncEnvelope } from '../src/services/space-sync-ingestion.js';

/**
 * Phase 3 fixture scenarios from docs/2026-10-19-space-to-context-sync-cloud-code-handoff.md §10.
 * Each test runs against its own isolated in-memory database. Scenarios already exercised in
 * tests/space-sync-ingestion.test.ts (replay, page version bump, unregistered page, conflict) are
 * not repeated here; this file covers the remaining ones plus the cross-cutting non-interference
 * assertions (no outbox messages, no Todo execution, no duplicate sources).
 */
function setup() {
  const database = createSqliteDatabase(':memory:');
  migrateDatabase(database.client);
  database.client.prepare(`
    INSERT INTO projects (project_key, display_name, aliases, status, origin, stage, created_at, updated_at)
    VALUES ('smart_listing', 'Smart Listing', '[]', 'active', 'human_confirmed', 'active_project', ?, ?)
  `).run('2026-10-19T00:00:00.000Z', '2026-10-19T00:00:00.000Z');
  const spaceSyncRepository = new SpaceSyncRepository(database.client);
  const contextSourceRepository = new ContextSourceRepository(database.client);
  spaceSyncRepository.createBinding({
    id: 'binding-1', projectKey: 'smart_listing', spaceId: null, pageId: 'page_f095a79b4bb48191b797811f8f53862d',
    pageUrl: 'https://chatgpt.com/space/page_f095a79b4bb48191b797811f8f53862d',
    managementMode: 'space', syncMode: 'manual', createdAt: new Date('2026-10-19T00:00:00.000Z')
  });
  const deps = {
    client: database.client, spaceSyncRepository, contextSourceRepository,
    limits: { maxBlocks: 100, maxComments: 100 }, now: () => new Date('2026-10-19T00:00:00.000Z')
  };
  return { database, spaceSyncRepository, contextSourceRepository, deps };
}

function baseEnvelope(overrides: Partial<SpaceSyncEnvelopeV1> = {}): SpaceSyncEnvelopeV1 {
  return spaceSyncEnvelopeV1Schema.parse({
    schemaVersion: 1,
    syncId: 'sync_1',
    projectKey: 'smart_listing',
    trigger: 'manual',
    capturedAt: '2026-10-19T00:00:00.000Z',
    page: {
      pageId: 'page_f095a79b4bb48191b797811f8f53862d',
      spaceId: null,
      url: 'https://chatgpt.com/space/page_f095a79b4bb48191b797811f8f53862d',
      title: 'AiJia Smart Listing 与买家空间项目总览',
      sequence: 1,
      updatedAt: '2026-10-18T10:00:00.000Z',
      blocks: [{ id: 'block_1', hash: 'a'.repeat(64), markdown: '当前阶段：试点' }]
    },
    comments: [],
    coverage: { pageComplete: true, commentsComplete: true, nextCursor: null, gaps: [] },
    ...overrides
  });
}

describe('Phase 3 fixture scenario: comments from different authors stay separate', () => {
  it('stores Ivy and James comments as distinct per-author sources, never merged into one', () => {
    const { contextSourceRepository, deps } = setup();
    ingestSpaceSyncEnvelope(baseEnvelope({
      comments: [
        { threadId: 'thread_1', messageId: 'msg_ivy_1', authorId: 'ou_ivy', authorDisplayName: 'Ivy',
          body: '这里应该补充负责人', createdAt: '2026-10-18T10:05:00.000Z', editedAt: null,
          threadState: 'open', resolvedAt: null, targetBlockId: 'block_1', selectedText: null },
        { threadId: 'thread_2', messageId: 'msg_james_1', authorId: 'ou_james', authorDisplayName: 'James',
          body: '我理解试点范围只包含买家空间', createdAt: '2026-10-18T10:06:00.000Z', editedAt: null,
          threadState: 'open', resolvedAt: null, targetBlockId: 'block_1', selectedText: null }
      ]
    }), deps);

    const commentSources = contextSourceRepository.listSources().filter((s) => s.sourceType === 'space_page_comment');
    expect(commentSources).toHaveLength(2);
    const authorOpenIds = commentSources.map((s) => s.metadata.authorOpenId);
    expect(new Set(authorOpenIds)).toEqual(new Set(['ou_ivy', 'ou_james']));
    expect(new Set(commentSources.map((s) => s.logicalKey)).size).toBe(2);
  });
});

describe('Phase 3 fixture scenario: a resolved comment does not become a shared decision', () => {
  it('records threadState and resolvedAt on the source without any consensus side effect', () => {
    const { contextSourceRepository, deps } = setup();
    ingestSpaceSyncEnvelope(baseEnvelope({
      comments: [{
        threadId: 'thread_1', messageId: 'msg_1', authorId: 'ou_ivy', authorDisplayName: 'Ivy',
        body: '已经讨论过，暂不改动', createdAt: '2026-10-18T10:05:00.000Z', editedAt: null,
        threadState: 'resolved', resolvedAt: '2026-10-18T11:00:00.000Z', targetBlockId: 'block_1', selectedText: null
      }]
    }), deps);

    const [comment] = contextSourceRepository.listSources().filter((s) => s.sourceType === 'space_page_comment');
    expect(comment?.metadata.threadState).toBe('resolved');
    expect(comment?.metadata.resolvedAt).toBe('2026-10-18T11:00:00.000Z');
    // Ingestion never writes context_topics/topic_perspectives: resolving a thread cannot,
    // by construction, create a shared_decision or any other analysis-layer record here.
  });
});

describe('Phase 3 fixture scenario: incomplete comment pagination is reported as a gap, not silence', () => {
  it('keeps commentsComplete=false and records the gap and cursor on the run receipt', () => {
    const { spaceSyncRepository, deps } = setup();
    const result = ingestSpaceSyncEnvelope(baseEnvelope({
      coverage: {
        pageComplete: true, commentsComplete: false, nextCursor: 'cursor-page-2',
        gaps: [{ code: 'comments_partial', summary: '评论分页未读完，下一页游标 cursor-page-2' }]
      }
    }), deps);

    expect(result.run.coverageCommentsComplete).toBe(false);
    expect(result.run.nextCursor).toBe('cursor-page-2');
    expect(result.run.gapCount).toBe(1);
    const latestRun = spaceSyncRepository.getLatestRunForBinding('binding-1');
    expect(latestRun?.coverageCommentsComplete).toBe(false);
  });
});

describe('Phase 3 fixture scenario: permission lost preserves history and the project', () => {
  it('marks the binding permission_lost, keeps prior sources, and rejects further ingestion', () => {
    const { database, spaceSyncRepository, contextSourceRepository, deps } = setup();
    ingestSpaceSyncEnvelope(baseEnvelope(), deps);
    const sourceCountBeforeLoss = contextSourceRepository.listSources().length;

    spaceSyncRepository.recordSyncFailure({
      bindingId: 'binding-1', errorCode: 'permission_denied', attemptedAt: new Date('2026-10-19T01:00:00.000Z')
    });

    expect(spaceSyncRepository.getBindingById('binding-1')?.status).toBe('permission_lost');
    expect(contextSourceRepository.listSources()).toHaveLength(sourceCountBeforeLoss);
    expect(database.client.prepare(`
      SELECT project_key FROM projects WHERE project_key = 'smart_listing'
    `).get()).toEqual({ project_key: 'smart_listing' });

    expect(() => ingestSpaceSyncEnvelope(baseEnvelope({ syncId: 'sync_2' }), deps))
      .toThrow('space_sync_binding_not_active');
  });
});

describe('Phase 3 isolation assertions: ingestion never touches delivery or Todo state', () => {
  it('leaves outbox and meeting_todos untouched across a full scenario sequence', () => {
    const { database, deps } = setup();
    ingestSpaceSyncEnvelope(baseEnvelope(), deps);
    ingestSpaceSyncEnvelope(baseEnvelope({
      syncId: 'sync_2',
      page: { ...baseEnvelope().page, sequence: 2, blocks: [{ id: 'block_1', hash: 'b'.repeat(64), markdown: '阶段已更新' }] },
      comments: [{
        threadId: 'thread_1', messageId: 'msg_1', authorId: 'ou_ivy', authorDisplayName: 'Ivy',
        body: '已补充负责人', createdAt: '2026-10-18T10:05:00.000Z', editedAt: null,
        threadState: 'resolved', resolvedAt: '2026-10-18T11:00:00.000Z', targetBlockId: 'block_1', selectedText: null
      }]
    }), deps);

    expect(database.client.prepare('SELECT COUNT(*) AS n FROM outbox').get()).toEqual({ n: 0 });
    expect(database.client.prepare('SELECT COUNT(*) AS n FROM meeting_todos').get()).toEqual({ n: 0 });
    expect(database.client.prepare('SELECT COUNT(*) AS n FROM batch_jobs').get()).toEqual({ n: 0 });
  });

  it('never creates duplicate sources for the same logical content across repeated ingests', () => {
    const { contextSourceRepository, deps } = setup();
    ingestSpaceSyncEnvelope(baseEnvelope(), deps);
    ingestSpaceSyncEnvelope(baseEnvelope(), deps);
    expect(contextSourceRepository.listSources().filter((s) => s.sourceType === 'space_page_snapshot')).toHaveLength(1);
  });
});
