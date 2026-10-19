import type Database from 'better-sqlite3';
import { contextEvidenceLocatorSchema } from '../domain/context.js';
import type { CurrentPerspective } from '../domain/alignment.js';
import type { CurrentTopic } from '../domain/topic.js';
import { AlignmentRepository } from '../repositories/alignment-repository.js';
import { OutboxRepository } from '../repositories/outbox-repository.js';
import { TopicRepository } from '../repositories/topic-repository.js';
import { canonicalJson, stableId } from './canonical-json.js';
import type { FounderCardEvidence } from './founder-card.js';
import { founderLineRootNames, renderFounderWorkMap, type FounderWorkMapCard, type FounderWorkMapTopic } from './founder-work-map-renderer.js';
import type { FounderWorkMapBoardView } from './founder-board-view.js';
import type { SpaceFreshnessSummary } from './space-sync-freshness.js';
import { spaceBoardSummary, type SpaceProjectPageView } from './space-project-page-view.js';

export interface CurrentFounderWorkMapInput {
  client: Database.Database;
  chatId: string;
  since: string;
  until: string;
  approvedChatIds: readonly string[];
  expectedCanonicalTopicCount: number;
  /** Precomputed via computeSpaceFreshness() by the caller; this function never reaches Space itself. */
  spaceFreshnessByTopicId?: ReadonlyMap<string, SpaceFreshnessSummary>;
  spacePageByTopicId?: ReadonlyMap<string, SpaceProjectPageView>;
}

export interface CurrentFounderWorkMapResult {
  mapId: string;
  canonicalTopicCount: number;
  cards: FounderWorkMapCard[];
  boardView:FounderWorkMapBoardView;
}

export function buildCurrentFounderWorkMap(input:CurrentFounderWorkMapInput):CurrentFounderWorkMapResult{
  assertInput(input);
  const topics=new TopicRepository(input.client),alignment=new AlignmentRepository(input.client);
  const canonical=topics.listCanonicalTopics();
  if(canonical.length!==input.expectedCanonicalTopicCount)throw new Error('FOUNDER_WORK_MAP_TOPIC_COUNT_MISMATCH');
  const rootByTopic=canonicalRoots(topics.listCurrentTopics(),topics.listRelations().filter(relation=>relation.relationType==='same_as'));
  const canonicalById=new Map(canonical.map(topic=>[topic.id,topic]));
  const parentByChild=new Map<string,string>();
  for(const relation of topics.listRelations().filter(relation=>relation.relationType==='part_of')){
    const child=rootByTopic.get(relation.fromTopicId),parent=rootByTopic.get(relation.toTopicId);
    if(child&&parent&&child!==parent)parentByChild.set(child,parent);
  }
  const hiddenRoots=new Set((input.client.prepare("SELECT topic_id FROM founder_topic_visibility WHERE visibility='space_managed'").all() as {topic_id:string}[])
    .flatMap(row=>{const root=rootByTopic.get(row.topic_id);return root?[root]:[]}));
  const correctionMessageIds=new Set((input.client.prepare('SELECT source_message_id FROM founder_feedback_corrections WHERE chat_id=?')
    .all(input.chatId) as {source_message_id:string}[])
    .map(row=>row.source_message_id));
  const preference=input.client.prepare('SELECT hide_orphan_active FROM founder_work_map_preferences WHERE chat_id=?').get(input.chatId) as
    {hide_orphan_active:number}|undefined;
  const parentsWithChildren=new Set(parentByChild.values());
  const visibleCanonical=canonical.filter(topic=>!hiddenRoots.has(topic.id)&&!(preference?.hide_orphan_active===1&&
    ['active_project','project_candidate','exploring','idea'].includes(topic.stage)&&!parentByChild.has(topic.id)&&!parentsWithChildren.has(topic.id)));
  const projectedRaw:FounderWorkMapTopic[]=visibleCanonical.map(topic=>{
    const componentIds=[...rootByTopic].filter(([,root])=>root===topic.id).map(([id])=>id);
    const evidence=loadEvidence(input.client,componentIds,correctionMessageIds);
    const parentId=parentByChild.get(topic.id);
    const displayName=cleanDisplayName(topic.displayName);
    const spaceFreshness=input.spaceFreshnessByTopicId?.get(topic.id),spacePage=input.spacePageByTopicId?.get(topic.id);
    const lastActivityAt=latestActivity(input.client,componentIds,topic.createdAt,spacePage?.pageUpdatedAt??null);
    return{...topic,displayName,evidence:evidence.items,linkedSourceCount:evidence.linkedSourceCount,lastActivityAt,
      ...(topic.stage==='closed'?{closedAt:closedSince(topics,topic.id)}:{}),
      displayKind:displayKindFor(topics,topic.id,topic.stage),
      parentName:parentId?cleanDisplayName(canonicalById.get(parentId)?.displayName??''):undefined,
      perspectives:alignment.listCanonicalPerspectives(topic.id).filter(perspective=>!isTopicLabelOnly(displayName,perspective.statement))
        .map(perspective=>projectPerspective(topic,perspective)),...(spaceFreshness?{spaceFreshness}:{}),...(spacePage?{spacePage}:{})};
  });
  const projected=markDormant(coalesceDisplayDuplicates(projectedRaw),input.until);
  const coverageGaps=loadCoverageGaps(input.client,input.chatId,input.since,input.until);
  const cards=renderFounderWorkMap({since:input.since,until:input.until,topics:projected,uncertainGrouping:[],coverageGaps});
  const boardView:FounderWorkMapBoardView={kind:'work_map',since:input.since,until:input.until,coverageGaps,
    topics:projected.map(topic=>({id:topic.id,name:topic.displayName,stage:topic.stage,kind:topic.displayKind??'project',
      outcome:topic.outcome,parentName:topic.parentName,sourceCount:topic.linkedSourceCount??topic.evidence.length,
      ...(topic.spacePage?{space:spaceBoardSummary(topic.spacePage)}:{}),
      ...(topic.lastActivityAt?{lastActivityAt:topic.lastActivityAt}:{}),...(topic.dormant?{dormant:true}:{}),
      ...(topic.stage==='closed'?{closedAt:topic.closedAt??null}:{})}))};
  const mapId=stableId('foundermap',canonicalJson({chatId:input.chatId,since:input.since,until:input.until,
    topics:canonical.map(topic=>({id:topic.id,version:topic.currentVersion})),hiddenRoots:[...hiddenRoots].sort(),
    hideOrphanActive:preference?.hide_orphan_active===1,pages:cards.length}));
  return{mapId,canonicalTopicCount:canonical.length,cards,boardView};
}

