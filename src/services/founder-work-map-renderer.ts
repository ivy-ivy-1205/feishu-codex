import type { CurrentTopic, TopicStage } from '../domain/topic.js';
import { founderCard, founderSourceText, founderText, type FounderCardEvidence } from './founder-card.js';

export interface FounderWorkMapTopic extends Pick<CurrentTopic, 'id' | 'currentVersion' | 'displayName' | 'stage' | 'outcome'> {
  evidence: readonly FounderCardEvidence[];
  displayKind?: 'project'|'task'|'goal';
  linkedSourceCount?: number;
  parentName?: string;
  perspectives?: readonly { founder:'Ivy'|'James'|'双方';status:'current'|'historical'|'unresolved';statement:string;observedAt:string }[];
  supportingItems?: readonly {kind:'principle'|'artifact'|'research'|'task'|'goal';displayName:string}[];
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
interface Item { section: string; text: string; ref?: FounderWorkMapItemRef }
const compareId = (a: { id: string }, b: { id: string }): number => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const aLine='AiJia AI Native 房产业务',bLine='自媒体生产线',cLine='公司协作基础设施';

export function renderFounderWorkMap(input: FounderWorkMapInput): FounderWorkMapCard[] {
  const start = Date.parse(input.since), end = Date.parse(input.until);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error('valid ordered work-map window is required');
  for (const collection of [input.topics, input.uncertainGrouping, input.coverageGaps]) {
    if (collection.some((item) => !item.id.trim()) || new Set(collection.map((item) => item.id)).size !== collection.length) {
      throw new Error('work-map item identities must be nonempty and unique');
    }
  }
  const items: Item[] = [];
  let numbered=0;
  const add = (section: string, text: string, ref: Omit<FounderWorkMapItemRef, 'displayedNumber'>) => {
    const displayedNumber = ++numbered;
    items.push({ section, text: `#${displayedNumber} · ${text}`, ref: { ...ref, displayedNumber } });
  };
  const addSupporting=(section:string,text:string)=>items.push({section,text});
  const topicByName=new Map<string,FounderWorkMapTopic>();
  const duplicateNames=new Set<string>();
  for(const topic of input.topics){if(topicByName.has(topic.displayName)){topicByName.delete(topic.displayName);duplicateNames.add(topic.displayName)}
    else if(!duplicateNames.has(topic.displayName))topicByName.set(topic.displayName,topic)}
  const topics = [...input.topics].sort((a,b)=>compareHierarchy(a,b,topicByName));
  for (const topic of topics) {
    if (!stages.includes(topic.stage) || !Number.isInteger(topic.currentVersion) || topic.currentVersion < 1 || !topic.displayName.trim()) {
      throw new Error('valid work-map topic is required');
    }
    const displayKind=topic.displayKind??'project';
    if(!['project','task','goal'].includes(displayKind))throw new Error('valid work-map display kind is required');
    const suffix = topic.stage === 'paused' ? '（暂停）' : topic.stage === 'closed' ? '（已结束）' : '';
    const hierarchy=hierarchyFor(topic,topicByName),framework=frameworkFor(hierarchy);
    const section=framework==='A'?`A 线｜${aLine}`:framework==='B'?`B 线｜${bLine}`:
      framework==='C'?`C 线｜${cLine}`:labels[topic.stage];
    if(framework&&hierarchy.length===1&&displayKind==='project')continue;
    const nestedProject=framework?hierarchy.length>2:hierarchy.length>1;
    const nestedSupporting=(framework?hierarchy.length>2:hierarchy.length>1)?'↳ ':'';
    const title=displayKind==='task'?`${nestedSupporting}任务｜${topic.displayName}`:displayKind==='goal'?`${nestedSupporting}阶段目标｜${topic.displayName}`:
      `${nestedProject?'↳ 子项目':'项目'}｜${topic.displayName}`;
    const text=`${founderText(title, 120)}${suffix}${topic.outcome ? `\n当前方向：${founderText(topic.outcome, 420)}` : ''}${perspectivePreview(topic.displayName,topic.perspectives??[])}${supportingPreview(topic.supportingItems??[])}${evidencePreview(topic.evidence,topic.linkedSourceCount??0)}`;
    if(displayKind==='project')add(section,text,{ kind: 'topic', id: topic.id, expectedVersion: topic.currentVersion });
    else addSupporting(section,text);
  }
  for (const grouping of [...input.uncertainGrouping].sort(compareId)) {
    const related = [...new Set(grouping.topicIds)].map((id) => items.find((item) => item.ref?.kind === 'topic' && item.ref.id === id)?.ref?.displayedNumber);
    if (related.length < 2 || related.some((number) => number === undefined)) throw new Error('grouping requires at least two known topics');
    add('归类待确认', `关联条目 ${related.sort((a, b) => a! - b!).map((number) => `#${number}`).join('、')}\n${founderText(grouping.summary, 240)}${evidencePreview(grouping.evidence)}`,
      { kind: 'uncertain_grouping', id: grouping.id });
  }
  for (const gap of [...input.coverageGaps].sort(compareId)) add('覆盖缺口', founderText(gap.summary, 240), { kind: 'coverage_gap', id: gap.id });
  const preface = `整理范围：${new Date(start).toISOString()} 至 ${new Date(end).toISOString()}\n这是根据已读取语料整理的工作地图，可继续纠正。`;
  const footer = `归类待确认：${input.uncertainGrouping.length} 项；覆盖缺口：${input.coverageGaps.length} 项。未报告缺口不代表完整同步。\n可直接在本卡下用自然语言回复，例如“2 和 4 是同一个项目”“第 1 项只是想法”。编号只给项目和待确认项；任务与阶段目标挂在所属项目下。`;
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
      itemRefs: chunk.flatMap((item) => item.ref?[item.ref]:[]), card: founderCard(`工作地图 · ${index + 1}/${chunks.length}`, lines) };
  });
}

