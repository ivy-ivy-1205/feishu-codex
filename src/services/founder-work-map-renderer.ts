import type { CurrentTopic, TopicStage } from '../domain/topic.js';
import { founderCard, founderSourceText, founderText, type FounderCardEvidence } from './founder-card.js';

export interface FounderWorkMapTopic extends Pick<CurrentTopic, 'id' | 'currentVersion' | 'displayName' | 'stage' | 'outcome'> {
  evidence: readonly FounderCardEvidence[];
  linkedSourceCount?: number;
  parentName?: string;
  perspectives?: readonly { founder:'Ivy'|'James'|'双方';status:'current'|'historical'|'unresolved';statement:string;observedAt:string }[];
  supportingItems?: readonly {kind:'principle'|'artifact'|'research';displayName:string}[];
}
export interface FounderWorkMapInput {
  since: string;
  until: string;
  topics: readonly FounderWorkMapTopic[];
  uncertainGrouping: readonly { id: string; topicIds: readonly string[]; summary: string; evidence: readonly FounderCardEvidence[] }[];
  coverageGaps: readonly { id: string; summary: string }[];
}
export interface FounderWorkMapItemRef {
  kind: 'topic' | 'uncertain_grouping' | 'coverage_gap';
  id: string;
  displayedNumber: number;
  expectedVersion?: number;
}
export interface FounderWorkMapCard {
  kind: 'founder_work_map';
  page: number;
  totalPages: number;
  itemRefs: FounderWorkMapItemRef[];
  card: Record<string, unknown>;
}

const stages: TopicStage[] = ['active_project', 'project_candidate', 'exploring', 'idea', 'paused', 'closed'];
const labels: Record<TopicStage, string> = {
  active_project: '正在推进的项目', project_candidate: '候选项目', exploring: '探索中的话题', idea: '想法', paused: '暂停 / 已结束', closed: '暂停 / 已结束'
};
interface Item { section: string; text: string; ref: FounderWorkMapItemRef }
const compareId = (a: { id: string }, b: { id: string }): number => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