function displayKindFor(topics:TopicRepository,topicId:string,stage:CurrentTopic['stage']):'project'|'task'|'goal'|'idea'{
  if(stage==='idea')return'idea';
  for(const version of [...topics.listVersions(topicId)].reverse()){
    if(version.rationale==='Ivy confirmed Founder work map task')return'task';
    if(version.rationale==='Ivy confirmed Founder work map goal')return'goal';
    if(/^Ivy confirmed Founder work map(?: V\d+)? baseline$/u.test(version.rationale))return'project';
  }
  return'project';
}

export function enqueueCurrentFounderWorkMap(input:CurrentFounderWorkMapInput&{
  confirmedChatId:string;groupDeliveryEnabled:boolean;now?:Date;
}):CurrentFounderWorkMapResult&{created:number}{
  if(!input.groupDeliveryEnabled)throw new Error('FOUNDER_WORK_MAP_DELIVERY_DISABLED');
  if(input.confirmedChatId!==input.chatId)throw new Error('FOUNDER_WORK_MAP_TARGET_NOT_CONFIRMED');
  const pending=(input.client.prepare("SELECT count(*) AS count FROM outbox WHERE status='pending'").get() as {count:number}).count;
  const active=(input.client.prepare("SELECT count(*) AS count FROM batch_jobs WHERE status IN ('queued','retry','processing')").get() as {count:number}).count;
  if(pending!==0||active!==0)throw new Error('FOUNDER_WORK_MAP_QUEUE_NOT_IDLE');
  const result=buildCurrentFounderWorkMap(input),outbox=new OutboxRepository(input.client);
  const created=input.client.transaction(()=>result.cards.reduce((count,card)=>count+Number(outbox.enqueueFounderWorkMap({
    ...card,mapId:result.mapId,targetChatId:input.chatId
  },input.now).created),0)).immediate();
  return{...result,created};
}

function assertInput(input:CurrentFounderWorkMapInput):void{
  if(!input.chatId.trim()||!input.approvedChatIds.includes(input.chatId))throw new Error('FOUNDER_WORK_MAP_CHAT_NOT_APPROVED');
  if(!Number.isSafeInteger(input.expectedCanonicalTopicCount)||input.expectedCanonicalTopicCount<1)throw new Error('FOUNDER_WORK_MAP_TOPIC_COUNT_INVALID');
  const since=Date.parse(input.since),until=Date.parse(input.until);
  if(!Number.isFinite(since)||!Number.isFinite(until)||since>=until)throw new Error('FOUNDER_WORK_MAP_WINDOW_INVALID');
}

