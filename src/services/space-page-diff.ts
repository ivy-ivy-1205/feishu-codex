import type { SpaceSyncBlock } from '../domain/space-sync.js';

/** Founder calendar is UTC+8 (Asia/Shanghai, no DST); weeks start Monday. */
const founderOffsetMs = 8 * 60 * 60 * 1_000;
const dayMs = 24 * 60 * 60 * 1_000;

export interface SpaceBlockDiff { added: string[]; changed: string[]; removed: string[] }

export interface SpacePageVersionBlocks { occurredAt: string; blocks: readonly SpaceSyncBlock[] }

export interface SpacePageChangeWindows {
  /** first_snapshot: no stored version predates this week, so no block may be presented as this week's change. */
  basis: 'version_diff' | 'first_snapshot';
  todayChangedBlockIds: string[];
  weekChangedBlockIds: string[];
}

/**
 * A block is unchanged when its id keeps the same hash, or when its exact content already
 * existed anywhere in the previous version (editors and agents may regenerate block ids).
 */
export function diffSpacePageBlocks(previous: readonly SpaceSyncBlock[], current: readonly SpaceSyncBlock[]): SpaceBlockDiff {
  const previousById = new Map(previous.map((block) => [block.id, block]));
  const previousHashes = new Set(previous.map((block) => block.hash));
  const currentIds = new Set(current.map((block) => block.id));
  const currentHashes = new Set(current.map((block) => block.hash));
  const diff: SpaceBlockDiff = { added: [], changed: [], removed: [] };
  for (const block of current) {
    if (previousHashes.has(block.hash)) continue;
    (previousById.has(block.id) ? diff.changed : diff.added).push(block.id);
  }
  for (const block of previous) if (!currentIds.has(block.id) && !currentHashes.has(block.hash)) diff.removed.push(block.id);
  return diff;
}

export function spaceWindowStarts(now: Date): { todayStart: string; weekStart: string } {
  const local = now.getTime() + founderOffsetMs;
  const localMidnight = Math.floor(local / dayMs) * dayMs;
  const weekday = (new Date(localMidnight).getUTCDay() + 6) % 7;
  return { todayStart: new Date(localMidnight - founderOffsetMs).toISOString(),
    weekStart: new Date(localMidnight - weekday * dayMs - founderOffsetMs).toISOString() };
}

/** `versions` are one page's stored snapshots in any order; the latest one is the page as it stands now. */
export function spacePageChangeWindows(versions: readonly SpacePageVersionBlocks[], now: Date): SpacePageChangeWindows {
  const ordered = [...versions].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  const latest = ordered.at(-1);
  if (!latest) return { basis: 'first_snapshot', todayChangedBlockIds: [], weekChangedBlockIds: [] };
  const { todayStart, weekStart } = spaceWindowStarts(now);
  const baselineBefore = (start: string) => [...ordered].reverse().find((version) => Date.parse(version.occurredAt) < Date.parse(start));
  const weekBaseline = baselineBefore(weekStart);
  if (!weekBaseline) return { basis: 'first_snapshot', todayChangedBlockIds: [], weekChangedBlockIds: [] };
  const changed = (baseline: SpacePageVersionBlocks) => {
    const diff = diffSpacePageBlocks(baseline.blocks, latest.blocks);
    return [...diff.added, ...diff.changed].sort();
  };
  return { basis: 'version_diff', todayChangedBlockIds: changed(baselineBefore(todayStart) ?? weekBaseline),
    weekChangedBlockIds: changed(weekBaseline) };
}
