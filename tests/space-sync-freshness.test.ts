import { describe, expect, it } from 'vitest';
import { computeSpaceFreshness } from '../src/services/space-sync-freshness.js';
import type { ProjectSpaceBindingRecord, SpaceSyncRunRecord } from '../src/repositories/space-sync-repository.js';

function binding(overrides: Partial<ProjectSpaceBindingRecord> = {}): ProjectSpaceBindingRecord {
  return {
    id: 'binding-1', projectKey: 'smart_listing', provider: 'chatgpt_space', spaceId: null,
    pageId: 'page_1', pageUrl: 'https://chatgpt.com/space/page_1', managementMode: 'space',
    syncMode: 'manual', status: 'active', lastSeenSequence: 3,
    lastPageUpdatedAt: '2026-10-18T10:00:00.000Z', lastSyncedAt: '2026-10-19T00:00:00.000Z',
    lastSuccessfulSyncAt: '2026-10-19T00:00:00.000Z', lastErrorCode: null,
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-19T00:00:00.000Z',
    ...overrides
  };
}

function run(overrides: Partial<SpaceSyncRunRecord> = {}): SpaceSyncRunRecord {
  return {
    id: 'sync-1', bindingId: 'binding-1', projectKey: 'smart_listing', pageId: 'page_1',
    trigger: 'manual', envelopeHash: 'hash-1', status: 'completed', errorCode: null,
    pageSourceCreated: true, commentSourcesCreated: 0, coveragePageComplete: true,
    coverageCommentsComplete: true, nextCursor: null, gapCount: 0,
    startedAt: '2026-10-19T00:00:00.000Z', completedAt: '2026-10-19T00:00:01.000Z',
    ...overrides
  };
}

describe('computeSpaceFreshness', () => {
  it('reports not_bound when the project has no binding', () => {
    const result = computeSpaceFreshness({
      binding: null, latestRun: null, now: new Date('2026-10-19T00:10:00.000Z'), staleAfterMinutes: 30
    });
    expect(result.status).toBe('not_bound');
  });

  it('reports synced within the staleness window', () => {
    const result = computeSpaceFreshness({
      binding: binding(), latestRun: run(), now: new Date('2026-10-19T00:10:00.000Z'), staleAfterMinutes: 30
    });
    expect(result.status).toBe('synced');
    expect(result.coverageIncomplete).toBe(false);
  });

  it('reports stale once the last successful sync is older than the threshold', () => {
    const result = computeSpaceFreshness({
      binding: binding(), latestRun: run(), now: new Date('2026-10-19T01:00:00.000Z'), staleAfterMinutes: 30
    });
    expect(result.status).toBe('stale');
  });

  it('reports stale when there has never been a successful sync', () => {
    const result = computeSpaceFreshness({
      binding: binding({ lastSuccessfulSyncAt: null }), latestRun: null,
      now: new Date('2026-10-19T00:10:00.000Z'), staleAfterMinutes: 30
    });
    expect(result.status).toBe('stale');
  });

  it('reports permission_lost regardless of sync age, and never claims a live refresh', () => {
    const result = computeSpaceFreshness({
      binding: binding({ status: 'permission_lost', lastErrorCode: 'permission_denied' }),
      latestRun: run(), now: new Date('2026-10-19T00:10:00.000Z'), staleAfterMinutes: 30
    });
    expect(result.status).toBe('permission_lost');
    expect(result.lastErrorCode).toBe('permission_denied');
  });

  it('surfaces incomplete coverage and gap count from the latest run', () => {
    const result = computeSpaceFreshness({
      binding: binding(), latestRun: run({ coverageCommentsComplete: false, gapCount: 1 }),
      now: new Date('2026-10-19T00:10:00.000Z'), staleAfterMinutes: 30
    });
    expect(result.coverageIncomplete).toBe(true);
    expect(result.gapCount).toBe(1);
  });
});