function canonicalRoots(all:readonly CurrentTopic[],relations:readonly {fromTopicId:string;toTopicId:string}[]):Map<string,string>{
  const byId=new Map(all.map(topic=>[topic.id,topic])),parent=new Map(all.map(topic=>[topic.id,topic.id]));
  const find=(id:string):string=>{const current=parent.get(id)!;if(current===id)return id;const root=find(current);parent.set(id,root);return root};
  for(const relation of relations){const a=find(relation.fromTopicId),b=find(relation.toTopicId);if(a===b)continue;
    const root=byId.get(a)!.createdAt.localeCompare(byId.get(b)!.createdAt)<=0?a:b;parent.set(root===a?b:a,root)}
  return new Map(all.map(topic=>[topic.id,find(topic.id)]));
}

function projectPerspective(topic:CurrentTopic,perspective:CurrentPerspective):NonNullable<FounderWorkMapTopic['perspectives']>[number]{
  const founder=perspective.kind==='shared_decision'?'双方':perspective.kind==='james_view'?'James':'Ivy';
  const status=perspective.kind==='shared_decision'?'current':perspective.kind==='unresolved'||perspective.speechAct==='explicit_disagreement'||
    perspective.observedAt>topic.changedAt?'unresolved':'historical';
  return{founder,status,statement:perspective.statement,observedAt:perspective.observedAt};
}

function isTopicLabelOnly(displayName:string,statement:string):boolean{
  const normalize=(value:string)=>value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/[\p{P}\p{S}\s]+/gu,'');
  const label=normalize(displayName),view=normalize(statement);
  return view===label||(view.endsWith(label)&&view.length-label.length<=12);
}

function loadEvidence(client:Database.Database,topicIds:readonly string[],correctionMessageIds:ReadonlySet<string>):{items:FounderCardEvidence[];linkedSourceCount:number}{
  if(topicIds.length===0)return{items:[],linkedSourceCount:0};
  const placeholders=topicIds.map(()=>'?').join(',');
  const links=client.prepare(`SELECT DISTINCT ts.source_id,ts.evidence_id FROM context_topic_sources ts
    JOIN context_topic_versions tv ON tv.id=ts.topic_version_id WHERE tv.topic_id IN (${placeholders})`).all(...topicIds) as {source_id:string;evidence_id:string|null}[];
  const ids=[...new Set(links.flatMap(link=>link.evidence_id?[link.evidence_id]:[]))];
  const items=ids.flatMap(id=>{
    const row=client.prepare(`SELECT e.id,e.source_id,e.source_version,e.excerpt,e.locator_json,s.occurred_at,s.metadata_json
      FROM context_evidence e JOIN context_sources s ON s.id=e.source_id WHERE e.id=?`).get(id) as {id:string;source_id:string;source_version:number;excerpt:string;locator_json:string;occurred_at:string;metadata_json:string}|undefined;
    if(!row)return[];const locator=contextEvidenceLocatorSchema.safeParse(JSON.parse(row.locator_json));if(!locator.success)return[];
    let minuteToken:string|undefined;try{const token=(JSON.parse(row.metadata_json) as {minuteToken?:unknown}).minuteToken;if(typeof token==='string')minuteToken=token}catch{}
    const isFounderCorrection=locator.data.kind==='group_message'&&correctionMessageIds.has(locator.data.messageId);
    return[{id:row.id,sourceId:row.source_id,sourceVersion:row.source_version,excerpt:row.excerpt,locator:locator.data,occurredAt:row.occurred_at,
      ...(minuteToken?{minuteToken}:{}),...(isFounderCorrection?{isFounderCorrection:true}:{})}];
  });
  return{items,linkedSourceCount:new Set(links.map(link=>link.source_id)).size};
}

const dormantAfterMs=30*24*60*60*1_000;

/** Latest occurrence among sources linked to the topic (corrections and Space comments included) or its Space page. */
function latestActivity(client:Database.Database,topicIds:readonly string[],createdAt:string,spacePageUpdatedAt:string|null):string{
  const placeholders=topicIds.map(()=>'?').join(',');
  const linked=topicIds.length?(client.prepare(`SELECT s.occurred_at value FROM context_topic_sources ts
    JOIN context_topic_versions tv ON tv.id=ts.topic_version_id JOIN context_sources s ON s.id=ts.source_id
    WHERE tv.topic_id IN (${placeholders})`).all(...topicIds) as {value:string}[]).map(row=>row.value):[];
  // A topic nobody has linked anything to yet (e.g. a freshly registered card) counts from its creation.
  const candidates=[...linked,...(spacePageUpdatedAt?[spacePageUpdatedAt]:[])];
  return (candidates.length?candidates:[createdAt]).reduce((latest,value)=>Date.parse(value)>Date.parse(latest)?value:latest);
}

/** When the topic entered its current closed run of versions. */
function closedSince(topics:TopicRepository,topicId:string):string|null{
  const versions=[...topics.listVersions(topicId)].sort((a,b)=>a.versionNumber-b.versionNumber);
  let since:string|null=null;
  for(let index=versions.length-1;index>=0&&versions[index]!.stage==='closed';index--)since=versions[index]!.changedAt;
  return since;
}

