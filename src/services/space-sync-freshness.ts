import type { ProjectSpaceBindingRecord, SpaceSyncRunRecord } from '../repositories/space-sync-repository.js';

export type SpaceFreshnessStatus = 'not_bound' | 'permission_lost' | 'stale' | 'synced';

export interface SpaceFreshnessSummary {
  status: SpaceFreshnessStatus;
  lastSuccessfulSyncAt: string | null;
  pageUpdatedAt: string | null;
  lastErrorCode: string | null;
  /** From the most recent run's coverage, when available; never inferred from a live probe. */
  coverageIncomplete: boolean;
  gapCount: number;
}

/**
 * Pure read-time projection over the binding's last-known state and its latest run's
 * coverage. Never contacts the Space producer and never claims a refresh in progress —
 * per docs/2026-10-19-space-to-context-sync-cloud-code-handoff.md §8.3: the work map
 * reads Context's current state and marks Space content as possibly stale instead of
 * waiting on, or pretending to trigger, an external sync.
 */
export function computeSpaceFreshness(input: {
  binding: ProjectSpaceBindingRecord | null;
  latestRun: SpaceSyncRunRecord | null;
  now: Date;
  staleAfterMinutes: number;
}): SpaceFreshnessSummary {
  const { binding, latestRun, now, staleAfterMinutes } = input;
  if (!binding) {
    return {
      status: 'not_bound', lastSuccessfulSyncAt: null, pageUpdatedAt: null,
      lastErrorCode: null, coverageIncomplete: false, gapCount: 0
    };
  }

  const coverageIncomplete = latestRun
    ? !latestRun.coveragePageComplete || !latestRun.coverageCommentsComplete
    : false;
  const gapCount = latestRun?.gapCount ?? 0;

  if (binding.status === 'permission_lost') {
    return {
      status: 'permission_lost', lastSuccessfulSyncAt: binding.lastSuccessfulSyncAt,
      pageUpdatedAt: binding.lastPageUpdatedAt, lastErrorCode: binding.lastErrorCode,
      coverageIncomplete, gapCount
    };
  }

  const ageMinutes = binding.lastSuccessfulSyncAt
    ? (now.getTime() - new Date(binding.lastSuccessfulSyncAt).getTime()) / 60_000
    : Number.POSITIVE_INFINITY;
  const status: SpaceFreshnessStatus = ageMinutes > staleAfterMinutes ? 'stale' : 'synced';

  return {
    status, lastSuccessfulSyncAt: binding.lastSuccessfulSyncAt, pageUpdatedAt: binding.lastPageUpdatedAt,
    lastErrorCode: binding.lastErrorCode, coverageIncomplete, gapCount
  };
}
