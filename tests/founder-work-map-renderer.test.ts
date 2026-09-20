import { describe, expect, it } from 'vitest';
import { renderFounderWorkMap, type FounderWorkMapTopic } from '../src/services/founder-work-map-renderer.js';

const window = { since: '2026-08-31T00:00:00.000Z', until: '2026-09-20T00:00:00.000Z' };
const topic = (id: string, stage: FounderWorkMapTopic['stage'] = 'idea'): FounderWorkMapTopic => ({
  id, currentVersion: 1, displayName: `话题 ${id}`, stage, outcome: null, evidence: []
});

describe('founder work map cards', () => {
  it('keeps ideas visible without inventing projects from an empty project set', () => {
    const [page] = renderFounderWorkMap({ ...window, topics: [topic('a')], uncertainGrouping: [], coverageGaps: [] });
    const body = JSON.stringify(page!.card);
    expect(body).toContain('想法');
    expect(body).toContain('话题 a');
    expect(body).not.toContain('正在推进的项目');
    expect(body).not.toContain('候选项目');
    expect(body).toContain('自然语言');
    expect(body).toContain('不代表完整同步');
  });

  it('retains every lifecycle section, uncertain grouping and coverage gaps', () => {
    const pages = renderFounderWorkMap({ ...window,
      topics: ['active_project', 'project_candidate', 'exploring', 'idea', 'paused', 'closed'].map((stage, i) => topic(String(i), stage as FounderWorkMapTopic['stage'])),
      uncertainGrouping: [{ id: 'join-a', topicIds: ['2', '3'], summary: '这两件事可能相关，尚未合并', evidence: [] }],
      coverageGaps: [{ id: 'gap-a', summary: '语音尚未转写' }]
    });
    const body = JSON.stringify(pages[0]!.card);
    for (const label of ['正在推进的项目', '候选项目', '探索中的话题', '想法', '暂停 / 已结束', '归类待确认', '覆盖缺口', '语音尚未转写']) expect(body).toContain(label);
    expect(pages.flatMap((page) => page.itemRefs)).toHaveLength(8);
  });

  it('paginates all primary items at twelve, with deterministic order and global reply numbers', () => {
    const topics = Array.from({ length: 25 }, (_, i) => topic(String(i).padStart(2, '0')));
    const input = { ...window, topics, uncertainGrouping: [], coverageGaps: [{ id: 'gap', summary: '文件不可读' }] };
    const pages = renderFounderWorkMap(input);
    expect(pages.map((page) => page.itemRefs.length)).toEqual([12, 12, 2]);
    expect(pages[1]!.itemRefs[0]).toEqual({ kind: 'topic', id: '12', displayedNumber: 13, expectedVersion: 1 });
    expect(pages.map((page) => page.page)).toEqual([1, 2, 3]);
    expect(pages.every((page) => page.totalPages === 3)).toBe(true);
    expect(renderFounderWorkMap({ ...input, topics: [...topics].reverse() })).toEqual(pages);
    expect(JSON.stringify(pages[2]!.card)).toContain('覆盖缺口');
    for (const page of pages) expect(JSON.stringify(page.card)).toContain('自然语言');
  });

  it('bounds source excerpts and redacts identities without rendering injected mentions or schema fields', () => {
    const dangerous = 'ou_secret <at id=all>所有人</at> ' + '😀'.repeat(2000);
    const [page] = renderFounderWorkMap({ ...window, topics: [{ ...topic('a'), displayName: dangerous,
      evidence: [{ id: 'ev', sourceId: 'src', sourceVersion: 1, occurredAt: window.since, excerpt: dangerous,
        locator: { kind: 'group_message', sourceVersion: 1, contentHash: 'a'.repeat(64), chatId: 'oc_test', messageId: 'om_a', threadId: null, authorOpenId: 'ou_private', occurredAt: window.since } }]
    }], uncertainGrouping: [], coverageGaps: [] });
    const body = JSON.stringify(page!.card);
    expect(body).not.toMatch(/ou_secret|ou_private|authorOpenId|confidence|<at/);
    expect(body).toContain('om_a');
    expect(body).toContain('2026-08-31');
    expect(body).toContain('…');
    expect(body.length).toBeLessThan(2500);
  });

  it('renders an honest empty map and rejects duplicate topic identities or invalid windows', () => {
    expect(JSON.stringify(renderFounderWorkMap({ ...window, topics: [], uncertainGrouping: [], coverageGaps: [] }))).toContain('暂无可归纳的话题');
    expect(() => renderFounderWorkMap({ ...window, topics: [topic('a'), topic('a')], uncertainGrouping: [], coverageGaps: [] })).toThrow();
    expect(() => renderFounderWorkMap({ ...window, since: 'bad', topics: [], uncertainGrouping: [], coverageGaps: [] })).toThrow();
  });

  it('preserves every item under worst-case Unicode text while keeping each payload under the byte budget', () => {
    const topics = Array.from({ length: 30 }, (_, i) => ({ ...topic(String(i).padStart(2, '0')), displayName: '😀'.repeat(1000), outcome: '😀'.repeat(3000),
      evidence: [{ id: `ev-${i}`, sourceId: 'src', sourceVersion: 1, occurredAt: window.since, excerpt: '😀'.repeat(3000),
        locator: { kind: 'group_message' as const, sourceVersion: 1, contentHash: 'a'.repeat(64), chatId: 'oc_test', messageId: 'm'.repeat(100), threadId: null, authorOpenId: null, occurredAt: window.since } }]
    }));
    const pages = renderFounderWorkMap({ ...window, topics, uncertainGrouping: [], coverageGaps: [] });
    expect(pages.flatMap((page) => page.itemRefs).map((ref) => ref.id)).toEqual(topics.map((entry) => entry.id));
    for (const page of pages) {
      expect(page.itemRefs.length).toBeLessThanOrEqual(12);
      expect(Buffer.byteLength(JSON.stringify(page.card))).toBeLessThanOrEqual(28_000);
    }
  });

  it('does not create ambiguous correction references to missing topics', () => {
    expect(() => renderFounderWorkMap({ ...window, topics: [topic('a')],
      uncertainGrouping: [{ id: 'join', topicIds: ['a', 'missing'], summary: '可能相关', evidence: [] }], coverageGaps: [] })).toThrow();
  });
});