/**
 * Not-closed topics without activity for 30 days leave the board (listed at the end of the text card) until new
 * activity arrives. Line roots and closed topics always stay; a parent stays while any not-closed child is active.
 */
function markDormant(topics:readonly FounderWorkMapTopic[],until:string):FounderWorkMapTopic[]{
  const threshold=Date.parse(until)-dormantAfterMs;
  const children=new Map<string,FounderWorkMapTopic[]>();
  for(const topic of topics)if(topic.parentName)children.set(topic.parentName,[...(children.get(topic.parentName)??[]),topic]);
  const memo=new Map<string,boolean>();
  const dormant=(topic:FounderWorkMapTopic,seen:Set<string>):boolean=>{
    if(memo.has(topic.id))return memo.get(topic.id)!;
    if(seen.has(topic.id))return true;seen.add(topic.id);
    // Paused work joins the reminder section at once: a correction that pauses it is itself recent activity.
    const result=!founderLineRootNames.includes(topic.displayName)&&topic.stage!=='closed'&&
      (topic.stage==='paused'||!(topic.lastActivityAt&&Date.parse(topic.lastActivityAt)>=threshold))&&
      !(children.get(topic.displayName)??[]).some(child=>child.stage!=='closed'&&!dormant(child,seen));
    memo.set(topic.id,result);return result;
  };
  return topics.map(topic=>dormant(topic,new Set())?{...topic,dormant:true}:topic);
}

function cleanDisplayName(value:string):string{
  return value.normalize('NFKC').replace(/^[\s,，:：;；|｜·.。]+/u,'').trim();
}

function coalesceDisplayDuplicates(topics:readonly FounderWorkMapTopic[]):FounderWorkMapTopic[]{
  const byName=new Map<string,FounderWorkMapTopic[]>();
  for(const topic of topics){const key=normalizeDisplayName(topic.displayName),group=byName.get(key)??[];group.push(topic);byName.set(key,group)}
  return topics.flatMap(topic=>{
    const key=normalizeDisplayName(topic.displayName),group=byName.get(key)!;
    if(group[0]!==topic)return[];
    if(group.length===1)return[topic];
    const stages=new Set(group.map(item=>item.stage)),parents=new Set(group.flatMap(item=>item.parentName?[item.parentName]:[]));
    if(stages.size!==1||parents.size>1)return group.map(item=>({...item,displayName:`${cleanDisplayName(item.displayName)}（同名待确认）`}));
    const evidence=[...new Map(group.flatMap(item=>item.evidence).map(item=>[item.id,item])).values()];
    const perspectives=[...new Map(group.flatMap(item=>item.perspectives??[])
      .map(item=>[JSON.stringify([item.founder,item.status,item.statement,item.observedAt]),item])).values()];
    return[{...topic,displayName:cleanDisplayName(topic.displayName),parentName:group.find(item=>item.parentName)?.parentName,
      outcome:topic.outcome??group.find(item=>item.outcome)?.outcome??null,evidence,perspectives,
      lastActivityAt:group.flatMap(item=>item.lastActivityAt?[item.lastActivityAt]:[]).reduce<string|undefined>((latest,value)=>
        !latest||Date.parse(value)>Date.parse(latest)?value:latest,undefined),
      linkedSourceCount:group.reduce((sum,item)=>sum+(item.linkedSourceCount??item.evidence.length),0)}];
  });
}

function normalizeDisplayName(value:string):string{
  return cleanDisplayName(value).toLocaleLowerCase('und').replace(/[\p{P}\p{S}\s]+/gu,'');
}

function loadCoverageGaps(client:Database.Database,chatId:string,since:string,until:string):{id:string;summary:string}[]{
  const rows=client.prepare(`SELECT metadata_json FROM context_sources WHERE source_type='feishu_sync_coverage'
    AND occurred_at>=? AND occurred_at<=? ORDER BY occurred_at DESC`).all(since,until) as {metadata_json:string}[];
  const counts=new Map<string,number>();
  for(const row of rows)try{const value=JSON.parse(row.metadata_json) as {chatId?:unknown;gaps?:unknown};if(value.chatId!==chatId||!Array.isArray(value.gaps))continue;
    for(const gap of value.gaps){if(typeof gap==='object'&&gap!==null&&'reasonCode'in gap&&typeof gap.reasonCode==='string')counts.set(gap.reasonCode,(counts.get(gap.reasonCode)??0)+1)}}catch{}
  return[...counts].sort().map(([reason,count])=>({id:`coverage:${reason}`,summary:`${reason}：${count} 条（不同同步批次可能重复）`}));
}
