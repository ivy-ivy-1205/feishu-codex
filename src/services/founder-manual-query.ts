import type Database from 'better-sqlite3';
import { AlignmentIssueRepository } from '../repositories/alignment-issue-repository.js';
import { AlignmentRepository } from '../repositories/alignment-repository.js';
import { TopicRepository } from '../repositories/topic-repository.js';
import { buildCurrentFounderWorkMap } from './current-founder-work-map.js';
import { founderCard, founderText } from './founder-card.js';
import type { FounderWorkMapCard } from './founder-work-map-renderer.js';

export type FounderManualQuery =
  | { kind:'work_map' }
  | { kind:'topic_alignment';topicName:string }
  | { kind:'open_alignment' };

export interface FounderManualCardQueryMessage {
  kind:'founder_manual_query'; queryMessageId:string; page:number; totalPages:number;
  targetChatId:string; card:Record<string,unknown>;
}
export type FounderManualQueryMessage=FounderManualCardQueryMessage|(FounderWorkMapCard&{
  mapId:string;targetChatId:string;manualQueryMessageId:string;
});

const baselineSince='2026-08-31T00:00:00.000Z';

export function parseFounderManualQuery(value:string):FounderManualQuery|null{
  const text=value.normalize('NFKC').trim();
  if(text==='查看工作地图')return{kind:'work_map'};
  if(text==='查看待对齐')return{kind:'open_alignment'};
  const match=/^查看对齐\s*[:：]\s*(.{1,100})$/u.exec(text);
  return match?.[1]?.trim()?{kind:'topic_alignment',topicName:match[1].trim()}:null;
}

export function isConfiguredFounder(client:Database.Database,openId:string):boolean{
  return Boolean(openId&&client.prepare("SELECT 1 FROM founder_identities WHERE source_system='feishu' AND external_author_id=?").get(openId));
}

export function buildFounderManualQueryMessages(input:{client:Database.Database;query:FounderManualQuery;
  queryMessageId:string;chatId:string;approvedChatIds:readonly string[];now:Date}):FounderManualQueryMessage[]{
  const status=processingStatus(input.client,input.chatId);
  if(input.query.kind==='work_map'){
    const result=buildWorkMap(input);
    if(result)return result.cards.map(item=>({...item,mapId:result.mapId,targetChatId:input.chatId,
      manualQueryMessageId:input.queryMessageId,card:withProcessingStatus(item.card,status)}));
  }
  const cards=input.query.kind==='topic_alignment'?[buildTopicAlignment(input,input.query.topicName)]:
    input.query.kind==='open_alignment'?[buildOpenAlignment(input)]:
      [founderCard('工作地图',['目前没有可展示的项目；机器人不会凭空创建项目。'])];
  return cards.map((card,index)=>({kind:'founder_manual_query',queryMessageId:input.queryMessageId,page:index+1,
    totalPages:cards.length,targetChatId:input.chatId,card:withProcessingStatus(card,status)}));
}

export function enqueueFounderManualQuery(client:Database.Database,messages:readonly FounderManualQueryMessage[],at:Date):number{
  let created=0;
  for(const message of messages){
    const queryMessageId=message.kind==='founder_manual_query'?message.queryMessageId:message.manualQueryMessageId;
    const key=`founder-manual-query:${message.targetChatId}:${queryMessageId}:${message.page}`;
    created+=client.prepare(`INSERT INTO outbox(id,destination,payload,idempotency_key,status,created_at)
      VALUES(?,?,?,?, 'pending',?) ON CONFLICT(idempotency_key) DO NOTHING`)
      .run(key,message.targetChatId,JSON.stringify(message),key,at.toISOString()).changes;
  }
  return created;
}

function buildWorkMap(input:{client:Database.Database;chatId:string;approvedChatIds:readonly string[];now:Date}):
  {mapId:string;cards:FounderWorkMapCard[]}|null {
  const count=new TopicRepository(input.client).listCanonicalTopics().length;
  if(count===0)return null;
  const result=buildCurrentFounderWorkMap({client:input.client,chatId:input.chatId,approvedChatIds:input.approvedChatIds,
    expectedCanonicalTopicCount:count,since:baselineSince,until:input.now.toISOString()});
  return{mapId:result.mapId,cards:result.cards};
}