function hierarchyFor(topic:FounderWorkMapTopic,byName:ReadonlyMap<string,FounderWorkMapTopic>):FounderWorkMapTopic[]{
  const path=[topic],seen=new Set([topic.id]);let current=topic;
  while(current.parentName){const parent=byName.get(current.parentName);if(!parent||seen.has(parent.id))break;
    path.unshift(parent);seen.add(parent.id);current=parent}
  return path;
}

function frameworkFor(path:readonly FounderWorkMapTopic[]):'A'|'B'|'C'|null{
  return path[0]?.displayName===aLine?'A':path[0]?.displayName===bLine?'B':path[0]?.displayName===cLine?'C':null;
}

function compareHierarchy(a:FounderWorkMapTopic,b:FounderWorkMapTopic,byName:ReadonlyMap<string,FounderWorkMapTopic>):number{
  const key=(topic:FounderWorkMapTopic):string=>{const path=hierarchyFor(topic,byName),framework=frameworkFor(path);
    const root=framework==='A'?'0':framework==='B'?'1':framework==='C'?'2':'3';
    const projectOrder=(name:string):string=>name==='AiJia AI Native 官网'?'00':name==='Smart Listing'?'01':
      name==='AI 选房经验与知识库'?'02':name==='房产销售过程数据沉淀'?'03':
      name==='飞书合伙人对齐'?'00':name==='企业微信接入'?'01':name;
    const hierarchy=path.length===1?['00-root']:path.slice(1).map(item=>`10-${projectOrder(item.displayName)}`);
    return [root,...hierarchy,stages.indexOf(topic.stage).toString().padStart(2,'0'),topic.id].join('|')};
  return key(a).localeCompare(key(b));
}

function supportingPreview(items:readonly {kind:'principle'|'artifact'|'research'|'task'|'goal';displayName:string}[]):string{
  const labels={principle:'原则',artifact:'产物',research:'研究',task:'任务',goal:'阶段目标'} as const;
  return [...items].sort((a,b)=>a.kind.localeCompare(b.kind)||a.displayName.localeCompare(b.displayName))
    .map(item=>`\n${labels[item.kind]}：${founderText(item.displayName,120)}`).join('');
}

function perspectivePreview(topicName:string,items:NonNullable<FounderWorkMapTopic['perspectives']>):string{
  const order={current:0,unresolved:1,historical:2} as const;
  const labels={current:'当前共识',unresolved:'待对齐'} as const;
  const visible=items.filter((item):item is typeof item&{status:'current'|'unresolved'}=>item.status!=='historical');
  const historyCount=items.length-visible.length;
  const details=[...visible].sort((a,b)=>order[a.status]-order[b.status]||a.observedAt.localeCompare(b.observedAt)||a.founder.localeCompare(b.founder)||a.statement.localeCompare(b.statement))
    .map(item=>{const at=new Date(item.observedAt);if(!Number.isFinite(at.getTime()))throw new Error('valid perspective time is required');
      return `\n${labels[item.status]}（${item.founder}，${at.toISOString().slice(0,10)}）：${founderText(item.statement,180)}`}).join('');
  return `${details}${historyCount?`\n历史记录：${historyCount} 条，可用“查看对齐：${founderText(topicName,80)}”查看`:''}`;
}

function evidencePreview(evidence: readonly FounderCardEvidence[],linkedSourceCount=0): string {
  const first = [...evidence].sort(compareId)[0];
  if(first){const source=first.locator.kind==='group_message'
    ?`来源：群聊 · ${new Date(first.occurredAt).toISOString()}\n原文：${founderText(first.excerpt,240)}`:founderSourceText(first);
    return `\n${source}${evidence.length > 1 ? `\n另有 ${evidence.length - 1} 条来源，完整来源保留在记录中。` : ''}`;}
  if(!Number.isSafeInteger(linkedSourceCount)||linkedSourceCount<0)throw new Error('valid linked source count is required');
  return linkedSourceCount>0?`\n来源：已关联 ${linkedSourceCount} 个来源，暂无可展示摘录。`:'\n来源：待补充（不作为已确认共识）';
}
