import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { SpaceSyncRepository } from '../src/repositories/space-sync-repository.js';

function setup() {
  const database = createSqliteDatabase(':memory:');
  migrateDatabase(database.client);
  database.client.prepare(`
    INSERT INTO projects (project_key, display_name, aliases, status, origin, stage, created_at, updated_at)
    VALUES ('smart_listing', 'Smart Listing', '[]', 'active', 'human_confirmed', 'active_project', ?, ?)
  `).run('2026-10-19T00:00:00.000Z', '2026-10-19T00:00:00.000Z');
  return new SpaceSyncRepository(database.client);
}

describe('SpaceSyncRepository bindings', () => {
  it('creates a binding and reads it back by page id', () => {
    const repository = setup();
    const created = repository.createBinding({
      id: 'binding-1', projectKey: 'smart_listing', spaceId: null,
      pageId: 'page_1', pageUrl: 'https://chatgpt.com/space/page_1',
      managementMode: 'space', syncMode: 'manual', createdAt: new Date('2026-10-19T00:00:00.000Z')
    });
    expect(created.status).toBe('active');
    expect(repository.getBindingByPageId('page_1')?.id).toBe('binding-1');
    expect(repository.getBindingById('missing')).toBeNull();
  });

  it('reads a binding back by projectKey, for worker eligibility that is unaware of pageId', () => {
    const repository = setup();
    repository.createBinding({
      id: 'binding-1', projectKey: 'smart_listing', spaceId: null,
      pageId: 'page_1', pageUrl: 'https://chatgpt.com/space/page_1',
      managementMode: 'space', syncMode: 'manual', createdAt: new Date('2026-10-19T00:00:00.000Z')
    });
    expect(repository.getBindingByProjectKey('smart_listing')?.id).toBe('binding-1');
    expect(repository.getBindingByProjectKey('unbound_project')).toBeNull();
  });

  it('still returns a permission_lost binding by projectKey, since history remains analyzable', () => {
    const repository = setup();
    repository.createBinding({
      id: 'binding-1', projectKey: 'smart_listing', spaceId: null,
      pageId: 'page_1', pageUrl: 'https://chatgpt.com/space/page_1',
      managementMode: 'space', syncMode: 'manual', createdAt: new Date('2026-10-19T00:00:00.000Z')
    });
    repository.recordSyncFailure({
      bindingId: 'binding-1', errorCode: 'permission_denied', attemptedAt: new Date('2026-10-19T01:00:00.000Z')
    });
    expect(repository.getBindingByProjectKey('smart_listing')?.status).toBe('permission_lost');
  });

  it('records a successful sync and clears any prior error', () => {
    const repository = setup();
    repository.createBinding({
      id: 'binding-1', projectKey: 'smart_listing', spaceId: null,
      pageId: 'page_1', pageUrl: 'https://chatgpt.com/space/page_1',
      managementMode: 'space', syncMode: 'manual', createdAt: new Date('2026-10-19T00:00:00.000Z')
    });
    repository.recordSyncFailure({
      bindingId: 'binding-1', errorCode: 'permission_denied', attemptedAt: new Date('2026-10-19T01:00:00.000Z')
    });
    expect(repository.getBindingById('binding-1')?.status).toBe('permission_lost');

    repository.recordSuccessfulSync({
      bindingId: 'binding-1', pageSequence: 4, pageUpdatedAt: '2026-10-19T02:00:00.000Z',
      syncedAt: new Date('2026-10-19T02:00:01.000Z')
    });
    const binding = repository.getBindingById('binding-1');
    expect(binding?.status).toBe('active');
    expect(binding?.lastErrorCode).toBeNull();
    expect(binding?.lastSeenSequence).toBe(4);
    expect(binding?.lastSuccessfulSyncAt).toBe('2026-10-19T02:00:01.000Z');
  });

  it('throws when recording a sync against an unknown binding', () => {
    const repository = setup();
    expect(() => repository.recordSuccessfulSync({
      bindingId: 'missing', pageSequence: 1, pageUpdatedAt: null, syncedAt: new Date('2026-10-19T00:00:00.000Z')
    })).toThrow('SPACE_SYNC_BINDING_NOT_FOUND');
  });
});

describe('SpaceSyncRepository runs', () => {
  it('inserts a completed run keyed by syncId and allows idempotent lookup', () => {
    const repository = setup();
    repository.createBinding({
      id: 'binding-1', projectKey: 'smart_listing', spaceId: null,
      pageId: 'page_1', pageUrl: 'https://chatgpt.com/space/page_1',
      managementMode: 'space', syncMode: 'manual', createdAt: new Date('2026-10-19T00:00:00.000Z')
    });
    expect(repository.getRunBySyncId('sync-1')).toBeNull();

    const run = repository.insertRun({
      syncId: 'sync-1', bindingId: 'binding-1', projectKey: 'smart_listing', pageId: 'page_1',
      trigger: 'manual', envelopeHash: 'hash-1', pageSourceCreated: true, commentSourcesCreated: 2,
      coveragePageComplete: true, coverageCommentsComplete: false, nextCursor: 'cursor-1', gapCount: 1,
      startedAt: new Date('2026-10-19T00:00:00.000Z'), completedAt: new Date('2026-10-19T00:00:01.000Z')
    });
    expect(run.pageSourceCreated).toBe(true);
    expect(run.coverageCommentsComplete).toBe(false);
    expect(repository.getRunBySyncId('sync-1')).toEqual(run);
  });

  it('rejects inserting the same syncId twice', () => {
    const repository = setup();
    repository.createBinding({
      id: 'binding-1', projectKey: 'smart_listing', spaceId: null,
      pageId: 'page_1', pageUrl: 'https://chatgpt.com/space/page_1',
      managementMode: 'space', syncMode: 'manual', createdAt: new Date('2026-10-19T00:00:00.000Z')
    });
    repository.insertRun({
      syncId: 'sync-1', bindingId: 'binding-1', projectKey: 'smart_listing', pageId: 'page_1',
      trigger: 'manual', envelopeHash: 'hash-1', pageSourceCreated: true, commentSourcesCreated: 0,
      coveragePageComplete: true, coverageCommentsComplete: true, nextCursor: null, gapCount: 0,
      startedAt: new Date('2026-10-19T00:00:00.000Z'), completedAt: new Date('2026-10-19T00:00:01.000Z')
    });
    expect(() => repository.insertRun({
      syncId: 'sync-1', bindingId: 'binding-1', projectKey: 'smart_listing', pageId: 'page_1',
      trigger: 'manual', envelopeHash: 'hash-2', pageSourceCreated: false, commentSourcesCreated: 0,
      coveragePageComplete: true, coverageCommentsComplete: true, nextCursor: null, gapCount: 0,
      startedAt: new Date('2026-10-19T00:00:00.000Z'), completedAt: new Date('2026-10-19T00:00:01.000Z')
    })).toThrow(/UNIQUE/);
  });
});