export function renderFounderWorkMap(input: FounderWorkMapInput): FounderWorkMapCard[] {
  const start = Date.parse(input.since), end = Date.parse(input.until);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error('valid ordered work-map window is required');
  for (const collection of [input.topics, input.uncertainGrouping, input.coverageGaps]) {
    if (collection.some((item) => !item.id.trim()) || new Set(collection.map((item) => item.id)).size !== collection.length) {
      throw new Error('work-map item identities must be nonempty and unique');
    }
  }
  const items: Item[] = [];
  const add = (section: string, text: string, ref: Omit<FounderWorkMapItemRef, 'displayedNumber'>) => {
    const displayedNumber = items.length + 1;
    items.push({ section, text: `#${displayedNumber} · ${text}`, ref: { ...ref, displayedNumber } });
  };
  const topics = [...input.topics].sort((a, b) => stages.indexOf(a.stage) - stages.indexOf(b.stage) || compareId(a, b));
  for (const topic of topics) {
    if (!stages.includes(topic.stage) || !Number.isInteger(topic.currentVersion) || topic.currentVersion < 1 || !topic.displayName.trim()) {
      throw new Error('valid work-map topic is required');
    }
    const suffix = topic.stage === 'paused' ? '（暂停）' : topic.stage === 'closed' ? '（已结束）' : '';
    add(labels[topic.stage], `${founderText(topic.displayName, 80)}${suffix}${topic.parentName ? `\n归属：${founderText(topic.parentName,80)}` : ''}${topic.outcome ? `\n当前方向：${founderText(topic.outcome, 160)}` : ''}${perspectivePreview(topic.perspectives??[])}${supportingPreview(topic.supportingItems??[])}${evidencePreview(topic.evidence,topic.linkedSourceCount??0)}`,
      { kind: 'topic', id: topic.id, expectedVersion: topic.currentVersion });
  }
  for (const grouping of [...input.uncertainGrouping].sort(compareId)) {
    const related = [...new Set(grouping.topicIds)].map((id) => items.find((item) => item.ref.kind === 'topic' && item.ref.id === id)?.ref.displayedNumber);
    if (related.length < 2 || related.some((number) => number === undefined)) throw new Error('grouping requires at least two known topics');
    add('归类待确认', `关联条目 ${related.sort((a, b) => a! - b!).map((number) => `#${number}`).join('、')}\n${founderText(grouping.summary, 240)}${evidencePreview(grouping.evidence)}`,
      { kind: 'uncertain_grouping', id: grouping.id });
  }
  for (const gap of [...input.coverageGaps].sort(compareId)) add('覆盖缺口', founderText(gap.summary, 240), { kind: 'coverage_gap', id: gap.id });
  const preface = `整理范围：${new Date(start).toISOString()} 至 ${new Date(end).toISOString()}\n这是根据已读取语料整理的工作地图，可继续纠正。`;
  const footer = `归类待确认：${input.uncertainGrouping.length} 项；覆盖缺口：${input.coverageGaps.length} 项。未报告缺口不代表完整同步。\n可直接在本卡下用自然语言回复，例如“2 和 4 是同一个项目”“第 1 项只是想法”。编号仅对应本次工作地图。`;
  const chunks: Item[][] = [[]];
  for (const item of items) {
    const chunk = chunks.at(-1)!;
    // Reserve header/pagination overhead and split exceptionally large Unicode cards too.
    const bytes = Buffer.byteLength(JSON.stringify([preface, footer, ...chunk.map((entry) => entry.text), item.text]), 'utf8');
    if (chunk.length >= 12 || (chunk.length > 0 && bytes > 24_000)) chunks.push([item]);
    else chunk.push(item);
  }
  return chunks.map((chunk, index) => {
    let section = '';
    const lines = [preface];
    for (const item of chunk) {
      if (section !== item.section) { lines.push(item.section); section = item.section; }
      lines.push(item.text);
    }
    if (items.length === 0) lines.push('暂无可归纳的话题；不会凭空创建项目。');
    lines.push(footer);
    return { kind: 'founder_work_map', page: index + 1, totalPages: chunks.length,
      itemRefs: chunk.map((item) => item.ref), card: founderCard(`工作地图 · ${index + 1}/${chunks.length}`, lines) };
  });
}

function supportingPreview(items:readonly {kind:'principle'|'artifact'|'research';displayName:string}[]):string{
  const labels={principle:'原则',artifact:'产物',research:'研究'} as const;
  return [...items].sort((a,b)=>a.kind.localeCompare(b.kind)||a.displayName.localeCompare(b.displayName))
    .map(item=>`\n${labels[item.kind]}：${founderText(item.displayName,120)}`).join('');
}

function perspectivePreview(items:NonNullable<FounderWorkMapTopic['perspectives']>):string{
  const order={current:0,unresolved:1,historical:2} as const;
  const labels={current:'当前共识',unresolved:'待对齐',historical:'历史提议'} as const;
  return [...items].sort((a,b)=>order[a.status]-order[b.status]||a.observedAt.localeCompare(b.observedAt)||a.founder.localeCompare(b.founder)||a.statement.localeCompare(b.statement))
    .map(item=>{const at=new Date(item.observedAt);if(!Number.isFinite(at.getTime()))throw new Error('valid perspective time is required');
      return `\n${labels[item.status]}（${item.founder}，${at.toISOString().slice(0,10)}）：${founderText(item.statement,180)}`}).join('');
}

function evidencePreview(evidence: readonly FounderCardEvidence[],linkedSourceCount=0): string {
  const first = [...evidence].sort(compareId)[0];
  if(first)return `\n${founderSourceText(first)}${evidence.length > 1 ? `\n另有 ${evidence.length - 1} 条来源，完整来源保留在记录中。` : ''}`;
  if(!Number.isSafeInteger(linkedSourceCount)||linkedSourceCount<0)throw new Error('valid linked source count is required');
  return linkedSourceCount>0?`\n来源：已关联 ${linkedSourceCount} 个来源，暂无可展示摘录。`:'\n来源：待补充（不作为已确认共识）';
}
