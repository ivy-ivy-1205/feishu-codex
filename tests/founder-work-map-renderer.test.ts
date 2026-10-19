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

  it('renders principles and research beneath their parent project instead of as separate numbered projects',()=>{
    const [page]=renderFounderWorkMap({...window,topics:[{...topic('a'),supportingItems:[
      {kind:'principle',displayName:'情绪价值'},{kind:'research',displayName:'PropHero 竞品研究'}]}],uncertainGrouping:[],coverageGaps:[]});
    const body=JSON.stringify(page!.card);
    expect(body).toContain('原则：情绪价值');expect(body).toContain('研究：PropHero 竞品研究');
    expect(page!.itemRefs).toHaveLength(1);
  });

  it('renders reviewed business lines before their nested projects instead of a flat active-project list',()=>{
    const a={...topic('a','active_project'),displayName:'AiJia AI Native 房产业务'};
    const website={...topic('website','active_project'),displayName:'AiJia AI Native 官网',parentName:a.displayName};
    const smart={...topic('smart','active_project'),displayName:'Smart Listing',parentName:a.displayName};
    const sales={...topic('sales','active_project'),displayName:'房产销售过程数据沉淀',parentName:a.displayName,
      outcome:'沉淀三类数据：1）Open Home 全程、全量、清晰录音并区分销售与客户；2）Open Home 或私聊后的 CRM 客户需求与情况回填，以每套房导出的 CRM 记录作为分析起点，当前尚未要求完整回填；3）销售团队内部 Training 录音语料。'};
    const b={...topic('b','active_project'),displayName:'自媒体生产线'};
    const episode={...topic('episode','closed'),displayName:'EP00《挺好》',parentName:b.displayName};
    const [page]=renderFounderWorkMap({...window,topics:[episode,sales,smart,b,website,a],uncertainGrouping:[],coverageGaps:[]});
    const body=JSON.stringify(page!.card);
    expect(body).toContain('A 线｜AiJia AI Native 房产业务');
    expect(body).toContain('项目｜AiJia AI Native 官网');
    expect(body).toContain('项目｜Smart Listing');
    expect(body).not.toContain('层级：');
    expect(body).toContain('销售团队内部 Training 录音语料');
    expect(body).toContain('B 线｜自媒体生产线');
    expect(body).toContain('项目｜EP00《挺好》（已结束）');
    expect(body).not.toContain('总项目：AiJia AI Native 房产业务');
    expect(body).not.toContain('总项目：自媒体生产线');
    expect(page!.itemRefs.map((item)=>item.id)).toEqual(['website','smart','sales','episode']);
    expect(body.indexOf('A 线｜AiJia AI Native 房产业务')).toBeLessThan(body.indexOf('项目｜AiJia AI Native 官网'));
    expect(body.indexOf('项目｜AiJia AI Native 官网')).toBeLessThan(body.indexOf('项目｜Smart Listing'));
    expect(body.indexOf('B 线｜自媒体生产线')).toBeLessThan(body.indexOf('项目｜EP00《挺好》'));
  });

  it('renders a glanceable tree and keeps tasks and phase goals out of project numbering',()=>{
    const a={...topic('a','active_project'),displayName:'AiJia AI Native 房产业务'};
    const smart={...topic('smart','active_project'),displayName:'Smart Listing',parentName:a.displayName};
    const sample={...topic('sample','active_project'),displayName:'Smart Listing L008｜27 Cecil Street 样板',parentName:smart.displayName};
    const update={...topic('update','active_project'),displayName:'给静姐和 Kenny 哥 update',parentName:a.displayName,displayKind:'task' as const};
    const c={...topic('c','active_project'),displayName:'公司协作基础设施'};
    const room={...topic('room','active_project'),displayName:'飞书合伙人对齐',parentName:c.displayName};
    const wecom={...topic('wecom','exploring'),displayName:'企业微信接入',parentName:c.displayName};
    const phase={...topic('phase','active_project'),displayName:'飞书第一阶段目标',parentName:room.displayName,displayKind:'goal' as const};
    const [page]=renderFounderWorkMap({...window,topics:[phase,wecom,room,c,update,sample,smart,a],uncertainGrouping:[],coverageGaps:[]});
    const body=JSON.stringify(page!.card);
    expect(body).toContain('A 线｜AiJia AI Native 房产业务');
    expect(body).toContain('#1 · 项目｜Smart Listing');
    expect(body).toContain('#2 · ↳ 子项目｜Smart Listing L008｜27 Cecil Street 样板');
    expect(body).toContain('任务｜给静姐和 Kenny 哥 update');
    expect(body).toContain('C 线｜公司协作基础设施');
    expect(body).toContain('#3 · 项目｜飞书合伙人对齐');
    expect(body).toContain('#4 · 项目｜企业微信接入');
    expect(body).toContain('↳ 阶段目标｜飞书第一阶段目标');
    expect(body.indexOf('#3 · 项目｜飞书合伙人对齐'))
      .toBeLessThan(body.indexOf('↳ 阶段目标｜飞书第一阶段目标'));
    expect(body.indexOf('↳ 阶段目标｜飞书第一阶段目标'))
      .toBeLessThan(body.indexOf('#4 · 项目｜企业微信接入'));
    expect(body.indexOf('C 线｜公司协作基础设施'))
      .toBeLessThan(body.indexOf('#3 · 项目｜飞书合伙人对齐'));
    expect(body).not.toContain('层级：');
    expect(page!.itemRefs.map(ref=>ref.id)).toEqual(['smart','sample','room','wecom']);
  });

  it('separates the current direction from historical proposals and unresolved viewpoints', () => {
    const [page] = renderFounderWorkMap({ ...window, topics: [{ ...topic('a', 'active_project'),
      outcome: '不承诺全场景、全量录音。', linkedSourceCount: 3,
      perspectives: [
        { founder: 'James', status: 'historical', statement: '所有真实业务场景开启录音。', observedAt: '2026-09-07T10:04:30.000Z' },
        { founder: 'Ivy', status: 'unresolved', statement: '先验证 Open Home 录音。', observedAt: '2026-09-24T09:00:00.000Z' }
      ]
    }], uncertainGrouping: [], coverageGaps: [] });
    const body = JSON.stringify(page!.card);
    expect(body).toContain('当前方向：不承诺全场景、全量录音。');
    expect(body).toContain('历史记录：1 条，可用“查看对齐：话题 a”查看');
    expect(body).toContain('待对齐（Ivy，2026-09-24）');
    expect(body).not.toContain('所有真实业务场景开启录音。');
    expect(body).toContain('已关联 3 个来源');
    expect(body).not.toContain('目标：不承诺全场景、全量录音。');
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
    expect(body).not.toContain('om_a');
    expect(body).toContain('来源：群聊');
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

  it('shows a Space sync line for a bound, up-to-date topic without a staleness warning', () => {
    const [page] = renderFounderWorkMap({ ...window, topics: [{ ...topic('a'), spaceFreshness: {
      status: 'synced', lastSuccessfulSyncAt: '2026-09-19T12:00:00.000Z', pageUpdatedAt: '2026-09-19T11:00:00.000Z',
      lastErrorCode: null, coverageIncomplete: false, gapCount: 0
    } }], uncertainGrouping: [], coverageGaps: [] });
    const body = JSON.stringify(page!.card);
    expect(body).toContain('Space');
    expect(body).toContain('2026-09-19T12:00:00.000Z');
    expect(body).not.toContain('可能滞后');
  });

  it('warns that Space content may be stale for a bound topic past the threshold', () => {
    const [page] = renderFounderWorkMap({ ...window, topics: [{ ...topic('a'), spaceFreshness: {
      status: 'stale', lastSuccessfulSyncAt: '2026-08-01T00:00:00.000Z', pageUpdatedAt: '2026-08-01T00:00:00.000Z',
      lastErrorCode: null, coverageIncomplete: false, gapCount: 0
    } }], uncertainGrouping: [], coverageGaps: [] });
    const body = JSON.stringify(page!.card);
    expect(body).toContain('Space 内容可能滞后');
  });

  it('surfaces a permission_lost Space binding without claiming it is up to date', () => {
    const [page] = renderFounderWorkMap({ ...window, topics: [{ ...topic('a'), spaceFreshness: {
      status: 'permission_lost', lastSuccessfulSyncAt: '2026-08-01T00:00:00.000Z', pageUpdatedAt: null,
      lastErrorCode: 'permission_denied', coverageIncomplete: false, gapCount: 0
    } }], uncertainGrouping: [], coverageGaps: [] });
    const body = JSON.stringify(page!.card);
    expect(body).toContain('权限缺失');
  });

  it('renders no Space line at all for a topic with no binding', () => {
    const [page] = renderFounderWorkMap({ ...window, topics: [topic('a')], uncertainGrouping: [], coverageGaps: [] });
    expect(JSON.stringify(page!.card)).not.toContain('Space');
  });

  it('does not use Space comments as the 来源 line when a project-page block already summarizes them', () => {
    const comment = { id: 'ctxev_c', sourceId: 'ctxsrc_c', sourceVersion: 1, excerpt: 'agent：已更新配套信息', occurredAt: '2026-09-19T00:00:00.000Z',
      locator: { kind: 'space_comment' as const, sourceVersion: 1, contentHash: 'a'.repeat(64), pageId: 'page_1', threadId: 't', messageId: 'm',
        authorOpenId: null, targetBlockId: null } };
    const spacePage = { freshness: { status: 'synced' as const, lastSuccessfulSyncAt: '2026-09-19T12:00:00.000Z', pageUpdatedAt: null,
      lastErrorCode: null, coverageIncomplete: false, gapCount: 0 }, pageUpdatedAt: '2026-09-19T11:00:00.000Z', digest: null,
      comments: { open: 0, resolved: 1, ivy: 0, james: 0, other: 0, divergenceCandidates: 0 } };
    const [page] = renderFounderWorkMap({ ...window, topics: [{ ...topic('a'), evidence: [comment], spacePage }], uncertainGrouping: [], coverageGaps: [] });
    const body = JSON.stringify(page!.card);
    expect(body).not.toContain('agent：已更新配套信息');
    expect(body).not.toContain('来源：待补充');
    expect(body).toContain('项目页（Space · 页面更新于 2026-09-19T11:00:00.000Z');
  });

  it('moves dormant topics into a numbered 长期无动态 section at the end of the text card', () => {
    const [page] = renderFounderWorkMap({ ...window, topics: [
      { ...topic('a', 'active_project'), displayName: '活跃项目' },
      { ...topic('b', 'active_project'), displayName: '沉睡项目', outcome: '等待 Jimmy', dormant: true, lastActivityAt: '2026-08-01T00:00:00.000Z' }
    ], uncertainGrouping: [], coverageGaps: [] });
    const body = JSON.stringify(page!.card);
    const section = body.indexOf('长期无动态 1 项');
    expect(section).toBeGreaterThan(body.indexOf('活跃项目'));
    expect(body.indexOf('#2 · 项目｜沉睡项目')).toBeGreaterThan(section);
    expect(body).toContain('最近动态 2026-08-01');
    expect(page!.itemRefs.map((ref) => ref.id)).toEqual(['a', 'b']);
  });
});