function buildTopicAlignment(input:{client:Database.Database;now:Date},name:string):Record<string,unknown>{
  const topics=new TopicRepository(input.client).listCanonicalTopics();
  const wanted=normalize(name),matches=topics.filter(topic=>normalize(topic.displayName)===wanted);
  if(matches.length!==1)return founderCard('双方理解与待对齐',[
    matches.length===0?`没有找到“${founderText(name,100)}”。请先用“查看工作地图”确认项目名称。`:
      `“${founderText(name,100)}”对应多个项目，暂不自动猜测。`],'orange');
  const topic=matches[0]!,perspectives=new AlignmentRepository(input.client).listCanonicalPerspectives(topic.id);
  const shared=perspectives.filter(item=>item.kind==='shared_decision');
  const ivy=perspectives.filter(item=>item.kind==='ivy_view'&&item.observedAt>=topic.changedAt);
  const james=perspectives.filter(item=>item.kind==='james_view'&&item.observedAt>=topic.changedAt);
  const ivyHistory=perspectives.filter(item=>item.kind==='ivy_view'&&item.observedAt<topic.changedAt);
  const jamesHistory=perspectives.filter(item=>item.kind==='james_view'&&item.observedAt<topic.changedAt);
  const ivyConfirmedBaseline=topic.rationale==='Ivy confirmed Founder work map baseline';
  const issues=new AlignmentIssueRepository(input.client).listForTopic(topic.id)
    .filter(item=>['candidate','ready','asked'].includes(item.status));
  const lines=[`项目：${founderText(topic.displayName,120)}`,
    `${ivyConfirmedBaseline?'已确认项目结构／目标（Ivy 确认）':'当前项目目标'}：${topic.outcome?founderText(topic.outcome,500):'尚未形成明确目标。'}`,
    section('已确认共识',shared.map(item=>item.statement),'暂无双方明确确认的共识；沉默不代表同意。'),
    section('Ivy 的当前个人理解',ivy.map(item=>item.statement),ivyConfirmedBaseline?'已通过上方项目结构／目标表达当前确认。':'暂无 Ivy 的当前表达。'),
    section('James 的当前个人理解',james.map(item=>item.statement),'暂无 James 的当前表达。'),
    ...(ivyHistory.length?[section('Ivy 的历史表达',ivyHistory.map(item=>dated(item.statement,item.observedAt)),'')]:[]),
    ...(jamesHistory.length?[section('James 的历史表达',jamesHistory.map(item=>dated(item.statement,item.observedAt)),'')]:[])];
  const ivyCurrent=ivyConfirmedBaseline||ivy.length>0;
  if(!ivyCurrent||james.length===0){const missing=!ivyCurrent&&james.length===0?'双方':!ivyCurrent?'Ivy':'James';
    lines.push(`缺少另一方表达：缺少${missing==='双方'?'双方':` ${missing} `}的当前表达。`)}
  else lines.push('缺少另一方表达：双方均已有个人表达，但这不自动等于已达成共识。');
  const displayedIssues=issues.slice(0,8);
  lines.push(issues.length?`真实分歧：${issues.length} 项有双方证据且会影响行动。\n${displayedIssues.map(issue=>
    `- ${founderText(issue.ivy.statement,150)} ↔ ${founderText(issue.james.statement,150)}`).join('\n')}${issues.length>displayedIssues.length?`\n仅展示前 ${displayedIssues.length} 项，请按具体项目继续查询。`:''}`:
    '真实分歧：当前没有满足“双方都有证据且影响行动”条件的分歧；这不代表所有事项都已对齐。');
  lines.push(`原始来源：当前观点共关联 ${new Set(perspectives.flatMap(item=>item.evidenceIds)).size} 条证据，可沿原群消息追溯。`);
  return founderCard('双方理解与待对齐',lines,issues.length?'orange':'blue');
}

function buildOpenAlignment(input:{client:Database.Database}):Record<string,unknown>{
  const topics=new TopicRepository(input.client),alignment=new AlignmentRepository(input.client),issues=new AlignmentIssueRepository(input.client);
  const topicList=topics.listCanonicalTopics(),topicById=new Map(topicList.map(topic=>[topic.id,topic]));
  const missing:string[]=[];
  for(const topic of topicList){
    const views=alignment.listCanonicalPerspectives(topic.id);
    const ivy=topic.rationale==='Ivy confirmed Founder work map baseline'||
      views.some(item=>item.kind==='ivy_view'&&item.observedAt>=topic.changedAt);
    const james=views.some(item=>item.kind==='james_view'&&item.observedAt>=topic.changedAt);
    if(ivy!==james)missing.push(`${topic.displayName}：缺少 ${ivy?'James':'Ivy'} 的当前表达`);
  }
  const open=topicList.flatMap(topic=>issues.listForTopic(topic.id))
    .filter(item=>['candidate','ready','asked'].includes(item.status));
  const lines=['已确认共识、单方理解和真实分歧严格分开；没有回复不会被记成同意。',
    `缺少另一方表达：${missing.length} 项${missing.length?`\n${missing.slice(0,12).map(item=>`- ${founderText(item,180)}`).join('\n')}`:'。'}`,
    `真实分歧：${open.length} 项${open.length?`\n${open.slice(0,12).map(item=>`- ${founderText(topicById.get(item.topicId)?.displayName??item.topicId,100)}：${founderText(item.ivy.statement,100)} ↔ ${founderText(item.james.statement,100)}`).join('\n')}`:'。'}`];
  return founderCard('待对齐总览',lines,open.length?'orange':'blue');
}

