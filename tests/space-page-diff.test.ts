import { describe, expect, it } from 'vitest';
import { diffSpacePageBlocks, spacePageChangeWindows, spaceWindowStarts } from '../src/services/space-page-diff.js';

const block = (id: string, hashChar: string, markdown = `${id} 内容`) => ({ id, hash: hashChar.repeat(64), markdown });

describe('diffSpacePageBlocks', () => {
  it('classifies added, changed, unchanged and removed blocks by id + hash', () => {
    const previous = [block('b1', 'a'), block('b2', 'b'), block('b3', 'c')];
    const current = [block('b1', 'a'), block('b2', 'd'), block('b4', 'e')];
    expect(diffSpacePageBlocks(previous, current)).toEqual({ added: ['b4'], changed: ['b2'], removed: ['b3'] });
  });

  it('falls back to content hash when an editor regenerated block ids without changing text', () => {
    const previous = [block('old_1', 'a'), block('old_2', 'b')];
    const current = [block('new_1', 'a'), block('new_2', 'b'), block('new_3', 'c')];
    expect(diffSpacePageBlocks(previous, current)).toEqual({ added: ['new_3'], changed: [], removed: [] });
  });

  it('treats a block that moved position but kept id and hash as unchanged', () => {
    const previous = [block('b1', 'a'), block('b2', 'b')];
    const current = [block('b2', 'b'), block('b1', 'a')];
    expect(diffSpacePageBlocks(previous, current)).toEqual({ added: [], changed: [], removed: [] });
  });
});

describe('spaceWindowStarts (Asia/Shanghai calendar, week starts Monday)', () => {
  it('computes local midnight today and Monday of this week', () => {
    // 2026-10-21 is a Wednesday; 01:30 UTC is 09:30 in UTC+8.
    expect(spaceWindowStarts(new Date('2026-10-21T01:30:00.000Z'))).toEqual({
      todayStart: '2026-10-20T16:00:00.000Z', weekStart: '2026-10-18T16:00:00.000Z' });
  });

  it('rolls to the next local day before UTC midnight', () => {
    // 2026-10-18T17:00Z is Monday 01:00 in UTC+8 — a new week already.
    expect(spaceWindowStarts(new Date('2026-10-18T17:00:00.000Z'))).toEqual({
      todayStart: '2026-10-18T16:00:00.000Z', weekStart: '2026-10-18T16:00:00.000Z' });
  });
});

describe('spacePageChangeWindows', () => {
  const v = (occurredAt: string, blocks: ReturnType<typeof block>[]) => ({ occurredAt, blocks });

  it('diffs the latest version against the last version before each window start', () => {
    const versions = [
      v('2026-10-15T02:00:00.000Z', [block('b1', 'a'), block('b2', 'b')]),
      v('2026-10-20T02:00:00.000Z', [block('b1', 'a'), block('b2', 'c')]),
      v('2026-10-21T01:00:00.000Z', [block('b1', 'a'), block('b2', 'c'), block('b3', 'd')])
    ];
    expect(spacePageChangeWindows(versions, new Date('2026-10-21T02:00:00.000Z'))).toEqual({
      basis: 'version_diff', todayChangedBlockIds: ['b3'], weekChangedBlockIds: ['b2', 'b3'] });
  });

  it('reports first_snapshot when no version predates the week, so nothing is claimed as this week\'s change', () => {
    const versions = [v('2026-10-20T02:00:00.000Z', [block('b1', 'a')])];
    expect(spacePageChangeWindows(versions, new Date('2026-10-21T02:00:00.000Z'))).toEqual({
      basis: 'first_snapshot', todayChangedBlockIds: [], weekChangedBlockIds: [] });
  });

  it('uses the week baseline for today when there is no version before today but one before the week', () => {
    const versions = [
      v('2026-10-14T02:00:00.000Z', [block('b1', 'a')]),
      v('2026-10-21T01:00:00.000Z', [block('b1', 'z')])
    ];
    expect(spacePageChangeWindows(versions, new Date('2026-10-21T02:00:00.000Z'))).toEqual({
      basis: 'version_diff', todayChangedBlockIds: ['b1'], weekChangedBlockIds: ['b1'] });
  });

  it('reports no change for an untouched page with old history', () => {
    const versions = [v('2026-10-01T02:00:00.000Z', [block('b1', 'a')])];
    expect(spacePageChangeWindows(versions, new Date('2026-10-21T02:00:00.000Z'))).toEqual({
      basis: 'version_diff', todayChangedBlockIds: [], weekChangedBlockIds: [] });
  });
});