function processingStatus(client:Database.Database,chatId:string):string{
  const received=client.prepare("SELECT MAX(received_at) value FROM founder_stream_events WHERE chat_id=? AND disposition IN ('captured','skipped_media')").get(chatId) as {value:string|null};
  const rows=client.prepare("SELECT type,status,payload,updated_at FROM batch_jobs WHERE type IN ('capture_group_message','capture_founder_attachment','analyze_founder_stream_batch')")
    .all() as {type:string;status:string;payload:string;updated_at:string}[];
  const scoped=rows.flatMap(row=>{try{const payload=JSON.parse(row.payload) as {chatId?:unknown;sourceIds?:unknown};
    return payload.chatId===chatId?[{...row,sourceIds:Array.isArray(payload.sourceIds)?payload.sourceIds.filter((id):id is string=>typeof id==='string'):[]}]:[]
  }catch{return[]}});
  const completedSources=new Set(scoped.filter(row=>row.type==='analyze_founder_stream_batch'&&row.status==='completed').flatMap(row=>row.sourceIds));
  const analyzedAt=scoped.filter(row=>row.type==='analyze_founder_stream_batch'&&row.status==='completed')
    .map(row=>row.updated_at).sort().at(-1)??null;
  const pending=scoped.filter(row=>['queued','retry','processing'].includes(row.status)).length;
  const unresolvedFailures=scoped.filter(row=>row.status==='failed'&&(row.sourceIds.length===0||row.sourceIds.some(id=>!completedSources.has(id)))).length;
  const gaps=countPersistedGaps(client,chatId);
  const audit=latestCoverageAudit(client,chatId);
  return `处理状态\n最后收到：${received.value??'尚无记录'}\n最后完成分析：${analyzedAt??'尚无完成记录'}\n最后防漏复核：${audit??'尚无记录'}\n待处理：${pending}；未补偿失败：${unresolvedFailures}；不可读/跳过缺口：${gaps}\n“待处理为 0”只证明已入库任务没有积压；缺口会单独显示，不把未读取内容算作已覆盖。`;
}

function latestCoverageAudit(client:Database.Database,chatId:string):string|null{
  const rows=client.prepare("SELECT captured_at,metadata_json FROM context_sources WHERE source_type='feishu_sync_coverage' ORDER BY captured_at DESC")
    .all() as {captured_at:string;metadata_json:string}[];
  for(const row of rows)try{const metadata=JSON.parse(row.metadata_json) as {chatId?:unknown;syncPurpose?:unknown};
    if(metadata.chatId===chatId&&metadata.syncPurpose==='daily_reconciliation')return row.captured_at}catch{}
  return null;
}

function withProcessingStatus(card:Record<string,unknown>,status:string):Record<string,unknown>{
  const elements=Array.isArray(card.elements)?card.elements:[];
  const result={...card,elements:[...elements,{tag:'hr'},{tag:'div',text:{tag:'plain_text',content:status}}]};
  return Buffer.byteLength(JSON.stringify(result),'utf8')<=28_000?result:
    founderCard('查询结果过长',[status,'结果超过飞书单卡安全上限，请缩小到具体项目后再次查询。'],'orange');
}

function countPersistedGaps(client:Database.Database,chatId:string):number{
  const rows=client.prepare("SELECT source_type,content_text,metadata_json FROM context_sources WHERE source_type IN ('feishu_sync_gap','feishu_sync_coverage')")
    .all() as {source_type:string;content_text:string;metadata_json:string}[];
  const unique=new Set<string>();
  const remember=(value:unknown)=>{if(typeof value!=='object'||value===null)return;
    const gap=value as {code?:unknown;sourceRef?:unknown};
    if(typeof gap.code==='string'&&typeof gap.sourceRef==='string')unique.add(`${gap.code}\n${gap.sourceRef}`)};
  for(const row of rows)try{
    const metadata=JSON.parse(row.metadata_json) as {chatId?:unknown;gaps?:unknown};
    if(metadata.chatId!==chatId)continue;
    if(row.source_type==='feishu_sync_gap'){remember(JSON.parse(row.content_text));continue}
    const content=JSON.parse(row.content_text) as {gaps?:unknown};
    const gaps=Array.isArray(content.gaps)?content.gaps:Array.isArray(metadata.gaps)?metadata.gaps:[];
    gaps.forEach(remember);
  }catch{/* Malformed audit rows are not treated as readable coverage. */}
  return unique.size;
}

function section(title:string,values:readonly string[],empty:string):string{
  return `${title}\n${values.length?values.map(value=>`- ${founderText(value,260)}`).join('\n'):empty}`;
}

function dated(statement:string,observedAt:string):string{
  return `${observedAt.slice(0,10)}｜${statement}`;
}

function normalize(value:string):string{return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/[\p{P}\p{S}\s]+/gu,'')}
